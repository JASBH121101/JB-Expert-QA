import assert from "node:assert/strict";
import test from "node:test";
import {
  createReportCertificationEngineAdapter,
  registerReportCertificationEngine,
  ReportCertificationAdapterError,
  REPORT_CERTIFICATION_ADAPTER_ID,
  REPORT_CERTIFICATION_ADAPTER_VERSION,
  REPORT_CERTIFICATION_ADAPTER_CAPABILITIES,
  REPORT_CERTIFICATION_LIMITS
} from "../src/engine-registry/adapters/report-certification.js";
import { createQaEngineRegistry } from "../src/engine-registry/index.js";
import {
  createQaEngineOrchestrator,
  getQaEngineActionType,
  QA_ENGINE_EXECUTION_PERMISSION,
  QA_ENGINE_ORCHESTRATOR_RISK
} from "../src/engine-registry/orchestrator.js";

const FIXED_DATE = new Date("2026-11-23T19:00:00.000Z");
const ID = "certification-test-0001";

function record(id, engineId, values = {}) {
  return {
    id,
    engineId,
    engineName: engineId,
    targetHash: "sha256-target-identity-A",
    targetLabel: "Project A",
    createdAt: "2026-11-23T18:00:00.000Z",
    outcome: "passed",
    score: 96,
    findingsCount: 0,
    findings: [],
    ...values
  };
}

function adapter(options = {}) {
  return createReportCertificationEngineAdapter({
    clock: () => new Date(FIXED_DATE),
    idFactory: () => ID,
    ...options
  });
}

test("Report & Certification adapter publishes a stable bounded in-process contract", () => {
  const instance = adapter();
  assert.equal(instance.id, REPORT_CERTIFICATION_ADAPTER_ID);
  assert.equal(instance.version, REPORT_CERTIFICATION_ADAPTER_VERSION);
  assert.equal(instance.category, "reporting");
  assert.equal(instance.targetType, "payload");
  assert.equal(instance.executionMode, "in-process");
  assert.deepEqual(instance.capabilities, [
    "multi-engine-report-aggregation",
    "scope-aware-certification",
    "severity-and-findings-summary",
    "engine-coverage-reporting",
    "json-markdown-html-export",
    "sha256-checkpoint-integrity",
    "bounded-local-report-generation"
  ]);
  assert.ok(Object.isFrozen(instance));
  assert.ok(Object.isFrozen(REPORT_CERTIFICATION_ADAPTER_CAPABILITIES));
  assert.ok(Object.isFrozen(REPORT_CERTIFICATION_LIMITS));
  assert.equal(REPORT_CERTIFICATION_LIMITS.externalNetworkRequests, 0);
  assert.equal(REPORT_CERTIFICATION_LIMITS.filesystemWrites, 0);
  assert.equal(REPORT_CERTIFICATION_LIMITS.crossEngineScoreAveraging, false);
});

test("registration adds metadata only, exposes reporting capability and rejects duplicate registration", () => {
  const registry = createQaEngineRegistry();
  const metadata = registerReportCertificationEngine(registry, {
    clock: () => new Date(FIXED_DATE),
    idFactory: () => ID
  });
  assert.equal(metadata.id, REPORT_CERTIFICATION_ADAPTER_ID);
  assert.equal(registry.has(REPORT_CERTIFICATION_ADAPTER_ID), true);
  assert.deepEqual(registry.find({ category: "reporting" }).map((item) => item.id), [
    REPORT_CERTIFICATION_ADAPTER_ID
  ]);
  assert.throws(
    () => registerReportCertificationEngine(registry),
    (error) => error instanceof ReportCertificationAdapterError && error.code === "DUPLICATE_ENGINE"
  );
  assert.throws(
    () => registerReportCertificationEngine({}),
    (error) => error instanceof ReportCertificationAdapterError && error.code === "INVALID_REGISTRY"
  );
});

