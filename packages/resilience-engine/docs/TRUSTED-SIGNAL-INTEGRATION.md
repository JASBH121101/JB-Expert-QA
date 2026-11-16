# Trusted Signal Producer and Store Integration (laboratory)

This document describes adapters for existing Security Guard Core v1 outputs and
JB Malware Engine scan reports, plus a durable local replay store. The adapters
are translation boundaries only. They do not change either source engine's
local security decision, collect telemetry, preserve raw samples, or authorize
recovery.

## Producer identity and host configuration

Each producer must be configured by the trusted host with one exact
\`sourceId\`, \`environment\`, and \`assetId\`. These values must exactly match one
source definition in the Trusted Signal Gateway registry. The host obtains the
HMAC key from its own secret store and passes it to the producer at runtime.
No production keys, trust roots, or default source identities are shipped.

The producer TTL defaults to 60 seconds and is bounded to five minutes. The
gateway must use matching source keys and scopes. The host remains responsible
for ensuring that an event or scan report really belongs to the configured
asset before calling an adapter.

## Security Guard adapter

Import \`@jb/resilience-engine/producers/security-guard\` and create a producer:

\`\`\`js
import { createSecurityGuardSignalProducer } from "@jb/resilience-engine/producers/security-guard";

const guardProducer = createSecurityGuardSignalProducer({
  sourceId: "guard-primary",
  environment: "production",
  assetId: "host-erp-01",
  signingKey: await hostSecretStore.get("resilience/guard-primary")
});

const envelope = guardProducer.fromThreatAssessment(threatAssessment);
await gateway.ingest(envelope);
\`\`\`

Mapping rules:

- Core v1 threat-assessment decisions \`challenge\`, \`review\`, and \`block\`
  become \`suspected\`.
- An \`observe\` assessment becomes \`unknown\`, never \`clear\`.
- A Core v1 security event is accepted only for category \`threat\`. Actions
  \`blocked\` and \`challenged\` become \`suspected\`; \`observed\` becomes
  \`unknown\`.
- The adapter never emits \`confirmed\` or \`tampered\`. A rejected HTTP request
  or a risk-policy block is not proof that the host itself is compromised.
- The adapter does not copy request identities, subjects, IP addresses, paths,
  payloads, or raw security telemetry into the Resilience envelope.

## Malware Engine adapter

Import \`@jb/resilience-engine/producers/malware-engine\`:

\`\`\`js
import { createMalwareEngineSignalProducer } from "@jb/resilience-engine/producers/malware-engine";

const malwareProducer = createMalwareEngineSignalProducer({
  sourceId: "malware-primary",
  environment: "production",
  assetId: "host-erp-01",
  signingKey: await hostSecretStore.get("resilience/malware-primary")
});

const report = await malwareEngine.scanFile(filePath);
const envelope = malwareProducer.fromScanReport(report, {
  evidenceRefs: await evidenceStore.retainAndReference(report)
});
await gateway.ingest(envelope);
\`\`\`

Mapping rules:

- \`malicious\` becomes \`confirmed\` only when the host supplies at least one
  retained evidence reference whose SHA-256 matches the scan report digest.
- A \`malicious\` report without a matching retained evidence reference is
  downgraded to \`suspected\`.
- \`suspicious\` becomes \`suspected\`.
- \`unknown\` and \`no_match\` become \`unknown\`. In particular, \`no_match\` is
  not a clean verdict and never becomes \`clear\`.
- The adapter accepts only opaque evidence reference IDs and their matching
  SHA-256 digests. The host owns evidence retention, access control, and
  eventual disposal.

The current Malware Engine report has no durable evidence-store reference of
its own. A host must retain the artifact under its evidence policy and pass
the resulting reference; the adapter will not invent one.

## Durable local replay store

Import \`@jb/resilience-engine/trusted-signal-store\`:

\`\`\`js
import {
  createFileTrustedSignalStore,
  createTrustedSignalGateway
} from "@jb/resilience-engine";

const replayStore = createFileTrustedSignalStore({
  filePath: "/var/lib/jb-resilience/trusted-signals.json"
});

const gateway = createTrustedSignalGateway({
  sources: [
    {
      sourceId: "guard-primary",
      engine: "security-guard",
      environment: "production",
      assetIds: ["host-erp-01"],
      key: await hostSecretStore.get("resilience/guard-primary")
    },
    {
      sourceId: "malware-primary",
      engine: "malware-engine",
      environment: "production",
      assetIds: ["host-erp-01"],
      key: await hostSecretStore.get("resilience/malware-primary")
    }
  ],
  replayStore
});
\`\`\`

The store:

- Uses an exclusive lock file to serialize writes across processes on one host.
- Claims \`(sourceId,eventId)\` exactly once and distinguishes replay from
  conflicting event-ID reuse.
- Writes bounded JSON state through a private temporary file, fsync, atomic
  rename, and directory sync.
- Revalidates persisted envelope shape and stored SHA-256 digests on every read.
- Never silently evicts replay keys. Capacity exhaustion, lock timeout,
  malformed ledger data, or failed persistence returns an error/rejection;
  callers must fail closed.

The file store is durable for a protected local filesystem on a single host. It
is **not** a cross-host transaction/consensus store and must not be placed on an
eventually consistent network share. Multi-host operation still requires a
database-backed adapter whose insert is protected by a unique constraint or
equivalent transaction, and whose reads are consistent. No database driver,
connection, external service, or paid infrastructure is introduced here.

## Recovery implications and remaining gates

These producer adapters intentionally do not manufacture a \`clear\` heartbeat.
The current Security Guard \`observe\` assessment is not a host-integrity
attestation, and Malware Engine \`no_match\` is explicitly not a clean verdict.
Consequently, a gateway that requires both engines may continue to report
\`unknown\` until a separately designed, authenticated clean/health attestation
contract exists. That blocks automatic recovery rather than assuming safety.

This integration does not enable production use, A2 containment, A3 failover,
or OS actions. Remaining gates include:

1. Host-owned evidence retention and source-to-asset authorization.
2. Key provisioning, rotation, revocation, and trust-registry lifecycle.
3. A clean/heartbeat attestation contract with bounded freshness.
4. A multi-host transactional replay-store adapter if multi-host operation is
   required.
5. End-to-end tests in the actual host integration environment.
