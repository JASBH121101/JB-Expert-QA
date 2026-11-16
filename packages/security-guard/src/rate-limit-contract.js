const SAFE_IDENTIFIER = /^[a-zA-Z0-9:_-]{1,96}$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Shared request contract for every runtime adapter.
 * Identity must already be resolved and trusted by server-side application code.
 */
export function normalizeRateLimitCheckInput(input = {}) {
  if (!isRecord(input)) throw new TypeError("check input must be an object");
  const allowed = new Set(["identity", "scope", "policy"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new TypeError("Unknown rate-limit check input: " + key);
  }

  const identity = input.identity;
  if (typeof identity !== "string" || !identity.trim() || identity.length > 512) {
    throw new TypeError("identity must be a non-empty trusted identifier no longer than 512 characters");
  }

  const scope = input.scope ?? "request";
  if (typeof scope !== "string" || !SAFE_IDENTIFIER.test(scope)) {
    throw new TypeError("scope must contain 1-96 safe identifier characters");
  }

  const normalized = { identity: identity.trim(), scope };
  if (input.policy !== undefined) {
    if (typeof input.policy !== "string" || !SAFE_IDENTIFIER.test(input.policy)) {
      throw new TypeError("policy must contain 1-96 safe identifier characters");
    }
    normalized.policy = input.policy;
  }
  return Object.freeze(normalized);
}

/**
 * Canonical wire decision shared by Worker services and remote runtime clients.
 * A blocked decision must carry a recognized HTTP status and coherent flags.
 */
export function normalizeRateLimitServiceDecision(value) {
  const allowed = new Set([
    "allowed", "exceeded", "enforced", "unavailable",
    "policy", "scope", "status", "retryAfterSeconds"
  ]);
  if (isRecord(value)) {
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) {
        throw new TypeError("Unknown rate-limit service decision field: " + key);
      }
    }
  }

  if (!isRecord(value) ||
      typeof value.allowed !== "boolean" ||
      typeof value.exceeded !== "boolean" ||
      typeof value.enforced !== "boolean" ||
      typeof value.unavailable !== "boolean" ||
      !(value.status === null || value.status === 429 || value.status === 503) ||
      !(value.retryAfterSeconds === null ||
        (Number.isSafeInteger(value.retryAfterSeconds) &&
          value.retryAfterSeconds >= 1 && value.retryAfterSeconds <= 60)) ||
      !(value.policy === null ||
        (typeof value.policy === "string" && SAFE_IDENTIFIER.test(value.policy))) ||
      !(typeof value.scope === "string" && SAFE_IDENTIFIER.test(value.scope))) {
    throw new TypeError("Rate-limit service returned an invalid decision");
  }

  if (value.allowed && value.status !== null) {
    throw new TypeError("Allowed service decision must not contain a response status");
  }
  if (!value.allowed && ![429, 503].includes(value.status)) {
    throw new TypeError("Blocked service decision requires an HTTP 429 or 503 status");
  }
  if (value.status === 429 &&
      (!value.exceeded || !value.enforced || value.unavailable)) {
    throw new TypeError("HTTP 429 requires an enforced exceeded-limit decision");
  }
  if (value.status === 503 &&
      (!value.unavailable || !value.enforced || value.exceeded)) {
    throw new TypeError("HTTP 503 requires an enforced unavailable-store decision");
  }
  if (value.status === null && value.retryAfterSeconds !== null) {
    throw new TypeError("Retry-After is only valid when a response status is present");
  }

  return Object.freeze({
    allowed: value.allowed,
    exceeded: value.exceeded,
    enforced: value.enforced,
    unavailable: value.unavailable,
    policy: value.policy,
    scope: value.scope,
    status: value.status,
    retryAfterSeconds: value.retryAfterSeconds
  });
}

/** Convert an adapter decision with a Response into the canonical wire shape. */
export function createRateLimitServicePayload(decision) {
  if (!isRecord(decision) ||
      typeof decision.allowed !== "boolean" ||
      typeof decision.exceeded !== "boolean" ||
      typeof decision.enforced !== "boolean" ||
      typeof decision.unavailable !== "boolean") {
    throw new TypeError("Rate-limit adapter returned an invalid decision");
  }

  const response = decision.response ?? null;
  const status = response?.status ?? null;
  const retryAfter = status === null ? null : response?.headers?.get?.("retry-after") ?? null;
  const retryAfterValue = retryAfter === null ? null : Number(retryAfter);

  return normalizeRateLimitServiceDecision({
    allowed: decision.allowed,
    exceeded: decision.exceeded,
    enforced: decision.enforced,
    unavailable: decision.unavailable,
    policy: decision.policy ?? null,
    scope: decision.scope ?? "request",
    status,
    retryAfterSeconds: Number.isSafeInteger(retryAfterValue) &&
      retryAfterValue >= 1 && retryAfterValue <= 60
      ? retryAfterValue
      : null
  });
}
