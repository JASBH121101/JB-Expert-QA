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

function assessment(nodeId, options = {}) {
  const node = inventory.nodes.find((entry) => entry.id === nodeId);
  const source = inventory.sources.find((entry) => entry.id === node.sourceId);
  const {
    assessmentId = "asmt.test." + nodeId.split(".").at(-1),
    status = "PASS",
    assessedAt = "2026-11-18T19:11:00Z",
    ev = evidence(status === "FAIL" ? "failure" : "success", source.commitSha),
    findings = []
  } = options;
  return {
    assessmentId,
    nodeId,
    version: node.version,
    commitSha: source.commitSha,
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

test("the append-only evidence ledger contains valid per-source exact-SHA assessments", () => {
  const result = validateSccmHistory(inventory, history);
  assert.equal(result.valid, true, result.errors.join("; "));
  assert.equal(history.length, 103);
  assert.ok(history.every((entry) => {
    const node = inventory.nodes.find((item) => item.id === entry.nodeId);
    const sourceId = node && (entry.sourceId ?? node.sourceId);
    const source = inventory.sources.find((item) => item.id === sourceId);
    return Boolean(source && entry.commitSha === source.commitSha);
  }));
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

test("versioned assessments preserve immutable evidence across source revisions", () => {
  const fixture = fixtureInventory();
  const original = {
    assessmentId: "asmt.fixture.original",
    nodeId: "fixture.component",
    version: "1.0.0",
    commitSha: sourceSha,
    status: "PASS",
    assessedAt: "2026-11-18T19:11:00Z",
    evidence: evidence("success", sourceSha),
    findings: []
  };
  const nextSha = "a".repeat(40);
  fixture.sources.push({
    id: "fixture-next",
    repository: "example/repo",
    ref: "main",
    commitSha: nextSha
  });
  const revised = {
    assessmentId: "asmt.fixture.revised",
    nodeId: "fixture.component",
    version: "1.0.0",
    commitSha: nextSha,
    status: "PASS",
    assessedAt: "2026-11-18T19:12:00Z",
    evidence: evidence("success", nextSha),
    findings: [],
    sourceId: "fixture-next"
  };
  const appended = appendSccmAssessment(fixture, [original], revised);
  assert.equal(appended.length, 2);
  assert.equal(appended[0].commitSha, sourceSha);
  assert.equal(appended[1].commitSha, nextSha);
  assert.equal(validateSccmHistory(fixture, appended).valid, true);
  const latest = evaluateSccmNode(fixture, appended, "fixture.component");
  assert.equal(latest.status, "PASS");
  assert.equal(latest.commitSha, nextSha);
});

test("versioned assessments cannot cite a source snapshot from another repository", () => {
  const fixture = fixtureInventory();
  const nextSha = "b".repeat(40);
  fixture.sources.push({
    id: "fixture-foreign",
    repository: "other/repo",
    ref: "main",
    commitSha: nextSha
  });
  const invalid = {
    assessmentId: "asmt.fixture.foreign",
    nodeId: "fixture.component",
    version: "1.0.0",
    commitSha: nextSha,
    status: "PASS",
    assessedAt: "2026-11-18T19:11:00Z",
    evidence: evidence("success", nextSha),
    findings: [],
    sourceId: "fixture-foreign"
  };
  const result = validateSccmAssessment(fixture, invalid);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("node's registered repository")));
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
    assessedAt: "2026-11-18T20:57:00Z",
    ev: []
  });
  const next = appendSccmAssessment(inventory, existing, first);
  assert.equal(next.length, existing.length + 1);
  assert.equal(Object.isFrozen(next), true);
  assert.equal(Object.isFrozen(next.at(-1)), true);
  assert.equal(existing.length, history.length);
  assert.throws(() => appendSccmAssessment(inventory, next, first), /already exists/);
  const older = { ...first, assessmentId: "asmt.visual.older", assessedAt: "2026-11-18T20:56:00Z" };
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


test("Localization Engine branch and subbranch are PASS with historical CLDR dependency intact", () => {
  const pluralRules = evaluateSccmNode(inventory, history, "jb.localization-engine.runtime.plurals");
  const branch = evaluateSccmNode(inventory, history, "jb.localization-engine.runtime");
  const subbranch = evaluateSccmNode(inventory, history, "jb.localization-engine.runtime.intl");
  const module = evaluateSccmNode(inventory, history, "jb.localization-engine.runtime.module");
  const engine = evaluateSccmNode(inventory, history, "jb.localization-engine");
  assert.equal(pluralRules.status, "PASS");
  assert.equal(pluralRules.ownStatus, "PASS");
  assert.equal(module.status, "PASS");
  assert.equal(branch.status, "PASS");
  assert.equal(subbranch.status, "PASS");
  assert.equal(engine.status, "PASS");
});

test("Visual QA branch and module pass while uncertified sibling branches keep Expert QA pending", () => {
  const visual = evaluateSccmNode(inventory, history, "jb.expert-qa.visual.module");
  const visualBranch = evaluateSccmNode(inventory, history, "jb.expert-qa.visual");
  const expert = evaluateSccmNode(inventory, history, "jb.expert-qa");
  assert.equal(visual.ownStatus, "PASS");
  assert.equal(visual.status, "PASS");
  assert.equal(visualBranch.status, "PASS");
  assert.equal(visualBranch.children[0].status, "PASS");
  assert.equal(visual.blockingChildren.length, 0);
  assert.equal(expert.ownStatus, "PASS");
  assert.equal(expert.status, "PENDING");
  assert.equal(evaluateSccmNode(inventory, history, "jb.ecosystem").status, "PENDING");
});

test("Security QA branch, static-analysis subbranch and module are PASS within their declared scope", () => {
  const branch = evaluateSccmNode(inventory, history, "jb.expert-qa.security");
  const subbranch = evaluateSccmNode(inventory, history, "jb.expert-qa.security.static-analysis");
  const module = evaluateSccmNode(inventory, history, "jb.expert-qa.security.module");
  assert.equal(branch.status, "PASS");
  assert.equal(subbranch.status, "PASS");
  assert.equal(module.status, "PASS");
  assert.equal(module.children.length, 3);
  assert.ok(module.children.every((component) => component.ownStatus === "PASS" && component.status === "PASS"));
  assert.equal(evaluateSccmNode(inventory, history, "jb.expert-qa").status, "PENDING");
});

test("Resilience A2 subbranch passes while the whole engine remains pending for other branches", () => {
  const a2 = evaluateSccmNode(inventory, history, "jb.resilience-engine.orchestration.a2-readonly");
  const engine = evaluateSccmNode(inventory, history, "jb.resilience-engine");
  assert.equal(a2.status, "PASS");
  assert.ok(a2.children[0].children.every((component) => component.status === "PASS"));
  assert.equal(engine.status, "PENDING");
  assert.ok(engine.blockingChildren.some((child) => child.status === "PENDING"));
});

test("Currency Engine branch, precision subbranch and curated components are PASS", () => {
  const branch = evaluateSccmNode(inventory, history, "jb.currency-engine.money");
  const subbranch = evaluateSccmNode(inventory, history, "jb.currency-engine.money.precision");
  const module = evaluateSccmNode(inventory, history, "jb.currency-engine.money.module");
  const engine = evaluateSccmNode(inventory, history, "jb.currency-engine");
  assert.equal(module.status, "PASS");
  assert.equal(subbranch.status, "PASS");
  assert.equal(branch.status, "PASS");
  assert.equal(engine.status, "PASS");
  assert.ok(module.children.every((component) => component.status === "PASS"));
  assert.equal(module.children.find((component) => component.id === "jb.currency-engine.money.fx").ownStatus, "PASS");
});

test("Currency QA hierarchy passes at component, module, subbranch and branch levels", () => {
  const branch = evaluateSccmNode(inventory, history, "jb.expert-qa.currency");
  const subbranch = evaluateSccmNode(inventory, history, "jb.expert-qa.currency.locale-validation");
  const module = evaluateSccmNode(inventory, history, "jb.expert-qa.currency.module");
  assert.equal(module.status, "PASS");
  assert.equal(subbranch.status, "PASS");
  assert.equal(branch.status, "PASS");
  assert.equal(module.children.length, 3);
  assert.ok(module.children.every((component) => component.ownStatus === "PASS" && component.status === "PASS"));
  assert.equal(evaluateSccmNode(inventory, history, "jb.expert-qa").status, "PENDING");
});

test("Database QA PostgreSQL integration hierarchy passes without certifying unsupported adapters", () => {
  const branch = evaluateSccmNode(inventory, history, "jb.expert-qa.database");
  const subbranch = evaluateSccmNode(inventory, history, "jb.expert-qa.database.integration");
  const module = evaluateSccmNode(inventory, history, "jb.expert-qa.database.module");
  assert.equal(module.status, "PASS");
  assert.equal(subbranch.status, "PASS");
  assert.equal(branch.status, "PASS");
  assert.equal(module.children.length, 3);
  assert.ok(module.children.every((component) => component.ownStatus === "PASS" && component.status === "PASS"));
  assert.equal(evaluateSccmNode(inventory, history, "jb.expert-qa").status, "PENDING");
  assert.equal(evaluateSccmNode(inventory, history, "jb.ecosystem").status, "PENDING");
});

test("Package QA distribution hierarchy is PASS on the clean consumer install matrix", () => {
  const branch = evaluateSccmNode(inventory, history, "jb.expert-qa.package");
  const subbranch = evaluateSccmNode(inventory, history, "jb.expert-qa.package.distribution");
  const module = evaluateSccmNode(inventory, history, "jb.expert-qa.package.module");
  assert.equal(module.status, "PASS");
  assert.equal(subbranch.status, "PASS");
  assert.equal(branch.status, "PASS");
  assert.equal(module.children.length, 3);
  assert.ok(module.children.every((component) => component.ownStatus === "PASS" && component.status === "PASS"));
  assert.equal(evaluateSccmNode(inventory, history, "jb.expert-qa").status, "PENDING");
});

test("Resilience A1 is certified while A2 and A3 stay bounded to laboratory components", () => {
  const policy = evaluateSccmNode(inventory, history, "jb.resilience-engine.policy");
  assert.equal(policy.status, "PASS");
  assert.equal(policy.children[0].status, "PASS");
  assert.equal(policy.children[0].children[0].status, "PASS");
  assert.ok(policy.children[0].children[0].children.every((component) => component.status === "PASS"));

  const containment = evaluateSccmNode(inventory, history, "jb.resilience-engine.containment");
  const a2Module = evaluateSccmNode(inventory, history, "jb.resilience-engine.containment.a2-module");
  assert.equal(containment.status, "PENDING");
  assert.equal(a2Module.status, "PENDING");
  assert.ok(a2Module.children.every((component) => component.ownStatus === "PASS"));

  const failover = evaluateSccmNode(inventory, history, "jb.resilience-engine.failover");
  const a3Module = evaluateSccmNode(inventory, history, "jb.resilience-engine.failover.a3-module");
  assert.equal(failover.status, "PENDING");
  assert.equal(a3Module.status, "PENDING");
  assert.equal(a3Module.children.find((component) => component.id === "jb.resilience-engine.failover.leader-election").status, "PENDING");
  assert.equal(a3Module.children.find((component) => component.id === "jb.resilience-engine.failover.fencing").ownStatus, "PASS");
  assert.equal(a3Module.children.find((component) => component.id === "jb.resilience-engine.failover.replay").ownStatus, "PASS");
  assert.equal(evaluateSccmNode(inventory, history, "jb.resilience-engine").status, "PENDING");
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
  assert.equal(report.counts.component.PASS, 44);
  assert.ok(report.progress.passed > 0);
  assert.ok(report.progress.pending > 0);
  assert.equal(report.progress.total, 141);
});

 
test("Regression and Core QA hierarchies pass within their declared parser and fixture coverage", () => {
  const regression = evaluateSccmNode(inventory, history, "jb.expert-qa.regression");
  const regressionModule = evaluateSccmNode(inventory, history, "jb.expert-qa.regression.module");
  const regressionComponents = regressionModule.children;
  assert.equal(regression.status, "PASS");
  assert.equal(regression.children[0].status, "PASS");
  assert.equal(regressionModule.status, "PASS");
  assert.equal(regressionComponents.length, 3);
  assert.ok(regressionComponents.every((component) =>
    component.status === "PASS" && component.ownStatus === "PASS"
  ));

  const core = evaluateSccmNode(inventory, history, "jb.expert-qa.core");
  const coreSubbranch = evaluateSccmNode(inventory, history, "jb.expert-qa.core.analysis-core");
  const coreModule = evaluateSccmNode(inventory, history, "jb.expert-qa.core.module");
  const coreRules = evaluateSccmNode(inventory, history, "jb.expert-qa.core.rules");
  const coreFindings = evaluateSccmNode(inventory, history, "jb.expert-qa.core.findings");
  const coreParser = evaluateSccmNode(inventory, history, "jb.expert-qa.core.parser");
  assert.equal(coreRules.status, "PASS");
  assert.equal(coreFindings.status, "PASS");
  assert.equal(coreParser.status, "PASS");
  assert.equal(coreModule.status, "PASS");
  assert.equal(coreSubbranch.status, "PASS");
  assert.equal(core.status, "PASS");
});

test("history validation fails closed on malformed entries rather than throwing", () => {
  const result = validateSccmHistory(inventory, [null, {}]);
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
});
