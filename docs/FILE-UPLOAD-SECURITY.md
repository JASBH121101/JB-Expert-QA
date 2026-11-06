# File upload security and malware quarantine

## Current status

JB Security Guard provides the upload-inspection orchestration contract and a bounded streaming ingestion path. It does not include an antivirus engine, cloud-storage client, or production quarantine adapter. The test-only in-memory store and mock scanner prove the lifecycle contract; they are not production integrations.

## Required upload lifecycle

1. **Receive:** apply request-size, per-file-size, aggregate-size, file-count, field-count, and multipart-part limits in the HTTP server and framework parser.
2. **Quarantine:** stream each object to private, non-public storage under a server-generated opaque identifier. Do not use the client filename as a filesystem path, object key, or URL.
3. **Inspect:** Guard counts actual bytes, calculates SHA-256, identifies the file using a short signature prefix, and checks the detected type against its built-in allowlist. Client-supplied MIME type and extension are untrusted hints and must agree when supplied.
4. **Scan:** pass the complete quarantined object to a maintained malware scanner. Require an explicit clean verdict, engine name, engine version, and scan timestamp.
5. **Promote:** only after a clean verdict, atomically mark the object as approved and move/copy it into the application's approved storage namespace.
6. **Serve:** serve approved objects with an explicit Content-Type, X-Content-Type-Options: nosniff, and safe Content-Disposition. Prefer attachment for documents. Do not render HTML, SVG, or other active content inline on the authenticated application's origin.
7. **Retain and audit:** keep a record of opaque object ID, size, SHA-256, detected type, scanner verdict/version, timestamps, and actor ID under the application's privacy policy. Never log file bytes, recovery tokens, session cookies, or other secrets.

## Guard upload inspector

The runtime API is createUploadInspector({ store, scanner, ...options }). It can also be created by guard.createUploadInspector(...).

~~~js
import { createUploadInspector } from "@jb/security-guard";

const inspector = createUploadInspector({
  store: privateQuarantineAdapter,
  scanner: malwareScannerAdapter,
  maxBytes: 5 * 1024 * 1024,
  scannerTimeoutMs: 15_000
});

// fileStream must be the individual file stream emitted by a bounded
// multipart parser. Never pass an unbounded request body as a file stream.
const result = await inspector.inspect({
  source: fileStream,
  fileName: upload.originalName,
  declaredMimeType: upload.mimeType
});

// Persist result.uploadId and result.sha256 with the authenticated actor.
// Only an approved result may be made available to a download route.
~~~

The default content allowlist is deliberately narrow: JPEG, PNG, GIF, WebP and PDF. Guard does not approve SVG, HTML, XML, ZIP archives, executables, or arbitrary MIME types. The allowedMimeTypes option can narrow the built-in list; it cannot add new types without code-level signature support. application/octet-stream is accepted as a generic client hint, but the file signature must still match an allowed type.

**Important boundary:** signature inspection is bounded prefix-based type identification, not full format validation, content disarm/reconstruction (CDR), or proof that a file is safe. A valid header does not rule out malformed, polyglot, or active trailing content. Decode and re-encode user-uploaded images with a maintained image library before publication. Serve PDFs as attachments by default; if previews are required, render them on a separate untrusted-content origin with restrictive browser policy. Keep `X-Content-Type-Options: nosniff` and explicit `Content-Disposition` controls.

### Adapter contracts

The store adapter must implement:

- createWriteStream({ uploadId }): return a writable stream that writes only to private quarantine storage. The object must not be reachable from public URLs or normal download routes.
- createReadStream({ uploadId }): return a readable stream of the complete quarantined object for scanning.
- promote({ uploadId, metadata, expectedSha256, expectedSize }): atomically compare the current quarantined object's bytes to the expected digest and size, and promote that exact immutable object in one transaction. Resolve with { promoted: true } only after the verified approved object is committed. A separate check followed by a later copy is vulnerable to a time-of-check/time-of-use race.
- delete({ uploadId }): idempotently delete a quarantined object. Repeated deletion requests for the same opaque ID must be safe because timeouts can race with late adapter completion.

