# JB Threat Lab — architecture and safety policy

## Mission

JB Threat Lab is a reusable validation laboratory for independently developed engines, applications, services, and future products. It is not limited to the three current JB engines. Its first integration targets are JB Expert QA, JB Security Guard, JB Malware Engine, NEXORA, and disposable client-project test instances.

## Separation of responsibilities

- **Threat Lab core:** scenario registry, target adapters, execution orchestration, normalized reports, and test evidence.
- **Target products:** the engines and applications being evaluated. They retain their own source, releases, data, and security decisions.
- **Profiles/adapters:** project-specific integration packages that translate a generic scenario into the target's supported test interface. No product-specific code belongs in the core unless it is a genuinely reusable lab primitive.

A lab pass means only that the named scenario produced its expected outcome. It does not certify the entire product or establish that a file, application, or environment is safe.

## First profiles

| Target | Planned test areas |
| --- | --- |
| JB Malware Engine | EICAR harmless test string; exact test-only signatures; inert suspicious text; benign false-positive checks; unknown/incomplete coverage; ZIP, PDF and PE parser boundaries; bounded scanning |
| JB Security Guard | XSS, SQL injection and path-traversal request patterns; ambiguous HTTP framing; upload size/type/digest checks; scanner timeout/error handling; fail-closed quarantine and promotion |
| JB Advisor Engine | deterministic product recommendation; fragrance/technology domain separation; offline research-candidate review gates; no automatic promotion to verified evidence |
| JB Expert QA | intentionally vulnerable source fixtures; repaired-code regression; database raw-query/TLS checks; deterministic visual regression; accessibility and responsive QA |
| NEXORA | owner authentication; authorization boundaries; business registration; templates; product CRUD; currency rules; PDF export; upload constraints; responsive/accessibility checks |
| Perfumaría JB (future profile) | initially a lightweight public catalogue with a private owner panel for products and photos; later, when the business grows, a separately installable modular Laravel/PHP ERP package for a VPS |
| Client ERP projects | disposable database; inventory arithmetic; stock movement invariants; roles; audit trail; input validation; backup/restore; export integrity; performance budgets |

NEXORA and Perfumaría JB are independent future integration targets, not dependencies of the current lab package. The Perfumaría JB storefront and its future ERP are not being developed in this PR.

## Malware testing boundary

The initial malware profile is static and fixture-based. It uses EICAR (a harmless antivirus test string), synthetic test-only signatures, benign files, and inert text fixtures. It does not run trojans, ransomware, spyware, worms, keyloggers, exploit code, or live samples. It does not download samples or connect to malware feeds. No claim is made that the current Malware Engine detects all families or variants.

Dynamic malware behavior analysis, if ever approved, requires a separate isolated disposable VM, no shared credentials, no production connectivity, snapshots, strict egress denial, and a separately reviewed handling policy. It is not part of the initial implementation.

## Safety controls

1. Scenarios must explicitly declare safe, offline, non-destructive, and non-executing.
2. Submitted samples are never executed by the lab.
3. Test data and databases must be disposable and separate from production.
4. Adapter code is trusted code, not sandboxed by the metadata gate; review it, use explicit timeouts and bounded inputs, and exclude secrets and personal data from reports.
5. No automatic source repair, database mutation, deployment, package publication, or production action.
6. No paid services, cloud malware feeds, external sample uploads, telemetry, or new paid infrastructure.
7. Every integration is opt-in and separately reviewed.

## Certification reporting

Reports now use `jb.threat-lab.report/v2`. Version 2 adds difficulty metadata, weighted coverage assessment, per-target readiness, and explicit skip reasons while retaining target identity/version, scenario identity/category, pass/fail/skip status, findings, metrics, and duration. Consumers that validate the report schema should accept v2 explicitly; do not interpret a v2 report as a v1 payload. Certification must list exactly which scenarios ran, skipped, and failed, and must not extrapolate beyond that scope.

## Trojan-focused validation

The Malware Engine also has dedicated, safe regression coverage beyond the core 17-scenario three-engine matrix:

- **Script delivery and persistence:** inert fixtures correlate download + dynamic execution with Windows Run-key, scheduled-task, service, and WMI event-subscription persistence indicators.
- **PE/RAT capability correlation:** a synthetic PE fixture correlates process-injection imports with remote command-channel imports; a control fixture verifies that process-injection imports alone do not imply RAT/Trojan behavior.
- **Backdoor/persistence:** a synthetic PE fixture correlates Windows service-persistence imports with remote command-channel and process-launch capabilities.
- **Credential theft/exfiltration:** a synthetic PE fixture correlates process-memory and logon-session access imports with remote-transfer capabilities.
- **Process hollowing:** unit coverage verifies that process-hollowing capability plus a remote command channel produces RAT/Trojan-like candidate labels.
- **False-positive guard:** a single low-specificity download marker and isolated process-injection imports must not produce a Trojan/RAT family candidate.
- **Containment boundary:** a suspicious Trojan-like candidate cannot be passed to `quarantineFile`; only an authentic `malicious` report from the same engine instance is eligible.

These are static behavior correlations over inert text and synthetic PE structures. They never execute files, create a network connection, or confirm malware. A family candidate remains `suspicious` and is not automatically quarantined. Exact configured hash/byte-signature matches remain the confirmed `malicious` path.

## Signed signature-bundle trust and rollback controls

The Malware Engine supports optional monotonic bundle sequencing and caller-persisted anti-rollback checkpoints:

- Ed25519 signatures are verified against explicitly trusted public-key IDs.
- Locally revoked key IDs are rejected even when the supplied bundle has a valid signature.
- Strict mode requires a positive signed `sequence` and a `signatureBundleState` created by `createSignatureBundleState()` or restored from its JSON representation.
- Lower sequence numbers are rejected; different signed content cannot reuse an accepted sequence; the exact same bundle is idempotent.
- Checkpoints are advanced only after all bundles and signature rules validate successfully. A rejected batch does not partially advance state.
- Key rotation is supported by adding a new trusted key ID and revoking the previous ID.

The checkpoint is caller-owned state, not protected storage. The host application must persist it atomically under restrictive operating-system permissions. Restoring an older or attacker-modified checkpoint defeats rollback protection. No signing private key, remote update feed, key server, or live malware database is shipped or configured. Legacy schema-v1 bundles without a sequence remain accepted only when strict sequencing is not requested and no checkpoint state is supplied.

## Current implementation status

The reusable core, target-scoped scenario registry, explicit offline/non-destructive/non-executing safety contract, inert fixtures, and versioned report schema are implemented in `@jb/threat-lab`. Its current four-engine integration matrix contains **20 scenarios**, all calling real engine APIs against temporary local fixtures and in-memory upload storage.

- **JB Malware Engine — 6 scenarios:** exact harmless EICAR match; benign no-match/false-positive; inert PowerShell-like text classified as suspicious, not confirmed malicious; exact configured SHA-256 signature detection; over-limit file returned as `unknown`; PDF active-action indicators classified as suspicious without an exact malware detection.
- **JB Security Guard — 8 scenarios:** the six existing request/upload controls plus composed origin allowlisting and session-bound CSRF checks, and a bounded rate-limit capacity/identity-rotation/reset sequence.
- **JB Expert QA — 6 scenarios:** the five existing HTML, database, visual, and Language QA checks plus compound local static-security analysis with safe controls and deterministic rescans.

