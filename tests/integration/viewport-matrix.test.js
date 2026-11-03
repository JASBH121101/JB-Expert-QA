import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { auditViewports } from "../../src/adapters/playwright/audit-url.js";

test("multi-viewport audit identifies a defect only at mobile width", { timeout: 30000 }, async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
<html lang="en">
<head>
  <title>Viewport fixture</title>
  <style>
    #toolbar { display: flex; gap: 12px; }
    #toolbar button { width: 110px; height: 44px; box-sizing: border-box; }
    @media (max-width: 480px) {
      #toolbar { position: relative; height: 48px; display: block; }
      #overlap-a { position: absolute; left: 0; top: 0; z-index: 1; }
      #overlap-b { position: absolute; left: 60px; top: 0; z-index: 2; }
    }
  </style>
</head>
<body>
  <div style="width:600px;height:20px">fixed width</div>
  <div id="toolbar">
    <button id="overlap-a" type="button">Save</button>
    <button id="overlap-b" type="button">Cancel</button>
  </div>
</body>
</html>`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const url = "http://127.0.0.1:" + server.address().port + "/";
  const config = {
    profile: "viewport-matrix-test",
    weights: { responsive: 50, "ui-ux": 50 },
    severityPenalties: { critical: 25, high: 12, medium: 5, low: 2, info: 0 },
    thresholds: { minimumScore: 80, failOnCritical: true }
  };

  try {
    const report = await auditViewports(url, {
      config,
      viewports: [
        { name: "mobile", width: 390, height: 844 },
        { name: "desktop", width: 1365, height: 900 }
      ],
      timeout: 10000,
      allowPrivateNetworks: true
    });
    const mobile = report.viewports.find((item) => item.name === "mobile");
    const desktop = report.viewports.find((item) => item.name === "desktop");
    assert.ok(mobile.findings.some((item) => item.id === "RESP-001"));
    assert.ok(mobile.findings.some((item) => item.id.startsWith("UIUX-004-")),
      "should detect overlapping controls at mobile width");
    assert.equal(desktop.findings.some((item) => item.id.startsWith("UIUX-004-")), false,
      "should not report the same controls as overlapping at desktop width");
    assert.equal(desktop.findings.some((item) => item.id === "RESP-001"), false);
    assert.equal(report.version, "0.6.0");
    assert.equal(report.summary.viewportsChecked, 2);
    assert.equal(report.summary.failedViewports, 0);
    assert.equal(report.summary.blockedRequests, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