test("empty history produces NOT_ASSESSED and never a false pass", async () => {
  const result = await adapter().run({
    history: [],
    engineDefinitions: [{ id: "static", name: "Static QA" }]
  });
  assert.equal(result.certification.assessment, "NOT_ASSESSED");
  assert.equal(result.certification.scope.currentSnapshotCount, 0);
  assert.equal(result.certification.averageCurrentScore, null);
  assert.match(result.artifact, /NOT_ASSESSED/);
  assert.match(result.artifact, /No saved audit snapshot is available/);
  assert.equal(result.certification.checkpoint.recordCount, 0);
  assert.match(result.certification.checkpoint.digest, /^[a-f0-9]{64}$/u);
});

test("clean current snapshots produce PASSED_WITHIN_RECORDED_SCOPE without cross-engine score certification", async () => {
  const result = await adapter().run({
    history: [
      record("static-run-1", "static"),
      record("visual-run-1", "visual", {
        targetHash: "sha256-target-identity-B",
        score: 91
      })
    ],
    engineDefinitions: [
      { id: "static", name: "Static QA" },
      { id: "visual", name: "Visual QA" },
      { id: "performance", name: "Performance QA" }
    ]
  });

  assert.equal(result.certification.assessment, "PASSED_WITHIN_RECORDED_SCOPE");
  assert.equal(result.certification.scope.retainedHistoryCount, 2);
  assert.equal(result.certification.scope.currentSnapshotCount, 2);
  assert.equal(result.certification.scope.targetCount, 2);
  assert.equal(result.certification.scope.usedEngineCount, 2);
  assert.equal(result.certification.scope.availableEngineCount, 3);
  assert.equal(result.certification.scoresComparableAcrossEngines, false);
  assert.equal(result.certification.outcomes.passed, 2);
  assert.match(result.certification.explanation, /recorded scope/iu);
});

test("newest snapshot is selected per engine and target identity", async () => {
  const result = await adapter().run({
    history: [
      record("older", "static", {
        createdAt: "2026-11-23T16:00:00.000Z",
        outcome: "not_passed",
        score: 40,
        findingsCount: 1
      }),
      record("newer", "static", {
        createdAt: "2026-11-23T18:30:00.000Z",
        outcome: "passed",
        score: 94
      }),
      record("other-target", "static", {
        targetHash: "sha256-target-identity-B",
        createdAt: "2026-11-23T18:15:00.000Z",
        outcome: "passed_with_observations",
        findingsCount: 1,
        findings: [{ id: "S-1", ruleId: "static.no-alt", title: "Missing alt text", severity: "medium" }]
      })
    ]
  });
  assert.equal(result.certification.assessment, "OBSERVATIONS");
  assert.equal(result.certification.scope.currentSnapshotCount, 2);
  assert.equal(result.certification.outcomes.passed, 1);
  assert.equal(result.certification.outcomes.observations, 1);
  assert.equal(result.certification.outcomes.notPassed, 0);
});

test("high/critical findings require review and cannot inherit a passed snapshot outcome", async () => {
  for (const severity of ["high", "critical"]) {
    const result = await adapter().run({
      history: [record("security-run", "security", {
        findingsCount: 1,
        findings: [{
          id: "SEC-1",
          ruleId: "security.header",
          title: "High-risk security finding",
          severity
        }]
      })]
    });
    assert.equal(result.certification.assessment, "REVIEW_REQUIRED");
    assert.equal(result.certification.outcomes.passed, 1);
    assert.equal(result.certification.findings.bySeverity[severity], 1);
  }
});

test("NOT_PASSED takes precedence when any latest engine/target snapshot failed", async () => {
  const result = await adapter().run({
    history: [
      record("static-run", "static"),
      record("security-run", "security", {
        outcome: "not_passed",
        score: 35,
        findingsCount: 1,
        findings: [{
          id: "SEC-2",
          ruleId: "security.injection",
          title: "Injection risk",
          severity: "critical"
        }]
      })
    ]
  });
  assert.equal(result.certification.assessment, "NOT_PASSED");
  assert.equal(result.certification.outcomes.notPassed, 1);
  assert.match(result.certification.explanation, /did not pass/iu);
});

