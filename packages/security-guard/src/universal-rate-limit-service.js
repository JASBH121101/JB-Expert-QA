import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createDistributedRateLimit } from "./distributed-rate-limit.js";

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,95}$/;
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function emit(onEvent, event) {
  try {
    const result = onEvent(Object.freeze({ component: "jb-security-guard", ...event }));
    if (result && typeof result.then === "function") Promise.resolve(result).catch(() => {});
  } catch { /* Observability must never interrupt the security boundary. */ }
}

function json(status, payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      ...headers
    }
  });
}

function normalizeSecret(value, name) {
  const secret = typeof value === "string" ? Buffer.from(value, "utf8")
    : Buffer.isBuffer(value) ? Buffer.from(value) : null;
  if (!secret || secret.length < 32 || secret.length > 512) {
    throw new TypeError(name + " must contain 32-512 bytes");
  }
  return secret;
}

function validId(value, name) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new TypeError(name + " must be a 1-96 character safe identifier");
  }
  return value;
}

async function readBoundedBody(request, maxBytes) {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared) || Number(declared) > maxBytes) return { ok: false, status: 413 };
  }
  const reader = request.body?.getReader();
  if (!reader) return { ok: false, status: 400 };
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      length += chunk.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, status: 413 };
      }
      chunks.push(chunk);
    }
  } catch {
    return { ok: false, status: 400 };
  } finally {
    reader.releaseLock?.();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return { ok: false, status: 400 };
  }
}

function normalizeClients(input, sharedOptions) {
  if (!isRecord(input)) throw new TypeError("clients must be an object keyed by client ID");
  const entries = Object.entries(input);
  if (entries.length < 1 || entries.length > 1000) {
    throw new TypeError("clients must contain between 1 and 1000 entries");
  }

  const clients = new Map();
  for (const [clientId, config] of entries) {
    validId(clientId, "Client ID");
    if (!isRecord(config)) throw new TypeError("Each client configuration must be an object");
    for (const key of Object.keys(config)) {
      if (!["secret", "policies"].includes(key)) throw new TypeError("Unknown client option: " + key);
    }
    const secret = normalizeSecret(config.secret, "Client secret");
    if (!isRecord(config.policies)) throw new TypeError("Each client must define a policies object");
    const policyEntries = Object.entries(config.policies);
    if (policyEntries.length < 1 || policyEntries.length > 32) {
      throw new TypeError("Each client must define between 1 and 32 policies");
    }

    const policies = new Map();
    for (const [policyName, policy] of policyEntries) {
      validId(policyName, "Policy name");
      if (!isRecord(policy)) throw new TypeError("Policy configuration must be an object");
      for (const key of Object.keys(policy)) {
        if (!["windowMs", "maxRequests", "scopes"].includes(key)) {
          throw new TypeError("Unknown policy option: " + key);
        }
      }
      const windowMs = policy.windowMs ?? 60_000;
      const maxRequests = policy.maxRequests ?? 120;
      if (!Number.isSafeInteger(windowMs) || windowMs < 1000 || windowMs > 86_400_000) {
        throw new TypeError("Policy windowMs must be an integer from 1000 to 86400000");
      }
      if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 1_000_000) {
        throw new TypeError("Policy maxRequests must be an integer from 1 to 1000000");
      }
      const scopes = policy.scopes ?? ["request"];
      if (!Array.isArray(scopes) || scopes.length < 1 || scopes.length > 32) {
        throw new TypeError("Policy scopes must contain between 1 and 32 identifiers");
      }
      const scopeSet = new Set(scopes.map((scope) => validId(scope, "Scope")));
      if (scopeSet.size !== scopes.length) throw new TypeError("Policy scopes must be unique");

      // Domain-separated key material keeps API credentials out of counter keys.
      const counterSecret = createHmac("sha256", secret)
        .update("jb-security-guard-counter-key-v1")
        .digest();
      const namespaceDigest = createHash("sha256")
        .update(clientId).update("\0").update(policyName)
        .digest("hex").slice(0, 24);
      const limiter = createDistributedRateLimit({
        store: sharedOptions.store,
        secret: counterSecret,
        namespace: "jb-guard:u:" + namespaceDigest,
        windowMs,
        maxRequests,
        storeTimeoutMs: sharedOptions.storeTimeoutMs,
        clock: sharedOptions.clock,
        failClosed: true,
        keyGenerator: (request) => String(request.scope) + "\0" + String(request.identity),
        onEvent: sharedOptions.onEvent
      });
      policies.set(policyName, Object.freeze({ scopes: scopeSet, limiter }));
    }
    clients.set(clientId, Object.freeze({ secret, secretDigest: createHash("sha256").update(secret).digest(), policies }));
  }
  return clients;
}

