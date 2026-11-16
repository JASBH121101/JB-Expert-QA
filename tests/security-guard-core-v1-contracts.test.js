import test from "node:test";
import assert from "node:assert/strict";
import {
  SECURITY_GUARD_CORE_V1_SCHEMAS,
  validateAuthenticationAttemptV1,
  validateAuthenticationDecisionV1,
  validateSecurityEventV1,
  validateRateLimitPolicyV1,
  validateThreatSignalV1,
  validateThreatAssessmentV1,
  validateThreatAssessmentPolicyV1,
  toAuthenticationDecisionV1
} from "@jb/security-guard/core-contract-v1";

const uuid = "5f4c1f7e-0f5c-4f5c-8f6a-6f7b6e1f4c21";
const uuid2 = "8e3a7f0c-2a91-4db4-a35c-cb7f23a0e155";
const digest = "a".repeat(64);

const attempt = () => ({
  schema: "jb.security.authentication.attempt/v1",
  attemptId: uuid,
  tenantId: "tenant-demo",
  applicationId: "catalog-api",
  operation: "login",
  outcome: "failure",
  occurredAtMs: 1794839271000,
  account: { key: digest, keyId: "account-key-2026" },
  client: { key: digest, keyId: "client-key-2026" }
});

const authDecision = (overrides = {}) => ({
  schema: "jb.security.authentication.decision/v1",
  attemptId: uuid,
  outcome: "deny",
  enforced: true,
  status: 429,
  retryAfterSeconds: 30,
  ...overrides
});

const event = () => ({
  schema: "jb.security.event/v1",
  eventId: uuid,
  occurredAtMs: 1794839271000,
  tenantId: "tenant-demo",
  applicationId: "catalog-api",
  producer: "security-guard-js",
  category: "authentication",
  ruleId: "JBG-AUTH-BRUTE-001",
  severity: "high",
  action: "blocked",
  outcome: "denied",
  subjectKey: digest,
  subjectKeyId: "identity-key-2026",
  scope: "account_ip",
  correlationId: uuid2
});

const policy = () => ({
  schema: "jb.security.policy.rate-limit/v1",
  id: "auth-login",
  tenantId: "tenant-demo",
  applicationId: "catalog-api",
  version: 1,
  enabled: true,
  mode: "enforce",
  failureMode: "closed",
  limits: [{
    id: "login-account-ip",
    identityType: "account_ip",
    scope: "login",
    windowSeconds: 60,
    maxRequests: 5
  }]
});

const signal = () => ({
  schema: "jb.security.threat-signal/v1",
  signalId: uuid,
  tenantId: "tenant-demo",
  applicationId: "catalog-api",
  detectedAtMs: 1794839271000,
  source: "js-inspector",
  type: "brute_force",
  confidence: 0.82,
  severity: "high",
  ruleId: "JBG-AUTH-BRUTE-001",
  subjectKey: digest,
  subjectKeyId: "identity-key-2026",
  routeTemplate: "/api/auth/{action}",
  evidenceCount: 12
});

const assessment = () => ({
  schema: "jb.security.threat-assessment/v1",
  assessmentId: uuid2,
  tenantId: "tenant-demo",
  applicationId: "catalog-api",
  assessedAtMs: 1794839271000,
  riskScore: 75,
  decision: "challenge",
  signalIds: [uuid],
  policyId: "auth-risk-v1"
});

test("Core v1 schema identifiers are exposed as immutable metadata", () => {
  assert.equal(SECURITY_GUARD_CORE_V1_SCHEMAS.authenticationAttempt, "jb.security.authentication.attempt/v1");
  assert.equal(Object.isFrozen(SECURITY_GUARD_CORE_V1_SCHEMAS), true);
});

test("authentication attempt accepts opaque identifiers and clones nested data", () => {
  const input = attempt();
  const validated = validateAuthenticationAttemptV1(input);
  assert.equal(validated.account.key, digest);
  assert.notEqual(validated.account, input.account);
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.account), true);
  assert.equal(Object.isFrozen(validated.client), true);
  assert.throws(() => { validated.account.key = "changed"; }, TypeError);
});