**Latest completed validation for PR #38, branch commit `698c605b75f28c929b294c4272e69bd6fcee3408`, targeting `integration/jb-threat-lab`:**
- [Core validation #43622143702](https://github.com/JASBH121101/JB-Expert-QA/actions/runs/43622143702): Node.js 22 ✅ and Node.js 24 ✅. Includes syntax checks, project regressions, Malware Engine regressions, all Threat Lab workspace tests, and clean npm package-distribution installs.
- [Security QA #43622143615](https://github.com/JASBH121101/JB-Expert-QA/actions/runs/43622143615): Node.js 22 ✅ and Node.js 24 ✅.
- [Language QA validation #43622143573](https://github.com/JASBH121101/JB-Expert-QA/actions/runs/43622143573): passed.
- [PostgreSQL integration #43622143578](https://github.com/JASBH121101/JB-Expert-QA/actions/runs/43622143578): PostgreSQL 16 read-only CLI E2E on Node.js 22 and 24 ✅.
- [Malware Engine validation #43622143567](https://github.com/JASBH121101/JB-Expert-QA/actions/runs/43622143567): Ubuntu and Windows on Node.js 22 and 24 ✅.
- [Three-engine certification #43622143590](https://github.com/JASBH121101/JB-Expert-QA/actions/runs/43622143590): package-boundary, Expert QA, Security Guard and Malware Engine jobs all ✅.
- The local Threat Lab workspace completed **14 tests, 14 passed, 0 failed**. Its core adapter matrix covers 17 scenarios: 6 Malware Engine, 6 Security Guard, and 5 Expert QA.

The suite uses temporary directories, inert fixtures, and in-memory upload storage. It does not use production data, execute malware samples, send network requests from Threat Lab adapters, contact external malware feeds, call AI providers, or require paid services. Static triage is not antivirus-grade certification and does not prove detection of every malware family. The PostgreSQL CLI E2E is the separate opt-in integration check and uses only a disposable CI PostgreSQL service; the Threat Lab database scenario remains static and makes zero database connections. The PNG comparison validates deterministic pixel differences, not every browser/device combination.

NEXORA, Perfumaría JB, and client ERP profiles remain future integrations. Their code, data, deployment, and lifecycle remain separate from the current engine packages.

- **JB Advisor Engine — 6 scenarios:** the three existing recommendation, research-review and product-type-isolation checks, plus insufficient-coverage no-winner gating, four-candidate order-independent weighted ranking, and atomic research-candidate capacity rejection.


## Four-engine certification update — 2026-11-14

PR #41 adds JB Advisor Engine as a fourth independently versioned target to `integration/jb-threat-lab`. The current four-engine matrix contains **26 scenarios**: 6 Malware Engine, 8 Security Guard, 6 Expert QA (including Language QA), and 6 Advisor Engine.

Advisor scenarios use synthetic smartphone fixtures and an in-memory research provider. Research candidates remain `unconfirmed` / `pending_review` until human review, mixed phone/laptop comparisons are rejected by domain isolation, and the integration records zero network requests.

Verified CI for PR #41:
- Core validation #43626122864: Node.js 22 and 24 passed.
- Four-package distribution #43626122830: all four engine packages packed and installed in clean directories on Node.js 22 and 24.
- PostgreSQL integration #43626122866: PostgreSQL 16 CLI E2E passed on Node.js 22 and 24.
- JB Engines Certification #43626122920: Expert QA, Security Guard, Malware Engine Windows/Ubuntu regressions and the existing three-engine package-boundary jobs passed.
- Security QA #43626122868 and Language QA #43626122855 passed.

PR #23 is closed as superseded. Its Advisor implementation is represented by PR #41; do not merge the obsolete `integration/jb-advisor-engine` branch.

The original PR #38 run records the historical three-engine baseline (17 scenarios). PR #41 adds the three Advisor scenarios and is the current four-engine integration.


## Six-tier difficulty model and certification gates

Each scenario carries a `difficulty` field. When omitted, it defaults to `basic` so existing adapters and scenario definitions remain compatible. The `difficulty` option in `lab.run()` is an inclusive maximum: requesting `advanced` runs Basic, Intermediate, and Advanced scenarios. Leaving it unset runs every registered tier.

| Tier | Weight | Intended test depth |
| --- | ---: | --- |
| Basic | 1 | Known patterns, deterministic outcomes, essential controls |
| Intermediate | 2 | Input normalization, variations, malformed values, ordinary boundary cases |
| Advanced | 4 | Multi-signal combinations, state changes, cross-feature interactions |
| Expert | 8 | Chained failures, false-positive controls, recovery paths, invariant checks |
| Extreme | 16 | Adversarial combinations, concurrency, bounded resource pressure, dependency degradation |
| Superextreme | 32 | Compound failures, long sequences, recovery invariants, strict isolation boundaries |

The report's `assessment` contains weighted score, execution coverage, present/missing levels, and a per-target breakdown. Weights are exponential; high-difficulty misses carry more weight than easy passes. A structural `target_scope` skip is excluded from the target's calculation. Adapter-declined and report-budget skips remain incomplete and block readiness.

A target is marked ready only when every required tier has at least one applicable scenario and every applicable scenario passes without skips. This evaluates only the registered cases; it is not a claim that the engine has no unknown vulnerabilities or defects.

### Baseline footprint after initial tier assignment


The footprint above is an inventory across separate local test files, not yet one consolidated cross-suite report. CI runs these suites independently. Each Threat Lab report assesses only the scenarios selected and executed in that run; cross-suite aggregation remains a future lab capability.
- **JB Malware Engine:** all six tiers are represented across the local core, Trojan-defense, persistence, and synthetic-PE test suites. Superextreme is currently represented by a synthetic PE credential-access/exfiltration correlation case; the file is never executed and no network request is made.
- **JB Security Guard:** all six tiers are represented, including composed origin/CSRF enforcement and bounded rate-limit capacity/reset invariants.
- **JB Expert QA:** all six tiers are represented, including compound local static-security analysis with safe controls and deterministic rescans.
- **JB Advisor Engine:** all six tiers are represented, including coverage gating, order-independent four-candidate ranking, and atomic research-candidate capacity limits.

The six-tier footprint is now represented across all four real engine-backed suites. This is tier presence, not comprehensive product coverage or proof that an engine is free of unknown defects. Preserve individual scenario results and keep expanding depth within each tier; never fill future gaps with mock-only engine outcomes.

### Required progression for new scenarios

1. Define the weakness or invariant the scenario is meant to expose.
2. State the exact expected engine verdict, finding code, and measurable metrics.
3. Use a deterministic, inert fixture with a bounded size and runtime.
4. Include a control case that protects against false positives where practical.
5. Confirm the adapter records zero network requests, no sample execution, and no production mutation.
6. Keep failures actionable: report the missing control, observed result, and expected result rather than a generic pass/fail only.


## NEXORA profiles — separate certification targets

The NEXORA repository contains two distinct deliverables and they must not be collapsed into one Threat Lab target:

- **NEXORA Configurable Catalog (frontend/catalog studio):** the independently scoped configurable-catalog prototype, including editable business templates, catalog fields, product presentation, responsive behavior, and browser-side demo persistence. Its tests must treat localStorage/demo behavior as prototype-only and must not mistake it for real authentication, server persistence, or secure file upload.
- **NEXORA Site Engine (Laravel/PHP distributable):** the separate Laravel application and server-side engine. Its profile must validate installation and database setup, owner authentication, role/permission boundaries, product/category CRUD, public-site exposure, export generation, upload validation/storage, and package/deployment safety using disposable local databases and filesystem fixtures.

They are separate registered targets (nexora-configurable-catalog and nexora-site-engine) with independent adapters, scenario IDs, tier coverage, and readiness. A pass in one profile must never certify the other. The Site Engine profile must follow its documented product scope: do not invent ERP, inventory, POS, payment, or SaaS multi-tenant tests unless those capabilities are explicitly brought into scope. The catalog prototype must not be certified as if it already had the Laravel backend.

**Integration status:** these two profiles are now explicitly tracked as separate targets in the Threat Lab test registry and coverage plan. Product-level adapter execution remains pending; placeholder/registry tests do not count as NEXORA security certification. All integration tests remain local, disposable, offline, non-destructive, and non-executing.


## NEXORA product adapter validation — six-tier matrix

The earlier registry-only test remains a structural boundary regression. Real-product adapters now execute allow-listed tests from two pinned checkouts, with separate target reports, independent readiness, minimal child-process environments, no shell, 2 MiB output caps, 120-second standard timeouts, and symlink-safe path resolution.

| Target | Pinned product revision | Six-tier coverage |
| --- | --- | --- |
| NEXORA Configurable Catalog prototype | \`JASBH121101/Nexora@88c4876c9678b93dadde55f79fe9d04890900741\` | Basic sample data; Intermediate setup/template contract; Advanced local storage and escaping; Expert responsive admin; Extreme full demo regression; Superextreme full demo regression plus explicit prototype-boundary checks |
| NEXORA Site Engine | \`JASBH121101/Nexora@3f68126ecc58b088c071007c5116bc95426d159b\` | Basic owner installation/template seeding; Intermediate public-data boundaries; Advanced role/field authorization; Expert export plus inventory least privilege; Extreme domain/DNS/TLS fake-adapter and published-host checks; Superextreme complete Laravel Feature and Unit suite |

The Catalog profile is a frontend demonstration. Its Superextreme scenario verifies that it remains demo-only, does not collect real passwords, and uses browser localStorage rather than claiming server authentication or persistence. Its six-tier readiness applies only to these registered prototype invariants.

The Site Engine profile uses PHPUnit with an in-memory SQLite database for every tier, including the full-suite gate. Its domain checks use deterministic fake DNS/TLS behavior and never connect to public DNS or an external TLS endpoint. The dedicated workflow also executes the full Laravel suite against an ephemeral PostgreSQL 16 service. No persistent database, production domain, customer data, deployment, paid service, or external provider is used.

Both targets are pinned to immutable source commits. Updating a product revision requires updating the workflow and test metadata together, then rerunning both profile validations. A six-tier ready result means only that all six registered scenarios for that revision passed; it is not a guarantee of no unknown vulnerabilities or of capabilities outside the documented product scope. Product defects must be fixed in the corresponding NEXORA product branch, not in this Threat Lab adapter package.
