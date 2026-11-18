# JB Engine Family Baseline Audit — 2026-11-18

**Repository:** https://github.com/JASBH121101/JB-Expert-QA  
**Audited baseline:** main at a513d389467264ed96018c3b678be118c90acef9  
**Audit method:** read-only inspection of the repository tree, package manifests, source files, tests, workflows, branches, pull requests and recent CI runs. No production environment was accessed.

## Executive result

The repository is substantially more advanced than a blank or early prototype. It contains independently scoped packages, runtime adapters, versioned contracts, test matrices and several completed hardening increments. A number of proposed repairs already exist in main and must not be recreated.

The current baseline is **not a universal production certification**. The main blockers are incomplete cross-runtime feature parity and conformance, host-owned production integrations, missing non-NPM distribution checks, Resilience A2/A3 authority boundaries, and repository branch governance.

One concrete Security Guard Python defect was found: the upload-type detector and its PNG fixture used escaped text rather than actual binary magic bytes. An isolated correction is being prepared on branch:
https://github.com/JASBH121101/JB-Expert-QA/tree/fix/security-guard-python-upload-signatures-v1

## Repository and package inventory

The main tree contains ten package directories:

| Package | Role | Observed test files |
|---|---|---:|
| advisor-engine | Independent fragrance and technology advisory engine | 29 |
| engine-contracts | Internal, dependency-free engine manifests and message contracts | 1 |
| expert-qa | Independently installable QA product package | 3 |
| malware-engine | Local static malware triage | 23 |
| resilience-engine | Health, policy-bounded recovery and ARC | 22 |
| security-guard | Node.js request and upload protection | Tests are in repository-level tests |
| security-guard-core | Language-neutral JSON Schema and conformance contracts | 18 |
| security-guard-php | PHP/Laravel adapter and upload quarantine orchestration | 2 |
| security-guard-python | Python/FastAPI adapter and upload quarantine orchestration | 2 |
| threat-lab | Local test orchestration harness, not a protection engine | 9 |

The repository also has 60 top-level JavaScript test files. Language QA is implemented inside JB Expert QA, not as a separately distributed package. ARC is part of Resilience Engine, not a separate defensive engine. Threat Lab is a testing harness and must not be represented as a runtime protection engine.

## CI and pull request state observed

The main baseline a513d389 had successful recent runs for:
- JB Engines Certification: https://github.com/JASBH121101/JB-Expert-QA/actions/runs/44198528181
- Core validation: https://github.com/JASBH121101/JB-Expert-QA/actions/runs/44198528306
- Security QA: https://github.com/JASBH121101/JB-Expert-QA/actions/runs/44198528140
- Database PostgreSQL integration: https://github.com/JASBH121101/JB-Expert-QA/actions/runs/44198528302

PR #125 remains open and draft, targeting main. Its latest JB Engines Certification run reported 38 successful jobs and no failed jobs:
https://github.com/JASBH121101/JB-Expert-QA/actions/runs/44214494475

That CI result validates the tested branch and fixtures; it does not certify a real A2 provider, production storage topology, independent verifier or production operations.

Six pull requests were open at the time of inspection:
- #125: A2 restart reconciliation, draft, targets main.
- #62: NEXORA Threat Lab profile consolidation, targets integration/jb-threat-lab, not main.
- #46, #45, #7 and #6: dependency update pull requests.

## Findings

### SG-PY-001 — Incorrect Python upload magic bytes
**Severity:** Medium  
**Location:** packages/security-guard-python/src/jb_security_guard/uploads.py and tests/test_upload_inspection.py

The Python JPEG and PNG checks contained two backslashes before hexadecimal escape sequences. Python therefore compared literal backslash text, not the actual JPEG/PNG byte signatures. The PNG test fixture repeated the same mistake, allowing the test to pass against the wrong representation. Real JPEG/PNG files could be rejected as unsupported, while a textual escape prefix could incorrectly satisfy the mistaken check if the injected scanner returned clean.

PR #126 implements the correction on `fix/security-guard-python-upload-signatures-v1`: the literals now represent actual binary bytes, the PNG fixture is real binary data, and tests include a real JPEG positive case plus a negative textual-escape case. As of 2026-11-18 02:18 UTC, all five PR workflows passed: Engine Certification 30/30 jobs, Core Validation 2/2, Security QA 2/2, Security Guard multi-runtime 2/2 and NPM package distribution 2/2. PR #126 was moved from draft to ready for review; it remains open and unmerged.

### SG-INTEROP-001 — Security Guard runtime parity is explicitly partial
**Severity:** High for any claim of universal parity

