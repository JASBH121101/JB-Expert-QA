import { chromium } from "playwright";
import { ExpertQAEngine, RuleRegistry } from "../../index.js";
import { responsiveRules, uiUxRules } from "../../specialists/index.js";
import { collectPageContext } from "./context.js";
import defaultConfig from "../../../config/default.config.json" with { type: "json" };

export async function auditUrl(url, {
  config = defaultConfig,
  viewport = { width: 1365, height: 900 },
  specialist,
  timeout = 30000,
  headless = true
} = {}) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new TypeError("Only http and https URLs are supported");
  }

  const browser = await chromium.launch({ headless });
  try {
    const page = await browser.newPage({ viewport });
    await page.goto(parsed.href, { waitUntil: "domcontentloaded", timeout });
    await page.waitForLoadState("networkidle", { timeout: Math.min(timeout, 5000) }).catch(() => {});
    const context = await collectPageContext(page, {
      thresholds: config.thresholds ?? {}
    });

    const registry = new RuleRegistry();
    [...responsiveRules, ...uiUxRules].forEach((rule) => registry.register(rule));
    const engine = new ExpertQAEngine({ registry, config });
    const report = await engine.audit(context, { specialist });
    return {
      ...report,
      target: { url: parsed.href, viewport, pageTitle: context.title },
      evidence: {
        documentScrollWidth: context.documentScrollWidth,
        documentScrollHeight: context.documentScrollHeight
      }
    };
  } finally {
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
  ...options
} = {}) {
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
    if (seen.has(viewport.name)) {
      throw new Error(`Duplicate viewport name: ${viewport.name}`);
    }
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
      execution: report.execution
    });
  }

  return Object.freeze({
    engine: "JB Expert QA",
    version: "0.2.0",
    generatedAt: new Date().toISOString(),
    target: { url: new URL(url).href },
    summary: Object.freeze({
      viewportsChecked: results.length,
      passedViewports: results.filter((item) => item.passed).length,
      failedViewports: results.filter((item) => !item.passed).length,
      totalFindings: results.reduce((sum, item) => sum + item.findings.length, 0)
    }),
    passed: results.every((item) => item.passed),
    viewports: Object.freeze(results)
  });
}

export { DEFAULT_VIEWPORTS };