function authorizedClient(clients, clientId, authorization) {
  const client = clients.get(clientId);
  const match = typeof authorization === "string"
    ? /^Bearer ([\x21-\x7e]{32,512})$/.exec(authorization)
    : null;
  const candidate = createHash("sha256").update(match?.[1] ?? "").digest();
  const expected = client?.secretDigest ?? createHash("sha256").update("jb-invalid-client-credential").digest();
  const valid = timingSafeEqual(candidate, expected);
  return client && valid ? client : null;
}

/**
 * Server-to-server universal rate-limit endpoint for applications hosted on
 * any platform. Deploy this Node.js service behind HTTPS and a shared atomic
 * store. Client credentials must remain on application servers, never browsers.
 */
export function createUniversalRateLimitService(options = {}) {
  if (!isRecord(options)) throw new TypeError("Universal rate-limit service options must be an object");
  const allowed = new Set(["store", "clients", "path", "maxBodyBytes", "storeTimeoutMs", "clock", "onEvent"]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new TypeError("Unknown universal service option: " + key);
  }
  const store = options.store;
  if (!isRecord(store) || typeof store.consumeLimit !== "function") {
    throw new TypeError("store.consumeLimit must implement an atomic shared fixed-window counter");
  }
  const path = options.path ?? "/__jb/security-guard/v1/check";
  if (typeof path !== "string" || !/^\/[a-zA-Z0-9/_:-]{1,120}$/.test(path)) {
    throw new TypeError("path must be a bounded absolute URL path");
  }
  const maxBodyBytes = options.maxBodyBytes ?? 4096;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 256 || maxBodyBytes > 16_384) {
    throw new TypeError("maxBodyBytes must be an integer from 256 to 16384");
  }
  const storeTimeoutMs = options.storeTimeoutMs ?? 3000;
  if (!Number.isSafeInteger(storeTimeoutMs) || storeTimeoutMs < 1 || storeTimeoutMs > 60_000) {
    throw new TypeError("storeTimeoutMs must be an integer from 1 to 60000");
  }
  const clock = options.clock ?? Date.now;
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  const onEvent = options.onEvent ?? (() => {});
  if (typeof onEvent !== "function") throw new TypeError("onEvent must be a function");

  const clients = normalizeClients(options.clients, { store, storeTimeoutMs, clock, onEvent });

  async function fetch(request) {
    if (!(request instanceof Request)) throw new TypeError("fetch requires a Web Request");
    const url = new URL(request.url);
    if (url.pathname !== path) return json(404, { error: "not_found" });
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" }, { allow: "POST" });
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") ?? "")) {
      return json(415, { error: "unsupported_media_type" });
    }

    const clientId = request.headers.get("x-jb-client-id");
    if (typeof clientId !== "string" || !SAFE_ID.test(clientId)) {
      return json(401, { error: "unauthorized" });
    }
    const client = authorizedClient(clients, clientId, request.headers.get("authorization"));
    if (!client) {
      emit(onEvent, { action: "universal-rate-client-unauthorized", severity: "high" });
      return json(401, { error: "unauthorized" });
    }

    const body = await readBoundedBody(request, maxBodyBytes);
    if (!body.ok) return json(body.status, { error: body.status === 413 ? "payload_too_large" : "invalid_request" });
    if (!isRecord(body.value)) return json(400, { error: "invalid_request" });
    for (const key of Object.keys(body.value)) {
      if (!["identity", "scope", "policy"].includes(key)) return json(400, { error: "invalid_request" });
    }

    const { identity, scope, policy } = body.value;
    if (typeof identity !== "string" || !identity.trim() || identity.length > 512 ||
        typeof scope !== "string" || !SAFE_ID.test(scope) ||
        typeof policy !== "string" || !SAFE_ID.test(policy)) {
      return json(400, { error: "invalid_request" });
    }
    const selected = client.policies.get(policy);
    if (!selected || !selected.scopes.has(scope)) return json(400, { error: "unknown_policy_or_scope" });

    const decision = await selected.limiter.check({ identity: identity.trim(), scope });
    if (decision.status === 503) {
      return json(503, {
        error: "security_rate_limit_unavailable",
        message: "Request temporarily unavailable due to a security control."
      }, { "retry-after": String(decision.retryAfterSeconds ?? 5) });
    }
    if (decision.exceeded) {
      return json(429, {
        error: "rate_limit_exceeded",
        message: "Too many requests. Try again later."
      }, { "retry-after": String(decision.retryAfterSeconds ?? 60) });
    }
    return json(200, { allowed: true, policy, scope });
  }

  return Object.freeze({
    fetch,
    getClients: () => Object.freeze([...clients.keys()]),
    getPolicies: (clientId) => {
      const client = clients.get(clientId);
      return Object.freeze(client ? [...client.policies.keys()] : []);
    }
  });
}
