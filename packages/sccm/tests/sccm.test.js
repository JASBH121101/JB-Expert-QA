import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  appendSccmAssessment,
  buildSccmReport,
  evaluateSccmNode,
  validateSccmAssessment,
  validateSccmHistory,
  validateSccmInventory
} from "../src/index.js";

const inventory = JSON.parse(await readFile(new URL("../manifests/inventory.v1.json", import.meta.url), "utf8"));
const history = JSON.parse(await readFile(new URL("../manifests/assessments.v1.json", import.meta.url), "utf8"));
const sourceSha = inventory.sources[0].commitSha;

function evidence(outcome = "success", commitSha = sourceSha) {
  return [{
    kind: "workflow-run",
    reference: "https://github.com/example/repo/actions/runs/100",
    commitSha,
    outcome,
    summary: "Deterministic SCCM test evidence."
  }];
}

function assessment(nodeId, {
  assessmentId = "asmt.test." + nodeId.split(".").at(-1),
  status = "PASS",
  assessedAt = "2026-11-18T19:11:00Z",
  ev = evidence(status === "FAIL" ? "failure" : "success"),
  findings = []
} = {}) {
  const node = inventory.nodes.find((entry) => entry.id === nodeId);
  return {
    assessmentId,
    nodeId,
    version: node.version,
    commitSha: sourceSha,
    status,
    assessedAt,
    evidence: ev,
    findings
  };
}

function fixtureInventory({ optionalComponent = false, withDependency = false } = {}) {
  const nodes = [
    ["fixture.ecosystem", "Fixture ecosystem", "ecosystem", null, true],
    ["fixture.engine", "Fixture engine", "engine", "fixture.ecosystem", true],
    ["fixture.branch", "Fixture branch", "branch", "fixture.engine", true],
    ["fixture.subbranch", "Fixture subbranch", "subbranch", "fixture.branch", true],
    ["fixture.module", "Fixture module", "module", "fixture.subbranch", true],
    ["fixture.component", "Fixture component", "component", "fixture.module", !optionalComponent],
    ["fixture.dependency-module", "Dependency module", "module", "fixture.subbranch", true],
    ["fixture.dependency-component", "Dependency component", "component", "fixture.dependency-module", true]
  ].map(([id, name, level, parentId, critical]) => ({
    id, name, level, parentId, sourceId: "fixture-main", version: "1.0.0", critical, dependencies: []
  }));
  if (withDependency) nodes.find((node) => node.id === "fixture.module").dependencies.push("fixture.dependency-component");
  return {
    schema: "jb.sccm.inventory/v1",
    inventoryVersion: "1.0.0",
    generatedAt: "2026-11-18T19:00:00Z",
    sources: [{
      id: "fixture-main",
      repository: "example/repo",
      ref: "main",
      commitSha: sourceSha
    }],
    nodes
  };
}

function passHistory(testInventory, ids, assessedAt = "2026-11-18T19:11:00Z") {
  return ids.map((nodeId, index) => {
    const node = testInventory.nodes.find((entry) => entry.id === nodeId);
    return {
      assessmentId: "asmt.fixture." + index,
      nodeId,
      version: node.version,
      commitSha: sourceSha,
      status: "PASS",
      assessedAt,
      evidence: evidence(),
      findings: []
    };
  });
}

test("the versioned hierarchy inventory validates with all six certification levels", () => {
  const result = validateSccmInventory(inventory);
  assert.equal(result.valid, true, result.errors.join("; "));
  assert.deepEqual(
    [...new Set(inventory.nodes.map((node) => node.level))].sort(),
    ["branch", "component", "ecosystem", "engine", "module", "subbranch"]
  );
  assert.equal(inventory.nodes.length, 141);
  assert.equal(inventory.nodes.filter((node) => node.level === "engine").length, 8);
});

test("inventory rejects missing hierarchy parents, wrong parent levels and dependency cycles", () => {
  const malformed = structuredClone(fixtureInventory({ withDependency: true }));
  malformed.nodes.find((node) => node.id === "fixture.engine").parentId = "fixture.component";
  malformed.nodes.find((node) => node.id === "fixture.dependency-component").dependencies.push("fixture.module");
  const result = validateSccmInventory(malformed);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("must have a ecosystem parent")));
  assert.ok(result.errors.some((error) => error.includes("cycle detected")));
});

