# JB Security Bridge — double-filter protocol v1

## Purpose

JB Security Bridge coordinates two independent security decisions for one resource or transaction:
- JB Expert QA: browser, URL, DNS, network-egress and navigation controls.
- JB Security Guard: request/upload policy, file inspection and quarantine.
- JB Malware Engine remains Security Guard's local scanning engine. It does not become a third independent approval authority.

The bridge correlates assessments. It does not replace either product's native policy and does not certify a resource as safe.

## Assessment protocol

Each producer submits an assessment with:
- schema: jb.security.assessment/v1
- eventId: unique event identifier
- correlationId: caller-generated ID shared by both filters for the same object or transaction
- producer: jb-expert-qa or jb-security-guard
- verdict: pass, review, quarantine or block
- severity: info, low, medium, high or critical
- reasonCode: stable machine-readable code, without sensitive data
- observedAt: ISO-8601 timestamp
- evidence: optional lowercase SHA-256 only

Use one correlationId per uploaded/downloaded object. Never reuse it for unrelated resources. A known SHA-256 mismatch under one correlationId is rejected.

## Decision policy

- allow only when both producers explicitly return pass.
- block if either producer returns block or critical severity.
- quarantine if either producer requests quarantine.
- review if an assessment is missing, inconclusive or high severity.
- a later clean event cannot downgrade a prior block or quarantine decision.
- if the bridge is unreachable, Security Guard must retain the object in quarantine.

Expert QA's passing site audit is not a malware verdict. Security Guard's clean file scan is not proof that the destination or navigation was safe. Both assessments must refer to the same correlationId.

## Authentication and transport

Messages are signed with HMAC-SHA-256 over the normalized assessment and sentAt timestamp. The receiver uses constant-time signature comparison, a 60-second clock-skew window, unique event IDs, bounded replay protection and bounded correlation storage.

Secrets are injected at runtime. Do not commit secrets, sample production keys, credentials, full URLs, query strings, request bodies or local file paths.

The first transport is intentionally local-only:
- HTTP listener binds only to 127.0.0.1.
- no CORS and no public network listener.
- request body is bounded and content type is checked.
- event IDs and correlation records are held in bounded memory for 15 minutes by default.
- the process restart clears in-memory state; both filters must reassess.
- remote or multi-host use requires a separately reviewed HTTPS/mTLS transport.

## Upload integration

When enabled in JB Security Guard, the upload inspector submits its assessment before storage promotion. It promotes only after the combined action is allow. Pending, review, quarantine, block or transport failure leaves the object quarantined and prevents promotion.

The bridge does not treat Malware Engine no_match as clean. The existing scanner verdict rules remain unchanged.

## Operational limits

This is an initial local coordination layer, not an endpoint firewall, VPN, Wi-Fi security product, durable incident database or security certification. It coordinates the two products' decisions but does not inspect encrypted traffic or independently stop network traffic. JB Expert QA's egress proxy and other browser controls remain separate enforcement components.
