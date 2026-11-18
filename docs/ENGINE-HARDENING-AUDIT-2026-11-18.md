# JB Engines — Independent Hardening Audit & Evidence Report

**Audit date:** 2026-11-18  
**Repository:** JASBH121101/JB-Expert-QA  
**Audit branch:** audit/engine-hardening-certification-2026-11-18  
**Baseline:** main @ a513d389467264ed96018c3b678be118c90acef9  
**Method:** read-only source review, PR topology review, and GitHub Actions check-run verification. No production services, external targets, malware samples, or live systems were exercised.

## Executive decision

The reviewed changes show strong automated regression and distribution evidence. The listed CI suites are green on the exact inspected heads where stated. The updated Malware Engine PowerShell lexer commit is an explicit exception: only focused local lexer checks have run, and its full CI validation remains pending. This supports **laboratory / CI certification only** for the previously tested scope. It does not establish production readiness, antivirus effectiveness, exploit resistance, or independent third-party certification.

No changes were made to main, no PR was merged, and no paid service or production environment was accessed.

## Verified CI evidence

| PR | Area | Inspected head | Check runs | Result |
|---|---|---|---:|---|
| #125 | Resilience A2 restart reconciliation | 95faf095ed575d62dc042433701ce909e00b0362 | 49/49 workflow jobs | PASS — latest inspected head |
| #135 | Malware Engine calibration + PowerShell string-context hardening | 665699bd6aab2d747ff94cad2e5af350a4c682d7 | 40/40 jobs on predecessor `04aef0251b1ef0bc7e36f43078dfcae0baf8ac29`; 5 focused local lexer cases PASS | CONDITIONAL — current lexer commit has no recorded full CI run |
| #136 | Security Guard upload inspection + attestation | c6c69a6a8fa8a451c0a35b6eb0f2213e73ba56b5 | 61/61 | PASS |
| #138 | PHP scanner byte-stream integrity (superseded/overlapping proposal) | a64a02ff9ca3d5df74670b8a0e8f3e13127ee30e | 48/48 | PASS (stale base; not combined evidence) |
| #139 | Cross-runtime malicious-upload quarantine retention + PHP sequential reader | bc1b3ab438fbdd01a1bb25131df3fd23884455cc | 43/43 jobs | PASS (code head; later commits are documentation-only) |
| #132 | Threat Lab unified certification report | b8073677f581089e43548b5ce138c829e8e2c34c | 50/50 | PASS |
| #131 | Resilience A1 operational evidence | e49edba95a3bc409911730e1d2755590c539cfa2 | 49/49 | PASS |
| #130 | Malware Engine fixture-only calibration evidence | 02738c75ec1dd4b531177030a7cac32177e0c0ff | 54/54 | PASS |
| #128 | Security Guard package distribution | 4f36ec9792e8b9e733e1a25e3948cd1a0d0e48a8 | 48/48 | PASS |

All totals above were queried from commit-specific GitHub check-runs, not inferred from PR summaries. Earlier cancelled/failed attempts were excluded when the inspected final head had a complete successful check set.

## Findings and required hardening

### F-01 — Stale PHP integration proposal is superseded by the current Security Guard quarantine branch
**Severity:** High (integration / release integrity)  
PR #138 still records stale base SHA `1d050e1dad0c22f9cb855b585029b8dc92f61384`, not #136's current head `c6c69a6a8fa8a451c0a35b6eb0f2213e73ba56b5`. Its 48 green checks therefore do not validate a combined current tree. The newer PR #139 is based on the exact #136 head and includes the sequential bounded PHP reader, byte-integrity checks, transient-empty/trailing-byte regressions, and the cross-runtime malicious-quarantine lifecycle. PR #139's code-bearing head `bc1b3ab438fbdd01a1bb25131df3fd23884455cc` passed 43/43 workflow jobs. Its seven subsequent commits change documentation only; latest head is `6780eb7fc2fed0ed580bbe9ea8dce4a15359101d`.
**Required action:** use #139 as the canonical Security Guard continuation from #136. Do not merge #138 independently; it now overlaps the PHP reader implemented in #139. A review note was added to #138 asking that it be treated as superseded or rebased only if a unique change remains. Keep #136/#139 draft until host integration evidence and final release review are complete.

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
- PHP #139 now carries a sequential bounded reader, counts and hashes the exact bytes delivered to the scanner, and rejects incomplete, transient-empty, trailing or altered content. #139 also verifies malicious verdicts remain in private quarantine across Node, PHP and Python, are never promoted, and emit quarantine telemetry.
- Python and PHP distribution paths have clean-consumer/package validation in the CI matrix.
- Resilience A2 validates strict record shapes, identity bindings, idempotency keys, evidence digests, independent verification, and forensic retention receipts; unresolved outcomes remain held.
- Threat Lab aggregation rejects duplicate target/scenario pairs and conflicting target definitions, and preserves source outcomes.
- Malware calibration uses synthetic evidence; this is useful for deterministic regression but intentionally insufficient for claims about live malware detection.

## Certification matrix

| Engine / subsystem | Laboratory evidence | Current decision |
|---|---|---|
| Resilience A1 | 49/49 CI checks | LAB-CERTIFIED |
| Resilience A2 | 49/49 workflow jobs on head `95faf095ed575d62dc042433701ce909e00b0362` | LAB-CERTIFIED — read-only reconciliation only |
| Security Guard core | 61/61 CI checks on #136 | LAB-CERTIFIED — integration pending |
| Security Guard PHP stream + malicious quarantine lifecycle | 43/43 workflow jobs on #139 code head | LAB-CERTIFIED — host storage/scanner integration pending |
| Security Guard distribution | 48/48 CI checks on #128 | LAB-CERTIFIED |
| Malware Engine calibration | 40/40 workflow jobs on predecessor `04aef0251b1ef0bc7e36f43078dfcae0baf8ac29`; 5 focused local PowerShell lexer cases on current head | CONDITIONAL — synthetic corpus only; latest lexer hardening still needs full CI |
| Threat Lab report | 50/50 CI checks | LAB-CERTIFIED — reporting/aggregation only |

## Release gates

1. Keep #139 as the canonical child of #136; do not merge the stale/overlapping #138 branch independently. Verify CI on the final code head and re-run after any further code changes.
2. Re-run the complete Malware Engine workflows on exact head `665699bd6aab2d747ff94cad2e5af350a4c682d7`; focused lexer tests passed locally, but no full CI run is recorded for the new PowerShell preprocessing yet.
3. Review the full diffs and adversarial tests for each PR, not just the green status.
4. Keep all draft PRs unmerged until dependency order and combined CI are proven.
5. For production adoption, require a real host integration review covering storage isolation, atomic promotion, authorization, secrets, observability, backups, and incident response.
6. Publish a certification artifact tied to immutable commit SHAs and explicit scope/limitations.

## Final status

**Laboratory evidence: PASS for the inspected commit heads.**  
**Production certification: NOT GRANTED.**  
**Release readiness: BLOCKED on production host-adapter, access-control, retention, and operational integration gates.**

This report is an engineering audit record, not a guarantee that the engines are invulnerable or that all defects have been found.