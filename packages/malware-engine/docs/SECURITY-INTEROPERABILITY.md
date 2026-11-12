# JB Security Interoperability Contract v1

This contract keeps JB Expert QA, JB Security Guard QA, and JB Malware Engine independently deployable while allowing their outputs to be connected without confusing their security decisions.

## Shared finding vocabulary

A normalized finding uses these fields:

```json
{
  "schema": "jb.security.finding/v1",
  "id": "stable-rule-or-detection-id",
  "producer": "jb-expert-qa | jb-security-guard | jb-malware-engine",
  "severity": "info | low | medium | high | critical",
  "title": "Short human-readable title",
  "description": "Evidence-based explanation",
  "observedAt": "ISO-8601 timestamp",
  "evidence": {
    "sha256": "optional lowercase SHA-256",
    "references": []
  }
}
```

The producer must preserve its native report and may additionally emit normalized findings. Do not invent evidence, file paths, user identities, or timestamps. Redact secrets, credentials, tokens, full request bodies, and URL query strings before exporting.

## File-scanning adapter contract

JB Security Guard accepts a scanner with this interface:

```js
scanner.scan({
  stream,
  uploadId,
  size,
  sha256,
  detectedMimeType,
  signal
}) -> Promise<{
  verdict: "clean" | "malicious" | "unknown",
  engine: string,
  version: string
}>
```

The stream must be consumed completely. A clean verdict is valid only for the exact declared size and SHA-256, and the storage adapter must atomically verify those same values at promotion time. A timeout, scanner error, malformed response, partial stream, unknown verdict, or promotion error must never approve an object.

JB Malware Engine exposes `createSecurityGuardScanner({ malwareEngine, tempDirectory, maxBytes, engineName, version })`. The adapter writes to a private temporary directory, verifies the size and SHA-256, invokes the local engine, and removes temporary data in a `finally` block.

Its verdict mapping is intentionally conservative:

| Malware Engine status | Security Guard verdict |
| --- | --- |
| `malicious` | `malicious` |
| `suspicious` | `unknown` |
| `unknown` | `unknown` |
| `no_match` | `unknown` |

**A `no_match` result is not a clean verdict.** This adapter therefore never authorizes promotion on its own. A separately validated scanner may be combined with it, but a positive clean verdict must come from a scanner whose coverage and trust policy explicitly support that conclusion.

## Decision boundaries

- JB Expert QA evaluates software, browser behavior, accessibility, configuration, and project rules. A passing QA score does not mean a file is malware-free and must never be translated to the scanner verdict `clean`.
- JB Security Guard enforces request/upload policy and owns the quarantine-to-approved transition. Only its storage adapter can make promotion atomic.
- JB Malware Engine performs local static file inspection. A heuristic `suspicious` result is not a confirmed malware detection; `no_match` is not proof of safety; `unknown` means coverage was incomplete or insufficient.
- These products must not share secrets, production storage, databases, or signing keys by default. Integrations are explicit adapters with bounded inputs and testable failure behavior.

## Compatibility and release gates

Before publishing an integration, verify:
1. The scanner interface and normalized finding fields match this document.
2. SHA-256 and byte count are preserved from ingestion through scan and promotion.
3. Scanner errors, aborts, malformed outputs, unknown results, and storage failures fail closed.
4. Temporary files, streams, browser contexts, and quarantine artifacts are cleaned up or explicitly retained under policy.
5. Unit and integration tests cover success, tampering, partial reads, timeouts, malformed inputs, and cross-platform behavior.
6. CI passes on the supported Node.js version and operating systems. A green CI run is not a security certification or production readiness assessment.
