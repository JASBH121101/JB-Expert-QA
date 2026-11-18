# JB Security Guard — Upload Inspection Contract v1

**Status:** versioned laboratory contract  
**Contract IDs:** jb.security.upload-scan-request/v1, jb.security.upload-scan-result/v1 and jb.security.upload-inspection.attestation/v1  
**Runtime targets:** Node.js, PHP 8.2+, Python 3.11+  
**Scope:** scanner handoff and the exact-byte / verdict binding at the quarantine boundary

## 1. Purpose and boundaries

This contract standardizes what a host scanner is asked to inspect and what evidence must be bound to its result. It does not merge the Node, PHP or Python implementations into a shared runtime, and it does not bundle a malware scanner, quarantine store, multipart parser or public-file server.

The binary stream is an out-of-band input to the scanner. The JSON request is the immutable metadata envelope that binds the stream to an opaque upload ID, byte count, SHA-256 and detected MIME type.

## 2. Scan request

Schema: contracts/upload-inspection/v1/scan-request.schema.json

Required fields:
- schema: exact value jb.security.upload-scan-request/v1.
- uploadId: server-generated opaque identifier, 16–64 URL-safe characters. It is not a client filename, path or tenant identity.
- size: exact positive byte count, capped at 100 MiB by this v1 contract.
- sha256: lowercase SHA-256 of the complete quarantined object.
- detectedMimeType: one of JPEG, PNG, GIF, WebP or PDF, determined from bounded content signatures.

The request must not contain the original filename, filesystem/object-store path, user identity, credentials, file bytes, arbitrary metadata or caller-selected policy.

## 3. Scan result

Schema: contracts/upload-inspection/v1/scan-result.schema.json

Required fields:
- schema: exact value jb.security.upload-scan-result/v1.
- uploadId: must equal the request's exact upload ID.
- verdict: clean, malicious or unknown.
- size and sha256: must exactly match the request.
- scanner.id and scanner.version: bounded, non-empty scanner identity and version.
- streamConsumed: must be literal true. A scanner cannot declare a clean result when it did not consume the complete stream.

streamConsumed is an output assertion only after the runtime adapter independently observes sequential consumption, exact byte count and digest. It must never be trusted as a caller-supplied boolean.

## 4. Required decision semantics

| Scanner result | Guard disposition |
|---|---|
| clean, complete stream, exact upload ID/size/SHA-256 | Eligible for the host's private atomic promotion step |
| malicious | Reject promotion; retain the exact object in private quarantine for controlled response and forensic disposition. Enforce a bounded retention period, quotas, restricted audited access and explicit deletion; never serve it through normal download routes |
| unknown | Do not promote; retain in private quarantine for an authorized review/disposition process |
| Incomplete stream | Do not promote; retain in private quarantine |
| Timeout, scanner outage, malformed result, wrong upload ID, digest or byte-count mismatch | Do not promote; retain in private quarantine |
| Quarantine or promotion uncertainty | Never report approval; reconcile using the host storage adapter's exact upload ID |

No result from this contract is permission to publish a file. The application's authorization-aware serving layer must make that decision separately.

## 5. Runtime mapping

The contract is language-neutral; runtimes keep their native APIs:

- **Node.js:** Guard passes stream, uploadId, size, sha256, detectedMimeType and an AbortSignal. Guard independently hashes and counts bytes in the verified stream and requires its readable side to end before accepting the scanner result.
- **PHP:** UploadInspectionService passes an `UploadInspectionReadOnlyStream` plus metadata including uploadId, size, sha256 and detectedMimeType. The scanner uses bounded sequential `read(maxBytes)` calls (maximum 1 MiB); the service independently hashes/counts delivered bytes, rejects transient empty reads before EOF, and verifies exact size, EOF and SHA-256.
- **Python:** UploadInspectionService passes a read-only digest-tracking stream plus the same metadata. The wrapper counts and hashes the bytes actually delivered to the scanner, disallows seeking and verifies exact EOF before accepting the scanner's own digest/size result.

The native scanner response shapes remain runtime-specific (engine/version in all current adapters; digest/size are independently supplied and verified according to each runtime). Adapters validate those native results and construct the language-neutral handoff/result envelope at the boundary.

