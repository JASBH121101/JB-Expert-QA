import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { auditUrl } from "../../src/adapters/playwright/audit-url.js";

const html = \`<!doctype html>
<html>
<head><meta charset="utf-8"><title>JB Expert QA fixture</title></head>
<body style="margin:0">
  <div class="wide-panel" style="width:600px;height:20px">Wide panel</div>
  <p class="tiny-copy" style="font-size:10px">Small text sample</p>
  <button style="width:16px;height:16px;padding:0"></button>
  <div class="large-gap" style="margin-top:220px">Content after test gap</div>
  <img src="/missing-image.png">
  <input id="email" type="email">
</body>
</html>\`;

test("Playwright and axe-core detect page defects with browser evidence", { timeout: 30000 }, async () => {
  const server = createServer((request, response) => {
    if (request.url === "/missing-image.png") {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("missing");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  const url = "http://127.0.0.1:" + address.port + "/";
  const config = {
    profile: "playwright-integration",
    weights: { responsive: 20, "ui-ux": 20, accessibility: 20, performance: 20, functional: 20 },
    severityPenalties: { critical: 25, high: 12, medium: 5, low: 2, info: 0 },
    thresholds: {
      minimumScore: 0,
      failOnCritical: true,
      minimumBodyFontPx: 12,
      largeEmptySpacePx: 160,
      minimumTargetSizePx: 24
    }
  };

  try {
    const report = await auditUrl(url, {
      config,
      viewport: { width: 390, height: 844 },
      timeout: 10000,
      allowPrivateNetworks: true
    });

    const ids = report.diagnostics.map((item) => item.id);
    assert.ok(ids.includes("RESP-001"), "should detect document horizontal overflow");
    assert.ok(ids.some((id) => id.startsWith("UIUX-001")), "should detect small text");
    assert.ok(ids.some((id) => id.startsWith("UIUX-003")), "should detect small interactive target");
    assert.ok(ids.some((id) => id.startsWith("A11Y-001")), "should detect image without alt");
    assert.ok(ids.some((id) => id.startsWith("A11Y-002")), "should detect unlabeled field");
    assert.ok(ids.some((id) => id.startsWith("A11Y-AXE-")), "should include axe-core findings");
    assert.ok(ids.some((id) => id.startsWith("FUNC-003")), "should detect HTTP error");
    assert.ok(report.evidence.axeViolations > 0);
    assert.ok(report.summary.rulesExecuted >= 18);
    assert.equal(report.target.url, url);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
