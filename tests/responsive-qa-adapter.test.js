import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_VIEWPORTS, FULL_VIEWPORTS } from "../src/adapters/playwright/audit-url.js";
import {
  createResponsiveQaAdapter,
  RESPONSIVE_QA_LIMITS,
  runResponsiveQa
} from "../src/adapters/responsive/index.js";

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
  await assert.rejects(
    runResponsiveQa({ url: "https://example.test" }, { viewports: Array(10).fill(DEFAULT_VIEWPORTS[0]) }),
    /1 to 9 viewports/
  );
  await assert.rejects(
    runResponsiveQa({ url: "https://example.test" }, { themes: ["light", "light"] }),
    /without duplicates/
  );
  await assert.rejects(
    runResponsiveQa({ url: "https://example.test" }, { themes: ["light", "dark", "light"] }),
    /without duplicates/
  );
  await assert.rejects(
    runResponsiveQa({ url: "https://example.test" }, { maxInteractionActions: 9 }),
    /between 1 and 8/
  );
  assert.throws(() => createResponsiveQaAdapter({ audit: true }), /must be a function/);
});

test("responsive adapter delegates to canonical audit with safe defaults and bounds report output", async () => {
  let received;
  const adapter = createResponsiveQaAdapter({
    audit: async (url, options) => {
      received = { url, options };
      return {
        passed: true,
        summary: { viewportsChecked: 18 },
        themeComparisons: Array.from({ length: 12 }, (_, i) => ({ index: i })),
        viewports: Array.from({ length: 22 }, (_, i) => ({
          name: "viewport-" + i,
          theme: "light",
          viewport: { width: 390, height: 844 },
          passed: true,
          findings: Array.from({ length: 30 }, (_, j) => ({ id: j })),
          screenshotPath: "/tmp/viewport-" + i + ".png",
          evidence: { intentionallyOmitted: true }
        }))
      };
    }
  });

  const result = await adapter({ url: "https://example.test" });
  assert.equal(received.url, "https://example.test");
  assert.deepEqual(received.options.viewports, DEFAULT_VIEWPORTS);
  assert.deepEqual(received.options.themes, ["light"]);
  assert.equal(received.options.updateBaselines, false);
  assert.equal(received.options.screenshotFullPage, false);
  assert.equal(received.options.interactionExploration, false);
  assert.equal(received.options.maxInteractionActions, 8);
  assert.equal(result.engine, "responsive");
  assert.equal(result.passed, true);
  assert.equal(result.viewports.length, 18);
  assert.equal(result.themeComparisons.length, 9);
  assert.equal(result.viewports[0].findings.length, 25);
  assert.equal(result.viewports[0].findingsTruncated, true);
  assert.equal("evidence" in result.viewports[0], false);
  assert.ok(Object.isFrozen(result.viewports));
});

test("responsive adapter preserves explicit baseline opt-in but never enables it implicitly", async () => {
  let seen;
  const adapter = createResponsiveQaAdapter({
    audit: async (_url, options) => {
      seen = options;
      return { passed: true, viewports: [] };
    }
  });
  await adapter({ url: "https://example.test" }, { updateBaselines: true, screenshotFullPage: true });
  assert.equal(seen.updateBaselines, true);
  assert.equal(seen.screenshotFullPage, true);
});
