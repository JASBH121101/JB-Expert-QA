import { chromium } from "playwright";
import { createRequire } from "node:module";
import { ExpertQAEngine, RuleRegistry } from "../../index.js";
import { ENGINE_VERSION } from "../../core/version.js";
import { createUrlSafetyGuard, assertSafeWebSocketUrl } from "./url-safety.js";
import { redactUrlForReport, redactUrlsInText } from "../../core/redaction.js";
import {
  responsiveRules,
  uiUxRules,
  accessibilityRules,
  performanceRules,
  functionalRules,
  consistencyRules
} from "../../specialists/index.js";
import { collectPageContext } from "./context.js";
import defaultConfig from "../../../config/default.config.json" with { type: "json" };

const require = createRequire(import.meta.url);
const axeScriptPath = require.resolve("axe-core/axe.min.js");
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

const ALL_RULES = [
  ...responsiveRules,
  ...uiUxRules,
  ...accessibilityRules,
  ...performanceRules,
  ...functionalRules,
  ...consistencyRules
];

export async function auditUrl(url, {
  config = defaultConfig,
  viewport = { width: 1365, height: 900 },
  specialist,
  timeout = 30000,
  headless = true,
  runAxe = true,
  allowPrivateNetworks = false
} = {}) {
  const assertSafeUrl = createUrlSafetyGuard({ allowPrivateNetworks });
  const parsed = await assertSafeUrl(url);

  const browser = await chromium.launch({ headless });
  let browserContext;
  try {
    browserContext = await browser.newContext({ viewport, serviceWorkers: "block" });
    const page = await browserContext.newPage();
    const runtimeIssues = {
      pageErrors: [],
      failedRequests: [],
      httpErrors: [],
      blockedRequests: []
    };
    page.on("pageerror", (error) => runtimeIssues.pageErrors.push({
      message: redactUrlsInText(error.message)
    }));
    page.on("requestfailed", (request) => runtimeIssues.failedRequests.push({
      url: redactUrlForReport(request.url()),
      failureText: redactUrlsInText(request.failure()?.errorText ?? "Request failed")
    }));
    page.on("response", (response) => {
      if (response.status() >= 400) runtimeIssues.httpErrors.push({
        url: redactUrlForReport(response.url()),
        status: response.status(),
        resourceType: response.request().resourceType()
      });
    });

    // Re-check every HTTP(S) navigation/resource, including redirects and browser fetches.
    await page.route("**/*", async (route) => {
      const requestUrl = route.request().url();
      try {
        const requestProtocol = new URL(requestUrl).protocol;
        if (["http:", "https:"].includes(requestProtocol)) {
          await assertSafeUrl(requestUrl);
        }
        await route.continue();
      } catch (error) {
        runtimeIssues.blockedRequests.push({
          url: redactUrlForReport(requestUrl),
          reason: error instanceof Error ? error.message : String(error)
        });
        await route.abort("blockedbyclient").catch(() => {});
      }
    });

    await page.routeWebSocket("**/*", async (webSocketRoute) => {
      const socketUrl = webSocketRoute.url();
      try {
        await assertSafeWebSocketUrl(socketUrl, assertSafeUrl);
        webSocketRoute.connectToServer();
      } catch (error) {
        runtimeIssues.blockedRequests.push({
          url: redactUrlForReport(socketUrl),
          reason: error instanceof Error ? error.message : String(error)
        });
        await webSocketRoute.close({ code: 1008, reason: "Blocked by JB Expert QA network policy" });
      }
    });

    await page.goto(parsed.href, { waitUntil: "domcontentloaded", timeout });
    await page.waitForLoadState("networkidle", { timeout: Math.min(timeout, 5000) }).catch(() => {});
    const context = await collectPageContext(page, { thresholds: config.thresholds ?? {} });
    context.url = redactUrlForReport(context.url);
    context.resources = (context.resources ?? []).map((resource) => ({
      ...resource,
      name: redactUrlForReport(resource.name)
    }));
    Object.assign(context, runtimeIssues);

    if (runAxe) {
      try {
        await page.addScriptTag({ path: axeScriptPath });
        context.axeViolations = await page.evaluate(async (tags) => {
          const result = await window.axe.run(document, {
            runOnly: { type: "tag", values: tags }
          });
          return result.violations.map((violation) => ({
            id: violation.id,
            impact: violation.impact,
            help: violation.help,
            description: violation.description,
            helpUrl: violation.helpUrl,
            nodes: violation.nodes.slice(0, 8).map((node) => ({
              target: node.target,
              summary: node.failureSummary?.slice(0, 500) ?? ""
            }))
          }));
        }, AXE_TAGS);
      } catch (error) {
        context.axeViolations = [];
        runtimeIssues.pageErrors.push({
          message: "axe-core scan failed: " + (error instanceof Error ? error.message : String(error))
        });
      }
    }

    const configuredSpecialists = new Set(Object.keys(config.weights ?? {}));
    const activeRules = ALL_RULES.filter((rule) => configuredSpecialists.has(rule.specialist));
    const registry = new RuleRegistry();
    activeRules.forEach((rule) => registry.register(rule));
    const engine = new ExpertQAEngine({ registry, config });
    const report = await engine.audit(context, { specialist });
    return {
      ...report,
      target: { url: redactUrlForReport(parsed.href), viewport, pageTitle: context.title },
      evidence: {
        documentScrollWidth: context.documentScrollWidth,
        documentScrollHeight: context.documentScrollHeight,
        pageErrors: runtimeIssues.pageErrors.length,
        failedRequests: runtimeIssues.failedRequests.length,
        httpErrors: runtimeIssues.httpErrors.length,
        blockedRequests: runtimeIssues.blockedRequests.length,
        axeViolations: context.axeViolations?.length ?? null
      }
    };
  } finally {
    if (browserContext) await browserContext.close().catch(() => {});
    await browser.close();
  }
}

