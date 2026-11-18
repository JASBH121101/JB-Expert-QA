# Contract conventions

All v1 contracts use JSON Schema Draft 2020-12.

- Timestamps are Unix epoch milliseconds.
- Tenant, application, policy, and scope identifiers use [A-Za-z0-9:_-] and are length-bounded.
- Identity keys are opaque lowercase 64-character HMAC-SHA-256 digests. The keyId identifies the active secret version; the secret itself is never transmitted.
- additionalProperties: false is intentional: unknown fields fail conformance rather than being silently ignored.
- HTTP 429 means an enforced quota was exceeded. HTTP 503 means an enforced dependency was unavailable.
- Runtime adapters may expose richer native objects internally, but must map to these bounded wire shapes at contract boundaries.
- Contract changes that alter meaning require a new schema version. Do not change v1 to accept raw identities, free-form metadata, or new decision semantics.

The v1 schemas define message shapes, not a database protocol, transaction algorithm, authentication protocol, or security guarantee. Those require separately specified adapter contracts and tests.

## Upload inspection attestation v1

The `jb.security.upload-inspection.attestation/v1` message binds a scanner verdict to one exact quarantined object using its upload ID, SHA-256 and byte count. It also records the detected MIME type, scanner engine/version and scan timestamp.

- Only `clean`, `malicious` and `unknown` are valid scanner verdicts. Values such as `no_match`, `suspicious`, `not_scanned` or a missing verdict must be mapped to `unknown` or rejected by the adapter; they must never be mapped to `clean`.
- `clean` is a scanner statement, not an approval decision. The host must independently verify the complete stream, digest and size, enforce policy, and atomically promote from private quarantine. Only the storage adapter can establish that promotion committed.
- `malicious` and `unknown` must never be promoted. Scanner errors, timeouts, malformed attestations, digest/size mismatches and uncertain promotion outcomes remain fail-closed.
- Upload IDs may be 32 lowercase hexadecimal characters or a UUID to accommodate the existing native runtime ID generators. They are opaque correlation identifiers, not authorization tokens.
- The contract deliberately excludes original filenames, local paths, raw file content, credentials, customer identifiers, scanner free-form diagnostics and arbitrary metadata.
- The maximum object size is 100 MiB and the MIME allowlist is JPEG, PNG, GIF, WebP and PDF. Runtime policies may impose a lower size limit or a narrower MIME allowlist, but may not expand this shared v1 contract.

The shared fixtures are in `tests/fixtures/upload-inspection`. The Node.js, PHP and Python Core validators consume the same positive vectors and reject malformed/unknown fields. This establishes validator-level conformance only; each upload pipeline must still map its verified scan result into this attestation and pass end-to-end integration tests before the contract can be called fully cross-runtime conformant.
