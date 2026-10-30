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
