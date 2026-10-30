import test from "node:test";
import assert from "node:assert/strict";
import { RuleRegistry, ExpertQAEngine } from "../src/index.js";
import {
  accessibilityRules,
  performanceRules,
  functionalRules,
  consistencyRules
} from "../src/specialists/index.js";

const config = {
  profile: "expanded-specialists",
  weights: { accessibility: 25, performance: 25, functional: 25, consistency: 25 },
  severityPenalties: { critical: 25, high: 12, medium: 5, low: 2, info: 0 },
  thresholds: { minimumScore: 0, failOnCritical: true }
};

async function runRules(rules, context) {
  const registry = new RuleRegistry();
  rules.forEach((rule) => registry.register(rule));
  return new ExpertQAEngine({ registry, config }).audit(context);
}

test("accessibility converts axe-core violations into actionable findings", async () => {
  const report = await runRules(accessibilityRules, {
    axeViolations: [{
      id: "color-contrast",
      impact: "serious",
      help: "Elements must have sufficient color contrast",
      description: "Some text does not have enough contrast.",
      helpUrl: "https://example.com/axe/color-contrast",
      nodes: [{ target: [".muted-label"], summary: "Foreground and background colors have insufficient contrast." }]
    }]
  });
  const finding = report.diagnostics.find((item) => item.id === "A11Y-AXE-COLOR-CONTRAST");
  assert.ok(finding);
  assert.equal(finding.severity, "high");
  assert.equal(finding.location, ".muted-label");
});

test("accessibility detects missing image alt and document language", async () => {
  const report = await runRules(accessibilityRules, {
    images: [{ selector: "img.hero", hasAlt: false, visible: true }],
    documentLang: ""
  });
  assert.ok(report.diagnostics.some((item) => item.id.startsWith("A11Y-001")));
  assert.ok(report.diagnostics.some((item) => item.id === "A11Y-003"));
});

test("accessibility detects unlabeled fields and skipped heading levels", async () => {
  const report = await runRules(accessibilityRules, {
    formControls: [{ selector: "#email", labelsText: "", ariaLabel: "", ariaLabelledByText: "" }],
    headings: [{ level: 1 }, { level: 3 }]
  });
  assert.ok(report.diagnostics.some((item) => item.id.startsWith("A11Y-002")));
  assert.ok(report.diagnostics.some((item) => item.id.startsWith("A11Y-004")));
});

test("performance detects large transferred resources and oversized DOM", async () => {
  const report = await runRules(performanceRules, {
    resources: [{ name: "/large.js", transferSize: 800000, durationMs: 300 }],
    domNodeCount: 2000
  });
  assert.ok(report.diagnostics.some((item) => item.id.startsWith("PERF-001")));
  assert.ok(report.diagnostics.some((item) => item.id === "PERF-004"));
});

test("functional detects runtime errors and HTTP failures", async () => {
  const report = await runRules(functionalRules, {
    pageErrors: [{ message: "Uncaught test error" }],
    httpErrors: [{ url: "/missing.js", status: 404, resourceType: "script" }]
  });
  assert.ok(report.diagnostics.some((item) => item.id.startsWith("FUNC-001")));
  assert.ok(report.diagnostics.some((item) => item.id.startsWith("FUNC-003")));
});

test("consistency detects different proportions in repeated cards", async () => {
  const report = await runRules(consistencyRules, {
    cards: [
      { selector: ".product-card:nth-child(1)", imageRatios: [1], buttonHeights: [40] },
      { selector: ".product-card:nth-child(2)", imageRatios: [1.6], buttonHeights: [40] }
    ]
  });
  assert.ok(report.diagnostics.some((item) => item.id === "CONS-001"));
});
