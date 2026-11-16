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
