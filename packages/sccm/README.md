# JB SCCM — Sistema Central de Certificación de Motores

SCCM is the source of truth for hierarchical, evidence-backed certification across the JB Engines ecosystem. It is deliberately separate from GitHub Actions: a green workflow is evidence for a scope, not proof that every descendant module or component is certified.

## Certification hierarchy

`ecosystem → engine → branch → subbranch → module → component`

The versioned inventory at `manifests/inventory.v1.json` records stable IDs, ownership, parentage, source repository/ref, exact source commit, package version, criticality and required dependencies.

The append-only evidence ledger at `manifests/assessments.v1.json` stores each assessment's unique ID, node, version, exact commit SHA, timestamp, result, evidence URLs and unresolved findings. New assessments may include `sourceId` to bind to a newly added immutable source snapshot; legacy entries continue to resolve through the node's original source. Source snapshots are added, never rewritten, so a component can be reassessed at a new SHA without invalidating or editing its older evidence.

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
2. Add a new immutable source snapshot for each audited repository revision; do not rewrite an older snapshot SHA.
3. Add assessments only after the exact source revision has been tested, including its `sourceId` for new revisions.
4. Never edit or delete historical assessment entries. Append a new record with a later timestamp and a unique assessment ID.
5. Keep unsupported modules/components as `PENDING`; do not infer their certification from an ancestor workflow.
6. Record engine-to-engine dependencies explicitly so an unverified dependency blocks the consumer.

## Current baseline

The versioned inventory contains 141 nodes across eight engines. The Language QA branch and module are PASS, including the CLDR catalog-audit component, with evidence bound to source snapshot `13fbe4162aeb0132598d7038789bffe9a592fa00`. Its required Localization Engine CLDR plural-rules component is also PASS. The Visual QA module is PASS for screenshot diff, layout-overflow, responsive viewport matrix and browser interaction-state components, with evidence bound to exact source snapshot `32d1b5f2bd227308fd3cbb03b6dda06a13cb86e8`. The Visual QA branch, browser-analysis subbranch and module are PASS with evidence bound to the current certification snapshot. The Security QA branch, static-analysis subbranch, module and three components are PASS for the declared local static-analysis/dependency-audit scope; online OSV lookup remains opt-in and this is not penetration-test certification. The Expert QA engine remains PENDING because other critical sibling branches are not yet certified. The Database QA branch and integration subbranch are PASS for the bounded PostgreSQL-first scope: PostgreSQL integration, static migration consistency and transaction/rollback components passed, using disposable PostgreSQL 16 CI on Node.js 22/24; optional Neon was explicitly skipped, and no production database was used. This does not certify MySQL, SQLite, arbitrary migration replay, backups or production readiness. The Package QA branch and distribution subbranch are PASS; clean consumer installation, public exports/entrypoints and dependency/package-boundary components are PASS from the seven-package tarball and clean-install workflow on Node.js 22/24. This validates the tested distribution paths, not all downstream application environments. Localization Engine BCP 47 canonicalization, deterministic fallback and date/number formatting components are now PASS; its CLDR plural-rules component remains independently bound to the PR #167 snapshot. The Localization Engine runtime hierarchy is PASS. The separate Currency QA branch, locale-validation subbranch, module and its three critical components (ISO registry, decimal precision and locale formatting) are PASS, bound to the exact Currency QA merge snapshot `fd510de51b61222bd63beb98a3ce0d5c189a6a01` and validated on Ubuntu 24.04 and Windows Server 2022 with Node.js 22 and 24. Currency Engine's curated ISO code/minor-unit registry, exact BigInt arithmetic, injected FX contract and locale formatting are PASS; the Currency Engine hierarchy is PASS within those documented bounds. This does not certify a complete current ISO list or any live FX provider. Resilience A1 policy/authorization branch and module are PASS for the bounded, tested contracts. A2 containment-safety and independent-verification components are PASS for laboratory contracts only; their module/subbranch/branch remain PENDING and A2 remains denied. A3 PostgreSQL target-state fencing and trusted-signal replay components are PASS for a single-primary laboratory only; leader election and the A3 module/subbranch/branch remain PENDING. These results do not certify production providers, autonomous containment, distributed consensus or production failover. The ecosystem is intentionally not marked certified.

SCCM does not deploy software, access production services, perform recovery actions, call external translation services or require paid providers.
