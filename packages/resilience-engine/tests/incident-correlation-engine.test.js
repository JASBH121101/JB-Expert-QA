import test from "node:test";
import assert from "node:assert/strict";
import {
  createIncidentCorrelationEngine
} from "../src/incident-correlation-engine.js";

const NOW = 1_800_000_000_000;
const ASSET = "host-erp-01";
const ENVIRONMENT = "production";
const SERVICE = "catalog-api";

function source({
  sourceId = "guard-primary",
  sourceEngine = "security-guard",
  state = "clear",
  issuedAtMs = NOW,
  severity = "info",
  reasonCode = "SIGNAL_CLEAR"
} = {}) {
  return { sourceId, sourceEngine, state, issuedAtMs, reasonCode, severity };
}

function securityState({
  state = "clear",
  sources = [source()],
  evidenceRefs = [],
  reason = state === "clear" ? "all-required-sources-clear" : "trusted-source-suspected-threat"
} = {}) {
  return {
    schema: "jb.resilience.signal-state/v1",
    state,
    reason,
    assetId: ASSET,
    environment: ENVIRONMENT,
    sources,
    evidenceRefs,
    preserveEvidence: true,
    authorizationGranted: false
  };
}

function observation({
  observationId = "00000000-0000-4000-8000-000000000001",
  observedAtMs = NOW - 1000,
  status = "healthy",
  consecutiveFailures = status === "unhealthy" ? 1 : 0,
  reasonCode = status === "healthy" ? "HEALTH_OK" : "HEALTH_CHECK_FAILED",
  serviceId = SERVICE
} = {}) {
  return {
    schema: "jb.resilience.health-observation/v1",
    observationId,
    assetId: ASSET,
    environment: ENVIRONMENT,
    serviceId,
    observedAtMs,
    status,
    consecutiveFailures,
    reasonCode
  };
}

function input({
  security = securityState(),
  health = [observation()]
} = {}) {
  return {
    schema: "jb.resilience.incident-input/v1",
    assetId: ASSET,
    environment: ENVIRONMENT,
    serviceId: SERVICE,
    securityState: security,
    healthObservations: health
  };
}

function engine(options = {}) {
  return createIncidentCorrelationEngine({
    clock: () => NOW,
    ...options
  });
}

test("requires supported bounded configuration", () => {
  assert.throws(() => createIncidentCorrelationEngine({ windowMs: 1000 }), /windowMs/);
  assert.throws(() => createIncidentCorrelationEngine({
    escalationFailureThreshold: 5,
    criticalFailureThreshold: 5
  }), /criticalFailureThreshold/);
  assert.throws(() => createIncidentCorrelationEngine({ unknownOption: true }), /unsupported incident engine option/);
});

test("all-clear security and healthy service produce a read-only observation", () => {
  const result = engine().evaluateIncident(input());

  assert.equal(result.schema, "jb.resilience.incident-decision/v1");
  assert.equal(result.priority, "info");
  assert.equal(result.riskScore, 0);
  assert.equal(result.decision, "observe");
  assert.equal(result.decisionRule, "ALL_CLEAR");
  assert.equal(result.authorizationGranted, false);
  assert.equal(result.mayAuthorizeRecovery, false);
  assert.equal(result.preserveEvidence, true);
});

test("clear security plus repeated health failures recommends policy evaluation without authorization", () => {
  const health = [
    observation({
      observationId: "00000000-0000-4000-8000-000000000001",
      status: "unhealthy",
      consecutiveFailures: 1,
      observedAtMs: NOW - 3000
    }),
    observation({
      observationId: "00000000-0000-4000-8000-000000000002",
      status: "unhealthy",
      consecutiveFailures: 2,
      observedAtMs: NOW - 2000
    }),
    observation({
      observationId: "00000000-0000-4000-8000-000000000003",
      status: "unhealthy",
      consecutiveFailures: 3,
      observedAtMs: NOW - 1000
    })
  ];
  const result = engine().evaluateIncident(input({ health }));

  assert.equal(result.priority, "high");
  assert.equal(result.decision, "review-recovery-policy");
  assert.equal(result.recommendedNextStep, "evaluate-a1-policy-separately");
  assert.equal(result.decisionRule, "HEALTH_FAILURE_THRESHOLD");
  assert.equal(result.authorizationGranted, false);
});

