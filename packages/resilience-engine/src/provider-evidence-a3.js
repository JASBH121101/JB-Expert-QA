import {
  createHash,
  createPublicKey,
  verify as verifySignature
} from "node:crypto";

const SCHEMA = "jb.resilience.a3-provider-evidence/v1";
const KEY_SCHEMA = "jb.resilience.provider-trust-key/v1";
const CAPABILITY = "A3-controlled-failover";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const ROLES = Object.freeze([
  "external-monitor",
  "coordination-authority",
  "source-fencing-provider",
  "target-fencing-verifier",
  "replication-verifier",
  "target-readiness-verifier",
  "traffic-provider",
  "failover-verifier",
  "budget-authority"
]);
const ROLE_FACTS = Object.freeze({
  "external-monitor": Object.freeze(["independentExternalMonitor", "monitorQuorum"]),
  "coordination-authority": Object.freeze([
    "durableCoordination", "exclusiveUnexpiredLease", "monotonicFencing"
  ]),
  "source-fencing-provider": Object.freeze(["sourceFenced"]),
  "target-fencing-verifier": Object.freeze(["targetEnforcesFencing", "staleEpochRejected"]),
  "replication-verifier": Object.freeze(["replicationHealthy", "replicationWithinRpo"]),
  "target-readiness-verifier": Object.freeze(["targetReady", "dependenciesReady"]),
  "traffic-provider": Object.freeze(["trafficCutoverPrepared", "rollbackPrepared"]),
  "failover-verifier": Object.freeze(["postFailoverVerification"]),
  "budget-authority": Object.freeze(["budgetAvailable"])
});
const EXPECTED_FIELDS = Object.freeze([
  "assetId", "environment", "incidentId", "policyId", "policyRevision",
  "policyHash", "sourceId", "targetId", "leaseId", "fencingEpoch", "rpoMs"
]);
const UNSIGNED_FIELDS = Object.freeze([
  "schema", "attestationId", "providerId", "role", "capability",
  ...EXPECTED_FIELDS, "issuedAtMs", "expiresAtMs", "keyId", "keyVersion",
  "algorithm", "facts", "evidenceRefs"
]);
const ATTESTATION_FIELDS = Object.freeze([...UNSIGNED_FIELDS, "signature"]);
const VERIFIERS = new WeakSet();
const VERIFIED_BUNDLES = new WeakSet();\nconst VERIFIED_REFERENCES = new WeakSet();\nconst REFERENCE_BUNDLES = new WeakMap();

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, label) {
  if (!isRecord(value) || Object.getOwnPropertySymbols(value).length) {
    throw new TypeError(label + " must be a plain data object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new TypeError(label + " has missing or unsupported fields");
  }
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(label + " must not contain accessors or hidden fields");
    }
  }
}

function identifier(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new TypeError(label + " is invalid");
  }
  return value;
}

function timestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(label + " must be a non-negative safe integer");
  }
  return value;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) =>
    JSON.stringify(key) + ":" + canonicalJson(value[key])
  ).join(",") + "}";
}

function normalizeExpected(input) {
  exactKeys(input, EXPECTED_FIELDS, "expected A3 scope");
  const result = {
    assetId: identifier(input.assetId, IDENTIFIER, "assetId"),
    environment: identifier(input.environment, IDENTIFIER, "environment"),
    incidentId: identifier(input.incidentId, IDENTIFIER, "incidentId"),
    policyId: identifier(input.policyId, IDENTIFIER, "policyId"),
    policyRevision: input.policyRevision,
    policyHash: input.policyHash,
    sourceId: identifier(input.sourceId, IDENTIFIER, "sourceId"),
    targetId: identifier(input.targetId, IDENTIFIER, "targetId"),
    leaseId: identifier(input.leaseId, IDENTIFIER, "leaseId"),
    fencingEpoch: input.fencingEpoch,
    rpoMs: input.rpoMs
  };
  if (result.sourceId === result.targetId) throw new TypeError("source and target must differ");
  if (!Number.isSafeInteger(result.policyRevision) || result.policyRevision < 1 ||
      typeof result.policyHash !== "string" || !SHA256.test(result.policyHash) ||
      !Number.isSafeInteger(result.fencingEpoch) || result.fencingEpoch < 1 ||
      !Number.isSafeInteger(result.rpoMs) || result.rpoMs < 1 ||
      result.rpoMs > 86_400_000) {
    throw new TypeError("A3 policy, fencing or RPO scope is invalid");
  }
  return Object.freeze(result);
}

