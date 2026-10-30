import test from "node:test";
import assert from "node:assert/strict";
import { formatReport, formatMarkdownReport, formatHtmlReport } from "../src/reporters/index.js";

const report = {
  engine: "JB Expert QA",
  generatedAt: "2026-10-30T19:00:00.000Z",
  target: { url: "https://example.com" },
  summary: { rulesExecuted: 2, rulesWithErrors: 0, findings: 1 },
  scoring: { score: 88, passed: true },
  diagnostics: [{
    id: "UIUX-001-1",
    specialist: "ui-ux",
    severity: "medium",
    title: "Small <label>",
    description: "Text is too small",
    location: ".caption",
    recommendation: "Increase size & review contrast"
  }],
  execution: [{ ruleId: "ui-ux.tiny-text", status: "passed" }]
};

test("markdown reporter includes findings and recommendations", () => {
  const output = formatMarkdownReport(report);
  assert.match(output, /JB Expert QA report/);
  assert.match(output, /Small <label>/);
  assert.match(output, /Increase size & review contrast/);
});

test("html reporter escapes untrusted report strings", () => {
  const output = formatHtmlReport(report);
  assert.match(output, /Small &lt;label&gt;/);
  assert.match(output, /Increase size &amp; review contrast/);
  assert.equal(output.includes("<label>"), false);
});

test("report format dispatcher supports JSON and rejects unknown formats", () => {
  assert.match(formatReport(report, "json"), /"score": 88/);
  assert.throws(() => formatReport(report, "pdf"), /Unsupported report format/);
});