test("suspected security signal escalates even when service health is healthy", () => {
  const result = engine().evaluateIncident(input({
    security: securityState({
      state: "suspected",
      reason: "trusted-source-suspected-threat",
      sources: [source({ state: "suspected", severity: "high", reasonCode: "THREAT_SUSPECTED" })]
    })
  }));

  assert.equal(result.priority, "high");
  assert.equal(result.decision, "escalate");
  assert.equal(result.decisionRule, "SECURITY_SUSPECTED");
});

test("confirmed and tampered states require human review and preserve evidence", () => {
  const evidenceRefs = [{
    refId: "evidence:sample-01",
    sha256: "a".repeat(64)
  }];
  for (const state of ["confirmed", "tampered"]) {
    const result = engine().evaluateIncident(input({
      security: securityState({
        state,
        reason: state === "confirmed" ? "trusted-source-confirmed-threat" : "source-reported-tampering",
        sources: [source({
          state,
          severity: "critical",
          reasonCode: state === "confirmed" ? "MALWARE_CONFIRMED" : "TAMPER_DETECTED"
        })],
        evidenceRefs
      })
    }));
    assert.equal(result.priority, "critical");
    assert.equal(result.decision, "human-review");
    assert.equal(result.recommendedNextStep, "preserve-evidence-and-human-review");
    assert.deepEqual(result.evidenceRefs, evidenceRefs);
    assert.equal(result.authorizationGranted, false);
  }
});

test("Gateway same-source conflicting signals remain valid correlation input", () => {
  const result = engine().evaluateIncident(input({
    security: securityState({
      state: "conflicting",
      reason: "same-source-conflicting-signals",
      sources: [
        source({ state: "clear", issuedAtMs: NOW - 1000, reasonCode: "SIGNAL_CLEAR" }),
        source({ state: "suspected", issuedAtMs: NOW - 1000, severity: "high", reasonCode: "THREAT_SUSPECTED" })
      ]
    })
  }));

  assert.equal(result.security.state, "conflicting");
  assert.equal(result.decisionRule, "SIGNAL_CONFLICT");
  assert.equal(result.priority, "critical");
});

test("cached clear security snapshots outside the freshness window become stale", () => {
  const result = engine().evaluateIncident(input({
    security: securityState({
      state: "clear",
      reason: "all-required-sources-clear",
      sources: [source({ state: "clear", issuedAtMs: NOW - 6 * 60_000 })]
    })
  }));

  assert.equal(result.security.state, "stale");
  assert.equal(result.decisionRule, "SECURITY_STALE");
  assert.equal(result.decision, "hold");
  assert.equal(result.authorizationGranted, false);
});

test("unknown, stale and conflicting security states never recommend recovery evaluation", () => {
  const cases = [
    ["unknown", "hold", "refresh-trusted-security-signals"],
    ["stale", "hold", "refresh-trusted-security-signals"],
    ["conflicting", "escalate", "hold-and-human-review"]
  ];
  for (const [state, decision, nextStep] of cases) {
    const result = engine().evaluateIncident(input({
      security: securityState({
        state,
        reason: state === "conflicting" ? "trusted-sources-disagree" : "required-source-signal-missing",
        sources: [source({ state: "unknown", reasonCode: "SIGNAL_UNKNOWN" })]
      })
    }));
    assert.equal(result.decision, decision);
    assert.equal(result.recommendedNextStep, nextStep);
    assert.equal(result.authorizationGranted, false);
  }
});

test("health observations with conflicting states at the same timestamp escalate", () => {
  const sameTime = NOW - 1000;
  const health = [
    observation({
      observationId: "00000000-0000-4000-8000-000000000001",
      observedAtMs: sameTime,
      status: "healthy"
    }),
    observation({
      observationId: "00000000-0000-4000-8000-000000000002",
      observedAtMs: sameTime,
      status: "unhealthy",
      consecutiveFailures: 1
    })
  ];
  const result = engine().evaluateIncident(input({ health }));

  assert.equal(result.health.state, "conflicting");
  assert.equal(result.decision, "escalate");
  assert.equal(result.decisionRule, "HEALTH_CONFLICT");
  assert.equal(result.priority, "critical");
});

