# Cross-engine validation and calibration

This document defines how the three engines should be evaluated. It distinguishes implemented checks from evidence that still needs to be collected.

## Validation layers

1. **Static validation** — syntax, AST rules, dependency metadata, configuration validation, and code-quality checks.
2. **Unit and regression tests** — deterministic fixtures for known-good behavior, known-bad behavior, boundary conditions, and prior defects.
3. **Adversarial parser tests** — malformed, truncated, cyclic, oversized, and deterministic mutation corpora. Parser tests must enforce byte, entry, depth, and time limits.
4. **Integration tests** — realistic Node.js request flows, upload quarantine adapters, browser interactions, and cross-engine decisions.
5. **Calibration** — labelled benign and suspicious/malicious fixtures, with false-positive and false-negative counts.
6. **Platform validation** — Linux and Windows runs for OS-specific behavior such as Authenticode.
7. **Independent release review** — review security boundaries, deployment guidance, dependencies, and unresolved limitations before use with customers.

## JB Expert QA

### Existing coverage

- Acorn-based JavaScript AST security checks and explicit reporting for unsupported/parser-gap files.
- Bounded intra-file taint/alias propagation.
- Project scan limits and incomplete-scan reporting.
- Playwright URL auditing, multi-viewport checks, accessibility scans, interaction-state exploration, and visual baseline comparison.
- JSON, Markdown, and HTML reports.

### Required calibration

- Build a module graph before reporting unused exports. Treat package entry points, dynamic imports, plugin registration, and reflection as uncertainty; do not report a symbol as dead solely because no direct import was found.
- Measure CSS usage across routes and representative interaction states. A selector not observed in one capture is not proof that it is unused.
- Add annotated screenshots as separate evidence artifacts; preserve the unmodified source screenshot.
- Add remediation options and a targeted re-verification command. A recheck must record which rules were rerun and compare the same evidence before/after.
- Expand taint analysis to interprocedural and cross-file flows only with explicit coverage boundaries and regression fixtures.

## JB Security Guard

### Existing coverage

- Request target normalization, URL decoding depth checks, selected XSS/SQLi/path traversal signatures, framing/header validation, rate limiting, authentication protections, security headers, origin and CSRF protections.
- Monitor and enforcement modes.
- Upload quarantine pipeline with content-signature checks, stream-size limits, scanner timeouts, digest verification, and fail-closed promotion.

### Required calibration

Use representative synthetic benign traffic, including search phrases, quotes, SQL keywords as ordinary text, Unicode, form values, and encoded URLs. Record:

- Requests observed.
- Requests blocked.
- False positives by rule and route.
- False negatives from a curated bypass suite.
- Request latency and memory cost.

Do not move deployments from monitor to balanced/strict solely because attack fixtures are detected. Set a promotion gate based on false-positive rates and a reviewed exception process.

Fuzz upload parsing with corrupt headers, truncated streams, declared/actual MIME mismatches, oversize inputs, timeouts, digest mismatches, and storage adapter failures. Unknown and failed scans must stay quarantined.

## JB Malware Engine

### Existing coverage

- SHA-256 and byte-pattern matching, including chunk-boundary tests.
- Ed25519-signed signature bundles with trusted-key validation.
- Bounded PE, ZIP, OLE/CFB, and PDF structural analysis.
- Script heuristics with comment/string masking.
- Deterministic malformed-input mutation suites.
- Synthetic benign script and generated-PE calibration cases.
- Windows-only Authenticode integration with an explicit unavailable result elsewhere.

### Required calibration

- Add a legally distributable benign Windows application corpus with provenance, version, SHA-256, and expected result. Never bundle proprietary installers without permission.
- Add a labelled set of malicious/suspicious test fixtures that are inert or purpose-built for testing. EICAR is a test marker, not representative malware coverage.
- Measure false positives separately for signed/unsigned installers, administrative scripts, Office files, archives, PDFs, and shortcuts.
- Keep parser completeness visible. A malformed, truncated, or unsupported container must not become a clean verdict.
- Establish signature bundle provenance, signing-key custody, revocation/rotation, versioning, and freshness policy before relying on external signatures.
- Extend VBA analysis only after the MS-OVBA decompression format has bounded, independently tested decoding and explicit incomplete-result handling.
- Add LNK, RTF, and ISO parsers as separate modules with format-specific fixtures and size limits; do not infer safety from extension alone.

## Metrics

Every calibration run should record:

- Commit SHA, engine version, operating system, Node version, fixture-set version, and run timestamp.
- True positives, false positives, true negatives, false negatives, and unknown/incomplete counts.
- Precision and recall only when a labelled set supports those calculations.
- Median and p95 scan duration, throughput, peak RSS, and parser truncation counts.
- Rule-level breakdowns and regression against the previous baseline.

Do not compare benchmark numbers from different machines as though they were directly equivalent. Do not count an incomplete analysis as a true negative.

## Current reproducibility gap

The root package pins direct dependency versions but does not yet contain a root `package-lock.json`. A committed lockfile and clean `npm ci` validation are required before claiming fully reproducible installation. Until then, use the documented test commands and record the exact resolved dependency tree with each release candidate.
