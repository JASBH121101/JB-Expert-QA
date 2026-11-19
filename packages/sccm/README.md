# JB SCCM — Sistema Central de Certificación de Motores

SCCM is the source of truth for hierarchical, evidence-backed certification across the JB Engines ecosystem. It is deliberately separate from GitHub Actions: a green workflow is evidence for a scope, not proof that every descendant module or component is certified.

## Certification hierarchy

`ecosystem → engine → branch → subbranch → module → component`

The versioned inventory at `manifests/inventory.v1.json` records stable IDs, ownership, parentage, source repository/ref, exact source commit, package version, criticality, required dependencies and optional `inScope` flag. Omitted `inScope` means `true`; explicit `false` marks a capability outside the approved project scope.

The append-only evidence ledger at `manifests/assessments.v1.json` stores each assessment's unique ID, node, version, exact commit SHA, timestamp, result, evidence URLs and unresolved findings. New assessments may include `sourceId` to bind to a newly added immutable source snapshot; legacy entries continue to resolve through the node's original source. Source snapshots are added, never rewritten, so a component can be reassessed at a new SHA without invalidating or editing its older evidence.

## Status and gating rules

- `PASS` requires reproducible HTTPS evidence for the exact source SHA, successful evidence outcomes and no unresolved findings.
- `FAIL` requires failure evidence. A critical failure propagates to every ancestor.
- `PENDING` is the default when no assessment exists, when evidence is incomplete, or when an in-scope critical descendant or required dependency is not `PASS`.
- `OUT_OF_SCOPE` is a calculated inventory state, not a test result. It is excluded from certification denominators and does not block ancestors. Historical assessments remain in the append-only ledger.
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
2. Add a new immutable source snapshot for each audited repository revision; do not rewrite an older snapshot SHA.
3. Add assessments only after the exact source revision has been tested, including its `sourceId` for new revisions.
4. Never edit or delete historical assessment entries. Append a new record with a later timestamp and a unique assessment ID.
5. Keep unfinished capabilities that remain in scope as `PENDING`; mark explicitly excluded capabilities with `inScope: false` and document the project decision. Never convert an excluded capability into a false `PASS`.
6. Record engine-to-engine dependencies explicitly so an unverified dependency blocks the consumer.

## Current baseline

The versioned inventory contains 142 registered nodes across eight engines. The approved certification scope explicitly excludes the Resilience A2 read-only reconciliation, A2 containment and A3 failover subtrees: 18 nodes in total. These nodes carry `inScope: false`, are reported as `OUT_OF_SCOPE`, and do not contribute to the in-scope denominator or block JB Resilience. This is a project scope decision, not a certification claim and not a request to implement those capabilities.

The 161-entry assessment ledger remains append-only. No historical PASS or PENDING evidence is deleted or rewritten; the evaluator simply separates those historical entries from the active scope. Resilience A1 policy/authorization remains in scope. The remaining 124 in-scope nodes are evaluated normally against their latest exact-SHA evidence. The SCCM workflow report is the authoritative result for any candidate commit; this document does not substitute prose for CI evidence.

All engine certifications remain bounded by their documented test matrices and adapters. A PASS for a test scope is not a guarantee of penetration-test coverage, external provider availability, live exchange-rate feeds, production deployment or operational performance outside the tested environment.
SCCM does not deploy software, access production services, perform recovery actions, call external translation services or require paid providers.

Security QA was re-certified after PR #184 on merged main commit `0c3bef31e9f31d5fb859a23b96ed609940dd1234`. The updated `jb-expert-qa-main-0c3bef31` source snapshot and append-only assessments cover the Security QA branch, static-analysis subbranch, module and rule-integrity component. Exact-main evidence: Security QA 2/2 jobs, Core validation 2/2 jobs and integrated JB Engines Certification 30/30 jobs passed.


Language QA was re-assessed after PR #192 on exact merged main snapshot `9907c3949602c31753e59ee948ef565d197e7a1e`. The Language QA branch, Translation integrity subbranch, Language QA module and Human review state component have new PASS assessments bound to that immutable source snapshot. Evidence includes the dedicated Language QA regression run, Core validation on Node.js 22/24, Security QA and the full 30-job integrated engine certification. The review-state assessment now covers SHA-256 content-bound approval, deterministic translation fingerprints, structural-gate precedence, stale-approval invalidation and accessor-safe approval records.


## Language QA linguistic-signals closeout — 2026-11-19

The deterministic linguistic review signals are registered as component `jb.expert-qa.language.linguistic-signals` and assessed PASS on the exact PR #208 head `ab6072e3d2404c30b39381e378a029fb22847f20`. Evidence: [Language QA validation](https://github.com/JASBH121101/JB-Expert-QA/actions/runs/44625540682) and [integrated JB Engines Certification](https://github.com/JASBH121101/JB-Expert-QA/actions/runs/44625540437). Signals remain advisory: repeated common words, unfinished markers and mojibake require human review; they do not translate or auto-approve copy.