test("duplicate observation IDs with different content are classified as conflict", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const health = [
    observation({ observationId: id, status: "healthy" }),
    observation({ observationId: id, status: "unhealthy", consecutiveFailures: 2 })
  ];
  const result = engine().evaluateIncident(input({ health }));

  assert.equal(result.health.state, "conflicting");
  assert.equal(result.decisionRule, "OBSERVATION_ID_CONFLICT");
  assert.equal(result.authorizationGranted, false);
});

test("identical duplicate observations are idempotently de-duplicated", () => {
  const item = observation();
  const result = engine().evaluateIncident(input({ health: [item, { ...item }] }));

  assert.equal(result.health.observationsInWindow, 1);
  assert.equal(result.health.observationIds.length, 1);
  assert.equal(result.decisionRule, "ALL_CLEAR");
});

test("stale health observations are excluded from the active correlation window", () => {
  const result = engine().evaluateIncident(input({
    health: [observation({ observedAtMs: NOW - 10 * 60_000 })]
  }));

  assert.equal(result.health.state, "unknown");
  assert.equal(result.health.ignoredStaleObservationIds.length, 1);
  assert.equal(result.decisionRule, "HEALTH_UNKNOWN");
  assert.equal(result.recommendedNextStep, "request-fresh-health-observation");
});

test("out-of-scope health or security snapshots are rejected", () => {
  assert.throws(() => engine().evaluateIncident({
    ...input(),
    healthObservations: [observation({ serviceId: "other-service" })]
  }), /scope mismatch/);
  assert.throws(() => engine().evaluateIncident(input({
    security: { ...securityState(), assetId: "other-host" }
  })), /scope does not match/);
});

test("future observations beyond the configured clock skew are rejected", () => {
  assert.throws(() => engine().evaluateIncident(input({
    health: [observation({ observedAtMs: NOW + 60_000 })]
  })), /too far in the future/);
});

test("rejects forged clear states and attempts to set authorization true", () => {
  assert.throws(() => engine().evaluateIncident(input({
    security: securityState({
      state: "clear",
      sources: [source({ state: "suspected" })]
    })
  })), /clear security state requires/);
  assert.throws(() => engine().evaluateIncident(input({
    security: { ...securityState(), authorizationGranted: true }
  })), /must preserve evidence/);
});

test("result and decision trace are deterministic for reordered observations", () => {
  const first = [
    observation({
      observationId: "00000000-0000-4000-8000-000000000001",
      status: "unhealthy",
      consecutiveFailures: 1,
      observedAtMs: NOW - 3000
    }),
    observation({
      observationId: "00000000-0000-4000-8000-000000000002",
      status: "unhealthy",
      consecutiveFailures: 2,
      observedAtMs: NOW - 2000
    }),
    observation({
      observationId: "00000000-0000-4000-8000-000000000003",
      status: "unhealthy",
      consecutiveFailures: 3,
      observedAtMs: NOW - 1000
    })
  ];
  const reversed = [...first].reverse();
  const resultA = engine().evaluateIncident(input({ health: first }));
  const resultB = engine().evaluateIncident(input({ health: reversed }));

  assert.equal(resultA.incidentId, resultB.incidentId);
  assert.equal(resultA.riskScore, resultB.riskScore);
  assert.equal(resultA.decisionRule, resultB.decisionRule);
  assert.deepEqual(resultA.trace, resultB.trace);
  assert.deepEqual(resultA.health.observationIds, resultB.health.observationIds);
});

test("incident identity remains stable within its correlation time bucket", () => {
  const resultA = engine().evaluateIncident(input());
  const resultB = engine().evaluateIncident(input({ health: [observation({
    observationId: "00000000-0000-4000-8000-000000000002",
    observedAtMs: NOW - 2000
  })] }));

  assert.equal(resultA.incidentId, resultB.incidentId);
});

test("enforces maximum observation count and strict plain-data input", () => {
  const instance = engine({ maxHealthObservations: 1 });
  assert.throws(() => instance.evaluateIncident(input({
    health: [observation(), observation({
      observationId: "00000000-0000-4000-8000-000000000002"
    })]
  })), /within its configured limit/);

  let getterCalls = 0;
  const hostile = { ...input() };
  Object.defineProperty(hostile.securityState, "state", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("getter must not run");
    }
  });
  assert.throws(() => engine().evaluateIncident(hostile), /without accessors/);
  assert.equal(getterCalls, 0);
});
