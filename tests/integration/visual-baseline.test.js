import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { auditViewports } from "../../src/adapters/playwright/audit-url.js";

test("viewport visual baselines are required, explicit to update, and compared locally", { timeout: 60000 }, async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html lang=\"en\"><head><title>Visual fixture</title><style>body{font:18px sans-serif;margin:20px}</style></head><body><main><h1>Visual fixture</h1><p>Stable deterministic screenshot.</p></main></body></html>");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const root = await mkdtemp(join(tmpdir(), "jbqa-baseline-"));
  const screenshotDir = join(root, "captures");
  const baselineDir = join(root, "baselines");
  const diffDir = join(root, "diffs");
  const url = "http://127.0.0.1:" + server.address().port + "/";
  const config = {
    profile: "visual-baseline-test",
    weights: { responsive: 100 },
    severityPenalties: { critical: 25, high: 12, medium: 5, low: 2, info: 0 },
    thresholds: { minimumScore: 0, failOnCritical: false }
  };
  const viewports = [{ name: "desktop", width: 900, height: 700 }];

  try {
    const missing = await auditViewports(url, {
      config, viewports, screenshotDir, baselineDir, diffDir,
      timeout: 10000, allowPrivateNetworks: true
    });
    assert.equal(missing.summary.baselineMissing, 1);
    assert.equal(missing.viewports[0].visualComparison.status, "baseline-missing");
    assert.equal(missing.passed, false);

    const updated = await auditViewports(url, {
      config, viewports, screenshotDir, baselineDir,
      updateBaselines: true,
      timeout: 10000, allowPrivateNetworks: true
    });
    assert.equal(updated.summary.baselinesUpdated, 1);
    assert.equal(updated.viewports[0].visualComparison.status, "baseline-updated");
    assert.equal(updated.passed, false);

    const compared = await auditViewports(url, {
      config, viewports, screenshotDir, baselineDir, diffDir,
      timeout: 10000, allowPrivateNetworks: true
    });
    assert.equal(compared.summary.visualComparisons, 1);
    assert.equal(compared.summary.visualFailures, 0);
    assert.equal(compared.viewports[0].visualComparison.status, "compared");
    assert.equal(compared.viewports[0].visualComparison.passed, true);
    assert.equal(compared.passed, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
