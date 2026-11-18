# JB Engines — Independent Hardening Audit & Evidence Report

**Audit date:** 2026-11-18  
**Repository:** JASBH121101/JB-Expert-QA  
**Audit branch:** audit/engine-hardening-certification-2026-11-18  
**Baseline:** main @ a513d389467264ed96018c3b678be118c90acef9  
**Method:** read-only source review, PR topology review, and GitHub Actions check-run verification. No production services, external targets, malware samples, or live systems were exercised.

## Executive decision

The reviewed changes show strong automated regression and distribution evidence. The listed CI suites are green on the exact inspected heads. This supports **laboratory / CI certification only**. It does not establish production readiness, antivirus effectiveness, exploit resistance, or independent third-party certification.

No changes were made to main, no PR was merged, and no paid service or production environment was accessed.

## Verified CI evidence

| PR | Area | Inspected head | Check runs | Result |
|---|---|---|---:|---|
| #125 | Resilience A2 restart reconciliation | cb200af6f6df8edf6cb3abd198b495a68f512011 | 59/59 | PASS |
| #135 | Malware Engine synthetic calibration | 04aef0251b1ef0bc7e36f43078dfcae0baf8ac29 | 48/48 | PASS |
| #136 | Security Guard upload inspection + attestation | c6c69a6a8fa8a451c0a35b6eb0f2213e73ba56b5 | 61/61 | PASS |
| #138 | PHP scanner byte-stream integrity | a64a02ff9ca3d5df74670b8a0e8f3e13127ee30e | 48/48 | PASS |
| #132 | Threat Lab unified certification report | b8073677f581089e43548b5ce138c829e8e2c34c | 50/50 | PASS |
| #131 | Resilience A1 operational evidence | e49edba95a3bc409911730e1d2755590c539cfa2 | 49/49 | PASS |
| #130 | Malware Engine fixture-only calibration evidence | 02738c75ec1dd4b531177030a7cac32177e0c0ff | 54/54 | PASS |
| #128 | Security Guard package distribution | 4f36ec9792e8b9e733e1a25e3948cd1a0d0e48a8 | 48/48 | PASS |

All totals above were queried from commit-specific GitHub check-runs, not inferred from PR summaries. Earlier cancelled/failed attempts were excluded when the inspected final head had a complete successful check set.

## Findings and required hardening

### F-01 — Stacked Security Guard PHP PR is based on a stale parent commit
**Severity:** High (integration / release integrity)  
PR #138 targets integration/security-guard-scan-attestation-v1, but its recorded base SHA is 1d050e1dad0c22f9cb855b585029b8dc92f61384; PR #136's current head is c6c69a6a8fa8a451c0a35b6eb0f2213e73ba56b5. Therefore the 48 green checks on #138 do not prove the current combined #136 + #138 tree.  
**Required action:** after #136's final changes are settled, update/rebase the #138 branch onto the exact current #136 head and rerun all required workflows on the combined tree. Keep both PRs draft until that evidence exists. Do not merge #138 independently into main.

### F-02 — CI certification is not production malware-scanning certification
**Severity:** High (assurance boundary)  
The Security Guard packages explicitly rely on host-injected storage and scanner adapters. The Malware Engine calibration changes use synthetic/fixture evidence. These tests prove contract behavior and known-case calibration, not detection of real-world malware or secure operation of a production storage adapter.  
**Required action:** preserve explicit host obligations: private quarantine, atomic promotion bound to exact object digest/size/attestation, access-control checks on retrieval, scanner provenance, timeout/resource limits, and independent operational monitoring. Do not label the package a production antivirus or claim a detection rate without a representative independently labelled corpus.

### F-03 — Resilience A2 recovery remains intentionally read-only
**Severity:** Medium (scope / operational readiness)  
The coordinator reports observations and deliberately returns executable=false, safeToRetry=false, and releaseAllowed=false. This is the correct fail-safe boundary for reconciliation, but it is not an automated recovery executor.  
**Required action:** retain this boundary. Any future executor must be a separate reviewed capability with explicit authorization, fencing/idempotency guarantees, independent verification, durable audit, and failure-injection tests. Do not silently turn reconciliation into automatic retry or release.

### F-04 — Threat Lab report must not be represented as external certification
**Severity:** Medium (claims / governance)  
The report schema itself states that it aggregates registered safe scenarios, runs no samples or production targets, and is not proof of absence of malware, vulnerabilities, or defects.  
**Required action:** preserve these limitations in exported reports, dashboards, badges, and release notes. Certification labels must identify exact commit, target, runtime, scenario coverage, skips, and evidence provenance.

## Positive controls observed

- Security Guard defines versioned JSON schemas and conformance vectors for scan requests, results, and attestations.
- PHP #138 uses a sequential bounded reader, counts and hashes the exact bytes delivered to the scanner, and rejects incomplete or altered content.
- Python and PHP distribution paths have clean-consumer/package validation in the CI matrix.
- Resilience A2 validates strict record shapes, identity bindings, idempotency keys, evidence digests, independent verification, and forensic retention receipts; unresolved outcomes remain held.
- Threat Lab aggregation rejects duplicate target/scenario pairs and conflicting target definitions, and preserves source outcomes.
- Malware calibration uses synthetic evidence; this is useful for deterministic regression but intentionally insufficient for claims about live malware detection.

## Certification matrix

| Engine / subsystem | Laboratory evidence | Current decision |
|---|---|---|
| Resilience A1 | 49/49 CI checks | LAB-CERTIFIED |
| Resilience A2 | 59/59 CI checks | LAB-CERTIFIED — read-only reconciliation only |
| Security Guard core | 61/61 CI checks on #136 | LAB-CERTIFIED — integration pending |
| Security Guard PHP stream integrity | 48/48 CI checks on #138 | CONDITIONAL — stacked-parent refresh required |
| Security Guard distribution | 48/48 CI checks on #128 | LAB-CERTIFIED |
| Malware Engine calibration | 48/48 CI checks on #135; 54/54 on #130 | LAB-CERTIFIED — synthetic corpus only |
| Threat Lab report | 50/50 CI checks | LAB-CERTIFIED — reporting/aggregation only |

## Release gates

1. Refresh #138 onto the exact final #136 head; rerun all workflows on the combined result.
2. Review the full diffs and adversarial tests for each PR, not just the green status.
3. Keep all draft PRs unmerged until dependency order and combined CI are proven.
4. For production adoption, require a real host integration review covering storage isolation, atomic promotion, authorization, secrets, observability, backups, and incident response.
5. Publish a certification artifact tied to immutable commit SHAs and explicit scope/limitations.

## Final status

**Laboratory evidence: PASS for the inspected commit heads.**  
**Production certification: NOT GRANTED.**  
**Release readiness: BLOCKED on F-01 and the remaining human/host integration gates.**

This report is an engineering audit record, not a guarantee that the engines are invulnerable or that all defects have been found.