The Core README correctly states:
- Node.js is the behavioral baseline and has the broadest protection set.
- Cloudflare Workers/Pages currently provide rate-limit adapters, not the complete Node protection stack.
- PHP/Laravel provides Core v1 identity/rate-limit integration and upload orchestration, not equivalent native request inspection, CSRF/origin, authentication/recovery and response-header middleware.
- Python/FastAPI provides Core v1 identity/rate-limit integration and upload orchestration, not the full Node feature set.

The follow-on branch `feature/security-guard-upload-inspection-contract-v1` now introduces language-neutral v1 scan-request and scan-result JSON Schemas, shared synthetic magic-byte/scanner-disposition vectors, and a runtime mapping document. Node, PHP and Python upload tests have been wired to the same vector file. PHP now rejects clean results unless the sequential stream position reaches the ingested size. Python now passes a read-only digest-tracking stream, independently checks bytes consumed and SHA-256, and rejects incomplete scans; its malicious staging object is deleted consistently with Node and PHP. This work is on a stacked branch based on PR #126 and is not yet CI-certified or merged. Do not claim universal production parity until its CI passes and host-specific deployments are validated. Broader Security Guard protections remain intentionally partial across runtimes.

The Node upload and request controls also remain host-dependent:
- Default request mode is monitor; blocking is an explicit policy choice.
- Process-local rate limiting is not global enforcement. Multi-instance deployments must configure and test a shared atomic store.
- Production quarantine storage and malware scanning are injected host adapters, not bundled production services.
- Image decode/re-encode, authorized serving and safe response headers remain host responsibilities.
- Heuristic request inspection is not a WAF replacement.

The static-asset rate-limit exclusion fix is already present in main. The key files checked on feature/security-guard-hardening-v2 — including the Node entrypoint/upload inspector, PHP upload service/interfaces/provider/config and Python FastAPI adapter — have the same blob SHA as main. Do not port those changes again. That branch is 25 commits ahead and 14 behind main, so it is not a safe merge base for new hardening without a fresh comparison.

### DIST-001 — PHP and Python packaging are not covered by the five-package NPM distribution gate
**Severity:** Medium

The NPM package-distribution workflow packs and installs the five independently distributed JavaScript packages in clean directories. PHP CI currently runs PHP syntax checks and its test runner. Python CI currently compiles the source and runs unittest through PYTHONPATH. The inspected workflows do not build and install a Composer archive/package in a clean consumer, nor build and install a Python wheel/sdist in a clean environment.

Add separate Composer validation/distribution and Python wheel/sdist build-install jobs before claiming equivalent independent distribution certification for those runtimes.

### MAL-001 — Malware Engine remains static triage, not antivirus
**Severity:** Production-readiness limitation

The package manifest describes development-stage static triage, not a certified antivirus. The README documents hash/signature matching, bounded parsers, archive/OLE inspection, heuristic findings, local quarantine and Windows event correlation. It also documents material exclusions:
- A no_match result is not proof of safety and maps to unknown at the Security Guard adapter.
- Static heuristics do not prove malicious behavior.
- No production signing key, intelligence-feed distribution or remote revocation service is configured.
- A native Windows service, protected quarantine ACL provisioning, Filter Manager minifilter/driver, crash/performance certification and real-time protection remain future work.
- The engine does not replace Microsoft Defender; keep Defender enabled.

The old feature/jb-malware-engine-refresh-v2 branch is 122 commits ahead and 235 behind main. Several reviewed components (LNK analysis, Windows event correlation and VPN kill-switch policy) already have identical blob hashes in main. Its download inspector additionally accepts APK files, while the current product scope explicitly excludes Android/APK. Do not merge or port this old branch wholesale.

### RES-001 — A2 and A3 remain denied
**Severity:** Critical authority boundary; correctly fail-closed

ARC is part of Resilience Engine. It is a certification harness and evidence protocol, not a separate defensive engine or an authority grant.

The current ARC disposition is:
- A0 observe: testable.
- A1 restart-service: candidate for operational lab certification, restricted to exact allowlisted stateless standard-criticality services and host-owned controls.
- A2 bounded containment: not executable; remains denied. The controller is disabled by default and no concrete production provider is bundled.
- A3 controlled failover: not executable; remains denied because the full external quorum, target-enforced fencing, replication/RPO, cutover and independent-verification control plane is not certified.

PR #125 adds a durable action-ledger and read-only restart-reconciliation laboratory path. It remains draft and unmerged. Required production work still includes host-specific crash/restore and permission testing, PostgreSQL failover/backup/PITR and tombstone preservation, real providers, independent verification, forensic retention, rollback/fencing and end-to-end fault injection. A green CI run must not enable A2 or A3.