## 6. Upload inspection attestation

Schema: contracts/upload-inspection/v1/attestation.schema.json

After and only after a runtime has observed complete sequential scanner consumption, verified the exact ingested byte count and SHA-256, and received a structurally valid `clean`, `malicious` or `unknown` result, it constructs a normalized attestation with:

- `schema`: exact value `jb.security.upload-inspection.attestation/v1`.
- `uploadId`: the exact server-generated ID used for quarantine and scanner handoff.
- `verdict`: `clean`, `malicious` or `unknown`; native values such as `no_match`, `suspicious` or `not_scanned` are not interchangeable with `clean`.
- `sha256`, `size` and `mimeType`: the exact digest, byte count and content-detected MIME of the inspected object.
- `engine` and `version`: bounded scanner identity/version labels.
- `scannedAtMs`: scan completion timestamp in Unix epoch milliseconds.

The attestation is scanner evidence, not a promotion decision and not a cryptographic scanner signature. It excludes filenames, local paths, file bytes, credentials, arbitrary metadata and raw customer identity. A clean verdict never authorizes publication by itself.

The actual upload pipeline returns a clean attestation alongside an approved result and exposes valid malicious/unknown attestations on the normalized inspection error for audit linkage. A non-clean attestation never authorizes promotion. If stream consumption is incomplete, the scanner result is malformed, or digest/size binding fails, no trusted attestation is emitted. Storage promotion must bind a clean attestation to the exact object in the same atomic commit:
- Node.js passes it in `metadata.attestation` to `store.promote(...)`.
- PHP requires it as the fourth argument to `UploadQuarantineStorage::promote(...)`.
- Python requires it as the fourth argument to `UploadQuarantineStorage.promote(...)`.

The host storage adapter must independently verify the upload ID, digest, size and clean verdict against the private quarantined bytes, then persist the attestation with the approved object in the same atomic transition. It must not store the object and attestation in separate, independently committed transactions. An adapter that cannot atomically commit both must not treat the object as approved.

The attestation schema and clean/malicious/unknown fixtures establish normalized contract conformance only. They do not sign scanner output, prove scanner identity cryptographically, validate the actual production scanner, or certify host storage. Production deployments still require authenticated/versioned scanner adapters, protected key/credential management, private quarantine and approved namespaces, atomic promotion, authorized serving, image decode/re-encode, retention/cleanup and fault-injection tests.

## 7. Shared conformance vectors

tests/fixtures/upload-inspection/conformance-vectors.v1.json is the shared offline corpus for all three runtimes. It contains synthetic magic-byte prefixes, valid and invalid filename/MIME combinations, clean/malicious/unknown verdicts, and a scanner that returns without consuming the stream.

The fixtures test bounded signature identification and decision semantics only. They are not complete or structurally valid file samples and do not certify a decoder, image sanitizer, PDF parser, antivirus product or production storage implementation.

Each runtime test must consume the same vector file and prove:
1. supported signature maps to the expected MIME;
2. filename-extension and declared-MIME mismatches are rejected;
3. unsupported and truncated signatures are rejected;
4. only a complete, exact clean scan can reach private promotion;
5. malicious results are rejected and staging data is removed;
6. unknown and incomplete results remain private and are never promoted.

## 8. Host deployment requirements

- The multipart parser must enforce its own limits before handing a file stream to Guard.
- Quarantine and approved namespaces must both be private.
- Promotion must atomically re-check the exact SHA-256 and byte count.
- Scanner deadlines, cancellation, bounded concurrency and retention/cleanup monitoring are host responsibilities.
- Images must be decoded and re-encoded with a maintained image library before publication.
- Serve downloads through authorization-aware handlers with explicit content types, safe disposition and X-Content-Type-Options: nosniff; PDFs should be attachments by default.
- Never use a public web root or public object-store bucket for incoming uploads.
- A no_match or incomplete-coverage result from JB Malware Engine is not a clean verdict.

Passing the shared fixtures establishes only v1 contract conformance in the tested runtime. It does not establish production readiness, complete detection coverage or third-party certification.
