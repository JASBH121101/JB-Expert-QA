# JB Engines — Independent Hardening Audit & Evidence Report

**Audit date:** 2026-11-18  
**Repository:** JASBH121101/JB-Expert-QA  
**Audit branch:** audit/engine-hardening-certification-2026-11-18  
**Baseline:** main @ a513d389467264ed96018c3b678be118c90acef9  
**Method:** read-only source review, PR topology review, and GitHub Actions check-run verification. No production services, external targets, malware samples, or live systems were exercised.

## Executive decision

The reviewed changes show strong automated regression and distribution evidence. The current Malware Engine PowerShell lexer head `603da7e26a43635faa35bc4fe79baf223b29333d` passed its complete targeted package workflow and repository integration matrix: **42/42 workflow jobs** via #144. Security Guard's newer integrated candidate #145 has been rebuilt from the exact #136 head after discovering that #139 was based on a stale merge base; #145's full CI is now pending. This supports **laboratory / CI certification only** for the individually tested scopes, not production readiness, real-world antivirus effectiveness, exploit resistance, or independent third-party certification.

No changes were made to `main`; the temporary validation PR #144 and obsolete validation requests #142/#143 were closed without merge. No paid service or production environment was accessed.

## Verified CI evidence

| PR | Area | Inspected head | CI evidence | Result |
|---|---|---|---:|---|
| #125 | Resilience A2 restart reconciliation | 95faf095ed575d62dc042433701ce909e00b0362 | 49/49 workflow jobs | PASS — latest inspected head |
| #135 | Malware Engine calibration + contextual PowerShell lexer hardening | 603da7e26a43635faa35bc4fe79baf223b29333d | 42/42 workflow jobs on exact head, validated via #144 | PASS — LAB-CERTIFIED, synthetic corpus only |
| #136 | Security Guard upload inspection + attestation | c6c69a6a8fa8a451c0a35b6eb0f2213e73ba56b5 | 61/61 | PASS |
| #138 | PHP scanner byte-stream integrity (superseded/overlapping proposal) | a64a02ff9ca3d5df74670b8a0e8f3e13127ee30e | 48/48 | PASS (stale base; not combined evidence) |
| #139 | Cross-runtime malicious-upload quarantine retention + PHP sequential reader | bc1b3ab438fbdd01a1bb25131df3fd23884455cc | 43/43 jobs on stale tree | NOT VALID as combined #136 evidence — 17 commits behind current parent; Python reader regressed |
| #145 | Canonical integrated Security Guard candidate (built from exact #136 head) | 36b251ebf43d5a00bee666a42835a449bfb910e2 | 8 workflows pending | CONDITIONAL — fresh combined validation running |
| #132 | Threat Lab unified certification report | b8073677f581089e43548b5ce138c829e8e2c34c | 50/50 | PASS |
| #131 | Resilience A1 operational evidence | e49edba95a3bc409911730e1d2755590c539cfa2 | 49/49 | PASS |
| #130 | Malware Engine fixture-only calibration evidence | 02738c75ec1dd4b531177030a7cac32177e0c0ff | 54/54 | PASS |
| #128 | Security Guard package distribution | 4f36ec9792e8b9e733e1a25e3948cd1a0d0e48a8 | 48/48 | PASS |

All totals above were queried from commit-specific GitHub Actions runs/jobs, not inferred from PR summaries. Malware head `603da7e...` was validated by six workflows on the exact same commit: JB Engines Certification 30/30; Malware Engine 4/4; Core Validation 2/2; NPM distribution 2/2; Security QA 2/2; NEXORA Threat Lab 2/2. The four Malware Engine matrix jobs each ran 204 tests: Windows Node 22/24 passed 204/204; Ubuntu Node 22/24 passed 200/200 with four Windows-only tests skipped on each Linux lane. No test failed.

## Findings and required hardening

### F-01 — Security Guard child branches were based on a stale parent and one reverted a stronger Python reader
**Severity:** High (integration / security regression)  
PR #138 and PR #139 share merge base `1d050e1dad0c22f9cb855b585029b8dc92f61384`, not current PR #136 head `c6c69a6a8fa8a451c0a35b6eb0f2213e73ba56b5`. Comparing #136 head to #139 code head `bc1b3ab438fbdd01a1bb25131df3fd23884455cc` reports a diverged history: #139 is 21 commits ahead and 17 behind, with merge base `1d050e1...`. Its 43/43 green jobs therefore do not validate a combined current #136 + #139 tree. Source review found a concrete regression: #136's Python `UploadInspectionReadOnlyStream` is a direct bounded reader that deliberately does not inherit `io.RawIOBase`, preventing a scanner from wrapping it in `io.BufferedReader` and falsely counting prefetched bytes as consumed. The stale #139 branch replaces it with `_VerifiedScannerStream(io.RawIOBase)` and removes related no-prefetch regression tests. #139's PHP sequential reader and malicious-retention changes remain valuable, but cannot be merged from that stale tree as-is.