test("authentication attempt permits a missing client only as a null key/keyId pair", () => {
  const validated = validateAuthenticationAttemptV1({
    ...attempt(),
    client: { key: null, keyId: null }
  });
  assert.equal(validated.client.key, null);
  assert.throws(() => validateAuthenticationAttemptV1({
    ...attempt(), client: { key: null, keyId: "client-key" }
  }));
  assert.throws(() => validateAuthenticationAttemptV1({
    ...attempt(), client: { key: digest, keyId: null }
  }));
});

test("authentication attempt rejects raw identifiers, unknown fields and invalid operations", () => {
  assert.throws(() => validateAuthenticationAttemptV1({
    ...attempt(), account: { key: "192.0.2.10", keyId: "account-key" }
  }));
  assert.throws(() => validateAuthenticationAttemptV1({ ...attempt(), password: "do-not-export" }));
  assert.throws(() => validateAuthenticationAttemptV1({ ...attempt(), operation: "unknown" }));
  assert.throws(() => validateAuthenticationAttemptV1({ ...attempt(), occurredAtMs: -1 }));
  assert.throws(() => validateAuthenticationAttemptV1({ ...attempt(), tenantId: "../tenant" }));
});

test("authentication decision requires coherent allow, monitor, deny and unavailable semantics", () => {
  assert.equal(validateAuthenticationDecisionV1(authDecision()).status, 429);
  assert.equal(validateAuthenticationDecisionV1(authDecision({
    outcome: "allow", enforced: false, status: null, retryAfterSeconds: null
  })).outcome, "allow");
  assert.equal(validateAuthenticationDecisionV1(authDecision({
    outcome: "monitor", enforced: false, status: null, retryAfterSeconds: 10
  })).retryAfterSeconds, 10);
  assert.equal(validateAuthenticationDecisionV1(authDecision({
    outcome: "unavailable", enforced: true, status: 503
  })).status, 503);
  assert.throws(() => validateAuthenticationDecisionV1(authDecision({ outcome: "deny", status: 503 })));
  assert.throws(() => validateAuthenticationDecisionV1(authDecision({ outcome: "monitor", enforced: true })));
  assert.throws(() => validateAuthenticationDecisionV1(authDecision({ outcome: "allow", retryAfterSeconds: 1 })));
  assert.throws(() => validateAuthenticationDecisionV1(authDecision({ retryAfterSeconds: 3601 })));
});

test("authentication decision builder binds the trusted attempt id and validates output", () => {
  assert.deepEqual(toAuthenticationDecisionV1(uuid, {
    outcome: "deny", enforced: true, status: 429, retryAfterSeconds: 15
  }), authDecision({ retryAfterSeconds: 15 }));
  assert.throws(() => toAuthenticationDecisionV1("raw-user-id", {
    outcome: "deny", enforced: true, status: 429, retryAfterSeconds: 15
  }));
  assert.throws(() => toAuthenticationDecisionV1(uuid, {
    outcome: "allow", enforced: true, status: 429, retryAfterSeconds: 15, extra: true
  }));
});

test("security event accepts bounded metadata and opaque subject keys", () => {
  const validated = validateSecurityEventV1(event());
  assert.equal(validated.category, "authentication");
  assert.equal(Object.isFrozen(validated), true);
});

test("security event rejects raw data, unknown keys and orphaned subject hashes", () => {
  assert.throws(() => validateSecurityEventV1({ ...event(), remoteAddress: "192.0.2.10" }));
  assert.throws(() => validateSecurityEventV1({ ...event(), subjectKey: "192.0.2.10" }));
  const orphan = event();
  delete orphan.subjectKeyId;
  assert.throws(() => validateSecurityEventV1(orphan));
  assert.throws(() => validateSecurityEventV1({ ...event(), requestBody: "password=..." }));
  assert.throws(() => validateSecurityEventV1({ ...event(), producer: "Security Guard" }));
});

test("rate-limit policy validates tenant isolation, explicit failure mode and bounded limits", () => {
  const validated = validateRateLimitPolicyV1(policy());
  assert.equal(validated.limits[0].maxRequests, 5);
  assert.equal(Object.isFrozen(validated.limits), true);
  assert.equal(Object.isFrozen(validated.limits[0]), true);
});

