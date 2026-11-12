import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { auditViewports } from "../../src/adapters/playwright/audit-url.js";

test("interactive state screenshots receive independent baselines and local diffs", { timeout: 60000 }, async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Interaction baseline fixture</title>
<style>
body { margin: 0; padding: 24px; color: #111111; background: #ffffff; font: 16px sans-serif; }
button { min-width: 120px; min-height: 48px; color: #111111; background: #eeeeee; border: 1px solid #555555; }
#panel { margin-top: 16px; padding: 16px; color: #111111; background: #eeeeee; }
</style>
</head>
<body>
<main>
  <button id="menu-trigger" type="button" aria-expanded="false" aria-controls="menu-panel">Open menu</button>
  <section id="menu-panel" hidden>Menu content</section>
</main>
<script>
const trigger = document.querySelector("#menu-trigger");
const panel = document.querySelector("#menu-panel");
trigger.addEventListener("click", () => {
  const open = trigger.getAttribute("aria-expanded") !== "true";
  trigger.setAttribute("aria-expanded", String(open));
  panel.hidden = !open;
});
</script>
</body>
</html>`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const root = await mkdtemp(join(tmpdir(), "jbqa-interaction-baselines-"));
  const screenshotDir = join(root, "captures");
  const baselineDir = join(root, "baselines");
  const diffDir = join(root, "diffs");
  const url = "http://127.0.0.1:" + server.address().port + "/";
  const config = {
    profile: "interaction-baseline-test",
    weights: { "ui-ux": 100 },
    severityPenalties: { critical: 25, high: 12, medium: 5, low: 2, info: 0 },
    thresholds: { minimumScore: 0, failOnCritical: false }
  };
  const common = {
    config,
    viewports: [{ name: "mobile", width: 390, height: 844 }],
    themes: ["light"],
    screenshotDir,
    baselineDir,
    interactionExploration: true,
    timeout: 10000,
    allowPrivateNetworks: true,
    runAxe: false
  };

  try {
    const updated = await auditViewports(url, {
      ...common,
      updateBaselines: true
    });
    assert.equal(updated.viewports[0].visualComparison.status, "baseline-updated");
    const updatedState = updated.viewports[0].evidence.interactionExploration.states[0];
    assert.equal(updatedState.visualComparison.status, "baseline-updated");
    assert.equal(updated.summary.interactionBaselinesUpdated, 1);
    assert.equal(updated.passed, false);

    const compared = await auditViewports(url, {
      ...common,
      diffDir
    });
    assert.equal(compared.viewports[0].visualComparison.status, "compared");
    assert.equal(compared.viewports[0].visualComparison.passed, true);
    const comparedState = compared.viewports[0].evidence.interactionExploration.states[0];
    assert.equal(comparedState.visualComparison.status, "compared");
    assert.equal(comparedState.visualComparison.passed, true);
    assert.equal(compared.summary.interactionVisualComparisons, 1);
    assert.equal(compared.summary.interactionVisualFailures, 0);
    assert.equal(compared.passed, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