function normalizeFacts(input, role) {
  const expected = ROLE_FACTS[role];
  exactKeys(input, expected, "A3 evidence facts");
  const facts = Object.create(null);
  for (const key of expected) {
    if (typeof input[key] !== "boolean") throw new TypeError("A3 evidence facts must be booleans");
    facts[key] = input[key];
  }
  return Object.freeze(facts);
}

function normalizeEvidenceRefs(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 20 ||
      Object.getOwnPropertySymbols(input).length || Object.keys(input).length !== input.length) {
    throw new TypeError("evidenceRefs must contain 1 to 20 dense references");
  }
  const seen = new Set();
  const refs = [];
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError("evidenceRefs must not contain holes or accessors");
    }
    const ref = descriptor.value;
    exactKeys(ref, ["refId", "sha256"], "A3 evidence reference");
    const refId = identifier(ref.refId, /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/, "refId");
    if (seen.has(refId)) throw new TypeError("duplicate A3 evidence reference");
    seen.add(refId);
    if (typeof ref.sha256 !== "string" || !SHA256.test(ref.sha256)) {
      throw new TypeError("A3 evidence reference digest is invalid");
    }
    refs.push(Object.freeze({ refId, sha256: ref.sha256 }));
  }
  return Object.freeze(refs);
}

function normalizeUnsigned(input) {
  exactKeys(input, UNSIGNED_FIELDS, "A3 provider attestation");
  if (input.schema !== SCHEMA || input.capability !== CAPABILITY ||
      !ROLES.includes(input.role)) throw new TypeError("unsupported A3 attestation identity");
  const value = {
    schema: SCHEMA,
    attestationId: identifier(input.attestationId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, "attestationId"),
    providerId: identifier(input.providerId, IDENTIFIER, "providerId"),
    role: input.role,
    capability: CAPABILITY,
    ...normalizeExpected(Object.fromEntries(EXPECTED_FIELDS.map((key) => [key, input[key]]))),
    issuedAtMs: timestamp(input.issuedAtMs, "issuedAtMs"),
    expiresAtMs: timestamp(input.expiresAtMs, "expiresAtMs"),
    keyId: identifier(input.keyId, KEY_ID, "keyId"),
    keyVersion: input.keyVersion,
    algorithm: input.algorithm,
    facts: normalizeFacts(input.facts, input.role),
    evidenceRefs: normalizeEvidenceRefs(input.evidenceRefs)
  };
  if (value.expiresAtMs <= value.issuedAtMs ||
      !Number.isSafeInteger(value.keyVersion) || value.keyVersion < 1 ||
      value.algorithm !== "Ed25519") {
    throw new TypeError("A3 attestation validity or key metadata is invalid");
  }
  return Object.freeze(value);
}

function normalizeAttestation(input) {
  exactKeys(input, ATTESTATION_FIELDS, "A3 provider attestation");
  const unsigned = Object.create(null);
  for (const key of UNSIGNED_FIELDS) unsigned[key] = input[key];
  const value = normalizeUnsigned(unsigned);
  if (typeof input.signature !== "string" || !SIGNATURE.test(input.signature)) {
    throw new TypeError("A3 signature must be canonical Ed25519 base64url");
  }
  const bytes = Buffer.from(input.signature, "base64url");
  if (bytes.length !== 64 || bytes.toString("base64url") !== input.signature) {
    throw new TypeError("A3 signature encoding is invalid");
  }
  return Object.freeze({ ...value, signature: input.signature, signatureBytes: bytes });
}