const DEFAULT_VIEWPORTS = Object.freeze([
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1365, height: 900 }
]);

export async function auditViewports(url, { viewports = DEFAULT_VIEWPORTS, ...options } = {}) {
  if (!Array.isArray(viewports) || viewports.length === 0) {
    throw new TypeError("At least one viewport is required");
  }
  const seen = new Set();
  const results = [];
  for (const viewport of viewports) {
    if (!viewport.name || !Number.isFinite(viewport.width) ||
        !Number.isFinite(viewport.height) || viewport.width <= 0 || viewport.height <= 0) {
      throw new TypeError("Each viewport requires a name and positive numeric width and height");
    }
    if (seen.has(viewport.name)) throw new Error("Duplicate viewport name: " + viewport.name);
    seen.add(viewport.name);
    const report = await auditUrl(url, {
      ...options,
      viewport: { width: viewport.width, height: viewport.height }
    });
    results.push({
      name: viewport.name,
      viewport: { width: viewport.width, height: viewport.height },
      passed: report.scoring.passed,
      score: report.scoring.score,
      findings: report.diagnostics,
      summary: report.summary,
      execution: report.execution,
      evidence: report.evidence
    });
  }
  return Object.freeze({
    engine: "JB Expert QA",
    version: ENGINE_VERSION,
    generatedAt: new Date().toISOString(),
    target: { url: redactUrlForReport(new URL(url).href) },
    summary: Object.freeze({
      viewportsChecked: results.length,
      passedViewports: results.filter((item) => item.passed).length,
      failedViewports: results.filter((item) => !item.passed).length,
      totalFindings: results.reduce((sum, item) => sum + item.findings.length, 0),
      blockedRequests: results.reduce((sum, item) =>
        sum + (item.evidence?.blockedRequests ?? 0), 0)
    }),
    passed: results.every((item) => item.passed),
    viewports: Object.freeze(results)
  });
}

export { DEFAULT_VIEWPORTS };
