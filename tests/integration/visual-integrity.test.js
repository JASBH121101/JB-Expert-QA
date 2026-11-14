import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { auditUrl } from "../../src/adapters/playwright/audit-url.js";

const config = {
  profile: "visual-localization",
  weights: { "ui-ux": 100 },
  severityPenalties: { critical: 25, high: 12, medium: 5, low: 2, info: 0 },
  thresholds: { minimumScore: 0, failOnCritical: false, minimumBodyFontPx: 12 }
};

test("localization audit checks visible text and accessibility attributes without translating loanwords", { timeout: 30000 }, async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html lang='es'><head><meta charset='utf-8'><title>Prueba de idioma</title></head><body><main><h1>Catálogo de productos</h1><p>Esta landing page presenta nuestros productos.</p><button>Iniciar sesión</button><button>Sign in</button><img src='/product.png' alt='View details'><input type='submit' value='Save changes'><button aria-label='Delete account'>Eliminar</button></main></body></html>");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const url = "http://127.0.0.1:" + server.address().port + "/";
  try {
    const report = await auditUrl(url, {
      config,
      viewport: { width: 390, height: 844 },
      timeout: 10000,
      runAxe: false,
      allowPrivateNetworks: true,
      targetLanguage: "es"
    });
    const findings = report.diagnostics.filter((item) => item.id.startsWith("UIUX-010-"));
    const matched = findings.map((item) => item.evidence?.text);
    assert.ok(matched.some((value) => value === "Sign in"));
    assert.ok(matched.some((value) => value === "View details"));
    assert.ok(matched.some((value) => value === "Save changes"));
    assert.ok(matched.some((value) => value === "Delete account"));
    assert.equal(matched.some((value) => value?.toLowerCase().includes("landing page")), false);
    assert.equal(report.evidence.localizationAudit.language, "es");
    assert.equal(report.evidence.localizationAudit.status, "checked");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});


test("does not treat an unclamped webkit box with visible overflow as clipped text", { timeout: 30000 }, async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Clipping regression</title></head><body>
      <p id="intentional-overflow" style="display:-webkit-box;width:40px;overflow:visible;white-space:nowrap">This overflow is intentionally visible</p>
      <p id="actual-line-clamp" style="display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:1;overflow:hidden;width:80px;height:18px">This paragraph is intentionally clamped to one line and must be reported</p>
    </body></html>`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const url = "http://127.0.0.1:" + server.address().port + "/";
  try {
    const report = await auditUrl(url, {
      config,
      viewport: { width: 1280, height: 800 },
      timeout: 10000,
      runAxe: false,
      allowPrivateNetworks: true,
      targetLanguage: "en"
    });
    const clipping = report.diagnostics.filter((item) => item.id.startsWith("UIUX-008-"));
    assert.equal(clipping.some((item) => item.location === "#intentional-overflow"), false);
    assert.equal(clipping.some((item) => item.location === "#actual-line-clamp"), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