function normalizeKey(input) {
  exactKeys(input, [
    "schema", "keyId", "keyVersion", "algorithm", "publicKeyPem",
    "providerId", "role", "status", "notBeforeMs", "expiresAtMs", "capabilities"
  ], "A3 provider trust key");
  if (input.schema !== KEY_SCHEMA || input.algorithm !== "Ed25519" ||
      !ROLES.includes(input.role) || input.status !== "active" ||
      typeof input.publicKeyPem !== "string" || input.publicKeyPem.length < 64 ||
      input.publicKeyPem.length > 4096 || !Array.isArray(input.capabilities) ||
      input.capabilities.length !== 1 || input.capabilities[0] !== CAPABILITY) {
    throw new TypeError("A3 provider trust key is invalid");
  }
  const keyId = identifier(input.keyId, KEY_ID, "keyId");
  const providerId = identifier(input.providerId, IDENTIFIER, "providerId");
  if (!Number.isSafeInteger(input.keyVersion) || input.keyVersion < 1) {
    throw new TypeError("A3 provider key version is invalid");
  }
  const notBeforeMs = timestamp(input.notBeforeMs, "key notBeforeMs");
  const expiresAtMs = timestamp(input.expiresAtMs, "key expiresAtMs");
  if (expiresAtMs <= notBeforeMs) throw new TypeError("A3 key validity is invalid");
  const publicKey = createPublicKey(input.publicKeyPem);
  if (publicKey.asymmetricKeyType !== "ed25519") throw new TypeError("A3 key must be Ed25519");
  const materialFingerprint = createHash("sha256").update(canonicalJson({
    keyId, keyVersion: input.keyVersion, publicKeyPem: input.publicKeyPem,
    providerId, role: input.role, notBeforeMs, expiresAtMs
  }), "utf8").digest("hex");
  return Object.freeze({
    keyId, keyVersion: input.keyVersion, publicKey, providerId,
    role: input.role, notBeforeMs, expiresAtMs, materialFingerprint
  });
}

export function createA3ProviderEvidenceSigningPayload(input) {
  return canonicalJson(normalizeUnsigned(input));
}

