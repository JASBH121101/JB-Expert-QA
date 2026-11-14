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
- **Process hollowing:** unit coverage verifies that process-hollowing capability plus a remote command channel produces RAT/Trojan-like candidate labels.
- **False-positive guard:** a single low-specificity download marker must not produce a Trojan-family candidate.
- **Containment boundary:** a suspicious Trojan-like candidate cannot be passed to `quarantineFile`; only an authentic `malicious` report from the same engine instance is eligible.

These are static behavior correlations over inert text and synthetic PE structures. They never execute files, create a network connection, or confirm malware. A family candidate remains `suspicious` and is not automatically quarantined. Exact configured hash/byte-signature matches remain the confirmed `malicious` path.

## Current implementation status

The reusable core, target-scoped scenario registry, explicit offline/non-destructive/non-executing safety contract, inert fixtures, and versioned report schema are implemented in `@jb/threat-lab`. Its first cross-engine suite now contains **16 scenarios**, all calling the real engine APIs against temporary local fixtures and in-memory upload storage.

- **JB Malware Engine — 6 scenarios:** exact harmless EICAR match; benign no-match/false-positive; inert PowerShell-like text classified as suspicious, not confirmed malicious; exact configured SHA-256 signature detection; over-limit file returned as `unknown`; PDF active-action indicators classified as suspicious without an exact malware detection.
- **JB Security Guard — 6 scenarios:** synthetic XSS, SQL injection and encoded path-traversal requests blocked; ambiguous Content-Length/Transfer-Encoding framing rejected; malicious upload rejected through the real Malware Engine adapter; no-match upload retained in quarantine rather than promoted.
- **JB Expert QA — 4 scenarios:** unsafe dynamic HTML sink detected; repaired `textContent` regression; static database audit detects dynamic raw SQL and disabled TLS without opening a database connection; deterministic PNG comparison identifies a synthetic pixel difference with zero AI calls.

**Previous completed baseline (`2d4606c`):**
- [Core validation #567](https://github.com/JASBH121101/JB-Expert-QA/actions/runs/43545838062): Node 22 ✅ and Node 24 ✅, including the initial Trojan script and PE/RAT Threat Lab checks.
- [Security QA #350](https://github.com/JASBH121101/JB-Expert-QA/actions/runs/43545838028): Node 22 ✅ and Node 24 ✅.
- [NPM package distribution #69](https://github.com/JASBH121101/JB-Expert-QA/actions/runs/43545838105): Node 22 ✅ and Node 24 ✅.

**Latest commit under validation (`232f4a6`):**
- [Core validation #569](https://github.com/JASBH121101/JB-Expert-QA/actions/runs/43546078965): running at the time of this documentation update.
- [Security QA #352](https://github.com/JASBH121101/JB-Expert-QA/actions/runs/43546078948): Node 22 ✅ and Node 24 ✅.
- [NPM package distribution #70](https://github.com/JASBH121101/JB-Expert-QA/actions/runs/43546078960): Node 22 ✅; Node 24 was still running at the time of this documentation update.
- [JB Malware Engine Validation #156](https://github.com/JASBH121101/JB-Expert-QA/actions/runs/43546078997): Ubuntu ✅ and Windows ✅.

The suite uses temporary directories and no production data, network requests, real malware execution, external feeds, paid services, or AI calls. Static triage is not antivirus-grade certification and does not prove detection of every malware family. The database auditor is local-static and makes zero database connections. The PNG comparison scenario validates deterministic visual diff only; it is not a full visual/browser certification.

NEXORA, Perfumaría JB, and client ERP profiles remain future integrations. Their code, data, deployment, and lifecycle remain separate from the current engine packages.