import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { auditViewports } from "../../src/adapters/playwright/audit-url.js";

test("viewport matrix audits light and dark color schemes independently", { timeout: 60000 }, async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Theme fixture</title>
<style>
:root { --page-surface: #ffffff; --bad-foreground: #888888; color-scheme: light; }
@media (prefers-color-scheme: dark) {
  :root { --page-surface: #121212; --bad-foreground: #333333; color-scheme: dark; }
}
body { margin: 0; background: var(--page-surface); color: var(--bad-foreground); }
:root[data-theme="light"] { --page-surface: #ffffff; --bad-foreground: #888888; }
:root[data-theme="dark"] { --page-surface: #121212; --bad-foreground: #333333; }
p { font-size: 16px; }
#state-toggle { color: #111111; background: #ffffff; }
#state-toggle:hover { color: #888888; }
#state-toggle:focus { color: #999999; }
#state-toggle:active { color: #aaaaaa; }
#theme-menu { color: #888888; background: #ffffff; }
#weak-boundary { border: 1px solid #aaaaaa; }
</style>
<script>
document.documentElement.dataset.theme =
  matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
document.addEventListener("DOMContentLoaded", () => {
  const themeButton = document.querySelector("#theme-toggle");
  const initialDark = document.documentElement.dataset.theme === "dark";
  themeButton.setAttribute("aria-pressed", String(initialDark));
  themeButton.addEventListener("click", () => {
    const nextDark = themeButton.getAttribute("aria-pressed") !== "true";
    document.documentElement.dataset.theme = nextDark ? "dark" : "light";
    themeButton.setAttribute("aria-pressed", String(nextDark));
  });
  const button = document.querySelector("#state-toggle");
  const menu = document.querySelector("#theme-menu");
  button.addEventListener("click", () => {
    const expanded = button.getAttribute("aria-expanded") === "true";
    button.setAttribute("aria-expanded", String(!expanded));
    menu.hidden = expanded;
  });
});
</script>
</head>
<body>
<main>
  <button id="theme-toggle" type="button" aria-pressed="false">Dark mode</button>
  <p id="theme-text">Theme-sensitive text sample</p>
  <button id="state-toggle" type="button" aria-expanded="false" aria-controls="theme-menu">Toggle menu</button>
  <div id="theme-menu" hidden>Menu content</div>
  <input id="weak-boundary" type="text" placeholder="Field placeholder">
  <button id="disabled-control" type="button" disabled>Disabled action</button>
  <button id="icon-control" type="button" aria-label="Icon action">
    <svg viewBox="0 0 16 16" width="16" height="16">
      <path d="M2 2h12v12H2z" fill="#aaaaaa"></path>
    </svg>
  </button>
</main>
</body>
</html>`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const url = "http://127.0.0.1:" + server.address().port + "/";
  const config = {
    profile: "theme-audit-test",
    weights: { "ui-ux": 100 },
    severityPenalties: { critical: 25, high: 12, medium: 5, low: 2, info: 0 },
    thresholds: { minimumScore: 0, failOnCritical: false }
  };

  try {
    const report = await auditViewports(url, {
      config,
      viewports: [{ name: "mobile", width: 390, height: 844 }],
      themes: ["light", "dark"],
      themeAttribute: "data-theme",
      themeStorageKey: "theme-mode",
      timeout: 10000,
      allowPrivateNetworks: true,
      runAxe: false,
      interactionExploration: true
    });

    assert.equal(report.summary.viewportsChecked, 2);
    assert.equal(report.summary.themesChecked, 2);
    assert.deepEqual(report.viewports.map((item) => item.theme), ["light", "dark"]);
    for (const viewport of report.viewports) {
      assert.equal(viewport.evidence.themeAudit.requestedColorScheme, viewport.theme);
      assert.equal(viewport.evidence.themeAudit.appliedThemeAttribute, "data-theme");
      assert.equal(viewport.evidence.themeAudit.storageKeySeeded, true);
      assert.equal(viewport.evidence.themeTransitionAudit.enabled, true);
      assert.deepEqual(viewport.evidence.themeTransitionAudit.sequence, [
        viewport.theme,
        viewport.theme === "dark" ? "light" : "dark",
        viewport.theme
      ]);
      assert.equal(viewport.evidence.themeTransitionAudit.restoredStable, true);
      assert.ok(viewport.evidence.themeAudit.hardcodedColorDeclarationCount >= 0);
      assert.ok(viewport.evidence.contrastSummary.measured >= 1);
      assert.ok(viewport.evidence.contrastSummary.exempt >= 1);
      assert.ok(viewport.evidence.themeAudit.colorTokens.some((token) =>
        token.name === "--page-surface"));
    }
    assert.equal(report.summary.themePairsCompared, 1);
    assert.ok(report.viewports[0].themeTokenComparison.changedTokens.some((token) =>
      token.name === "--page-surface"));
    assert.ok(report.viewports[0].findings.some((item) =>
      item.id.startsWith("UIUX-005-")));
    assert.ok(report.viewports[0].findings.some((item) =>
      item.evidence?.kind === "component-boundary"));
    assert.ok(report.viewports[0].findings.some((item) =>
      item.evidence?.kind === "non-text-graphic"));
    assert.ok(report.viewports[1].findings.some((item) =>
      item.id.startsWith("UIUX-005-")));
    for (const themeResult of report.viewports) {
      const states = themeResult.findings
        .filter((item) => item.location === "#state-toggle")
        .map((item) => item.evidence?.interactionState);
      assert.ok(states.includes("hover"));
      assert.ok(states.includes("focus") || states.includes("focus-visible"));
      assert.ok(states.includes("active"));
      assert.equal(themeResult.evidence.interactionStatesChecked, 2);
      const themeToggleState = themeResult.evidence.interactionExploration.states.find((state) =>
        state.kind === "theme-toggle");
      assert.ok(themeToggleState);
      assert.equal(
        themeToggleState.themeMarker,
        themeResult.theme === "dark" ? "light" : "dark"
      );
      assert.equal(themeToggleState.themeToggleEffect.status, "changed");
      assert.equal(themeToggleState.themeToggleEffect.themeMarkerChanged, true);
      assert.ok(themeToggleState.themeToggleEffect.changedTokens.some((token) =>
        token.name === "--page-surface"));
      assert.ok(themeResult.evidence.contrastSummary.samples > 0);
    }
    assert.equal(report.viewports.some((item) =>
      item.findings.some((finding) => finding.id === "UIUX-006")), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