scanner.scan({ stream, uploadId, size, sha256, detectedMimeType, signal }) must consume the entire stream and return { verdict: clean | malicious | unknown, engine, version }. The scanner adapter must honor AbortSignal; it must not return clean before the complete file has been inspected. Guard wraps the scanner input in a streaming verifier. It recalculates SHA-256 and byte count over the bytes flowing to the scanner, rejects truncation, extension, or content substitution, and verifies that the readable stream reached its end before accepting a clean verdict. It then passes the expected digest and size to promote(); the storage adapter must atomically verify those values against the quarantined object at promotion time. This closes the gap between the initial upload hash, the object scanned, and the object approved, provided the production adapter honors the atomic verification contract.

Guard defaults to a 5 MiB file limit and a 15-second scan timeout. Storage writer and reader initialization are also bounded by the ingestion timeout; late-arriving streams are destroyed and cleanup is retried without leaving the request waiting indefinitely. Quarantine deletion has a bounded cleanup wait and emits a sanitized cleanup-failed event when the adapter does not respond. These adapter timeouts do not make an uncooperative remote store transactional: production adapters must still implement idempotent writes, atomic promotion, and lifecycle cleanup. All limits are configurable within hard upper bounds. Scanner outages, timeouts, invalid results, unknown verdicts, and promotion failures never approve the file. Items whose scanner/approval status is uncertain remain in quarantine and must be private.

## Fail-closed requirements

- A scanner timeout, unreachable scanner, malformed scanner response, unsupported file type, or unknown verdict must leave the object quarantined or delete it; it must never be publicly approved.
- A retry must be idempotent; do not create multiple public copies for one upload.
- Deletion and retention jobs must operate on opaque server-generated IDs, not user-controlled paths.
- A rejected object must never be accessible through the normal download or preview route.
- Never extract an archive directly into a public or application directory.
- For archives, enforce maximum entry count, nesting depth, compressed bytes, expanded bytes, expansion ratio, and reject path traversal, absolute paths, symlinks, and special files before extraction.
- A clean verdict must be bound to the exact SHA-256 and size of the quarantined object; the storage adapter should prevent mutation between scan and promotion.
- Promotion must be atomic. If the adapter cannot guarantee that, do not use it for production approval.

## Parser and storage limits

Configure limits independently at every boundary:

- Node.js server request and header timeouts.
- Guard maxBodyBytes and Expect: 100-continue gate.
- JSON and URL-encoded parser limits.
- Multipart file-size, file-count, field-count, parts-count, and field-size limits.
- Per-user and per-IP upload quotas plus concurrency limits.
- Private storage quota and maximum object size.
- Scanner execution time, memory, and decompression limits.

A Content-Length check alone is not enough: chunked uploads do not declare the full payload size. The HTTP server and multipart parser must count actual received bytes and abort at the configured limit. Guard's file inspector applies a second per-file streaming cap after the parser has produced the file stream.

## Quarantine retention and cleanup

Keep unknown, timed-out, malformed, or unavailable scan results private for investigation/retry. The host application must define a short, bounded quarantine retention period, retry budget, cleanup schedule, and storage quota. A failed deletion must generate an operational alert without exposing object paths or scanner internals.

## Scanner integration acceptance tests

- A normal allowed image and document reach the approved namespace only after a clean scan.
- A file with a misleading extension or MIME type is rejected when its signature is not allowed.
- A known harmless antivirus test fixture is detected by the configured scanner and remains quarantined/rejected.
- Scanner timeout, service outage, malformed response, and unknown verdict all fail closed.
- Oversized single files, too many files/parts, and oversized aggregate bodies are rejected.
- Archive bombs, nested archives, path traversal names, symlinks, and unsupported file types are rejected without extraction outside quarantine.
- A pending or rejected object cannot be fetched through the user-facing download route.
- Logs and telemetry contain no file content, filenames, object paths or secrets.

## Integration boundary

This is an upload-inspection engine contract, not a production antivirus certification. Select and configure the actual scanner, private quarantine storage, retention policy, multipart parser, and download authorization in the host application before production uploads are permitted. JB Guard cannot scan an upload until the host application supplies real adapters.