test("JSON, Markdown and HTML formats produce safe artifacts and retain checkpoint digest", async () => {
  const history = [record("static-run", "static", {
    findingsCount: 1,
    findings: [{
      id: "S-1",
      ruleId: "static.secret",
      title: "token=secret-report-value",
      severity: "medium"
    }]
  })];
  const json = await adapter().run({ history, format: "json" });
  const parsed = JSON.parse(json.artifact);
  assert.equal(parsed.certificate.assessment, "OBSERVATIONS");
  assert.equal(parsed.certificate.checkpoint.digest, json.certification.checkpoint.digest);
  assert.equal(json.artifact.includes("secret-report-value"), false);

  const markdown = await adapter().run({ history, format: "markdown" });
  assert.match(markdown.artifact, /Consolidated QA Intelligence Report/);
  assert.match(markdown.artifact, /Certification checkpoint/);
  assert.match(markdown.artifact, /SHA-256:/);

  const html = await adapter().run({ history, format: "html" });
  assert.match(html.artifact, /<!doctype html>/iu);
  assert.match(html.artifact, /Certification Report/iu);
  assert.equal(html.artifact.includes("secret-report-value"), false);
  assert.match(html.artifact, /sha256/iu);
});

test("target labels are anonymized and sensitive data is not included in exports", async () => {
  const privateTarget = "https://example.test/private?token=report-target-secret";
  const result = await adapter().run({
    history: [record("run", "static", {
      targetHash: privateTarget,
      targetLabel: privateTarget,
      findings: [{
        id: "S-2",
        ruleId: "static.secret",
        title: "Credential token=report-finding-secret",
        severity: "low"
      }],
      findingsCount: 1
    })],
    format: "json"
  });
  const output = JSON.stringify(result);
  assert.equal(output.includes("example.test"), false);
  assert.equal(output.includes("report-target-secret"), false);
  assert.equal(output.includes("report-finding-secret"), false);
  assert.match(output, /Target [a-f0-9]{12}/u);
});

test("checkpoint digest is stable for identical evidence and changes when assessment evidence changes", async () => {
  const sameA = await adapter().run({ history: [record("run", "static")] });
  const sameB = await adapter().run({ history: [record("run", "static")] });
  const changed = await adapter().run({
    history: [record("run", "static", { score: 72, outcome: "not_passed" })]
  });
  assert.equal(sameA.certification.checkpoint.digest, sameB.certification.checkpoint.digest);
  assert.notEqual(sameA.certification.checkpoint.digest, changed.certification.checkpoint.digest);
});

test("input validation rejects unsupported keys, accessors, sparse arrays, invalid outcomes and excessive data", async () => {
  const instance = adapter();
  await assert.rejects(
    instance.run({ history: [], reportPath: "/tmp/should-not-write.html" }),
    (error) => error instanceof ReportCertificationAdapterError && error.code === "UNSUPPORTED_FIELD"
  );
  await assert.rejects(
    instance.run({ history: [record("bad", "static", { outcome: "unknown-means-pass" })] }),
    (error) => error instanceof ReportCertificationAdapterError && error.code === "INVALID_OUTCOME"
  );
  await assert.rejects(
    instance.run({ history: [record("bad", "static", { score: 101 })] }),
    (error) => error instanceof ReportCertificationAdapterError && error.code === "INVALID_SCORE"
  );
  await assert.rejects(
    instance.run({ history: [record("bad", "static", {
      findings: [{ id: "1", ruleId: "x", title: "x", severity: "unclassified" }]
    })] }),
    (error) => error instanceof ReportCertificationAdapterError && error.code === "INVALID_SEVERITY"
  );
  await assert.rejects(
    instance.run({ history: [record("bad", "static")], format: "pdf" }),
    (error) => error instanceof ReportCertificationAdapterError && error.code === "INVALID_FORMAT"
  );
  await assert.rejects(
    instance.run({ history: Array(1) }),
    (error) => error instanceof ReportCertificationAdapterError && error.code === "INVALID_HISTORY"
  );
  await assert.rejects(
    instance.run({ history: Array(2001).fill(record("x", "static")) }),
    (error) => error instanceof ReportCertificationAdapterError && error.code === "INVALID_HISTORY"
  );
  await assert.rejects(
    instance.run({ history: [record("bad", "static", { createdAt: "yesterday-ish" })] }),
    (error) => error instanceof ReportCertificationAdapterError && error.code === "INVALID_TIMESTAMP"
  );
});

