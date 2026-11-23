import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_VIEWPORTS, FULL_VIEWPORTS } from "../src/adapters/playwright/audit-url.js";
import { runResponsiveQa, RESPONSIVE_QA_LIMITS } from "../src/adapters/responsive/index.js";

test("responsive adapter preserves canonical default and full viewport matrices", () => {
  assert.equal(DEFAULT_VIEWPORTS.length, 3);
  assert.deepEqual(DEFAULT_VIEWPORTS.map((v) => v.name), ["mobile", "tablet", "desktop"]);
  assert.equal(FULL_VIEWPORTS.length, 9);
  assert.deepEqual(FULL_VIEWPORTS.map((v) => v.name), [
    "small-phone", "phone", "mobile", "large-phone", "tablet",
    "small-laptop", "laptop", "desktop", "wide-monitor"
  ]);
  assert.equal(RESPONSIVE_QA_LIMITS.maxResults, 18);
});

test("responsive adapter rejects invalid targets and matrices before browser execution", async () => {
  await assert.rejects(runResponsiveQa({}, {}), /target.url/);
  await assert.rejects(runResponsiveQa({ url: "https://example.test" }, { viewports: [] }), /1 to 9 viewports/);
  await assert.rejects(runResponsiveQa({ url: "https://example.test" }, { viewports: Array(10).fill(DEFAULT_VIEWPORTS[0]) }), /1 to 9 viewports/);
  await assert.rejects(runResponsiveQa({ url: "https://example.test" }, { themes: ["light", "light"] }), /without duplicates/);
  await assert.rejects(runResponsiveQa({ url: "https://example.test" }, { themes: ["light", "dark", "light"] }), /without duplicates/);\n  await assert.rejects(runResponsiveQa({ url: "https://example.test" }, { maxInteractionActions: 9 }), /between 1 and 8/);
});

test("responsive adapter defaults baseline updates and full-page captures off", () => {
  // Defaults are enforced at the adapter boundary; no call is made to a live site.
  assert.equal(RESPONSIVE_QA_LIMITS.maxViewports, 9);
  assert.equal(RESPONSIVE_QA_LIMITS.maxThemes, 2);
  assert.equal(RESPONSIVE_QA_LIMITS.maxFindingsPerViewport, 25);
});
