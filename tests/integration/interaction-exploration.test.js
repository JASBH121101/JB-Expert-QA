import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { auditUrl } from "../../src/adapters/playwright/audit-url.js";

function startServer(handler) {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("interactive exploration opens a closed sidebar and detects its overlapping controls", { timeout: 30000 }, async () => {
  const server = await startServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
<html lang="en">
<head>
  <title>Closed sidebar fixture</title>
  <style>
    #sidebar { display: none; position: fixed; inset: 0 auto auto 0; width: 260px; height: 220px; z-index: 20; background: white; }
    #sidebar.open { display: block; }
    #sidebar button { position: absolute; top: 20px; left: 12px; width: 150px; height: 48px; }
    #menu-b { left: 55px !important; top: 20px; z-index: 2; }
    #menu-a { z-index: 1; }
  </style>
</head>
<body>
  <button id="sidebar-toggle" type="button" aria-label="Open sidebar menu" aria-expanded="false" aria-controls="sidebar">☰</button>
  <button id="save-button" type="button">Save changes</button>
  <aside id="sidebar" hidden>
    <button id="menu-a" type="button">First navigation item</button>
    <button id="menu-b" type="button">Second navigation item</button>
  </aside>
  <script>
    const toggle = document.getElementById("sidebar-toggle");
    const sidebar = document.getElementById("sidebar");
    toggle.addEventListener("click", () => {
      sidebar.hidden = false;
      sidebar.classList.add("open");
      toggle.setAttribute("aria-expanded", "true");
    });
  </script>
</body>
</html>`);
  });

  const url = "http://127.0.0.1:" + server.address().port + "/";
  try {
    const report = await auditUrl(url, {
      config: {
        profile: "interaction-exploration-test",
        weights: { "ui-ux": 100 },
        severityPenalties: { critical: 25, high: 12, medium: 5, low: 2, info: 0 },
        thresholds: { minimumScore: 0, failOnCritical: true }
      },
      viewport: { width: 390, height: 844 },
      timeout: 10000,
      runAxe: false,
      allowPrivateNetworks: true,
      sameOriginOnly: true,
      interactionExploration: true,
      maxInteractionActions: 8
    });

    const overlap = report.diagnostics.find((item) =>
      item.id.startsWith("UIUX-004-") &&
      item.evidence?.state?.startsWith("interaction-") &&
      [item.evidence.selectorA, item.evidence.selectorB].includes("#menu-a") &&
      [item.evidence.selectorA, item.evidence.selectorB].includes("#menu-b")
    );

    assert.ok(overlap, "should detect the collision that only exists after opening the sidebar");
    assert.equal(overlap.evidence.triggerSelector, "#sidebar-toggle");
    assert.equal(overlap.evidence.blockedSelector, "#menu-a");
    assert.equal(report.evidence.interactionStatesChecked, 1);
    assert.equal(report.evidence.interactionActionsAttempted, 1);
    assert.equal(report.evidence.interactionExploration.enabled, true);
    assert.equal(report.evidence.interactionExploration.states[0].overlapCount > 0, true);
    assert.equal(report.evidence.interactionExploration.skipped.length, 0);
    assert.equal(report.target.pageTitle, "Closed sidebar fixture");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("interaction exploration does not click destructive or submit actions", { timeout: 30000 }, async () => {
  let destructiveClicks = 0;
  const server = await startServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
<html lang="en">
<head><title>Safe interaction fixture</title></head>
<body>
  <button id="menu-toggle" type="button" aria-expanded="false" aria-controls="menu">Open menu</button>
  <nav id="menu" hidden><a href="#home">Home</a></nav>
  <button id="delete-record" type="button" onclick="window.deleted = true">Delete record</button>
  <form><button id="submit-form" type="submit">Submit form</button></form>
  <script>
    document.getElementById("menu-toggle").addEventListener("click", () => {
      document.getElementById("menu").hidden = false;
    });
    document.getElementById("delete-record").addEventListener("click", () => {
      document.body.dataset.deleted = "true";
    });
  </script>
</body>
</html>`);
  });
  const url = "http://127.0.0.1:" + server.address().port + "/";
  try {
    const report = await auditUrl(url, {
      config: { profile: "safe-interaction-test", weights: { "ui-ux": 100 }, thresholds: { minimumScore: 0 } },
      viewport: { width: 390, height: 844 },
      timeout: 10000,
      runAxe: false,
      allowPrivateNetworks: true,
      interactionExploration: true
    });
    assert.equal(report.evidence.interactionExploration.candidatesDiscovered, 1);
    assert.equal(report.evidence.interactionExploration.actionsAttempted, 1);
    assert.equal(destructiveClicks, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