export function createA3ProviderEvidenceVerifier({
  resolveTrustedProviderKey,
  clock = Date.now,
  maxAgeMs = 30_000,
  maxLifetimeMs = 60_000,
  maxFutureSkewMs = 5_000
} = {}) {
  if (typeof resolveTrustedProviderKey !== "function" || typeof clock !== "function") {
    throw new TypeError("host-owned provider key resolver and clock are required");
  }
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1_000 || maxAgeMs > 300_000 ||
      !Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs < 1_000 || maxLifetimeMs > 300_000 ||
      !Number.isSafeInteger(maxFutureSkewMs) || maxFutureSkewMs < 0 || maxFutureSkewMs > 30_000) {
    throw new TypeError("A3 evidence freshness limits are invalid");
  }
  const observed = new Map();

  function verify(input, expectedInput) {
    try {
      const now = timestamp(clock(), "A3 verifier clock");
      const attestation = normalizeAttestation(input);
      const expected = normalizeExpected(expectedInput);
      for (const key of EXPECTED_FIELDS) {
        if (attestation[key] !== expected[key]) {
          return Object.freeze({ verified: false, reason: "scope-mismatch" });
        }
      }
      if (attestation.issuedAtMs > now + maxFutureSkewMs ||
          now - attestation.issuedAtMs > maxAgeMs ||
          attestation.expiresAtMs <= now ||
          attestation.expiresAtMs - attestation.issuedAtMs > maxLifetimeMs) {
        return Object.freeze({ verified: false, reason: "stale-or-expired-evidence" });
      }
      const resolved = resolveTrustedProviderKey(attestation.keyId);
      if (!resolved || typeof resolved.then === "function") {
        return Object.freeze({ verified: false, reason: "trusted-key-unavailable" });
      }
      const key = normalizeKey(resolved);
      if (key.keyId !== attestation.keyId || key.keyVersion !== attestation.keyVersion ||
          key.providerId !== attestation.providerId || key.role !== attestation.role) {
        return Object.freeze({ verified: false, reason: "provider-key-binding-mismatch" });
      }
      const previous = observed.get(key.keyId);
      if (previous && (key.keyVersion < previous.keyVersion ||
          (key.keyVersion === previous.keyVersion && key.materialFingerprint !== previous.fingerprint) ||
          (key.keyVersion > previous.keyVersion && key.providerId !== previous.providerId))) {
        return Object.freeze({ verified: false, reason: "provider-key-rollback-or-substitution" });
      }
      observed.set(key.keyId, { keyVersion: key.keyVersion, fingerprint: key.materialFingerprint, providerId: key.providerId });
      if (now < key.notBeforeMs || now >= key.expiresAtMs) {
        return Object.freeze({ verified: false, reason: "provider-key-inactive" });
      }
      const payload = createA3ProviderEvidenceSigningPayload(
        Object.fromEntries(UNSIGNED_FIELDS.map((field) => [field, attestation[field]]))
      );
      if (verifySignature(null, Buffer.from(payload, "utf8"), key.publicKey, attestation.signatureBytes) !== true) {
        return Object.freeze({ verified: false, reason: "signature-invalid" });
      }
      return Object.freeze({
        verified: true,
        attestationId: attestation.attestationId,
        providerId: attestation.providerId,
        role: attestation.role,
        keyId: attestation.keyId,
        keyVersion: attestation.keyVersion,
        issuedAtMs: attestation.issuedAtMs,
        expiresAtMs: attestation.expiresAtMs,
        facts: attestation.facts,
        evidenceRefs: attestation.evidenceRefs
      });
    } catch {
      return Object.freeze({ verified: false, reason: "invalid-provider-evidence" });
    }
  }

  const verifier = Object.freeze({ algorithm: "Ed25519", capability: CAPABILITY, verify });
  VERIFIERS.add(verifier);
  return verifier;
}

export function verifyA3ProviderEvidenceBundle({ attestations, expected, verifier } = {}) {
  const denied = (reason, extra = {}) => Object.freeze({
    schema: "jb.resilience.a3-provider-evidence-bundle/v1",
    verified: false,
    executable: false,
    reason,
    ...extra
  });
  if (!Array.isArray(attestations) || attestations.length !== ROLES.length ||
      Object.getOwnPropertySymbols(attestations).length ||
      Object.keys(attestations).length !== attestations.length || !VERIFIERS.has(verifier)) {
    return denied("invalid-provider-evidence-bundle");
  }
  let scope;
  try {
    scope = normalizeExpected(expected);
  } catch {
    return denied("invalid-expected-scope");
  }
  const byRole = new Map();
  const results = [];
  for (let index = 0; index < attestations.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(attestations, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      return denied("invalid-provider-evidence-bundle");
    }
    let result;
    try {
      result = verifier.verify(descriptor.value, scope);
    } catch {
      return denied("provider-attestation-rejected");
    }
    if (!isRecord(result) || result.verified !== true || !ROLES.includes(result.role)) {
      return denied("provider-attestation-rejected", {
        detail: isRecord(result) ? result.reason : "invalid-provider-evidence"
      });
    }
    if (byRole.has(result.role)) return denied("duplicate-provider-role", { deniedRole: result.role });
    byRole.set(result.role, result);
    results.push(result);
  }
  if (ROLES.some((role) => !byRole.has(role))) return denied("required-provider-role-missing");

  if (byRole.get("external-monitor").providerId === scope.sourceId ||
      byRole.get("external-monitor").providerId === scope.targetId) {
    return denied("external-monitor-must-be-outside-failover-endpoints");
  }

  const independentPairs = [
    ["traffic-provider", "failover-verifier"],
    ["traffic-provider", "target-fencing-verifier"],
    ["source-fencing-provider", "target-fencing-verifier"],
    ["coordination-authority", "failover-verifier"]
  ];
  for (const [left, right] of independentPairs) {
    if (byRole.get(left).providerId === byRole.get(right).providerId) {
      return denied("independent-provider-identity-required", { roles: [left, right] });
    }
  }

  const facts = Object.create(null);
  for (const result of results) Object.assign(facts, result.facts);
  const observedAtMs = Math.min(...results.map((entry) => entry.issuedAtMs));
  const expiresAtMs = Math.min(...results.map((entry) => entry.expiresAtMs));
  if (expiresAtMs <= observedAtMs) return denied("evidence-windows-do-not-overlap");

  const bundle = Object.freeze({
    schema: "jb.resilience.a3-provider-evidence-bundle/v1",
    verified: true,
    executable: false,
    scope,
    facts: Object.freeze(facts),
    observedAtMs,
    expiresAtMs,
    providers: Object.freeze(results.map((result) => Object.freeze({
      providerId: result.providerId,
      role: result.role,
      keyId: result.keyId,
      keyVersion: result.keyVersion,
      attestationId: result.attestationId,
      evidenceRefs: result.evidenceRefs
    })))
  });
  VERIFIED_BUNDLES.add(bundle);
  return bundle;
}

