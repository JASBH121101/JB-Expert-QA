# JB Engines — Technical Certification Plan

## Scope

This certification validates four core engines as separate products and then validates their explicit integration contracts:

1. **JB Expert QA** — source/project, dependency, browser, accessibility, visual and database QA. It diagnoses and reports defects in software projects.
2. **JB Security Guard QA** — runtime HTTP/request and upload-boundary protection. It enforces policy in the application server.
3. **JB Malware Engine** — bounded local file triage using hashes, byte signatures, static heuristics and supported file-format analyzers.
4. **JB Resilience Engine** — Linux/Windows service-health tracking and policy-bounded recovery with human approval for critical actions.

The packages remain independently versioned and independently installable. This certification does not collapse their source trees into one monolithic runtime.

## Local execution without GitHub Actions

JB Expert QA now includes a repository-owned local certification runner. It can run the selected regression and integration checks directly on the developer's machine; GitHub Actions is not required to start these profiles.

Commands:

    npm run qa:local
    npm run qa:local:full

The core profile runs root syntax/regression checks, package-distribution boundaries, shared engine contracts and the safe Threat Lab suite. The full profile adds Security Guard, Resilience Engine, internationalization and dead-code regression suites. JSON and Markdown reports are written locally under .jb-expert-qa/certification.

The runner invokes only fixed npm scripts from an allowlist, runs them sequentially, enforces per-check timeouts, preserves failures and redacts the bounded output tail. It does not call GitHub APIs, access production services or deploy infrastructure.

This local profile runs only on the current host and Node.js version. It is not a substitute for cross-platform Node/OS matrices or browser provisioning; the report states these coverage limitations and lists checks not included in the selected profile.

## Hosted compatibility matrix (optional)
The `JB Engines Certification` GitHub Actions workflow runs:

- Expert QA full regression tests on Node.js 22 and 24, including browser QA.
- Expert QA security assessment report generation, retained as a workflow artifact.
- Security Guard's controlled request/security regression suite on Ubuntu and Windows, Node.js 22 and 24.
- Malware Engine's complete package test suite, including calibration and the Security Guard streaming adapter, on Ubuntu and Windows, Node.js 22 and 24.
- A bounded Malware Engine performance benchmark using generated benign fixtures.
- Resilience Engine policy, health-monitor and Linux/Windows adapter tests on Ubuntu and Windows, Node.js 22 and 24.
- Clean package-distribution checks for all seven independently installable packages on Node.js 22 and 24, including Localization and Currency Engine.
- A unified Threat Lab v1 certification report that consolidates the original safe integration reports for the four JB engines, validates target/version uniqueness, exposes missing engines or tiers, and preserves skips/failures instead of treating them as passes. NEXORA Catalog and Site Engine remain separate product targets in their dedicated workflow because their repositories are not mounted in the monorepo runner. One report plus its source reports is retained per OS/Node matrix lane.

All test payloads are synthetic or inert. Malware plumbing uses the harmless EICAR test string and generated fixtures; no suspicious executable is run. Security tests target local test handlers and in-memory fixtures, not public websites or production systems.

## Four-core-engine operating model

The intended integration is a pipeline with explicit ownership:

```text
Project / application repository
             |
             v
      JB Expert QA
  inspect -> diagnose -> report
             |
      reviewed remediation
             |
             v
    Application build / tests
             |
             v
   JB Security Guard QA
 protect requests and upload boundary
             |
       upload stream
             v
     JB Malware Engine
  hash / signatures / static triage
             |
             v
   Guard-owned verdict policy
 quarantine / block / unknown
```

### Responsibilities and trust boundaries

- Expert QA can identify a risky route, unsafe configuration, missing validation, dead code, dependency exposure or visual/accessibility regression. Its quality score is never a malware verdict.
- Security Guard owns request enforcement and the upload decision. It must fail closed on scanner errors, malformed responses, timeouts, digest/size mismatch and unknown verdicts.
- Malware Engine scans files locally and reports its own evidence. An exact signature match can produce `malicious`; heuristic results can produce `suspicious`; incomplete coverage can produce `unknown`; `no_match` is not proof that a file is safe.
- The current Malware Engine scope is Windows-focused. Android/iOS and APK support are excluded; desktop VPN enforcement, Windows services/drivers, firewall/routing changes, and installers remain deferred until a real Windows test device is available and separately approved.
- The existing Malware-to-Guard adapter intentionally maps `no_match`, `suspicious` and `unknown` to Guard's `unknown` verdict. It never promotes an upload to `clean`. This is a security property, not a defect to relax.
- Expert QA is a read-only quality gate by default. Remediation must be reviewed and tested before it is accepted.

## Repair workflow

Expert QA's first job is to produce reproducible findings with file/line evidence, severity and remediation guidance. The operator then reviews the proposed change, applies a patch on a dedicated branch, runs the affected unit/integration tests and reruns the full certification workflow.

The supervised autopilot has explicit opt-in controls. Low-risk auto-repair requires the AI deep-analysis, source-upload, apply-low-risk and run-tests flags together. It is not enabled by this certification workflow. No code is silently rewritten, and visual QA remains deterministic/local unless a separately authorized emergency AI fallback is explicitly requested.

## Certification decision

Resilience Engine is tested separately on Ubuntu and Windows, Node.js 22 and 24. Critical-service recovery must be rejected without valid human approval; platform adapters use injected test runners and never restart CI host services. Tests also verify that proposals expiring during asynchronous approval cannot execute, Windows reaches `STOPPED` before `start` and `RUNNING` afterward, and active threat/tamper signals suspend recovery.

A green workflow is necessary but not sufficient. Final certification requires:

- All required test jobs pass on supported Node.js/OS combinations.
- No unresolved critical/high findings without an accepted risk decision.
- Malware detection calibration reviewed against both positive inert fixtures and a representative benign fixture corpus.
- False-positive, false-negative and unknown/incomplete coverage rates reported; no unsupported claim of antivirus-grade detection.
- Integration contract checks prove exact size/hash binding, complete stream consumption, cleanup, timeout/abort behavior and fail-closed handling.
- Human review of reports and any remediation diffs.

Possible outcomes: **Passed**, **Passed with observations**, or **Not passed**. This internal result is not an independent third-party certification and does not establish production readiness.

## Safety and cost controls

- No changes to `main`, production databases, customer files, deployments or external infrastructure.
- No paid services, external malware feeds or source uploads are enabled by this workflow.
- CI uses GitHub-hosted runners and the repository's existing free-tier controls.
- No malware samples are executed. No destructive tests are run against live systems.
- Artifacts contain test reports/benchmarks only. Standard artifacts use 14-day retention; the unified Threat Lab reports and Resilience OS service-manager lab evidence use 30-day retention.

## Security assessment scope

The certification security report uses production-source scope. It evaluates deployable source files and excludes test directories, fixture/testing directories, and the repository's own security-rule definition files, which contain intentionally unsafe examples and detection patterns. These excluded files remain covered by the full regression suite; they are not treated as application runtime code. Any finding that remains in production-source scope continues to block the assessment.
