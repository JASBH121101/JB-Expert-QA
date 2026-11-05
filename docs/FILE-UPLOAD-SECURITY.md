# File upload security and malware quarantine

## Current status

JB Security Guard currently enforces declared request-body limits and can reject oversized Expect: 100-continue requests at the Node.js server boundary. It does not scan file contents and must not be described as antivirus protection. A real malware-scanning engine and private quarantine storage have not been connected.

## Required upload lifecycle

Every upload in a production host application must follow this state flow:

1. **Receive:** apply request-size, per-file-size, aggregate-size, file-count, field-count, and multipart-part limits in the HTTP server and framework parser.
2. **Quarantine:** stream the object to private, non-public storage under a server-generated opaque identifier. Do not use the client filename as a filesystem path, object key, or URL.
3. **Inspect:** verify an application allowlist, inspect file signatures (magic bytes), compare the detected type with the permitted type, and reject malformed files. Client-supplied MIME type and extension are untrusted hints only.
4. **Scan:** pass the quarantined object to a maintained malware scanner. Require an explicit clean verdict, scanner engine/version, and scan timestamp.
5. **Promote:** only after a clean verdict, atomically mark the object as approved and move/copy it into the application's approved storage namespace.
6. **Serve:** serve approved objects with an explicit Content-Type, X-Content-Type-Options: nosniff, and safe Content-Disposition. Prefer attachment for documents. Do not render HTML, SVG, or other active content inline on the authenticated application's origin.
7. **Retain and audit:** keep a record of opaque object ID, size, hash, detected type, scanner verdict/version, timestamps, and actor ID under the application's privacy policy. Never log file bytes, recovery tokens, session cookies, or other secrets.

## Fail-closed requirements

- A scanner timeout, unreachable scanner, malformed scanner response, unsupported file type, or unknown verdict must leave the object quarantined.
- A retry must be idempotent; do not create multiple public copies for one upload.
- Deletion and retention jobs must operate on opaque server-generated IDs, not user-controlled paths.
- A rejected object must never be accessible through the normal download or preview route.
- Never extract an archive directly into a public or application directory.
- For archives, enforce maximum entry count, nesting depth, compressed bytes, expanded bytes, expansion ratio, and reject path traversal, absolute paths, symlinks, and special files before extraction.
- Re-scan retained content when the malware definitions or scanning engine materially change, when feasible.

## Parser and storage limits

Configure limits independently at every boundary:
- Node.js server request and header timeouts.
- Guard maxBodyBytes and Expect: 100-continue gate.
- JSON and URL-encoded parser limits.
- Multipart file-size, file-count, field-count, parts-count, and field-size limits.
- Per-user and per-IP upload quotas plus concurrency limits.
- Private storage quota and maximum object size.
- Scanner execution time, memory, and decompression limits.

A Content-Length check alone is not enough: chunked uploads do not declare the full payload size. The framework parser and upload stream must count actual received bytes and abort at the configured limit.

## Scanner integration acceptance tests

Before enabling uploads, test at minimum:
- A normal allowed image and document reach the approved namespace only after a clean scan.
- A file with a misleading extension or MIME type is rejected when its signature is not allowed.
- A known harmless antivirus test fixture is detected by the configured scanner and remains quarantined/rejected.
- Scanner timeout, service outage, malformed response, and unknown verdict all fail closed.
- Oversized single files, too many files/parts, and oversized aggregate bodies are rejected.
- Archive bombs, nested archives, path traversal names, symlinks, and unsupported file types are rejected without extraction outside quarantine.
- A rejected or pending object cannot be fetched through the user-facing download route.
- Logs and telemetry contain no file content or secrets.

## Integration boundary

This document is a security requirement, not an implementation claim. Select and configure the real scanner, quarantine storage, retention policy, upload parser, and download authorization in the host application before production uploads are permitted. JB Guard cannot scan a file merely by observing its HTTP request.
