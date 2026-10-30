import test from "node:test";
import assert from "node:assert/strict";
import { RuleRegistry, ExpertQAEngine } from "../src/index.js";
import { responsiveRules, uiUxRules } from "../src/specialists/index.js";

const config = {
  profile: "specialist-tests",
  weights: { responsive: 50, "ui-ux": 50 },
  severityPenalties: { critical: 25, high: 12, medium: 5, low: 2, info: 0 },
  thresholds: { minimumScore: 0, failOnCritical: true }
};

test("responsive specialist detects document horizontal overflow", async () => {
  const registry = new RuleRegistry();
  responsiveRules.forEach((rule) => registry.register(rule));
  const report = await new ExpertQAEngine({ registry, config }).audit({
    viewport: { width: 375, height: 812 },
    documentScrollWidth: 420
  }, { specialist: "responsive" });
  assert.equal(report.diagnostics.some((item) => item.id === "RESP-001"), true);
});

test("responsive specialist ignores a document that fits viewport", async () => {
  const registry = new RuleRegistry();
  responsiveRules.forEach((rule) => registry.register(rule));
  const report = await new ExpertQAEngine({ registry, config }).audit({
    viewport: { width: 390, height: 844 },
    documentScrollWidth: 390
  }, { specialist: "responsive" });
  assert.equal(report.summary.findings, 0);
});

test("UI UX specialist detects tiny text and large empty gaps", async () => {
  const registry = new RuleRegistry();
  uiUxRules.forEach((rule) => registry.register(rule));
  const report = await new ExpertQAEngine({ registry, config }).audit({
    textElements: [{ selector: ".caption", fontSize: 10 }],
    verticalGaps: [{ selector: ".product-details-gap", height: 220 }]
  }, { specialist: "ui-ux" });
  assert.equal(report.diagnostics.length, 2);
  assert.equal(report.diagnostics.some((item) => item.id.startsWith("UIUX-001")), true);
  assert.equal(report.diagnostics.some((item) => item.id.startsWith("UIUX-002")), true);
});

test("UI UX specialist ignores intentional whitespace and hidden elements", async () => {
  const registry = new RuleRegistry();
  uiUxRules.forEach((rule) => registry.register(rule));
  const report = await new ExpertQAEngine({ registry, config }).audit({
    verticalGaps: [{ height: 300, containsContent: true }],
    textElements: [{ fontSize: 8, visible: false }]
  }, { specialist: "ui-ux" });
  assert.equal(report.summary.findings, 0);
});