test("inventory rejects invalid source snapshot references and duplicate node identifiers", () => {
  const malformed = structuredClone(fixtureInventory());
  malformed.sources[0].commitSha = "1234";
  malformed.nodes.push(structuredClone(malformed.nodes[1]));
  const result = validateSccmInventory(malformed);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("full 40-character SHA")));
  assert.ok(result.errors.some((error) => error.includes("duplicated")));
});

test("inventory rejects accessor properties without executing them", () => {
  let invoked = false;
  const input = structuredClone(fixtureInventory());
  Object.defineProperty(input, "schema", {
    enumerable: true,
    get() {
      invoked = true;
      return "jb.sccm.inventory/v1";
    }
  });
  assert.equal(validateSccmInventory(input).valid, false);
  assert.equal(invoked, false);
});

test("the initial evidence ledger contains only valid exact-SHA assessments", () => {
  const result = validateSccmHistory(inventory, history);
  assert.equal(result.valid, true, result.errors.join("; "));
  assert.equal(history.length, 42);
  assert.ok(history.every((entry) => entry.commitSha === sourceSha));
});

test("PASS requires success evidence bound to the exact source commit", () => {
  const component = assessment("jb.expert-qa.language.semantic-integrity");
  assert.equal(validateSccmAssessment(inventory, component).valid, true);
  assert.equal(validateSccmAssessment(inventory, { ...component, evidence: [] }).valid, false);
  const mismatched = { ...component, evidence: evidence("success", "1".repeat(40)) };
  const mismatchResult = validateSccmAssessment(inventory, mismatched);
  assert.equal(mismatchResult.valid, false);
  assert.ok(mismatchResult.errors.some((error) => error.includes("must match the assessed commit")));
});

test("PASS cannot include unresolved findings and FAIL requires failure evidence", () => {
  const passWithFinding = assessment("jb.expert-qa.language.semantic-integrity", {
    findings: ["Unresolved semantic drift"]
  });
  assert.equal(validateSccmAssessment(inventory, passWithFinding).valid, false);
  const failWithoutEvidence = assessment("jb.expert-qa.language.semantic-integrity", {
    status: "FAIL",
    ev: evidence("success")
  });
  assert.equal(validateSccmAssessment(inventory, failWithoutEvidence).valid, false);
});

test("assessment history is append-only, immutable and timestamp-monotonic per node", () => {
  const existing = history;
  const first = assessment("jb.expert-qa.visual.screenshot-diff", {
    status: "PENDING",
    assessmentId: "asmt.visual.pending",
    assessedAt: "2026-11-18T19:11:00Z",
    ev: []
  });
  const next = appendSccmAssessment(inventory, existing, first);
  assert.equal(next.length, existing.length + 1);
  assert.equal(Object.isFrozen(next), true);
  assert.equal(Object.isFrozen(next.at(-1)), true);
  assert.equal(existing.length, history.length);
  assert.throws(() => appendSccmAssessment(inventory, next, first), /already exists/);
  const older = { ...first, assessmentId: "asmt.visual.older", assessedAt: "2026-11-18T19:09:00Z" };
  assert.throws(() => appendSccmAssessment(inventory, next, older), /cannot move backwards/);
});

test("Language QA is PASS at component, module, subbranch and branch levels", () => {
  const branch = evaluateSccmNode(inventory, history, "jb.expert-qa.language");
  const module = evaluateSccmNode(inventory, history, "jb.expert-qa.language.module");
  const components = branch.children[0].children[0].children;
  assert.equal(branch.status, "PASS");
  assert.equal(branch.children[0].status, "PASS");
  assert.equal(module.status, "PASS");
  assert.equal(components.length, 9);
  assert.ok(components.every((component) => component.status === "PASS"));
  assert.equal(components.find((component) => component.id === "jb.expert-qa.language.cldr-catalog-audit").ownStatus, "PASS");
});

