import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { auditProject } from "../src/adapters/filesystem/audit-project.js";
import {
  reverifyProject,
  reverifySecurityProject
} from "../src/adapters/filesystem/reverify-project.js";

async function fixture(t, source) {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-reverify-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "tests"), { recursive: true });
  await writeFile(path.join(root, "tests", "fixture.test.js"), "");
  await writeFile(path.join(root, "src", "app.js"), source);
  return root;
}

test("project re-verification reruns only prior finding rules and reports resolved findings", async (t) => {
  const root = await fixture(t, "export function run(input) { return eval(input); }\n");
  const previous = await auditProject(root);
  assert.ok(previous.diagnostics.some((item) => item.ruleId === "security.dynamic-code"));

  await writeFile(path.join(root, "src", "app.js"),
    "export function run(input) { return String(input); }\n");

  const result = await reverifyProject(root, { previousReport: previous });
  assert.equal(result.status, "partial");
  assert.equal(result.scope, "targeted-only");
  assert.equal(result.fullAuditRequired, true);
  assert.ok(result.selection.ruleIds.includes("security.dynamic-code"));
  assert.ok(result.selection.rulesExecuted < previous.summary.rulesExecuted);
  assert.ok(result.summary.resolved >= 1);
  assert.equal(result.summary.newFindings, 0);
  assert.equal(result.comparison.scope.type, "targeted-rules");
});

test("security re-verification keeps the targeted security profile and resolves a removed finding", async (t) => {
  const root = await fixture(t, "export function run(input) { return eval(input); }\n");
  const { auditSecurityProject } = await import("../src/adapters/filesystem/audit-security-project.js");
  const previous = await auditSecurityProject(root);
  assert.ok(previous.diagnostics.some((item) => item.ruleId === "security.dynamic-code"));

  await writeFile(path.join(root, "src", "app.js"),
    "export function run(input) { return String(input); }\n");

  const result = await reverifySecurityProject(root, { previousReport: previous });
  assert.equal(result.profile, "security");
  assert.ok(result.selection.ruleIds.includes("security.dynamic-code"));
  assert.ok(result.summary.resolved >= 1);
  assert.equal(result.summary.currentExecutionErrors, 0);
  assert.equal(result.currentReport.securityAssessment.astAnalysis.status, "not-run");
  assert.equal(result.currentReport.securityAssessment.astAnalysis.complete, false);
  assert.equal(result.currentReport.securityAssessment.complete, false);
});

test("re-verification returns not-needed when the previous report has no findings or execution errors", async (t) => {
  const root = await fixture(t, "export const value = 1;\n");
  const result = await reverifyProject(root, {
    previousReport: { diagnostics: [], execution: [] }
  });
  assert.equal(result.status, "not-needed");
  assert.deepEqual(result.selection.ruleIds, []);
  assert.equal(result.currentReport, null);
});

test("re-verification rejects malformed previous reports and invalid audit options", async (t) => {
  const root = await fixture(t, "export const value = 1;\n");
  await assert.rejects(
    reverifyProject(root, { previousReport: {} }),
    /diagnostics array/
  );
  await assert.rejects(
    reverifyProject(root, { previousReport: { diagnostics: [], execution: {} } }),
    /execution must be an array/
  );
  await assert.rejects(
    reverifyProject(root, { previousReport: { diagnostics: [] }, auditOptions: [] }),
    /auditOptions/
  );
});
