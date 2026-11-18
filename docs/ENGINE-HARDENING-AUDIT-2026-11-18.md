# JB Engines — Independent Hardening Audit & Evidence Report

**Audit date:** 2026-11-18  
**Repository:** JASBH121101/JB-Expert-QA  
**Audit branch:** audit/engine-hardening-certification-2026-11-18  
**Baseline:** main @ a513d389467264ed96018c3b678be118c90acef9  
**Method:** read-only source review, PR topology review, and GitHub Actions check-run verification. No production services, external targets, malware samples, or live systems were exercised.

## Executive decision

The reviewed changes show strong automated regression and distribution evidence. The current Malware Engine PowerShell lexer head `603da7e26a43635faa35bc4fe79baf223b29333d` passed its complete targeted package workflow and repository integration matrix: **42/42 workflow jobs** via #144. Security Guard's canonical integrated candidate #145 is built directly on the exact #136 head. Its latest exact head `44109341a508bc3412b649658ff89845baff7fa2` passed all eight required workflows (30/30 jobs). This supports **laboratory / CI certification only** for the individually tested scopes, not production readiness, real-world antivirus effectiveness, exploit resistance, or independent third-party certification.

No changes were made to `main`; the temporary validation PR #144 and obsolete validation requests #142/#143 were closed without merge. No paid service or production environment was accessed.

## Verified CI evidence

| PR | Area | Inspected head | CI evidence | Result |
|---|---|---|---:|---|
| #125 | Resilience A2 restart reconciliation | 70e26eab24b2f5127e038955399b641c3be9a513 | 8/8 workflows; 49/49 jobs; zero failures | PASS — exact-head timeout-race regression validated; read-only lab scope only |
| #135 | Malware Engine calibration + contextual PowerShell lexer hardening | 603da7e26a43635faa35bc4fe79baf223b29333d | 42/42 workflow jobs on exact head, validated via #144 | PASS — LAB-CERTIFIED, synthetic corpus only |
| #136 | Security Guard upload inspection + attestation | c6c69a6a8fa8a451c0a35b6eb0f2213e73ba56b5 | 61/61 | PASS |
| #138 | PHP scanner byte-stream integrity (superseded/overlapping proposal) | a64a02ff9ca3d5df74670b8a0e8f3e13127ee30e | 48/48 | PASS (stale base; not combined evidence) |
| #139 | Cross-runtime malicious-upload quarantine retention + PHP sequential reader | bc1b3ab438fbdd01a1bb25131df3fd23884455cc | 43/43 jobs on stale tree | NOT VALID as combined #136 evidence — 17 commits behind current parent; Python reader regressed |
| #145 | Canonical integrated Security Guard candidate (built from exact #136 head) | 44109341a508bc3412b649658ff89845baff7fa2 | 8/8 workflows passed (30/30 jobs) | PASS — exact combined CI passed; laboratory scope only |
| #132 | Threat Lab unified certification report | b8073677f581089e43548b5ce138c829e8e2c34c | 50/50 | PASS |
| #131 | Resilience A1 operational evidence | e49edba95a3bc409911730e1d2755590c539cfa2 | 49/49 | PASS |
| #130 | Malware Engine fixture-only calibration evidence | 02738c75ec1dd4b531177030a7cac32177e0c0ff | 54/54 | PASS |
| #128 | Security Guard package distribution | 4f36ec9792e8b9e733e1a25e3948cd1a0d0e48a8 | 48/48 | PASS |

All totals above were queried from commit-specific GitHub Actions runs/jobs, not inferred from PR summaries. Malware head `603da7e...` was validated by six workflows on the exact same commit: JB Engines Certification 30/30; Malware Engine 4/4; Core Validation 2/2; NPM distribution 2/2; Security QA 2/2; NEXORA Threat Lab 2/2. The four Malware Engine matrix jobs each ran 204 tests: Windows Node 22/24 passed 204/204; Ubuntu Node 22/24 passed 200/200 with four Windows-only tests skipped on each Linux lane. No test failed.

## Findings and required hardening

### F-01 — Security Guard child branches were based on a stale parent and one reverted a stronger Python reader
**Severity:** High (integration / security regression)  
PR #138 and PR #139 share merge base `1d050e1dad0c22f9cb855b585029b8dc92f61384`, not current PR #136 head `c6c69a6a8fa8a451c0a35b6eb0f2213e73ba56b5`. Comparing #136 head to #139 code head `bc1b3ab438fbdd01a1bb25131df3fd23884455cc` reports a diverged history: #139 is 21 commits ahead and 17 behind, with merge base `1d050e1...`. Its 43/43 green jobs therefore do not validate a combined current #136 + #139 tree. Source review found a concrete regression: #136's Python `UploadInspectionReadOnlyStream` is a direct bounded reader that deliberately does not inherit `io.RawIOBase`, preventing a scanner from wrapping it in `io.BufferedReader` and falsely counting prefetched bytes as consumed. The stale #139 branch replaces it with `_VerifiedScannerStream(io.RawIOBase)` and removes related no-prefetch regression tests. #139's PHP sequential reader and malicious-retention changes remain valuable, but cannot be merged from that stale tree as-is.

