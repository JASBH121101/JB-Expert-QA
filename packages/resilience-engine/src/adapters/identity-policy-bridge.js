import {
  createHash,
  createPublicKey,
  verify as verifySignature
} from "node:crypto";
import { createResiliencePolicyEngine } from "../policy-engine.js";

const KEY_SCHEMA = "jb.resilience.policy-trust-key/v1";
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const PRINCIPAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const POLICY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const BASE64URL_SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const KEY_FIELDS = [
  "schema", "keyId", "keyVersion", "algorithm", "publicKeyPem",
  "principalId", "role", "status", "notBefore", "expiresAt", "policyIds"
];
const POLICY_CONTEXT_FIELDS = ["policy", "signature", "policyHash", "signingPayload"];
const SIGNATURE_FIELDS = ["keyId", "algorithm", "value"];
const POLICY_FIELDS = [
  "schema", "policyId", "revision", "mode", "validity", "signature",
  "policyHash", "defaults", "budgets", "services"
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
  if (keys.length !== expected.length ||
      keys.some((key) => !expected.includes(key))) {
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

function normalizeTrustedKey(input) {
  exactKeys(input, KEY_FIELDS, "trusted policy key");
  if (input.schema !== KEY_SCHEMA) throw new TypeError("unsupported trusted policy key schema");
  const keyId = assertIdentifier(input.keyId, KEY_ID, "keyId");
  if (!Number.isSafeInteger(input.keyVersion) || input.keyVersion < 1) {
    throw new TypeError("keyVersion must be a positive safe integer");
  }
  if (typeof input.algorithm !== "string" || !/^[A-Za-z0-9._-]{1,32}$/.test(input.algorithm)) {
    throw new TypeError("trusted policy key algorithm is invalid");
  }
  if (typeof input.publicKeyPem !== "string" ||
      input.publicKeyPem.length < 64 || input.publicKeyPem.length > 8192 ||
      !/^\\s*-----BEGIN PUBLIC KEY-----[\\s\\S]+-----END PUBLIC KEY-----\\s*$/.test(input.publicKeyPem)) {
    throw new TypeError("publicKeyPem must be a PEM-encoded public key");
  }
  const principalId = assertIdentifier(input.principalId, PRINCIPAL_ID, "principalId");
  const role = assertIdentifier(input.role, /^[A-Za-z][A-Za-z0-9._-]{0,63}$/, "key role");
  if (!["active", "revoked", "suspended"].includes(input.status)) {
    throw new TypeError("trusted key status is invalid");
  }
  const notBefore = assertTimestamp(input.notBefore, "key notBefore");
  const expiresAt = assertTimestamp(input.expiresAt, "key expiresAt");
  if (expiresAt <= notBefore) throw new TypeError("trusted key validity window is invalid");
  if (!Array.isArray(input.policyIds) || input.policyIds.length < 1 ||
      input.policyIds.length > 100 || Object.getOwnPropertySymbols(input.policyIds).length ||
      Object.keys(input.policyIds).length !== input.policyIds.length) {
    throw new TypeError("policyIds must contain 1 to 100 dense policy identifiers");
  }
  const policyIds = [];
  for (let index = 0; index < input.policyIds.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input.policyIds, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError("policyIds must not contain holes or accessors");
    }
    policyIds.push(assertIdentifier(descriptor.value, POLICY_ID, "policyIds[]"));
  }
  if (new Set(policyIds).size !== policyIds.length) {
    throw new TypeError("policyIds must not contain duplicates");
  }

  let publicKey;
  try {
    publicKey = createPublicKey(input.publicKeyPem);
  } catch {
    throw new TypeError("trusted policy public key could not be imported");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("trusted policy public key must be Ed25519");
  }

  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  const materialFingerprint = createHash("sha256")
    .update(publicKeyDer)
    .update("\0" + principalId + "\0" + input.role + "\0" + policyIds.slice().sort().join("\0"))
    .digest("hex");

  return Object.freeze({
    keyId,
    keyVersion: input.keyVersion,
    algorithm: input.algorithm,
    publicKey,
    principalId,
    role,
    status: input.status,
    notBefore,
    expiresAt,
    policyIds: Object.freeze(policyIds),
    materialFingerprint
  });
}

function normalizePolicyContext(context, now) {
  exactKeys(context, POLICY_CONTEXT_FIELDS, "policy signature verification context");
  const { policy, signature, policyHash, signingPayload } = context;
  exactKeys(policy, POLICY_FIELDS, "advanced resilience policy");
  exactKeys(signature, SIGNATURE_FIELDS, "policy signature");
  if (policy.schema !== "jb.resilience.policy/v2" ||
      typeof policy.policyId !== "string" || !POLICY_ID.test(policy.policyId) ||
      !Number.isSafeInteger(policy.revision) || policy.revision < 1) {
    throw new TypeError("policy identity is invalid");
  }
  if (signature.keyId !== policy.signature.keyId ||
      signature.algorithm !== policy.signature.algorithm ||
      signature.value !== policy.signature.value) {
    throw new TypeError("policy signature context does not match the policy");
  }
  if (signature.algorithm !== "Ed25519" ||
      typeof signature.value !== "string" || !BASE64URL_SIGNATURE.test(signature.value)) {
    throw new TypeError("policy signature must be a canonical Ed25519 base64url signature");
  }
  const signatureBytes = Buffer.from(signature.value, "base64url");
  if (signatureBytes.length !== 64 || signatureBytes.toString("base64url") !== signature.value) {
    throw new TypeError("policy signature encoding is invalid");
  }
  if (typeof policyHash !== "string" || !SHA256.test(policyHash) ||
      policy.policyHash !== policyHash) {
    throw new TypeError("policy hash context is invalid");
  }
  if (typeof signingPayload !== "string" ||
      Buffer.byteLength(signingPayload, "utf8") > 256 * 1024) {
    throw new TypeError("policy signing payload is invalid or exceeds 256 KiB");
  }
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError("policy verifier clock is invalid");
  }
  return Object.freeze({
    keyId: signature.keyId,
    policyId: policy.policyId,
    signatureBytes,
    signingPayload
  });
}

