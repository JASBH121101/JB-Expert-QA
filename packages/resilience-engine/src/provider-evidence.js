import {
  createHash,
  createPublicKey,
  verify as verifySignature
} from "node:crypto";

const KEY_SCHEMA = "jb.resilience.provider-trust-key/v1";
const ATTESTATION_SCHEMA = "jb.resilience.provider-evidence/v1";
const BUNDLE_SCHEMA = "jb.resilience.a2-provider-evidence/v1";
const CAPABILITY = "A2-bounded-containment";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const BASE64URL_SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const ROLES = Object.freeze([
  "policy-authority",
  "containment-provider",
  "containment-verifier",
  "forensic-recorder",
  "budget-authority"
]);
const ROLE_FACTS = Object.freeze({
  "policy-authority": Object.freeze(["ownerApprovedProfile"]),
  "containment-provider": Object.freeze(["reversibleAdapter", "rollbackPlan"]),
  "containment-verifier": Object.freeze(["independentContainmentVerification"]),
  "forensic-recorder": Object.freeze(["forensicEvidencePreserved"]),
  "budget-authority": Object.freeze(["budgetAvailable"])
});
const KEY_FIELDS = [
  "schema", "keyId", "keyVersion", "algorithm", "publicKeyPem",
  "providerId", "role", "status", "notBeforeMs", "expiresAtMs", "capabilities"
];
const ATTESTATION_UNSIGNED_FIELDS = [
  "schema", "attestationId", "providerId", "role", "capability", "assetId",
  "environment", "incidentId", "policyId", "policyRevision", "policyHash",
  "issuedAtMs", "expiresAtMs", "keyId", "keyVersion", "algorithm",
  "facts", "evidenceRefs"
];
const ATTESTATION_FIELDS = [...ATTESTATION_UNSIGNED_FIELDS, "signature"];
const PROVIDER_VERIFIER_BRAND = Symbol("JB Resilience provider evidence verifier");
const EXPECTED_FIELDS = [
  "assetId", "environment", "incidentId", "policyId", "policyRevision", "policyHash"
];

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

function assertIdentifier(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new TypeError(label + " is invalid");
  }
  return value;
}