/**
 * Verify the raw bytes behind each signed A3 evidence reference. The host
 * resolver must fetch from authoritative monitor/provider systems. This
 * validates scope and digest, not the semantic truth of the evidence.
 */
export async function verifyA3EvidenceReferences({
  bundle,
  resolveEvidenceReference,
  clock = Date.now,
  maxReferenceBytes = 10 * 1024 * 1024,
  maxTotalBytes = 50 * 1024 * 1024,
  timeoutMs = 5_000
} = {}) {
  const denied = (reason) => Object.freeze({
    schema: "jb.resilience.a3-evidence-reference-verification/v1",
    verified: false,
    executable: false,
    reason
  });
  if (!VERIFIED_BUNDLES.has(bundle) ||
      typeof resolveEvidenceReference !== "function" ||
      typeof clock !== "function" ||
      !Number.isSafeInteger(maxReferenceBytes) || maxReferenceBytes < 1 ||
      maxReferenceBytes > 25 * 1024 * 1024 ||
      !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < maxReferenceBytes ||
      maxTotalBytes > 100 * 1024 * 1024 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    return denied("invalid-evidence-reference-verification-input");
  }
  let now;
  try { now = timestamp(clock(), "A3 evidence verifier clock"); }
  catch { return denied("invalid-evidence-reference-clock"); }
  if (now < bundle.observedAtMs || now >= bundle.expiresAtMs) {
    return denied("provider-evidence-stale-or-expired");
  }

  const references = [];
  let totalBytes = 0;
  for (const provider of bundle.providers) {
    for (const reference of provider.evidenceRefs) {
      if (references.length >= 180) return denied("evidence-reference-count-exceeded");
      const controller = new AbortController();
      let timer;
      let timedOut = false;
      const pending = Promise.resolve().then(() => resolveEvidenceReference(Object.freeze({
        refId: reference.refId,
        sha256: reference.sha256,
        providerId: provider.providerId,
        role: provider.role,
        scope: bundle.scope,
        signal: controller.signal
      })));
      pending.catch(() => {});
      const deadline = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new Error("A3 evidence lookup timed out"));
        }, timeoutMs);
      });
      let resolved;
      try { resolved = await Promise.race([pending, deadline]); }
      catch { return denied(timedOut ? "evidence-reference-timeout" : "evidence-reference-unavailable"); }
      finally { clearTimeout(timer); }

      try { now = timestamp(clock(), "A3 evidence verifier clock"); }
      catch { return denied("invalid-evidence-reference-clock"); }
      if (now < bundle.observedAtMs || now >= bundle.expiresAtMs) {
        return denied("provider-evidence-stale-or-expired");
      }

      try {
        exactKeys(resolved, [
          "providerId", "role", ...EXPECTED_FIELDS, "bytes"
        ], "resolved A3 evidence reference");
      } catch { return denied("invalid-resolved-evidence-reference"); }

      if (resolved.providerId !== provider.providerId || resolved.role !== provider.role ||
          EXPECTED_FIELDS.some((key) => resolved[key] !== bundle.scope[key])) {
        return denied("evidence-reference-scope-mismatch");
      }
      if (!(resolved.bytes instanceof Uint8Array)) return denied("invalid-evidence-reference-bytes");
      const bytes = Buffer.from(resolved.bytes);
      if (bytes.length < 1 || bytes.length > maxReferenceBytes ||
          totalBytes + bytes.length > maxTotalBytes) {
        return denied("evidence-reference-size-limit-exceeded");
      }
      const actualSha256 = createHash("sha256").update(bytes).digest("hex");
      if (actualSha256 !== reference.sha256) return denied("evidence-reference-digest-mismatch");
      totalBytes += bytes.length;
      references.push(Object.freeze({
        refId: reference.refId,
        providerId: provider.providerId,
        role: provider.role,
        sha256: actualSha256,
        size: bytes.length
      }));
    }
  }
  try { now = timestamp(clock(), "A3 evidence verifier clock"); }
  catch { return denied("invalid-evidence-reference-clock"); }
  if (now < bundle.observedAtMs || now >= bundle.expiresAtMs) {
    return denied("provider-evidence-stale-or-expired");
  }
  const verification = Object.freeze({
    schema: "jb.resilience.a3-evidence-reference-verification/v1",
    verified: true,
    executable: false,
    scope: bundle.scope,
    referenceCount: references.length,
    totalBytes,
    verifiedAtMs: now,
    references: Object.freeze(references)
  });
  VERIFIED_REFERENCES.add(verification);
  REFERENCE_BUNDLES.set(verification, bundle);
  return verification;
}

