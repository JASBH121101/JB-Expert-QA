import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { auditUrl } from "../../src/adapters/playwright/audit-url.js";

const config = {
  profile: "rtl-localization",
  weights: { "ui-ux": 100 },
  severityPenalties: { critical: 25, high: 12, medium: 5, low: 2, info: 0 },
  thresholds: { minimumScore: 0, failOnCritical: false, minimumBodyFontPx: 12 }
};

async function withServer(html, run) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    return await run("http://127.0.0.1:" + server.address().port + "/");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("visual localization audit recognizes Arabic text and detects an LTR document direction", { timeout: 30000 }, async () => {
  const html = "<!doctype html><html lang='ar' dir='ltr'><head><meta charset='utf-8'><title>متجر</title></head><body><main><h1>متجر المنتجات</h1><button>تسجيل الدخول</button><button>Sign in</button></main></body></html>";
  const report = await withServer(html, url => auditUrl(url, {
    config, viewport: { width: 390, height: 844 }, timeout: 10000,
    runAxe: false, allowPrivateNetworks: true, targetLanguage: "ar"
  }));
  const audit = report.evidence.localizationAudit;
  assert.equal(audit.language, "ar");
  assert.deepEqual(audit.supportedLanguages, ["es", "en", "ar"]);
  assert.equal(audit.directionAudit.expected, "rtl");
  assert.equal(audit.directionAudit.computed, "ltr");
  assert.equal(audit.directionAudit.status, "review-required");
  assert.ok(audit.findings.some(item => item.detectedLanguage === "en" && item.marker === "sign in"));
  assert.ok(report.diagnostics.some(item => item.id === "UIUX-013"));
});

test("visual localization audit accepts RTL direction for Arabic pages", { timeout: 30000 }, async () => {
  const html = "<!doctype html><html lang='ar' dir='rtl'><head><meta charset='utf-8'><title>متجر</title></head><body><main><h1>متجر المنتجات</h1><button>تسجيل الدخول</button></main></body></html>";
  const report = await withServer(html, url => auditUrl(url, {
    config, viewport: { width: 390, height: 844 }, timeout: 10000,
    runAxe: false, allowPrivateNetworks: true
  }));
  assert.equal(report.evidence.localizationAudit.directionAudit.status, "passed");
  assert.equal(report.diagnostics.some(item => item.id === "UIUX-013"), false);
});
