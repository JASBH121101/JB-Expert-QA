import { chromium } from "playwright";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { comparePngFiles } from "../visual/png-diff.js";
import { createRequire } from "node:module";
import { ExpertQAEngine } from "../../core/engine.js";
import { RuleRegistry } from "../../core/rule-registry.js";
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
import { exploreInteractionStates } from "./interactions.js";
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
  allowPrivateNetworks = false,
  sameOriginOnly = false,
  interactionExploration = false,
  maxInteractionActions = 8,
  interactionSettleMs = 180,
  interactionScreenshotDir = null,
  interactionViewportName = "default",
  screenshotPath = null,
  screenshotFullPage = false
} = {}) {
  if (typeof sameOriginOnly !== "boolean") throw new TypeError("sameOriginOnly must be a boolean");
  if (typeof interactionExploration !== "boolean") throw new TypeError("interactionExploration must be a boolean");
  if (screenshotPath !== null && (typeof screenshotPath !== "string" || !screenshotPath.trim())) throw new TypeError("screenshotPath must be a non-empty path");
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
          if (sameOriginOnly && new URL(requestUrl).origin !== parsed.origin) {
            throw new Error("Request blocked by same-origin-only audit policy");
          }
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
        const normalizedSocketUrl = socketUrl.replace(/^ws:/i, "http:").replace(/^wss:/i, "https:");
        if (sameOriginOnly && new URL(normalizedSocketUrl).origin !== parsed.origin) {
          throw new Error("WebSocket blocked by same-origin-only audit policy");
        }
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

    let interactionResult = null;
    if (interactionExploration) {
      interactionResult = await exploreInteractionStates(page, {
        url: parsed.href,
        thresholds: config.thresholds ?? {},
        maxActions: maxInteractionActions,
        settleMs: interactionSettleMs,
        timeout,
        screenshotDir: interactionScreenshotDir ?? (screenshotPath ? join(dirname(screenshotPath), "interaction-states") : null),
        viewportName: interactionViewportName
      });
      context.interactiveElements = [
        ...(context.interactiveElements ?? []).map((item) => ({ ...item, state: "initial" })),
        ...interactionResult.interactiveElements
      ];
      context.interactiveOverlaps = [
        ...(context.interactiveOverlaps ?? []).map((item) => ({ ...item, state: "initial" })),
        ...interactionResult.interactiveOverlaps
      ];
      context.interactionExploration = {
        enabled: true,
        candidatesDiscovered: interactionResult.candidatesDiscovered,
        actionsAttempted: interactionResult.actionsAttempted,
        statesCaptured: interactionResult.statesCaptured,
        overlapsFound: interactionResult.overlapsFound,
        states: interactionResult.states,
        skipped: interactionResult.skipped
      };
    } else {
      context.interactionExploration = {
        enabled: false,
        candidatesDiscovered: 0,
        actionsAttempted: 0,
        statesCaptured: 0,
        overlapsFound: 0,
        states: [],
        skipped: []
      };
    }

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

    if (screenshotPath) {
      await mkdir(dirname(screenshotPath), { recursive: true });
      await page.screenshot({ path: screenshotPath, fullPage: screenshotFullPage, animations: "disabled" });
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
        sameOriginOnly,
        interactiveOverlaps: context.interactiveOverlaps?.length ?? 0,
        interactionStatesChecked: context.interactionExploration?.statesCaptured ?? 0,
        interactionCandidates: context.interactionExploration?.candidatesDiscovered ?? 0,
        interactionActionsAttempted: context.interactionExploration?.actionsAttempted ?? 0,
        interactionExploration: context.interactionExploration,
        axeViolations: context.axeViolations?.length ?? null,
        screenshotPath
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

export async function auditViewports(url, {
  viewports = DEFAULT_VIEWPORTS,
  screenshotDir = null,
  screenshotFullPage = false,
  baselineDir = null,
  diffDir = null,
  updateBaselines = false,
  visualThreshold = 0.1,
  maxDiffPixelRatio = 0.005,
  ...options
} = {}) {
  if (!Array.isArray(viewports) || viewports.length === 0) {
    throw new TypeError("At least one viewport is required");
  }
  const seen = new Set();
  const seenSafeNames = new Set();
  const results = [];
  if (updateBaselines && !baselineDir) throw new TypeError("baselineDir is required when updating visual baselines");
  if (baselineDir && !screenshotDir) throw new TypeError("screenshotDir is required when comparing visual baselines");

  // Validate the complete matrix before launching Chromium or writing any artifacts.
  const validatedViewports = viewports.map((viewport) => {
    if (!viewport || typeof viewport.name !== "string" || !viewport.name.trim() ||
        viewport.name.length > 80 || /[\u0000-\u001f\u007f]/.test(viewport.name) ||
        !Number.isSafeInteger(viewport.width) || !Number.isSafeInteger(viewport.height) ||
        viewport.width < 1 || viewport.height < 1 ||
        viewport.width > 8192 || viewport.height > 8192 ||
        viewport.width * viewport.height > 33_554_432) {
      throw new TypeError("Each viewport requires a safe name and integer dimensions within the 32-megapixel budget");
    }
    const normalizedName = viewport.name.trim().toLowerCase();
    if (seen.has(normalizedName)) throw new Error("Duplicate viewport name: " + viewport.name);
    seen.add(normalizedName);
    const safeName = viewport.name.trim().replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "");
    const normalizedSafeName = safeName.toLowerCase();
    if (!safeName) throw new TypeError("Viewport name must contain at least one safe filename character");
    if (seenSafeNames.has(normalizedSafeName)) {
      throw new Error("Viewport names collide after filename normalization: " + viewport.name);
    }
    seenSafeNames.add(normalizedSafeName);
    return { viewport, safeName };
  });

  for (const { viewport, safeName } of validatedViewports) {
    const screenshotPath = screenshotDir ? join(screenshotDir, safeName + ".png") : null;
    const report = await auditUrl(url, {
      ...options,
      screenshotPath,
      screenshotFullPage,
      viewport: { width: viewport.width, height: viewport.height },
      interactionScreenshotDir: screenshotDir ? join(screenshotDir, "interaction-states") : null,
      interactionViewportName: safeName
    });
    let visualComparison = null;
    if (baselineDir) {
      const baselinePath = join(baselineDir, safeName + ".png");
      if (updateBaselines) {
        await mkdir(dirname(baselinePath), { recursive: true });
        await writeFile(baselinePath, await readFile(screenshotPath));
        visualComparison = { status: "baseline-updated", passed: false, baselinePath, actualPath: screenshotPath };
      } else {
        let baselineExists = true;
        try { await access(baselinePath); } catch { baselineExists = false; }
        if (!baselineExists) {
          visualComparison = { status: "baseline-missing", passed: false, baselinePath, actualPath: screenshotPath };
        } else {
          visualComparison = await comparePngFiles({
            baselinePath,
            actualPath: screenshotPath,
            diffPath: diffDir ? join(diffDir, safeName + ".diff.png") : null,
            threshold: visualThreshold,
            maxDiffPixelRatio
          });
        }
      }
    }
    const visualPassed = !visualComparison ||
      (visualComparison.status === "compared" && visualComparison.passed === true);
    results.push({
      name: viewport.name,
      viewport: { width: viewport.width, height: viewport.height },
      passed: report.scoring.passed && visualPassed,
      score: report.scoring.score,
      findings: report.diagnostics,
      summary: report.summary,
      execution: report.execution,
      evidence: report.evidence,
      screenshotPath,
      visualComparison
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
      blockedRequests: results.reduce((sum, item) => sum + (item.evidence?.blockedRequests ?? 0), 0),
      visualComparisons: results.filter((item) => item.visualComparison?.status === "compared").length,
      baselineMissing: results.filter((item) => item.visualComparison?.status === "baseline-missing").length,
      visualFailures: results.filter((item) => item.visualComparison?.status === "compared" && !item.visualComparison.passed).length,
      baselinesUpdated: results.filter((item) => item.visualComparison?.status === "baseline-updated").length
    }),
    passed: results.every((item) => item.passed),
    viewports: Object.freeze(results)
  });
}

export { DEFAULT_VIEWPORTS };
