import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditProject } from "../src/adapters/filesystem/audit-project.js";
import { auditSecurityProject } from "../src/adapters/filesystem/audit-security-project.js";
import { reverifyProject, reverifySecurityProject } from "../src/adapters/filesystem/reverify-project.js";

async function withProject(run) {
  const root = await mkdtemp(join(tmpdir(), "jb-reverify-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("project re-verification reruns only the rule IDs represented in the previous report", async () => {
  await withProject(async (root) => {
    const source = join(root, "src", "database.js");
    await writeFile(source, "const rows = await prisma.$queryRawUnsafe(query);\n");
    const previous = await auditProject(root);
    assert.ok(previous.diagnostics.some((item) => item.ruleId === "database.raw-query"));

    const result = await reverifyProject(root, { previousReport: previous });
    assert.equal(result.status, "completed");
    assert.deepEqual(result.selection.ruleIds, ["database.raw-query"]);
    assert.equal(result.selection.rulesExecuted, 1);
    assert.equal(result.summary.unchanged, 1);
    assert.equal(result.summary.resolved, 0);
    assert.equal(result.summary.newFindings, 0);
    assert.equal(result.currentReport.summary.selection.type, "targeted-rules");
  });
});

test("project re-verification reports a finding as resolved after the unsafe call is removed", async () => {
  await withProject(async (root) => {
    const source = join(root, "src", "database.js");
    await writeFile(source, "const rows = await prisma.$queryRawUnsafe(query);\n");
    const previous = await auditProject(root);
    await writeFile(source, "const rows = await prisma.$queryRaw('SELECT * FROM users WHERE id = ?', [id]);\n");

    const result = await reverifyProject(root, { previousReport: previous });
    assert.equal(result.summary.resolved, 1);
    assert.equal(result.summary.unchanged, 0);
    assert.equal(result.summary.newFindings, 0);
  });
});

test("security re-verification accepts the previous audit options and remains offline by default", async () => {
  await withProject(async (root) => {
    await writeFile(join(root, "src", "unsafe.js"), "const result = eval(userInput);\n");
    const previous = await auditSecurityProject(root);
    const result = await reverifySecurityProject(root, { previousReport: previous });

    assert.equal(result.profile, "security");
    assert.deepEqual(result.selection.ruleIds, [...new Set(previous.diagnostics.map((item) => item.ruleId))].sort());
    assert.equal(result.currentReport.dependencyAdvisories.status, "disabled");
    assert.equal(result.currentReport.securityAssessment.networkRequests, 0);
  });
});

test("re-verification does not run every rule when the previous report has no findings", async () => {
  const result = await reverifyProject("/not-used", {
    previousReport: { diagnostics: [], execution: [] }
  });
  assert.equal(result.status, "not-needed");
  assert.equal(result.currentReport, null);
  assert.deepEqual(result.selection.ruleIds, []);
  assert.equal(result.summary.previousFindings, 0);
});

test("re-verification rejects malformed previous reports and audit options", async () => {
  await assert.rejects(
    reverifyProject("/not-used", { previousReport: {} }),
    /diagnostics array/
  );
  await assert.rejects(
    reverifyProject("/not-used", { previousReport: { diagnostics: [] }, auditOptions: [] }),
    /auditOptions must be an object/
  );
});