function assertTimestamp(value, label) {
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

function normalizeFacts(input, role) {
  const expected = ROLE_FACTS[role];
  exactKeys(input, expected, "provider evidence facts");
  const facts = Object.create(null);
  for (const key of expected) {
    if (typeof input[key] !== "boolean") {
      throw new TypeError("provider evidence facts must be booleans");
    }
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
    exactKeys(ref, ["refId", "sha256"], "evidence reference");
    const refId = assertIdentifier(ref.refId, /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/, "evidence refId");
    if (seen.has(refId)) throw new TypeError("evidenceRefs must not contain duplicate refIds");
    seen.add(refId);
    if (typeof ref.sha256 !== "string" || !SHA256.test(ref.sha256)) {
      throw new TypeError("evidence reference sha256 is invalid");
    }
    refs.push(Object.freeze({ refId, sha256: ref.sha256 }));
  }
  return Object.freeze(refs);
}

function normalizeExpected(input) {
  exactKeys(input, EXPECTED_FIELDS, "expected provider evidence scope");
  const expected = {
    assetId: assertIdentifier(input.assetId, IDENTIFIER, "assetId"),
    environment: assertIdentifier(input.environment, IDENTIFIER, "environment"),
    incidentId: assertIdentifier(input.incidentId, IDENTIFIER, "incidentId"),
    policyId: assertIdentifier(input.policyId, IDENTIFIER, "policyId"),
    policyRevision: input.policyRevision,
    policyHash: input.policyHash
  };
  if (!Number.isSafeInteger(expected.policyRevision) || expected.policyRevision < 1) {
    throw new TypeError("policyRevision must be a positive safe integer");
  }
  if (typeof expected.policyHash !== "string" || !SHA256.test(expected.policyHash)) {
    throw new TypeError("policyHash is invalid");
  }
  return Object.freeze(expected);
}

function normalizeUnsignedAttestation(input) {
  exactKeys(input, ATTESTATION_UNSIGNED_FIELDS, "provider evidence attestation");
  if (input.schema !== ATTESTATION_SCHEMA) throw new TypeError("unsupported provider evidence schema");
  const attestationId = assertIdentifier(input.attestationId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, "attestationId");
  const providerId = assertIdentifier(input.providerId, IDENTIFIER, "providerId");
  if (!ROLES.includes(input.role)) throw new TypeError("provider role is invalid");
  if (input.capability !== CAPABILITY) throw new TypeError("unsupported provider capability");
  const assetId = assertIdentifier(input.assetId, IDENTIFIER, "assetId");
  const environment = assertIdentifier(input.environment, IDENTIFIER, "environment");
  const incidentId = assertIdentifier(input.incidentId, IDENTIFIER, "incidentId");
  const policyId = assertIdentifier(input.policyId, IDENTIFIER, "policyId");
  if (!Number.isSafeInteger(input.policyRevision) || input.policyRevision < 1) {
    throw new TypeError("policyRevision must be a positive safe integer");
  }
  if (typeof input.policyHash !== "string" || !SHA256.test(input.policyHash)) {
    throw new TypeError("policyHash is invalid");
  }
  const issuedAtMs = assertTimestamp(input.issuedAtMs, "issuedAtMs");
  const expiresAtMs = assertTimestamp(input.expiresAtMs, "expiresAtMs");
  if (expiresAtMs <= issuedAtMs) throw new TypeError("provider evidence validity window is invalid");
  const keyId = assertIdentifier(input.keyId, KEY_ID, "keyId");
  if (!Number.isSafeInteger(input.keyVersion) || input.keyVersion < 1) {
    throw new TypeError("keyVersion must be a positive safe integer");
  }
  if (input.algorithm !== "Ed25519") throw new TypeError("provider evidence must use Ed25519");
  return Object.freeze({
    schema: ATTESTATION_SCHEMA,
    attestationId,
    providerId,
    role: input.role,
    capability: CAPABILITY,
    assetId,
    environment,
    incidentId,
    policyId,
    policyRevision: input.policyRevision,
    policyHash: input.policyHash,
    issuedAtMs,
    expiresAtMs,
    keyId,
    keyVersion: input.keyVersion,
    algorithm: "Ed25519",
    facts: normalizeFacts(input.facts, input.role),
    evidenceRefs: normalizeEvidenceRefs(input.evidenceRefs)
  });
}

function normalizeAttestation(input) {
  exactKeys(input, ATTESTATION_FIELDS, "provider evidence attestation");
  const unsigned = Object.create(null);
  for (const key of ATTESTATION_UNSIGNED_FIELDS) unsigned[key] = input[key];
  const normalized = normalizeUnsignedAttestation(unsigned);
  if (typeof input.signature !== "string" || !BASE64URL_SIGNATURE.test(input.signature)) {
    throw new TypeError("provider evidence signature must be canonical Ed25519 base64url");
  }
  const signatureBytes = Buffer.from(input.signature, "base64url");
  if (signatureBytes.length !== 64 || signatureBytes.toString("base64url") !== input.signature) {
    throw new TypeError("provider evidence signature encoding is invalid");
  }
  return Object.freeze({ ...normalized, signature: input.signature, signatureBytes });
}

function normalizeTrustedKey(input) {
  exactKeys(input, KEY_FIELDS, "trusted provider key");
  if (input.schema !== KEY_SCHEMA) throw new TypeError("unsupported provider trust-key schema");
  const keyId = assertIdentifier(input.keyId, KEY_ID, "keyId");
  if (!Number.isSafeInteger(input.keyVersion) || input.keyVersion < 1) {
    throw new TypeError("keyVersion must be a positive safe integer");
  }
  if (input.algorithm !== "Ed25519") throw new TypeError("trusted provider key must use Ed25519");
  if (typeof input.publicKeyPem !== "string" ||
      input.publicKeyPem.length < 64 || input.publicKeyPem.length > 8192 ||
      !/^\s*-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----\s*$/.test(input.publicKeyPem)) {
    throw new TypeError("provider public key must be PEM encoded");
  }
  const providerId = assertIdentifier(input.providerId, IDENTIFIER, "providerId");
  if (!ROLES.includes(input.role)) throw new TypeError("trusted provider key role is invalid");
  if (!["active", "revoked", "suspended"].includes(input.status)) {
    throw new TypeError("trusted provider key status is invalid");
  }
  const notBeforeMs = assertTimestamp(input.notBeforeMs, "notBeforeMs");
  const expiresAtMs = assertTimestamp(input.expiresAtMs, "expiresAtMs");
  if (expiresAtMs <= notBeforeMs) throw new TypeError("provider key validity window is invalid");
  if (!Array.isArray(input.capabilities) || input.capabilities.length !== 1 ||
      input.capabilities[0] !== CAPABILITY || Object.getOwnPropertySymbols(input.capabilities).length ||
      Object.keys(input.capabilities).length !== 1) {
    throw new TypeError("trusted provider key must grant only the A2 containment evidence capability");
  }
  const capabilityDescriptor = Object.getOwnPropertyDescriptor(input.capabilities, "0");
  if (!capabilityDescriptor || !capabilityDescriptor.enumerable ||
      !Object.hasOwn(capabilityDescriptor, "value")) {
    throw new TypeError("provider capabilities must not contain accessors");
  }

  let publicKey;
  try {
    publicKey = createPublicKey(input.publicKeyPem);
  } catch {
    throw new TypeError("trusted provider public key could not be imported");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("trusted provider public key must be Ed25519");
  }
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  const materialFingerprint = createHash("sha256")
    .update(canonicalJson({
      keyId,
      keyVersion: input.keyVersion,
      algorithm: input.algorithm,
      publicKeyDer: publicKeyDer.toString("base64"),
      providerId,
      role: input.role,
      status: input.status,
      notBeforeMs,
      expiresAtMs,
      capabilities: [CAPABILITY]
    }), "utf8")
    .digest("hex");

  return Object.freeze({
    keyId,
    keyVersion: input.keyVersion,
    algorithm: "Ed25519",
    publicKey,
    providerId,
    role: input.role,
    status: input.status,
    notBeforeMs,
    expiresAtMs,
    materialFingerprint
  });
}

/**
 * Return the canonical payload that the trusted provider must sign with Ed25519.
 * The signature field is deliberately excluded; all identity, scope, timing,
 * fact and evidence-reference fields are covered.
 */
export function createProviderEvidenceSigningPayload(unsignedAttestation) {
  return canonicalJson(normalizeUnsignedAttestation(unsignedAttestation));
}

/**
 * Verify signed, short-lived A2 provider attestations against a host-owned
 * authoritative key resolver. The resolver must return the current durable
 * key record on every call; this module does not own provider enrollment.
 */
export function createProviderEvidenceVerifier({
  resolveTrustedProviderKey,
  clock = Date.now,
  maxAgeMs = 30_000,
  maxLifetimeMs = 60_000,
  maxFutureSkewMs = 5_000
} = {}) {
  if (typeof resolveTrustedProviderKey !== "function") {
    throw new TypeError("a host-owned resolveTrustedProviderKey function is required");
  }
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  for (const [name, value, min, max] of [
    ["maxAgeMs", maxAgeMs, 1000, 300_000],
    ["maxLifetimeMs", maxLifetimeMs, 1000, 300_000],
    ["maxFutureSkewMs", maxFutureSkewMs, 0, 30_000]
  ]) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new TypeError(name + " is invalid");
    }
  }

  const observedKeys = new Map();

  function verify(attestationInput, expectedInput) {
    try {
      const now = assertTimestamp(clock(), "provider verifier clock");
      const attestation = normalizeAttestation(attestationInput);
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
      if (resolved && typeof resolved.then === "function") {
        return Object.freeze({ verified: false, reason: "async-key-resolver-not-supported" });
      }
      if (!resolved) return Object.freeze({ verified: false, reason: "unknown-provider-key" });
      const key = normalizeTrustedKey(resolved);
      if (key.keyId !== attestation.keyId ||
          key.keyVersion !== attestation.keyVersion ||
          key.providerId !== attestation.providerId ||
          key.role !== attestation.role) {
        return Object.freeze({ verified: false, reason: "provider-key-binding-mismatch" });
      }

      const previous = observedKeys.get(key.keyId);
      if (previous && (key.keyVersion < previous.keyVersion ||
          (key.keyVersion === previous.keyVersion &&
           key.materialFingerprint !== previous.materialFingerprint) ||
          (key.keyVersion > previous.keyVersion && key.providerId !== previous.providerId))) {
        return Object.freeze({ verified: false, reason: "provider-key-rollback-or-substitution" });
      }
      observedKeys.set(key.keyId, {
        keyVersion: key.keyVersion,
        materialFingerprint: key.materialFingerprint,
        providerId: key.providerId
      });

      if (key.status !== "active" || now < key.notBeforeMs || now >= key.expiresAtMs) {
        return Object.freeze({ verified: false, reason: "provider-key-inactive" });
      }
      const payload = createProviderEvidenceSigningPayload(
        Object.fromEntries(ATTESTATION_UNSIGNED_FIELDS.map((field) => [field, attestation[field]]))
      );
      const valid = verifySignature(
        null,
        Buffer.from(payload, "utf8"),
        key.publicKey,
        attestation.signatureBytes
      ) === true;
      if (!valid) return Object.freeze({ verified: false, reason: "signature-invalid" });

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

  return Object.freeze({
    [PROVIDER_VERIFIER_BRAND]: true,
    algorithm: "Ed25519",
    capability: CAPABILITY,
    verify,
    getObservedKeyVersion(keyId) {
      if (typeof keyId !== "string" || !KEY_ID.test(keyId)) return null;
      return observedKeys.get(keyId)?.keyVersion ?? null;
    }
  });
}

/**
 * Verify the five independently role-scoped attestations needed to populate
 * the provider-owned A2 readiness predicates. This does not verify the trusted
 * threat signal itself and never authorizes or executes containment.
 */
export function verifyA2ProviderEvidenceBundle({ attestations, expected, verifier } = {}) {
  if (!Array.isArray(attestations) || attestations.length !== ROLES.length ||
      Object.getOwnPropertySymbols(attestations).length !== 0 ||
      Object.keys(attestations).length !== attestations.length ||
      verifier?.[PROVIDER_VERIFIER_BRAND] !== true ||
      typeof verifier.verify !== "function") {
    return Object.freeze({
      schema: BUNDLE_SCHEMA,
      verified: false,
      executable: false,
      reason: "invalid-provider-evidence-bundle"
    });
  }

  let scope;
  try {
    scope = normalizeExpected(expected);
  } catch {
    return Object.freeze({
      schema: BUNDLE_SCHEMA,
      verified: false,
      executable: false,
      reason: "invalid-expected-scope"
    });
  }

  const byRole = new Map();
  const verified = [];
  for (let index = 0; index < attestations.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(attestations, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      return Object.freeze({
        schema: BUNDLE_SCHEMA,
        verified: false,
        executable: false,
        reason: "invalid-provider-evidence-bundle"
      });
    }
    const attestation = descriptor.value;
    let result;
    try {
      result = verifier.verify(attestation, scope);
    } catch {
      result = null;
    }
    if (!isRecord(result) || result.verified !== true ||
        !ROLES.includes(result.role)) {
      return Object.freeze({
        schema: BUNDLE_SCHEMA,
        verified: false,
        executable: false,
        reason: "provider-attestation-rejected",
        detail: isRecord(result) ? result.reason : "invalid-provider-evidence"
      });
    }

    // Use the verifier's normalized role, never read the role property from
    // an untrusted caller object before its exact-shape validation.
    const role = result.role;
    if (byRole.has(role)) {
      return Object.freeze({
        schema: BUNDLE_SCHEMA,
        verified: false,
        executable: false,
        reason: "missing-or-duplicate-provider-role",
        deniedRole: role
      });
    }
    byRole.set(role, result);
    verified.push(result);
  }

  if (ROLES.some((role) => !byRole.has(role))) {
    return Object.freeze({
      schema: BUNDLE_SCHEMA,
      verified: false,
      executable: false,
      reason: "required-provider-role-missing"
    });
  }
  if (byRole.get("containment-provider").providerId ===
      byRole.get("containment-verifier").providerId) {
    return Object.freeze({
      schema: BUNDLE_SCHEMA,
      verified: false,
      executable: false,
      reason: "containment-verifier-must-be-independent"
    });
  }

  const facts = Object.create(null);
  for (const result of verified) Object.assign(facts, result.facts);
  const observedAtMs = Math.min(...verified.map((result) => result.issuedAtMs));
  const expiresAtMs = Math.min(...verified.map((result) => result.expiresAtMs));
  if (expiresAtMs <= observedAtMs) {
    return Object.freeze({
      schema: BUNDLE_SCHEMA,
      verified: false,
      executable: false,
      reason: "provider-evidence-windows-do-not-overlap"
    });
  }

  return Object.freeze({
    schema: BUNDLE_SCHEMA,
    verified: true,
    executable: false,
    scope,
    facts: Object.freeze(facts),
    observedAtMs,
    expiresAtMs,
    providers: Object.freeze(verified.map((result) => Object.freeze({
      providerId: result.providerId,
      role: result.role,
      keyId: result.keyId,
      keyVersion: result.keyVersion,
      attestationId: result.attestationId,
      evidenceRefs: result.evidenceRefs
    })))
  });
}

export const A2_PROVIDER_EVIDENCE_ROLES = ROLES;
