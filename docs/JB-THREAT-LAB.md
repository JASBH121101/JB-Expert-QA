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

Reports use `jb.threat-lab.report/v1` and include target identity/version, scenario identity/category, pass/fail/skip status, findings, metrics, and duration. Future versions may add coverage and confidence metadata. Certification must list exactly which scenarios ran, skipped, and failed, and must not extrapolate beyond that scope.

## Trojan-focused validation

The Malware Engine now has dedicated, safe regression coverage beyond the original 16 cross-engine cases:

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

The reusable core, target-scoped scenario registry, explicit offline/non-destructive/non-executing safety contract, inert fixtures, and versioned report schema are implemented in `@jb/threat-lab`. Its first cross-engine suite now contains **16 scenarios**, all calling the real engine APIs against temporary local fixtures and in-memory upload storage.

- **JB Malware Engine — 6 scenarios:** exact harmless EICAR match; benign no-match/false-positive; inert PowerShell-like text classified as suspicious, not confirmed malicious; exact configured SHA-256 signature detection; over-limit file returned as `unknown`; PDF active-action indicators classified as suspicious without an exact malware detection.
- **JB Security Guard — 6 scenarios:** synthetic XSS, SQL injection and encoded path-traversal requests blocked; ambiguous Content-Length/Transfer-Encoding framing rejected; malicious upload rejected through the real Malware Engine adapter; no-match upload retained in quarantine rather than promoted.
- **JB Expert QA — 4 scenarios:** unsafe dynamic HTML sink detected; repaired `textContent` regression; static database audit detects dynamic raw SQL and disabled TLS without opening a database connection; deterministic PNG comparison identifies a synthetic pixel difference with zero AI calls.

**Latest completed validation for branch commit `dc7c795`:**
- [Core validation #576](https://github.com/JASBH121101/JB-Expert-QA/actions/runs/43547309541): Node 22 ✅ and Node 24 ✅. Includes all Malware Engine package regressions, the cross-engine Threat Lab, Trojan script/persistence tests, PE RAT/backdoor/credential-theft correlations, signed-bundle policy tests, and package-distribution checks.
- [Security QA #359](https://github.com/JASBH121101/JB-Expert-QA/actions/runs/43547309496): Node 22 ✅ and Node 24 ✅.
- [NPM package distribution #74](https://github.com/JASBH121101/JB-Expert-QA/actions/runs/43547309572): Node 22 ✅ and Node 24 ✅.
- [JB Malware Engine Validation #160](https://github.com/JASBH121101/JB-Expert-QA/actions/runs/43547309579): Ubuntu ✅ and Windows ✅.
The suite uses temporary directories and no production data, network requests, real malware execution, external feeds, paid services, or AI calls. Static triage is not antivirus-grade certification and does not prove detection of every malware family. The database auditor is local-static and makes zero database connections. The PNG comparison scenario validates deterministic visual diff only; it is not a full visual/browser certification.

NEXORA, Perfumaría JB, and client ERP profiles remain future integrations. Their code, data, deployment, and lifecycle remain separate from the current engine packages.