**Corrective action:** PR #145 has been rebuilt from exact #136 head `c6c69a6a8fa8a451c0a35b6eb0f2213e73ba56b5`; comparing #136 head to #145 head `44109341a508bc3412b649658ff89845baff7fa2` shows status `ahead`, 16 commits ahead, 0 behind, and merge base exactly `c6c69a6...`. It preserves the stronger Python direct reader and its tests, integrates the typed bounded PHP sequential reader and its adversarial tests, and applies malicious quarantine retention to Node/Python/PHP plus shared vectors and Threat Lab tests. Full CI on #145 passed on the exact head `44109341a508bc3412b649658ff89845baff7fa2`: 8/8 workflows and 30/30 jobs succeeded. Do not merge #138 or #139 independently. Review corrections were added to both PRs.

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
| Resilience A2 | Exact head `70e26eab24b2f5127e038955399b641c3be9a513`: 8/8 workflows, 49/49 jobs | LAB PASS — timeout/abort race regression validated; read-only reconciliation only |
| Security Guard core | 61/61 CI checks on #136; canonical integrated #145 passed 8/8 workflows (30/30 jobs) | LAB-CERTIFIED — integrated candidate validated in CI; production adapters remain host obligations |
| Security Guard PHP stream + malicious quarantine lifecycle | #145 exact combined tree `44109341a508bc3412b649658ff89845baff7fa2`; 8/8 workflows (30/30 jobs) passed | PASS — source review remains lab-scoped |
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

**Laboratory evidence: PASS for individually inspected components, including Malware Engine candidate `603da7e...` (42/42 workflow jobs) and integrated Security Guard #145 (30/30 CI jobs). Resilience A2's updated candidate is pending fresh exact-head CI after the timeout-race fix.**  
**Production certification: NOT GRANTED.**  
**Release readiness: BLOCKED on production host-adapter, access-control, retention, and operational integration gates.**

This report is an engineering audit record, not a guarantee that the engines are invulnerable or that all defects have been found.

## 2026-11-18 follow-up — additional engine source review

This follow-up supersedes any earlier statement in this report that #145 CI was pending. All results below remain commit-pinned and laboratory-scoped.

### Security Guard — canonical integrated candidate

- Exact head: `44109341a508bc3412b649658ff89845baff7fa2`.
- Latest exact-head run: eight workflows passed, with 30/30 jobs successful and no failed jobs.
- The candidate combines the #136 attestation base with bounded Node/PHP/Python inspection paths, malicious-verdict quarantine retention and shared conformance/Threat Lab tests.
- The integration preserves the Python direct bounded reader rather than reintroducing `io.RawIOBase` / `io.BufferedReader` prefetch semantics. PHP uses sequential bounded reads and verifies exact delivered-byte digest/size, incomplete consumption, trailing bytes and altered content.
- Decision: **CI PASS; lab integration review may proceed.** Production certification remains blocked on host-provided private storage, authorization on retrieval, atomic promotion bound to digest/size/attestation, scanner provenance, timeout/resource policy, operational monitoring and tested retention/recovery.

### Malware Engine — source and adversarial-fixture review (#135)

- Exact code head: `603da7e26a43635faa35bc4fe79baf223b29333d`; CI evidence: 42/42 workflow jobs on that exact head.
- The reviewed heuristic pipeline masks selected comments and literals before matching indicators. PowerShell processing retains selected semantically meaningful arguments and expandable subexpressions; Python preprocessing masks comments, ordinary strings and docstrings while examining executable f-string replacement expressions.
- Heuristic-only evidence remains `suspicious`, not `malicious`; test fixtures explicitly verify that a heuristic-only result cannot authorize quarantine (`VERDICT_REQUIRED`). The synthetic calibration matrix includes benign controls, suspicious examples and the harmless EICAR plumbing marker.
- Reported platform tests: Windows Node 22/24, 204/204 each; Ubuntu Node 22/24, 200/200 each, with four Windows-only tests skipped per Linux lane.
- Decision: **LAB PASS for the tested lexical and static-analysis paths.** This is not a measured false-positive/false-negative rate, not an independent representative live-malware corpus, not behavioral sandbox certification and not real-time endpoint protection. The lexical filters are explicitly not full language parsers; evasive syntax and unsupported formats remain residual risks.

### Resilience A2 — restart reconciliation and durable action ledger (#125)