/**
 * Feed only an A3 bundle and reference result produced by this module into
 * the existing read-only continuity gates. This is readiness, never authority.
 */
export function evaluateA3ProviderReadiness({
  bundle,
  references,
  clock = Date.now
} = {}) {
  const denied = (reason) => Object.freeze({
    schema: "jb.resilience.continuity-readiness/v1",
    capability: "A3-controlled-failover",
    eligible: false,
    denied: Object.freeze(["providerEvidence"]),
    reason,
    executable: false
  });
  if (!VERIFIED_BUNDLES.has(bundle) || !VERIFIED_REFERENCES.has(references) ||
      REFERENCE_BUNDLES.get(references) !== bundle || typeof clock !== "function") {
    return denied("verified-a3-bundle-and-matching-reference-check-required");
  }
  let now;
  try { now = timestamp(clock(), "A3 readiness clock"); }
  catch { return denied("invalid-a3-readiness-clock"); }
  if (now < bundle.observedAtMs || now >= bundle.expiresAtMs ||
      references.verifiedAtMs < bundle.observedAtMs ||
      references.verifiedAtMs >= bundle.expiresAtMs ||
      now < references.verifiedAtMs) {
    return denied("provider-evidence-stale-or-expired");
  }

  const requiredFacts = [
    "independentExternalMonitor",
    "monitorQuorum",
    "durableCoordination",
    "exclusiveUnexpiredLease",
    "monotonicFencing",
    "targetEnforcesFencing",
    "sourceFenced",
    "replicationHealthy",
    "replicationWithinRpo",
    "targetReady",
    "dependenciesReady",
    "trafficCutoverPrepared",
    "rollbackPrepared",
    "postFailoverVerification",
    "budgetAvailable"
  ];
  const evidence = Object.create(null);
  for (const fact of requiredFacts) evidence[fact] = bundle.facts[fact] === true;
  evidence.observedAt = bundle.observedAtMs;
  evidence.expiresAt = bundle.expiresAtMs;
  evidence.now = now;
  return evaluateA3FailoverReadiness(evidence);
}

export const A3_PROVIDER_EVIDENCE_ROLES = ROLES;
