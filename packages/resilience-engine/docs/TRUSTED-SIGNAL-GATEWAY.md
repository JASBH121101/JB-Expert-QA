# Trusted Signal Gateway v0.4

## Purpose

The Trusted Signal Gateway is the authenticated ingress boundary between JB Security Guard, JB Malware Engine and JB Resilience Engine. It accepts signed, bounded security signals; it does not collect telemetry or execute remediation.

Security Guard and Malware Engine remain the owners of their detection findings. Resilience consumes only the normalized state emitted by an explicitly configured, authenticated producer. Existing Security Guard Core v1 events and Malware Engine triage reports are not implicitly trusted or automatically translated into confirmed verdicts.

## Envelope: `jb.resilience.trusted-signal/v1`

Every envelope contains exactly:

- `eventId`: UUID used as the replay key with `sourceId`.
- `sourceId`, `sourceEngine`: exact identity and engine name registered by the host.
- `environment`, `assetId`: exact environment and asset scope registered for that source.
- `issuedAtMs`, `expiresAtMs`: UTC epoch milliseconds; maximum lifetime is five minutes by default.
- `state`: `clear`, `suspected`, `confirmed`, `tampered`, or `unknown`.
- `severity`, `reasonCode`, `evidenceRefs`: bounded metadata and immutable evidence references.
- `signature`: HMAC-SHA-256 over the canonical envelope without the signature field.

The producer key is injected through host-owned configuration and must contain at least 32 UTF-8 bytes. No production key, default trust root, or environment secret is shipped in this package. Source identity, engine identity, environment and allowed asset IDs are pinned together in the gateway registry. Wildcards are not accepted.

Confirmed and tampered signals require at least one evidence reference. Each reference contains an opaque `refId` and a SHA-256 digest; the gateway preserves those references and never deletes source evidence.

## Replay-store contract

A production adapter must declare `durable: true` and implement:

- `recordSignal({ signal, signalDigest, receivedAtMs, retentionUntilMs })`: an atomic unique claim on `(sourceId,eventId)`; return `{ recorded: true }` exactly once, and reject duplicates or conflicting ID reuse.
- `listSignals({ assetId, environment, sinceMs })`: a consistent read of retained signed envelopes and their stored digests.

The in-memory implementation is test/development-only. It is rejected by default and can be enabled only with both `requireDurableStore: false` and `allowInMemoryStore: true`. It never evicts records automatically because eviction would reopen replay windows. A database/transactional adapter is required before production use.

The gateway verifies signatures and digests again when reading persisted records. Store outages, malformed records and integrity mismatches never become a clear signal.

## Fail-closed aggregation

All configured source identities scoped to an asset/environment are required to have a fresh signal. Missing sources resolve to `unknown`; expired required signals resolve to `stale`. A `clear` signal mixed with a non-clear finding resolves to `conflicting`. `tampered` dominates; explicit `unknown` blocks a clear result. A confirmed finding without conflicting clear evidence resolves to `confirmed`; suspected findings resolve to `suspected`.

Every result sets `preserveEvidence: true` and `authorizationGranted: false`. Even a fully clear result is only an authenticated signal state; it is not a recovery permit, policy approval, containment order or failover authorization. Existing v1 recovery stays unchanged. A2 containment and A3 failover remain unavailable pending separate certifications.

## Limits and operational boundary

- Ingress only: no OS telemetry collection, shell commands, service restarts, network changes, quarantine, containment or failover.
- No production secrets, key rotation service, cross-host consensus database or deployment configuration are included.
- Clock skew, signal lifetime, history window, envelope size, source count and evidence-reference count are bounded.
- A durable adapter must preserve atomic replay claims across process restarts and concurrent gateway instances; an eventually consistent or process-local implementation is not sufficient.
