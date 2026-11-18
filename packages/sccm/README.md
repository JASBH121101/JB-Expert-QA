# JB SCCM — Sistema Central de Certificación de Motores

SCCM is the source of truth for hierarchical, evidence-backed certification across the JB Engines ecosystem. It is deliberately separate from GitHub Actions: a green workflow is evidence for a scope, not proof that every descendant module or component is certified.

## Certification hierarchy

`ecosystem → engine → branch → subbranch → module → component`

The versioned inventory at `manifests/inventory.v1.json` records stable IDs, ownership, parentage, source repository/ref, exact source commit, package version, criticality and required dependencies.

The append-only evidence ledger at `manifests/assessments.v1.json` stores each assessment's unique ID, node, version, exact commit SHA, timestamp, result, evidence URLs and unresolved findings. A new assessment supersedes the previous assessment for a node without deleting history.

## Status and gating rules

- `PASS` requires reproducible HTTPS evidence for the exact source SHA, successful evidence outcomes and no unresolved findings.
- `FAIL` requires failure evidence. A critical failure propagates to every ancestor.
- `PENDING` is the default when no assessment exists, when evidence is incomplete, or when a critical descendant or required dependency is not `PASS`.
- A parent can never bypass a critical pending/failed component. The same rule applies recursively across all six levels.
- A node's own test result is reported as `ownStatus`; its effective `status` includes descendant and dependency gates. This makes “CI passed, module still pending” explicit rather than hiding it.
- Non-critical failures remain visible as warnings. Criticality is explicit in the inventory and defaults to blocking.

## Reproducible commands

From the monorepo root:

```sh
npm run sccm:check
npm run sccm:report
```

The first command validates the registry and gate behavior. The second prints a JSON snapshot with effective statuses and counts. Both are local and dependency-free beyond the Node.js runtime already required by the monorepo.

## Extending the inventory

1. Add a node with the correct direct parent level and an existing source ID.
2. Update the source snapshot SHA when the audited repository revision changes.
3. Add assessments only after the exact source revision has been tested.
4. Never edit or delete historical assessment entries. Append a new record with a later timestamp and a unique assessment ID.
5. Keep unsupported modules/components as `PENDING`; do not infer their certification from an ancestor workflow.
6. Record engine-to-engine dependencies explicitly so an unverified dependency blocks the consumer.

## Current baseline

The initial inventory contains 140 nodes across eight engines. It records exact-main evidence for the Language QA component tree and Resilience A2 read-only reconciliation slice. Other engines and components remain pending until their scope-specific reviews and evidence are completed. The ecosystem is intentionally not marked certified.

SCCM does not deploy software, access production services, perform recovery actions, call external translation services or require paid providers.