/**
 * Creates a synchronous, fail-closed Ed25519 verifier for the existing
 * Resilience Policy Engine. The host owns the trusted-key registry and
 * supplies a synchronous resolver that returns the current key record.
 *
 * The resolver is called on every signature check. No key or revocation
 * decision is cached as authoritative. Version and material continuity
 * checks prevent a resolver from silently downgrading or replacing a key
 * under the same keyId without increasing keyVersion.
 */
export function createEd25519PolicySignatureVerifier({
  resolveTrustedKey,
  clock = Date.now
} = {}) {
  if (typeof resolveTrustedKey !== "function") {
    throw new TypeError("a host-owned synchronous resolveTrustedKey function is required");
  }
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  const observedKeys = new Map();

  function verifyPolicySignature(context) {
    try {
      const now = clock();
      const normalizedContext = normalizePolicyContext(context, now);
      const resolved = resolveTrustedKey(normalizedContext.keyId);
      if (resolved && typeof resolved.then === "function") return false;
      if (!resolved) return false;

      const key = normalizeTrustedKey(resolved);
      if (key.keyId !== normalizedContext.keyId) return false;

      const previous = observedKeys.get(key.keyId);
      if (previous) {
        if (key.keyVersion < previous.keyVersion) return false;
        if (key.keyVersion === previous.keyVersion &&
            key.materialFingerprint !== previous.materialFingerprint) return false;
        if (key.keyVersion > previous.keyVersion &&
            key.principalId !== previous.principalId) return false;
      }
      // Record every structurally valid newer registry version, including revoked
      // or suspended entries, so a later stale snapshot cannot roll revocation back.
      observedKeys.set(key.keyId, {
        keyVersion: key.keyVersion,
        materialFingerprint: key.materialFingerprint,
        principalId: key.principalId
      });

      if (key.algorithm !== "Ed25519" ||
          key.publicKey.asymmetricKeyType !== "ed25519" ||
          key.role !== "policy-owner" ||
          key.status !== "active" ||
          now < key.notBefore || now >= key.expiresAt ||
          !key.policyIds.includes(normalizedContext.policyId)) {
        return false;
      }

      return verifySignature(
        null,
        Buffer.from(normalizedContext.signingPayload, "utf8"),
        key.publicKey,
        normalizedContext.signatureBytes
      ) === true;
    } catch {
      return false;
    }
  }

  return Object.freeze({
    algorithm: "Ed25519",
    verifyPolicySignature,
    getObservedKeyVersion(keyId) {
      if (typeof keyId !== "string" || !KEY_ID.test(keyId)) return null;
      return observedKeys.get(keyId)?.keyVersion ?? null;
    }
  });
}

/**
 * Binds the host-owned policy-key verifier to the existing Resilience Policy
 * Engine. Every decision, authorization reservation, pre-execution assertion
 * and completion is delegated unchanged to createResiliencePolicyEngine.
 */
export function createResilienceIdentityPolicyBridge({
  policy,
  resolveTrustedKey,
  policyRevisionStore,
  capabilityLedger,
  allowInMemoryStores = false,
  clock = Date.now,
  authorizationTtlMs = 30_000
} = {}) {
  const identity = createEd25519PolicySignatureVerifier({
    resolveTrustedKey,
    clock
  });
  const engine = createResiliencePolicyEngine({
    policy,
    verifyPolicySignature: identity.verifyPolicySignature,
    policyRevisionStore,
    capabilityLedger,
    allowInMemoryStores,
    clock,
    authorizationTtlMs
  });

  return Object.freeze({
    engine: "JB Resilience Identity & Policy Bridge",
    version: "1.0.0",
    signatureAlgorithm: "Ed25519",
    policyEngine: engine,
    verifyPolicySignature: identity.verifyPolicySignature,
    getObservedKeyVersion: identity.getObservedKeyVersion,
    evaluate: engine.evaluate,
    authorize: engine.authorize,
    assertAuthorization: engine.assertAuthorization,
    completeAuthorization: engine.completeAuthorization
  });
}
