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
| JB Malware Engine | EICAR harmless test string; test-only hash/byte signatures; inert suspicious text; benign false-positive corpus; unknown/incomplete coverage; file size and parser boundaries |
| JB Security Guard | mocked request and upload validation; size limits; malformed metadata; digest mismatch; timeout/error handling; fail-closed behavior |
| JB Expert QA | static analysis of intentionally vulnerable source fixtures; expected findings; repaired fixture regression; database and API contract checks; deterministic visual checks |
| NEXORA | owner authentication; authorization boundaries; business registration; templates; product CRUD; currency rules; PDF export; upload constraints; responsive/accessibility checks |
| Client ERP projects | disposable database; inventory arithmetic; stock movement invariants; roles; audit trail; input validation; backup/restore; export integrity; performance budgets |

The project name NEXORA is taken from the existing project context. If a customer project has a different final name, its profile uses that name without changing the laboratory.

## Malware testing boundary

The initial malware profile is static and fixture-based. It uses EICAR (a harmless antivirus test string), synthetic test-only signatures, benign files, and inert text fixtures. It does not run trojans, ransomware, spyware, worms, keyloggers, exploit code, or live samples. It does not download samples or connect to malware feeds. No claim is made that the current Malware Engine detects all families or variants.

Dynamic malware behavior analysis, if ever approved, requires a separate isolated disposable VM, no shared credentials, no production connectivity, snapshots, strict egress denial, and a separately reviewed handling policy. It is not part of the initial implementation.

## Safety controls

1. Scenarios must explicitly declare safe, offline, and non-destructive.
2. Submitted samples are never executed by the lab.
3. Test data and databases must be disposable and separate from production.
4. Adapters must have explicit timeouts and bounded inputs; secrets and personal data are excluded from reports.
5. No automatic source repair, database mutation, deployment, package publication, or production action.
6. No paid services, cloud malware feeds, external sample uploads, telemetry, or new paid infrastructure.
7. Every integration is opt-in and separately reviewed.

## Certification reporting

Reports use `jb.threat-lab.report/v1` and include target identity/version, scenario identity/category, pass/fail/skip status, findings, metrics, and duration. Future versions may add coverage and confidence metadata. Certification must list exactly which scenarios ran, skipped, and failed, and must not extrapolate beyond that scope.

## Current implementation status

The core registry, adapter contract, safety gate, inert fixtures, report schema, unit tests, and isolated Node 22/24 CI workflow are implemented in `@jb/threat-lab`. Product adapters and the initial project-specific scenario suites remain subsequent milestones.
