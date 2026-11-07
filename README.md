# JB Expert QA

JB Expert QA is a supervised quality and security analysis toolkit for JavaScript/Node.js projects and web applications. This repository currently contains three related engines:

- **JB Expert QA** — static project checks, JavaScript AST security analysis, browser/runtime inspection, responsive checks, accessibility checks, and visual regression support.
- **JB Security Guard** — Node.js HTTP request protection, authentication controls, security headers, origin/CSRF protections, distributed adapter contracts, and upload quarantine orchestration.
- **JB Malware Engine** — bounded, non-executing file triage using hashes, byte signatures, signed signature bundles, script heuristics, and structural analysis for selected file formats.

The engines are still under active development. A passing test suite is evidence about the tested cases, not proof that an application or file is safe.

## Requirements

- Node.js 22 or newer
- npm
- Git

## Install

From the repository root:

```bash
npm install
```

The root package declares `packages/*` as npm workspaces, so internal packages are linked locally by `npm install`. The root package currently pins its direct dependencies, but a root `package-lock.json` is not yet checked in. Until the lockfile is generated and committed, transitive dependency resolution is not fully reproducible. Do not use this repository's current dependency installation as a production supply-chain guarantee.

## Run checks

```bash
# Full Node.js test discovery (all security engines and the recommender)
npm test

# Phone and perfume recommendation tests
npm run test:recommendation-engine

# Android/Termux-compatible test selection (browser suites are explicitly excluded)
npm run test:mobile

# Local-only Security Guard request demonstration
npm run demo:security-guard

# Focused security QA tests
npm run test:expert-qa

# Security Guard package tests
npm run test:security-guard

# Malware Engine package tests
npm run test:malware-engine

# Android-compatible subset for Termux (browser suites excluded)
npm run test:mobile

# Install the local pre-push hook
npm run hooks:install
```

The pre-push hook runs `npm run test:mobile` when it detects Termux; on desktop it runs `npm run test:all-engines`. Browser-dependent Playwright suites remain unvalidated on Android. Hooks are local safeguards and can be bypassed; CI and independent review remain necessary.

## Recommendation Engine

The rule-based phone/perfume recommender consumes a supplied catalog and explicit customer priorities. It does not fetch live prices or stock, convert currencies, or invent missing specifications. Unknown availability is returned as unverified. Its score measures weighted fit against supplied attributes, not guaranteed product quality.

## Benchmarks

```bash
npm run benchmark:expert-qa
node bench/security-guard.js
node packages/malware-engine/bench/run.js
```

Benchmarks should be compared only across equivalent environments and fixture versions. Throughput is not a measure of detection quality. Detection quality needs labelled benign and malicious/suspicious test sets with recorded provenance.

## Analysis scope and safety boundaries

### JB Expert QA

- Project audits read bounded source files and do not execute the audited project.
- JavaScript security data-flow currently uses Acorn for `.js`, `.mjs`, and `.cjs` files. It tracks bounded intra-file aliases; it is not interprocedural or cross-file taint analysis.
- Unsupported source languages and parse gaps must remain visible as incomplete coverage.
- URL/browser audits use Playwright. Only audit targets that you own or are explicitly authorized to test. URL safety controls are part of the scanner's threat boundary.
- Visual baselines and screenshot evidence require review; a screenshot comparison can be sensitive to browser, font, and operating-system differences.

### JB Security Guard

- Request inspection is defense in depth, not a replacement for a correctly configured reverse proxy, framework body limits, authorization, output encoding, or parameterized database access.
- `monitor` mode observes; enforcement modes can block legitimate traffic. Measure false positives with representative benign traffic before enabling enforcement.
- The upload inspector is an orchestration and quarantine contract, not a bundled antivirus service. Production use requires private quarantine storage, a real scanner, bounded multipart parsing, cleanup, and download authorization. Unknown or unavailable scan results must not be promoted.

### JB Malware Engine

- The engine performs static, bounded inspection and does not execute scanned files.
- A signature or high-confidence detection can support a malicious verdict; heuristic indicators generally support a suspicious verdict.
- `unknown` means analysis was incomplete or outside supported coverage. It must not be treated as clean.
- Authenticode verification is Windows-only and depends on the host operating system's trust provider.
- OLE, ZIP, PDF, and PE parsing is bounded. Unsupported or partially decoded content must be reported as partial/unknown rather than silently treated as clean.

## Repository workflow

Development work is performed on feature branches. Do not push directly to `main` or merge a feature branch without an explicit release decision. Keep secrets, credentials, real customer data, and proprietary malware samples out of commits, fixtures, screenshots, and test logs.

See [SECURITY.md](SECURITY.md) for reporting security issues and [docs/VALIDATION-AND-CALIBRATION.md](docs/VALIDATION-AND-CALIBRATION.md) for the validation strategy.