**Corrective action:** PR #145 has been rebuilt from exact #136 head `c6c69a6a8fa8a451c0a35b6eb0f2213e73ba56b5`; comparing #136 head to #145 head `36b251ebf43d5a00bee666a42835a449bfb910e2` shows status `ahead`, 15 commits ahead, 0 behind, and merge base exactly `c6c69a6...`. It preserves the stronger Python direct reader and its tests, integrates the typed bounded PHP sequential reader and its adversarial tests, and applies malicious quarantine retention to Node/Python/PHP plus shared vectors and Threat Lab tests. Full CI on #145 is pending. Do not merge #138 or #139 independently. Review corrections were added to both PRs.

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
- PHP's bounded sequential reader is now carried by candidate #145, counts and hashes the exact bytes delivered to the scanner, and rejects incomplete, transient-empty, trailing or altered content. #145 keeps #136's Python direct reader (no `io.RawIOBase`/`BufferedReader` prefetch path) and its associated tests while integrating malicious retention and quarantine telemetry across Node, PHP and Python.
- Python and PHP distribution paths have clean-consumer/package validation in the CI matrix.
- Resilience A2 validates strict record shapes, identity bindings, idempotency keys, evidence digests, independent verification, and forensic retention receipts; unresolved outcomes remain held. The execution-capable controller also requires the external revision anchor to be explicitly configured, durable and atomic, plus the pending-record APIs; the coordinator remains read-only.
- Threat Lab aggregation rejects duplicate target/scenario pairs and conflicting target definitions, and preserves source outcomes.
- Malware calibration uses synthetic evidence; this is useful for deterministic regression but intentionally insufficient for claims about live malware detection.

## Certification matrix

| Engine / subsystem | Laboratory evidence | Current decision |
|---|---|---|
| Resilience A1 | 49/49 CI checks | LAB-CERTIFIED |
| Resilience A2 | 49/49 workflow jobs on head `95faf095ed575d62dc042433701ce909e00b0362` | LAB-CERTIFIED — read-only reconciliation only |
| Security Guard core | 61/61 CI checks on #136 | LAB-CERTIFIED — integration pending |
| Security Guard PHP stream + malicious quarantine lifecycle | #145 exact combined tree `36b251ebf43d5a00bee666a42835a449bfb910e2`; 8 full workflows pending | CONDITIONAL — awaiting fresh combined CI and review |
| Security Guard distribution | 48/48 CI checks on #128 | LAB-CERTIFIED |
| Malware Engine calibration + contextual PowerShell lexical triage | 42/42 workflow jobs on exact head `603da7e26a43635faa35bc4fe79baf223b29333d`; 204 tests per platform, Windows 204/204, Linux 200/200 plus four Windows-only skips | LAB-CERTIFIED — synthetic/fixture corpus only; not antivirus efficacy certification |
| Threat Lab report | 50/50 CI checks | LAB-CERTIFIED — reporting/aggregation only |

## Release gates

1. Keep #145 as the canonical integrated Security Guard candidate from exact #136 head; do not merge #138 or #139 independently. Require all eight full workflows to pass on exact #145 head before any merge.
2. Preserve the exact Malware Engine evidence at head `603da7e26a43635faa35bc4fe79baf223b29333d`; any later code change must trigger the complete cross-platform and integration matrix again.
3. Review the full diffs and adversarial tests for each PR, not just the green status.
4. Keep all draft PRs unmerged until dependency order and combined CI are proven.
5. For production adoption, require a real host integration review covering storage isolation, atomic promotion, authorization, secrets, observability, backups, and incident response.
6. Publish a certification artifact tied to immutable commit SHAs and explicit scope/limitations.

## Final status

**Laboratory evidence: PASS for individually inspected components, including Malware Engine candidate `603da7e...` (42/42 workflow jobs); integrated Security Guard #145 remains pending fresh CI.**  
**Production certification: NOT GRANTED.**  
**Release readiness: BLOCKED on production host-adapter, access-control, retention, and operational integration gates.**

This report is an engineering audit record, not a guarantee that the engines are invulnerable or that all defects have been found.