test("rate-limit policy rejects implicit fail mode, invalid bounds and extra fields", () => {
  assert.throws(() => validateRateLimitPolicyV1({ ...policy(), failureMode: "maybe" }));
  assert.throws(() => validateRateLimitPolicyV1({
    ...policy(), limits: [{ ...policy().limits[0], maxRequests: 0 }]
  }));
  assert.throws(() => validateRateLimitPolicyV1({ ...policy(), owner: "browser" }));
  assert.throws(() => validateRateLimitPolicyV1({ ...policy(), limits: [] }));
  assert.throws(() => validateRateLimitPolicyV1({ ...policy(), tenantId: "tenant one" }));
});

test("threat signal accepts bounded evidence without turning a signal into a decision", () => {
  const validated = validateThreatSignalV1(signal());
  assert.equal(validated.type, "brute_force");
  assert.equal(validated.confidence, 0.82);
  assert.equal(Object.isFrozen(validated), true);
});

test("threat signal validates confidence, route templates, HMAC pairing and input allow-list", () => {
  assert.throws(() => validateThreatSignalV1({ ...signal(), confidence: 1.01 }));
  assert.throws(() => validateThreatSignalV1({ ...signal(), confidence: Number.NaN }));
  assert.throws(() => validateThreatSignalV1({ ...signal(), routeTemplate: "/users/123?token=x" }));
  const orphan = signal();
  delete orphan.subjectKeyId;
  assert.throws(() => validateThreatSignalV1(orphan));
  assert.throws(() => validateThreatSignalV1({ ...signal(), rawIp: "192.0.2.10" }));
});

test("threat assessment combines unique signal references with bounded risk score", () => {
  assert.equal(validateThreatAssessmentV1(assessment()).decision, "challenge");
  assert.throws(() => validateThreatAssessmentV1({
    ...assessment(), signalIds: [uuid, uuid]
  }));
  assert.throws(() => validateThreatAssessmentV1({
    ...assessment(), signalIds: []
  }));
  assert.throws(() => validateThreatAssessmentV1({
    ...assessment(), riskScore: 101
  }));
  assert.throws(() => validateThreatAssessmentV1({
    ...assessment(), decision: "auto_block"
  }));
});


const assessmentPolicy = () => ({
  schema: "jb.security.policy.threat-assessment/v1",
  id: "default-threat-policy",
  tenantId: "tenant-demo",
  applicationId: "catalog-api",
  version: 1,
  enabled: true,
  windowMs: 300000,
  maxSignals: 32,
  minimumConfidence: 0.5,
  severityWeights: { info: 5, low: 15, medium: 35, high: 65, critical: 90 },
  typeWeights: {
    brute_force: 100, endpoint_scan: 90, enumeration: 80, sql_injection: 110,
    parameter_tampering: 100, api_abuse: 95, bot_traffic: 75, anomaly: 50, upload_risk: 100
  },
  thresholds: { challenge: 35, review: 60, block: 85 },
  blockRequirements: {
    minSignals: 3, minDistinctRules: 2, minDistinctTypes: 2, minimumConfidence: 0.9
  }
});

test("threat assessment policy validates explicit weights, thresholds and independent evidence gates", () => {
  const validated = validateThreatAssessmentPolicyV1(assessmentPolicy());
  assert.equal(validated.thresholds.block, 85);
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.typeWeights), true);
  assert.equal(Object.isFrozen(validated.blockRequirements), true);
});

test("threat assessment policy rejects unsafe or ambiguous configuration", () => {
  assert.throws(() => validateThreatAssessmentPolicyV1({
    ...assessmentPolicy(), thresholds: { challenge: 80, review: 60, block: 85 }
  }), /challenge <= review <= block/);
  assert.throws(() => validateThreatAssessmentPolicyV1({
    ...assessmentPolicy(), blockRequirements: { ...assessmentPolicy().blockRequirements, minSignals: 1 }
  }), /minSignals/);
  assert.throws(() => validateThreatAssessmentPolicyV1({
    ...assessmentPolicy(), maxSignals: 2
  }), /counts must fit/);
  assert.throws(() => validateThreatAssessmentPolicyV1({
    ...assessmentPolicy(), typeWeights: { ...assessmentPolicy().typeWeights, unknown: 100 }
  }), /unsupported field/);
  assert.throws(() => validateThreatAssessmentPolicyV1({
    ...assessmentPolicy(), blockRequirements: {
      ...assessmentPolicy().blockRequirements, minimumConfidence: 0.2
    }
  }), /minimumConfidence must be from/);
});
