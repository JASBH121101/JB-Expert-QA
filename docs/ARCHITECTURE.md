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


## Extended dead-code review heuristics

The static dead-code reviewer also checks JavaScript imports and local \`var\`/\`let\`/\`const\` bindings for identifiers with no observed reads. It skips duplicate names rather than guessing across lexical scopes, ignores parameters, and abstains for files using \`eval\` or \`with\`. Assignment-only writes do not count as reads. Findings remain informational; initializers can have side effects and are never automatically removed.

For standalone CSS, SCSS, SASS, and Less stylesheets, it checks basic class and ID selectors against scanned project text. It abstains when dynamic class assignment or framework-specific selector scoping is detected. A text reference is not browser proof of use, and no text reference is not proof of dead CSS. CSS-in-JS, embedded component styles, runtime-generated selectors, and route/state coverage require separate browser-based analysis.

Current static coverage remains limited to JavaScript modules Acorn can parse and basic standalone stylesheet selectors. TypeScript, TSX/JSX syntax, Vue/Svelte style blocks, CSS selector usage across runtime routes, and whole-program lexical scope resolution are not certified by these heuristics. All findings are review-only and no code is deleted automatically.

## Static declaration and dependency-graph analysis

JB Expert QA also reports function/class declarations with no statically observed references outside their own declaration, unresolved relative module specifiers, and circular dependencies in the statically resolved JavaScript module graph. Function/class checks skip duplicate binding names and abstain for direct `eval`, `with`, or parse failures. Relative import resolution checks scanned files and common extension/index conventions, including JSON/CSS assets and package-directory entrypoints; bare package imports, aliases, and paths outside the scan root are not declared missing. The cycle detector uses strongly connected components and reports each cyclic group, including self-imports.

These are static findings, not proofs of runtime behavior. Dynamic import/require expressions, computed paths, framework registration, reflection, bundler aliases, generated files, TypeScript/JSX module syntax, and files omitted by scan limits can reduce coverage. Circular dependencies may be intentional. Findings are review-only, missing relative paths require project/build-context verification, and no declaration or dependency is automatically changed. The project report exposes separate counts for unused declarations, unresolved relative imports, and dependency cycles, plus coverage warnings.

## Audit coverage, abstentions, and report semantics

The project scanner records supported file extensions and separately reports files skipped by file-count/depth limits, size limits, read errors, and symbolic links. Any skipped symbolic link is treated as an incomplete inventory for release scoring: the scanner does not follow links and therefore cannot claim those targets were audited. A project with no supported source files receives an insufficient-source assessment and cannot receive a passing source-quality result, even when the directory scan itself completed.

Static module-graph rules are intentionally limited to JavaScript `.js`, `.mjs`, and `.cjs`. TypeScript `.ts`, `.tsx`, `.mts`, `.cts`, JSX, Vue, and Svelte module syntax is surfaced as a coverage warning where import/export reachability matters; it is not silently treated as parsed. When file-count/depth, size, read, or symlink omissions exist, unused-export reachability and unresolved-relative-import checks abstain rather than reporting likely false positives. CSS selector checks also abstain on incomplete inventories. Indentation-based `.sass` syntax is explicitly reported as outside the brace-based selector parser; CSS selector parsing is limited to `.css`, `.scss`, and `.less`.

Project reports include scanned extensions, source-file counts, and per-analyzer language coverage. Markdown and HTML reports display a partial-coverage status instead of PASS whenever the scan or the relevant static-analysis coverage is incomplete. The score remains an issue score; coverage gates are reported separately so a high numerical score cannot conceal missing source coverage. CSS selector reference lookup uses a per-file token index to avoid repeating a full project text scan for every selector.

