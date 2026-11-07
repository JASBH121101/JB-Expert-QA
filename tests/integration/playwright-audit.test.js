import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { auditUrl } from "../../src/adapters/playwright/audit-url.js";

const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>JB Expert QA fixture</title></head>
<body style="margin:0">
  <div class="wide-panel" style="width:600px;height:20px">Wide panel</div>
  <p class="tiny-copy" style="font-size:10px">Small text sample</p>
  <button style="width:16px;height:16px;padding:0"></button>
  <div id="overlap-fixture" style="position:relative;width:320px;height:64px">
    <button id="overlap-a" style="position:absolute;left:0;top:0;width:110px;height:44px;padding:0;margin:0;border:0;box-sizing:border-box;z-index:1">A</button>
    <button id="overlap-b" style="position:absolute;left:60px;top:0;width:110px;height:44px;padding:0;margin:0;border:0;box-sizing:border-box;z-index:2">B</button>
    <button id="separate-button" style="position:absolute;left:190px;top:0;width:110px;height:44px;padding:0;margin:0;border:0;box-sizing:border-box">C</button>
  </div>
  <div class="large-gap" style="margin-top:220px">Content after test gap</div>
  <img src="/missing-image.png">
  <input id="email" type="email">
</body>
</html>`;

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
  const screenshotRoot = await mkdtemp(path.join(os.tmpdir(), "jb-qa-annotated-"));
  const screenshotPath = path.join(screenshotRoot, "initial.png");
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
      allowPrivateNetworks: true,
      screenshotPath
    });

    const ids = report.diagnostics.map((item) => item.id);
    assert.ok(ids.includes("RESP-001"), "should detect document horizontal overflow");
    assert.ok(ids.some((id) => id.startsWith("UIUX-001")), "should detect small text");
    assert.ok(ids.some((id) => id.startsWith("UIUX-003")), "should detect small interactive target");
    const overlapFinding = report.diagnostics.find((item) =>
      item.id.startsWith("UIUX-004-") && item.evidence?.selectorA === "#overlap-a");
    assert.ok(overlapFinding, "should detect overlapping buttons");
    assert.equal(overlapFinding.severity, "high", "should flag the button hidden behind the top layer");
    assert.equal(overlapFinding.evidence.blockedSelector, "#overlap-a");
    assert.equal(overlapFinding.evidence.blockingSelector, "#overlap-b");
    assert.ok(overlapFinding.evidence.overlapPercentOfSmallerTarget >= 40);
    assert.equal(report.diagnostics.some((item) =>
      item.id.startsWith("UIUX-004-") && item.location?.includes("#separate-button")), false,
    "should not flag the separate button");
    assert.ok(ids.some((id) => id.startsWith("A11Y-001")), "should detect image without alt");
    assert.ok(ids.some((id) => id.startsWith("A11Y-002")), "should detect unlabeled field");
    assert.ok(ids.some((id) => id.startsWith("A11Y-AXE-")), "should include axe-core findings");
    assert.ok(ids.some((id) => id.startsWith("FUNC-003")), "should detect HTTP error");
    assert.ok(report.evidence.axeViolations > 0);
    assert.ok(report.evidence.diagnosticScreenshotPath, "should produce a separate annotated screenshot");
    assert.ok(report.evidence.diagnosticMarkers > 0, "should mark the overlapping and overflowing controls");
    await access(screenshotPath);
    await access(report.evidence.diagnosticScreenshotPath);
    assert.ok(report.summary.rulesExecuted >= 18);
    assert.equal(report.target.url, url);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(screenshotRoot, { recursive: true, force: true });
  }
});


test("browser audit redacts secrets from target and resource URLs", { timeout: 30000 }, async () => {
  const targetSecret = "target-secret-value";
  const resourceSecret = "resource-secret-value";
  const server = createServer((request, response) => {
    if (request.url.startsWith("/asset.js?")) {
      response.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
      response.end("window.auditAssetLoaded = true;" + " ".repeat(5000));
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      "<!doctype html><html lang='en'><head><title>URL redaction fixture</title>" +
      "<script src='/asset.js?api_key=" + resourceSecret + "'></script>" +
      "</head><body><main><h1>Audit</h1></main></body></html>"
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const url = "http://127.0.0.1:" + address.port + "/?access_token=" + targetSecret;
  const config = {
    profile: "redaction-integration",
    weights: { responsive: 1, "ui-ux": 1, accessibility: 1, performance: 1, functional: 1, consistency: 1 },
    thresholds: { minimumScore: 0, failOnCritical: false, largeResourceBytes: 1 }
  };
  try {
    const report = await auditUrl(url, {
      config,
      viewport: { width: 390, height: 844 },
      timeout: 10000,
      runAxe: false,
      allowPrivateNetworks: true
    });
    const serialized = JSON.stringify(report);
    assert.equal(new URL(report.target.url).searchParams.get("access_token"), "[REDACTED]");
    assert.equal(serialized.includes(targetSecret), false);
    assert.equal(serialized.includes(resourceSecret), false);
    assert.ok(report.diagnostics.some((item) => item.id.startsWith("PERF-001")));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("same-origin-only browser audits block all third-party HTTP requests", { timeout: 30000 }, async () => {
  let externalRequests = 0;
  const externalServer = createServer((_request, response) => {
    externalRequests += 1;
    response.writeHead(200, { "content-type": "image/svg+xml" });
    response.end("<svg xmlns='http://www.w3.org/2000/svg' width='2' height='2'></svg>");
  });
  await new Promise((resolve, reject) => {
    externalServer.once("error", reject);
    externalServer.listen(0, "127.0.0.1", resolve);
  });

  const externalUrl = "http://127.0.0.1:" + externalServer.address().port + "/pixel.svg";
  const mainServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html lang='en'><head><title>Isolated audit</title></head><body><h1>Local preview</h1><img src='" + externalUrl + "' alt='pixel'></body></html>");
  });
  await new Promise((resolve, reject) => {
    mainServer.once("error", reject);
    mainServer.listen(0, "127.0.0.1", resolve);
  });

  const url = "http://127.0.0.1:" + mainServer.address().port + "/";
  try {
    const report = await auditUrl(url, {
      config: {
        profile: "same-origin-isolation",
        weights: { responsive: 50, "ui-ux": 50 },
        thresholds: { minimumScore: 0, failOnCritical: true }
      },
      viewport: { width: 390, height: 844 },
      timeout: 10000,
      runAxe: false,
      allowPrivateNetworks: true,
      sameOriginOnly: true
    });
    assert.equal(report.evidence.sameOriginOnly, true);
    assert.ok(report.evidence.blockedRequests >= 1);
    assert.equal(externalRequests, 0, "third-party server must receive no browser request");
  } finally {
    await new Promise((resolve) => mainServer.close(resolve));
    await new Promise((resolve) => externalServer.close(resolve));
  }
});