test("green module workflows do not bypass uncertified critical components", () => {
  const visual = evaluateSccmNode(inventory, history, "jb.expert-qa.visual.module");
  const expert = evaluateSccmNode(inventory, history, "jb.expert-qa");
  assert.equal(visual.ownStatus, "PASS");
  assert.equal(visual.status, "PENDING");
  assert.ok(visual.blockingChildren.length > 0);
  assert.equal(expert.ownStatus, "PASS");
  assert.equal(expert.status, "PENDING");
  assert.equal(evaluateSccmNode(inventory, history, "jb.ecosystem").status, "PENDING");
});

test("Resilience A2 subbranch passes while the whole engine remains pending for other branches", () => {
  const a2 = evaluateSccmNode(inventory, history, "jb.resilience-engine.orchestration.a2-readonly");
  const engine = evaluateSccmNode(inventory, history, "jb.resilience-engine");
  assert.equal(a2.status, "PASS");
  assert.ok(a2.children[0].children.every((component) => component.status === "PASS"));
  assert.equal(engine.status, "PENDING");
  assert.ok(engine.blockingChildren.some((child) => child.status === "PENDING"));
});

test("a critical component failure propagates through every ancestor", () => {
  const failure = assessment("jb.expert-qa.language.semantic-integrity", {
    assessmentId: "asmt.language.semantic-integrity.failure",
    status: "FAIL",
    assessedAt: "2026-11-18T19:12:00Z",
    ev: evidence("failure")
  });
  const changed = appendSccmAssessment(inventory, history, failure);
  assert.equal(evaluateSccmNode(inventory, changed, "jb.expert-qa.language").status, "FAIL");
  assert.equal(evaluateSccmNode(inventory, changed, "jb.expert-qa").status, "FAIL");
  assert.equal(evaluateSccmNode(inventory, changed, "jb.ecosystem").status, "FAIL");
});

test("non-critical component failure is visible but does not block its parent", () => {
  const fixture = fixtureInventory({ optionalComponent: true });
  const ids = fixture.nodes.map((node) => node.id);
  const allPass = passHistory(fixture, ids);
  const failure = {
    assessmentId: "asmt.optional.failure",
    nodeId: "fixture.component",
    version: "1.0.0",
    commitSha: sourceSha,
    status: "FAIL",
    assessedAt: "2026-11-18T19:12:00Z",
    evidence: evidence("failure"),
    findings: ["Optional component failure"]
  };
  const updated = appendSccmAssessment(fixture, allPass, failure);
  const root = evaluateSccmNode(fixture, updated, "fixture.ecosystem");
  assert.equal(root.status, "PASS");
  const module = evaluateSccmNode(fixture, updated, "fixture.module");
  assert.equal(module.status, "PASS");
  assert.equal(module.warnings[0].status, "FAIL");
});

test("required dependencies block certification until the dependency is PASS", () => {
  const fixture = fixtureInventory({ withDependency: true });
  const ids = fixture.nodes.map((node) => node.id).filter((id) => id !== "fixture.dependency-component");
  const entries = passHistory(fixture, ids);
  const module = evaluateSccmNode(fixture, entries, "fixture.module");
  assert.equal(module.ownStatus, "PASS");
  assert.equal(module.status, "PENDING");
  assert.deepEqual(module.blockingDependencies, [{ id: "fixture.dependency-component", status: "PENDING" }]);
});

test("SCCM report counts aggregate statuses instead of trusting raw CI totals", () => {
  const report = buildSccmReport(inventory, history);
  assert.equal(report.schema, "jb.sccm.report/v1");
  assert.equal(report.status, "PENDING");
  assert.equal(report.counts.component.total, 72);
  assert.equal(report.counts.component.PASS, 14);
  assert.ok(report.progress.passed > 0);
  assert.ok(report.progress.pending > 0);
  assert.equal(report.progress.total, 141);
});

test("history validation fails closed on malformed entries rather than throwing", () => {
  const result = validateSccmHistory(inventory, [null, {}]);
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
});