- Exact head: `95faf095ed575d62dc042433701ce909e00b0362`; previously verified certification matrix: 49/49 jobs successful.
- Source review confirms the recovery coordinator accepts only a durable journal, an explicitly read-only provider adapter, a separate verifier, a forensic-retention lookup and an evidence resolver. It re-fetches each pending record by claim ID, binds records and receipts to exact action/scope/profile/idempotency identity, hashes resolved evidence locally, validates verification and retention receipts, and applies bounded timeouts/pages/cursor checks.
- A claim without the durable provider-start marker is held without querying the provider. Unknown, malformed, stale, mismatched or unavailable evidence stays held. Every output is explicitly `executable: false`, `safeToRetry: false`, and `releaseAllowed: false`.
- The file ledger uses a single-host lock, strict record validation, versioned HMAC-SHA-256 guard, atomic replacement/fsync and an optional external monotonic revision anchor. The PostgreSQL reference anchor performs conditional revision/digest compare-and-swap and validates its schema/trigger contract. Tests cover duplicate claims across processes, atomic lifecycle transitions, malformed/truncated state, symlink rejection, journal/guard rollback and revision divergence; PostgreSQL integration exercises two Pools against one disposable primary.
- Decision: **LAB PASS for the tested ledger and read-only reconciliation contracts.** It does not establish an independently administered database failure domain, real provider behavior, independent backup/failover/restore resilience, production evidence retention or authorization. A two-Pool test against one primary is not evidence of independent rollback protection.

### Resilience A1 — OS service-manager lab evidence (#131)

- Exact head: `e49edba95a3bc409911730e1d2755590c539cfa2`; CI evidence: 49/49 jobs successful.
- The operational lab creates a uniquely named disposable service on the hosted runner, invokes the typed Linux systemd or Windows SCM adapter, verifies the service-manager state after restart and confirms the process ID changed. Cleanup removes the disposable service and temporary files.
- The evidence is bound to commit, workflow run, runtime, platform and architecture, and explicitly marks production/customer services as untested.
- Decision: **LAB PASS for the named adapter exercises on the hosted runners only.** This does not prove recovery of customer applications/data, arbitrary host permissions/configurations, production monitoring, backup/restore, or A2/A3 authority.

### Threat Lab — unified report and evidence aggregation (#132)

- Exact head: `b8073677f581089e43548b5ce138c829e8e2c34c`; CI evidence: 50/50 jobs successful.
- The report builder consumes persisted original Threat Lab v2 scenario reports; it does not infer a pass from workflow status. It rejects unsupported schemas, duplicate report IDs, duplicate target/scenario pairs, conflicting target definitions and missing required targets. Failed scenarios and non-scope skips block readiness; structural target-scope skips remain visible.
- The report explicitly declares zero samples executed, zero network requests and no production targets tested. It preserves source outcomes and identifies commit/runtime/platform/architecture.
- Decision: **LAB PASS for report aggregation and readiness semantics.** The report is not third-party certification or proof of absence of defects. Product-level artifact signing, externally verifiable provenance and longer-term evidence retention remain separate governance work.

### Consolidated lab decision and remaining gates

| Engine | Laboratory decision | Main remaining production gate |
|---|---|---|
| Security Guard | CI PASS on integrated #145 exact head | Real host storage, authorization, scanner trust, atomic promotion, retention and recovery |
| Malware Engine | LAB PASS on #135 exact head | Representative independently labelled corpus, parser fuzzing, signed intelligence distribution and native endpoint service/driver |
| Resilience A1 | LAB PASS on #131 exact head | Customer-host/application recovery and operational certification |
| Resilience A2 | LAB PASS on #125 exact head; read-only only | Independent provider/verifier/recorder, external failure-domain anchor, backup/failover/restore and separately approved executor |
| Threat Lab | LAB PASS on #132 exact head | Signed/provenanced artifacts and governance for product-level certification |

All five workstreams remain unmerged. No production deployment or paid service was used. Green CI is evidence for the tested commit and workflows only; it is not a universal compatibility guarantee or a security warranty.


### Resilience A2 exact-head correction — 2026-11-18

The earlier A2 entry above records the historical result for head `95faf095ed575d62dc042433701ce909e00b0362`. A subsequent source review found a deadline race in `invokeBounded()`: an adapter resolving while handling the timeout-triggered abort could win the promise race even though the deadline had fired. This was corrected on PR #125's lab branch.

- Current candidate: `70e26eab24b2f5127e038955399b641c3be9a513`.
- Source change: after the race settles, the coordinator now checks the timeout flag and discards any value if the timeout callback has fired.
- Adversarial regression: the provider fixture receives the abort signal and resolves with a valid-looking provider receipt; the test requires a held result and verifies no evidence resolution, independent verification or retention lookup follows.
- Scope of change: only `packages/resilience-engine/src/a2-recovery-coordinator.js` and its targeted tests changed relative to the original 49/49 head. The compare is exactly three commits ahead, zero behind.
- Current validation state: exact-head CI for `70e26e...` completed successfully: **8/8 workflows, 49/49 jobs, zero failures**. The added timeout/abort race regression is covered by this matrix.

Therefore the old #125 LAB PASS is superseded for release-gating purposes. The A2 source review remains positive, but its new candidate is **CONDITIONAL / REVALIDATION PENDING**. A2 remains read-only at restart reconciliation, and production execution remains unapproved.
