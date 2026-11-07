const SENSITIVE_QUERY_KEYS = new Set([
  "key", "apikey", "accesskey", "awsaccesskeyid", "token", "accesstoken",
  "refreshtoken", "authtoken", "idtoken", "bearertoken", "authorization",
  "auth", "secret", "clientsecret", "password", "passwd", "signature", "sig",
  "xamzcredential", "xamzsignature", "xamzsecuritytoken", "xgoogcredential",
  "xgoogsignature", "xgoogsecuritytoken", "credential", "privatekey", "session",
  "sessionid", "state", "code", "nonce", "ticket", "jwt"
]);

function normalizeQueryKey(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveQueryKey(value) {
  const key = normalizeQueryKey(value);
  return SENSITIVE_QUERY_KEYS.has(key) ||
    key.endsWith("token") || key.endsWith("secret") || key.endsWith("signature");
}

export function redactUrlForReport(input) {
  if (typeof input !== "string" || !input) return input ?? "";
  let parsed;
  try { parsed = new URL(input); }
  catch {
    // Never echo malformed URL text: credentials or tokens may be present in
    // userinfo/query data that cannot be parsed safely.
    return "[unparseable URL omitted]";
  }

  if (["data:", "blob:", "javascript:"].includes(parsed.protocol)) return parsed.protocol + "[omitted]";
  if (parsed.username) parsed.username = "[REDACTED]";
  if (parsed.password) parsed.password = "[REDACTED]";

  for (const key of [...new Set(parsed.searchParams.keys())]) {
    if (!isSensitiveQueryKey(key)) continue;
    const values = parsed.searchParams.getAll(key);
    parsed.searchParams.delete(key);
    for (const value of values) parsed.searchParams.append(key, value ? "[REDACTED]" : "");
  }

  parsed.hash = "";
  const result = parsed.href;
  return result.length > 2048 ? result.slice(0, 2048) + "…" : result;
}

export function redactUrlsInText(value) {
  return String(value ?? "").replace(
    /\bhttps?:\/\/[^\s"'<>]+/gi,
    (url) => redactUrlForReport(url)
  );
}

/**
 * Sanitizes rule execution errors before they are included in audit reports.
 * Error text is treated as untrusted data and is bounded to avoid leaking
 * credentials or allowing oversized exception messages to inflate reports.
 */
export function redactSensitiveText(input) {
  const source = String(input ?? "").slice(0, 2048);
  return redactUrlsInText(source)
    .replace(/\\b(bearer|basic)\\s+[a-z0-9._~+\\/-]+=*/gi, "$1 [REDACTED]")
    .replace(/\\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|password|passwd|secret|authorization)\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|[^\\s,;]+)/gi, "$1[REDACTED]")
    .slice(0, 512);
}
