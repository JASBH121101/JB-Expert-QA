# JB Engines — Repository Architecture

## Architectural principle

This repository hosts three **distinct engines with separate responsibilities**. It is a shared code repository, not a single combined engine. Each engine retains its own API boundary, configuration, version, tests, release criteria, and failure semantics.

The engines may exchange normalized findings through explicit, versioned adapters. They must not share internal state or silently inherit one another's authority. The interoperability contracts in [SECURITY-INTEROPERABILITY.md](./SECURITY-INTEROPERABILITY.md) and [SECURITY-BRIDGE.md](./SECURITY-BRIDGE.md) define the permitted coordination.

## Engine boundaries

### 1. JB Expert QA

**Primary responsibility:** evaluate software and application quality.

- Static project and code-quality analysis.
- Browser-based functional, responsive, accessibility, performance, and consistency audits.
- Security-oriented source and URL checks within its configured audit scope.
- Visual regression, deterministic diagnostics, scoring, and machine-readable reports.
- Optional, replaceable AI assistance and supervised local remediation.

**Decision boundary:** an Expert QA score or passing site audit is not a malware verdict, does not authorize an uploaded file, and is not a substitute for runtime request authorization.

The Expert QA core is the repository root package. Its browser and filesystem adapters remain explicit and bounded. Project auditing must not execute the audited project's code or access production credentials and databases by default.

### 2. JB Security Guard

**Primary responsibility:** enforce runtime application and request security policies.

- HTTP request and header hardening.
- Origin and CSRF protections.
- Authentication and account-recovery protections.
- Rate limiting and bounded distributed-store operations.
- Upload inspection orchestration and quarantine lifecycle.
- Sanitized security events and configurable monitor/block policies.

**Decision boundary:** Security Guard owns request-policy enforcement and the quarantine-to-approved transition. A file can only be promoted by its storage adapter after the configured scan and integrity checks succeed. Missing, inconclusive, malformed, timed-out, or failed checks must fail closed.

The current package targets Node.js and its documented Express-compatible middleware interface. This does **not** establish compatibility with Cloudflare Workers or other runtimes. Any such deployment requires a runtime-native adapter and its own tests; do not import Node/Express middleware into a Worker and assume it is compatible.

### 3. JB Malware Engine

**Primary responsibility:** inspect files for malware indicators and configured signatures.

- Streaming hashing and exact hash/byte-signature matching.
- Bounded static analysis of supported executable, archive, Office, OLE, and PDF formats.
- Conservative heuristic triage and structured scan reports.
- Explicit local quarantine support for authentic confirmed detections under its own policy.

**Decision boundary:** Malware Engine is a distinct inspection engine, not an HTTP authorization engine or storage-promotion authority. Its verdicts retain their exact meaning:

| Verdict | Meaning |
| --- | --- |
| `malicious` | A configured exact signature matched. |
| `suspicious` | Heuristic evidence warrants review; this is not a confirmed detection. |
| `no_match` | No configured detection matched; this does not prove the file is safe. |
| `unknown` | Coverage was incomplete or insufficient. |
| `error` | A file-level scan error occurred. |

When used by Security Guard, Malware Engine is invoked through the documented scanner adapter. A Malware Engine `no_match` or `suspicious` result must never be converted into a clean/approved result. Security Guard remains responsible for the upload policy and storage promotion.

The engine is local-first and is not a certified antivirus or a replacement for Microsoft Defender.

## Permitted coordination

Coordination is an interoperability layer, not a merger:

1. Each engine keeps its native report, internal model, rules, and tests.
2. An engine may additionally publish a normalized finding conforming to the versioned shared contract.
3. Findings must identify their producer and preserve evidence provenance. Secrets, credentials, tokens, full request bodies, and URL query strings must be redacted before export.
4. Cross-engine adapters must validate input, bound payload size and execution time, handle cancellation, and fail safely.
5. Correlation IDs may relate observations about the same resource or transaction; they must not be reused for unrelated resources.
6. A result from one engine must not be relabeled as another engine's verdict or used to bypass the receiving engine's policy.

The current Security Bridge is a local coordination protocol between Expert QA and Security Guard. Malware Engine remains an independent file-analysis component used through the Guard scanner contract. This distinction preserves three engine boundaries while keeping the upload decision in one accountable place.

## Versioning, testing, and release gates

- Version each engine independently. A change to one engine does not imply a release of the other two.
- Keep engine-specific unit tests, integration tests, benchmarks, and validation workflows. A combined CI run may orchestrate these jobs, but it must report their outcomes separately.
- Run contract tests for each adapter independently of the producing engine's internal implementation.
- Require cross-engine tests for correlation, malformed findings, mismatched hashes, partial streams, timeouts, cancellation, and unavailable adapters.
- Do not automatically merge feature branches that contain overlapping histories. Compare each branch against current `main`, then integrate only reviewed, non-duplicated changes.
- A passing CI run demonstrates only that the configured checks passed. It is not a security certification, antivirus certification, penetration test, or production-readiness attestation.

## Runtime and data isolation

- No engine receives production secrets, production databases, or production storage access by default.
- Do not share signing keys, authentication secrets, quarantine credentials, or private state between engines.
- Malware scanning uses bounded local processing unless a separately reviewed adapter explicitly provides another backend.
- Security Guard's in-memory rate limits are process-local; global multi-instance enforcement requires a reviewed shared atomic store.
- Expert QA is primarily a development/CI audit engine, not a middleware to run on every ERP request.
- ERP, Cloudflare Pages/Workers, Neon, and R2 integrations require separate compatibility, authorization, data-retention, and quota reviews before deployment.

## Existing Expert QA capabilities

The Expert QA core includes an extensible rule registry, validated engine configuration, deterministic scoring, browser specialists, static project specialists, Playwright-based browser auditing, responsive multi-viewport checks, PNG screenshots, explicit pixel-diff baselines, optional AI screenshot review, structured remediation planning, JSON/Markdown/HTML reports, and automated tests.

The optional AI layer is replaceable and not required for deterministic checks. AI output never approves a release. Any automated repair remains supervised, constrained to allowlisted low-risk files in an isolated local worktree, requires explicit opt-ins, and does not push, open a PR, merge, or deploy.

## Known limitations

Automated checks can miss vulnerabilities and produce false positives. Static analysis is not a substitute for a maintained vulnerability database or independent security assessment. Malware Engine's heuristic and `no_match` results do not prove safety. Security Guard's Node/Express implementation is not a Cloudflare Worker adapter. Upload inspection still requires a production-grade scanner and private storage adapter with a documented retention and cleanup policy before customer uploads can be treated as production-protected.


## Static dead-export analysis

JB Expert QA includes a conservative JavaScript export-reachability rule. It inspects statically resolvable relative imports and re-exports and reports exports with no importer inside the scanned project as **review-only candidates**. It does not prove that code is unused: external package consumers, dynamic loading, reflection, framework conventions, runtime entrypoints, generated files, and unsupported syntax can affect reachability.

The detector deliberately emits coverage warnings or abstains when it sees non-literal dynamic module loading or parse failures. It skips index modules, declared package entrypoints, CommonJS boundaries, and export-star modules. It supports JavaScript \`.js\`, \`.mjs\`, and \`.cjs\` modules only; TypeScript, JSX, Vue, Svelte, CSS selectors, and CSS reachability are outside this rule's scope.

Findings are informational and must be reviewed. The detector never deletes files, declarations, or exports and must never be used as an automatic deletion list. GitHub Actions validates its regression tests on Node.js 22 and 24.
