# JB Engines — quality and validation roadmap

This document is the working acceptance plan for JB Expert QA, JB Security Guard, and JB Malware Engine. It distinguishes implemented capabilities from work that still requires implementation or independent validation. A feature is not considered certified merely because its source code or tests exist.

## Release principles

- Keep the repository private during active development and security review.
- Develop on `feature/deep-analysis-cross-engine-upgrade`; do not merge to `main` without explicit approval.
- Prefer local deterministic tests and focused CI over repeated full CI runs.
- Treat incomplete analysis as incomplete, never as a clean result.
- Preserve reproducible evidence: commit, runtime, platform, test command, test counts, and benchmark configuration.
- Do not execute live malware samples. Use generated malformed files, benign fixtures, and the harmless EICAR test marker only.
- Never claim antivirus certification, complete language coverage, or production readiness without independent evidence.

## Phase 1 — engineering foundations

### Current implementation
- JavaScript AST parsing and bounded intra-file taint propagation.
- Explicit incomplete-coverage findings for unsupported TypeScript/JSX/Vue/Svelte inputs.
- Project scan completeness checks and bounded project scanning.
- Local pre-push hook installer and all-engine test entry point.
- Separate Expert QA, Security Guard, and Malware Engine packages and test suites.
- Benchmark scripts and a persistent benchmark-history format.

### Remaining acceptance work
- Add and maintain a root lockfile from a trusted Node/npm environment; do not hand-author dependency integrity values.
- Validate a clean install from the lockfile on supported Node versions.
- Add a dependency inventory/SBOM and automated advisory review.
- Add a cross-package import graph and circular-dependency report.
- Verify that the local hook is installed in each developer clone; hooks are not automatically transferred by Git.
- Verify that `npm run test:all-engines` actually includes every package suite and report per-package counts.

## Phase 2 — JB Expert QA depth

### Current implementation
- AST-based JavaScript request-source to security-sink checks.
- HTML sink heuristics and project-level security rules.
- Playwright adapters, interaction exploration, viewport checks, visual diff, accessibility, and performance specialists.
- Structured findings and HTML/Markdown reporters.

### Remaining acceptance work
1. Build a scope-aware AST symbol index for declarations, references, imports, exports, re-exports, and package entry points.
2. Report unused declarations only when scope and monorepo-wide reference analysis prove they are unused. Dynamic imports, reflection, framework conventions, generated files, and public package exports must be accounted for.
3. Add import-cycle detection and unresolved import checks.
4. Measure CSS selector usage across all discovered routes and representative UI states. Findings must state which routes/states were observed and must not call a selector unused when coverage is incomplete.
5. Attach screenshots to visual findings and annotate the actual element bounds for overlap and overflow evidence.
6. Add remediation alternatives with cause, impact, recommended fix, and verification command.
7. Add targeted re-verification using stable rule IDs and compare the before/after findings.
8. Expand AST support by language with explicit parser coverage. Never silently treat unsupported syntax as analyzed.

## Phase 3 — JB Security Guard calibration

### Current implementation
- Monitor, balanced, strict, and custom modes.
- Request-target inspection with bounded repeated percent-decoding and malformed-encoding checks.
- Request/header/body-size controls, framing checks when raw headers are available, rate limiting, authentication protection, origin/CSRF protection, response headers, and upload quarantine contracts.
- Sanitized events and fail-closed upload inspection.
- Unicode compatibility normalization before high-confidence request signature checks.

### Remaining acceptance work
1. Maintain a labelled attack corpus: single/double/multiple URL encoding, mixed-case encodings, Unicode compatibility forms, control characters, traversal, XSS, and SQLi test strings.
2. Maintain a separate labelled benign corpus: ordinary search terms, quotes, SQL vocabulary in natural language, encoded user text, forms, and international text.
3. Report true positives, false positives, false negatives, and per-rule confusion matrices. Do not promote monitor to balanced based only on attack detection tests.
4. Fuzz request normalization, raw-header framing, upload metadata, stream truncation, timeouts, adapter failures, and quarantine promotion/recovery.
5. Ship a demonstration app with one-command local attack and benign-traffic suites.
6. Test monitor/balanced behavior under load and verify that event payloads remain redacted.
7. Require an external security review before customer-facing enforcement.

## Phase 4 — JB Malware Engine coverage and calibration

### Current implementation
- Streaming SHA-256 and byte-pattern matching.
- Signed Ed25519 signature-bundle verification.
- Bounded PE, ZIP/OOXML, OLE/CFB, and PDF triage.
- Script heuristics, recursive scanning, Windows Authenticode reporting, and explicit quarantine.
- Incomplete/unknown results for unsupported or budget-exhausted analysis.
- Deterministic malformed-input parser regression tests and a small benign Windows utility calibration corpus.

### Remaining acceptance work
1. Expand benign corpora with legally redistributable Windows utilities, installers, signed/unsigned binaries, scripts, and Office documents. Record source, license, file hash, OS/version, and expected label.
2. Report false-positive rates separately by file type and heuristic; do not equate `no_match` with proof of safety.
3. Extend deterministic parser fuzzing with mutation strategies, corpus seeds, timeouts, memory ceilings, and saved reproducer fixtures for PE, ZIP/ZIP64, OLE, and PDF.
4. Add dedicated VBA decompression/decompilation and macro feature extraction in a resource-limited worker.
5. Add LNK, RTF, ISO, and installer metadata parsers with strict byte, entry, recursion, and time budgets.
6. Implement a trusted signature-feed lifecycle: source provenance, signing-key rotation/revocation, expiry, rollback prevention, and offline verification.
7. Validate Authenticode on real Windows runners/VMs, including invalid, expired, revoked, unsigned, and valid test certificates.
8. Keep Windows kernel/filter-driver and real-time protection work out of scope until a separate signed native service, VM test lab, crash recovery plan, and independent review exist.

## Phase 5 — evidence, remediation, and certification gates

Every finding should carry:
- Stable rule ID and engine/version.
- File/route/request location and bounded evidence.
- Severity, confidence, and coverage state.
- Cause and impact, without exposing secrets.
- Recommended fix plus safe alternatives.
- A focused re-verification command.

Every release candidate must publish:
- Test totals by engine and platform.
- Coverage gaps and skipped tests.
- False-positive/false-negative measurements against labelled corpora.
- Benchmark environment and resource metrics.
- Regression comparison against the previous baseline.
- Known limitations and an explicit release decision.

## Phase 6 — marketplace recommendation engine

This is a separate product track, not a security engine. Validate it with 10–15 or more consented, anonymized customer scenarios covering budget, priorities, constraints, and product availability. Score recommendation relevance, factual accuracy, explanation quality, and handling of missing data. Keep phone and perfume recommendations separate where their ranking criteria differ.

## Current branch work added in this iteration

- Security Guard now applies Unicode NFKC compatibility normalization to the decoded inspection copy of the request target before matching high-confidence signatures. The original request URL is not rewritten for routing.
- Added regression coverage for full-width encoded XSS and benign natural-language search text.
- Added deterministic malformed-input regression tests for the PE, ZIP, OLE, and PDF parsers. The test asserts structured bounded findings and that parsers do not mutate caller-owned buffers.
- Added a small benign Windows administration/script fixture corpus to catch obvious heuristic false positives.

## Validation status

These additions are committed to the development branch but have not yet been executed in Termux or GitHub Actions in this iteration. Treat them as **implemented, pending test execution**, not as passing or certified. The deterministic parser test is a regression smoke-fuzzer, not a substitute for coverage-guided fuzzing or long-running fuzz campaigns.