test("accessor properties are rejected without invoking getters", async () => {
  const instance = adapter();
  let invoked = false;
  const maliciousRecord = record("bad", "static");
  Object.defineProperty(maliciousRecord, "score", {
    enumerable: true,
    get() {
      invoked = true;
      return 99;
    }
  });
  await assert.rejects(
    instance.run({ history: [maliciousRecord] }),
    (error) => error instanceof ReportCertificationAdapterError && error.code === "ACCESSOR_NOT_ALLOWED"
  );
  assert.equal(invoked, false);
});

test("engine definition validation and malformed clock/id factories fail closed", async () => {
  await assert.rejects(
    adapter().run({ history: [], engineDefinitions: [{ id: "Bad ID", name: "Bad" }] }),
    (error) => error instanceof ReportCertificationAdapterError && error.code === "INVALID_ENGINE_DEFINITIONS"
  );
  await assert.rejects(
    createReportCertificationEngineAdapter({ clock: () => "not-a-date" }).run({ history: [] }),
    (error) => error instanceof ReportCertificationAdapterError && error.code === "INVALID_CLOCK"
  );
  await assert.rejects(
    createReportCertificationEngineAdapter({ idFactory: () => "" }).run({ history: [] }),
    (error) => error instanceof ReportCertificationAdapterError && error.code === "INVALID_ID_FACTORY"
  );
});

test("orchestrator requires exact policy, execution permission and external approval before report generation", async () => {
  const registry = createQaEngineRegistry();
  registerReportCertificationEngine(registry, {
    clock: () => new Date(FIXED_DATE),
    idFactory: () => ID
  });
  registry.seal();
  const actionType = getQaEngineActionType(REPORT_CERTIFICATION_ADAPTER_ID);
  const denied = createQaEngineOrchestrator({
    registry,
    policy: {
      id: "report-deny-policy",
      grantedPermissions: [QA_ENGINE_EXECUTION_PERMISSION],
      rules: []
    },
    requestApproval: async () => ({ approved: true, approvalId: "unused" })
  });
  const deniedResult = await denied.execute({
    id: "report-denied-plan",
    actions: [{ id: "report-denied-action", type: actionType, input: { history: [] } }]
  });
  assert.equal(deniedResult.status, "blocked");
  assert.equal(denied.verifyLedger().valid, true);

  const rejected = createQaEngineOrchestrator({
    registry,
    policy: {
      id: "report-rejected-policy",
      grantedPermissions: [QA_ENGINE_EXECUTION_PERMISSION],
      rules: [{ type: actionType, maxRisk: QA_ENGINE_ORCHESTRATOR_RISK }]
    },
    requestApproval: async () => ({ approved: false })
  });
  const rejectedResult = await rejected.execute({
    id: "report-rejected-plan",
    actions: [{ id: "report-rejected-action", type: actionType, input: { history: [] } }]
  });
  assert.equal(rejectedResult.status, "blocked");
  assert.equal(rejected.verifyLedger().valid, true);

  const approved = createQaEngineOrchestrator({
    registry,
    policy: {
      id: "report-approved-policy",
      grantedPermissions: [QA_ENGINE_EXECUTION_PERMISSION],
      rules: [{ type: actionType, maxRisk: QA_ENGINE_ORCHESTRATOR_RISK }]
    },
    requestApproval: async () => ({ approved: true, approvalId: "report-approval-1" })
  });
  const approvedResult = await approved.execute({
    id: "report-approved-plan",
    actions: [{
      id: "report-approved-action",
      type: actionType,
      input: { history: [record("run", "static")], format: "json" }
    }]
  });
  assert.equal(approvedResult.status, "succeeded");
  assert.equal(approvedResult.actions[0].output.certification.assessment, "PASSED_WITHIN_RECORDED_SCOPE");
  assert.equal(approved.verifyLedger().valid, true);
});