### QA-001 — Expert QA and Language QA are quality gates, not certification authorities
**Severity:** Scope limitation

JB Expert QA supports static project, browser, responsive, accessibility, visual and security audits. It is read-only by default; autopilot remediation requires explicit opt-in and review. Its findings can be heuristic and a passing score is not a security certification.

Language QA currently focuses on structural checks for PHP/JSON resources, placeholder parity, glossary suggestions and human review. Its documented initial locales are es-419 and en. It does not certify semantic accuracy, legal wording, tone or native-speaker quality; approval remains a human decision.

### TL-001 — Threat Lab has six tiers but no single cross-suite certification report
**Severity:** Medium

Threat Lab includes Basic, Intermediate, Advanced, Expert, Extreme and Superextreme tiers and bounded local scenario execution. Its documentation says current engine tier footprints are an inventory across separate test files; the runner does not yet merge those separate runs into one cross-suite certification report. A target is ready only for the applicable registered scenario set that actually ran.

Threat Lab is not an OS sandbox. Adapter code is trusted code and must be reviewed and run against disposable local fixtures or explicitly authorized environments. PR #62 consolidates NEXORA product certification paths on the separate integration/jb-threat-lab branch; it is not a merge into main.

### GOV-001 — Main branch is unprotected
**Severity:** High governance risk

The repository had 135 branches at inspection. The main branch API reported protected=false and the repository had no active rulesets. No branch-protection configuration was observed. Multiple long-lived and divergent branches increase the chance of stale or duplicated work being merged.

Recommended control: protect main with pull-request-only changes, required CI checks (Core Validation, Engine Certification, Security QA, PostgreSQL integration, runtime matrix and package distribution), no force pushes and no deletion. Apply review requirements appropriate to the repository's maintainer model. Do not delete stale branches until their unique commits have been compared and preserved.

## Branch reuse decisions

- feature/security-guard-hardening-v2: do not port verified duplicate source changes; 25 ahead / 14 behind.
- feature/jb-security-guard: 86 ahead / 266 behind; too divergent to merge wholesale.
- feature/jb-advisor-engine-quality-fix-v1: the matching implementation and its tests checked have the same blob SHA as main; do not repeat the fix.
- feature/jb-malware-engine-refresh-v2: 122 ahead / 235 behind; do not merge wholesale; reviewed code overlaps main and APK scope conflicts with current policy.
- feature/jb-engines-security-guard-multiruntime-certification-v1, feature/jb-engines-universal-certification-v1 and feature/jb-engines-language-qa-matrix-v1: workflow-only branches behind main; main already has the corresponding certification jobs.
- feature/jb-resilience-a2-restart-reconciliation-v1: 115 commits ahead, 0 behind; current work is PR #125, still draft and unmerged.

## Recommended execution order

1. **Completed on PR #126 (not merged):** isolated Python binary-signature correction, real PNG/JPEG test fixtures and full passing Security Guard multi-runtime / Engine Certification CI.
2. **In progress on the stacked upload-contract branch:** define upload-inspection contract v1 and shared cross-runtime vectors for Node, PHP and Python; require each runtime to prove complete stream consumption and equivalent fail-closed outcomes.
3. Add Composer and Python wheel/sdist clean-install distribution jobs.
4. Audit Security Guard's request parsing, proxy trust, CSRF/origin, auth/recovery, shared-store semantics and real host upload integrations. Keep monitor-first rollout and do not claim WAF coverage.
5. Expand Malware Engine's representative benign/positive test corpus and report measured false-positive, false-negative and unknown coverage; keep production antivirus claims disabled.
6. Complete Resilience A1 operational tests. Keep A2/A3 denied until host-specific provider, durable storage, independent verifier, fencing, rollback and forensic operations are separately certified.
7. Add a consolidated, evidence-bearing Threat Lab report that records commit SHA, runtime matrix, scenario IDs, skipped cases, findings and capability disposition.
8. Add main-branch protection and required status checks; preserve branch history until duplicate and unique commits are reconciled.

## Audit decision

Main is a strong development baseline with successful CI, but the engine family is **not yet universally production-certified**. The immediate actionable defect is isolated to the Python upload signature detector and is being corrected on its own branch. Other gaps are documented above and should be closed with explicit contracts, tests and host-specific evidence rather than duplicate code or unsupported certification claims.

No production deployment, production database mutation, policy grant or paid service is part of this audit.
