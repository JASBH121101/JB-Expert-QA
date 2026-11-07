import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { auditUrl } from "../../src/adapters/playwright/audit-url.js";

test("CSS coverage reports unmatched selectors but skips interactive and inactive media states", { timeout: 30000 }, async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
<html lang="en">
<head>
  <title>CSS coverage fixture</title>
  <style>
    .visible-card { color: rgb(1, 2, 3); }
    .never-mounted-widget { display: block; }
    .hover-only:hover { outline: 1px solid red; }
    @media print { .print-only { display: block; } }
    @media screen and (min-width: 320px) { .screen-unused { display: block; } }
  </style>
</head>
<body><main><article class="visible-card">Visible</article></main></body>
</html>`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const url = "http://127.0.0.1:" + server.address().port + "/";
  try {
    const report = await auditUrl(url, {
      config: {
        profile: "css-selector-coverage-test",
        weights: { "ui-ux": 100 },
        severityPenalties: { critical: 25, high: 12, medium: 5, low: 2, info: 0 },
        thresholds: { minimumScore: 0, failOnCritical: false }
      },
      viewport: { width: 390, height: 844 },
      timeout: 10000,
      runAxe: false,
      allowPrivateNetworks: true,
      sameOriginOnly: true
    });

    const candidates = report.diagnostics.filter((item) => item.metadata?.detector === "runtime-css-selector-coverage");
    assert.ok(candidates.some((item) => item.location === ".never-mounted-widget"));
    assert.ok(candidates.some((item) => item.location === ".screen-unused"));
    assert.equal(candidates.some((item) => item.location === ".visible-card"), false);
    assert.equal(candidates.some((item) => item.location === ".hover-only:hover"), false);
    assert.equal(candidates.some((item) => item.location === ".print-only"), false);
    assert.ok(candidates.every((item) => item.metadata.safeToDeleteAutomatically === false));
    assert.equal(report.evidence.cssSelectorCoverage.stylesheetsScanned, 1);
    assert.equal(report.evidence.cssSelectorCoverage.unmatchedSelectors, 2);
    assert.equal(report.evidence.cssSelectorCoverage.complete, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
