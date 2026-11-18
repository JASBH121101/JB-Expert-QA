# @jb/threat-lab

An extensible, local-first test laboratory for JB engines and independent applications. It is an orchestration harness, not a protection engine, malware sandbox, antivirus, or production monitor.

## Design

Targets register through a small adapter contract: `runScenario({ scenario, context })`. A target can be a security engine, QA engine, ERP, catalog, API, or any future application. Scenarios are reusable test definitions and can declare `appliesTo` target IDs/kinds to avoid running irrelevant cases. The lab produces a versioned JSON report with pass/fail/skip outcomes, findings, metrics, and durations.

The lab does not import or couple itself to a particular JB product. Integrations belong in separate adapters, so adding a future engine or a customer application does not require changing the lab core.

## Safety boundary

A scenario is accepted only when it explicitly declares `safe: true`, `network: false`, `destructive: false`, and `executesSample: false`. Sample execution is prohibited. Adapters must use disposable test data, local fixtures, mocks, and explicitly authorized test environments. The lab core itself does not open network connections, execute submitted samples, mutate target source, change production data, or deploy anything. This metadata gate is not an operating-system sandbox: adapter code is trusted code and must be reviewed, kept offline, and run against disposable local fixtures or authorized test instances.

Included fixtures are inert data. The EICAR string is a harmless antivirus test pattern, not malware. Suspicious script, SQL, and path strings are text fixtures only and must never be executed or used as filesystem paths.

## Example

```js
import { createThreatLab } from "@jb/threat-lab";

const lab = createThreatLab();
lab.registerTarget({
  id: "my-application",
  kind: "application",
  version: "dev",
  capabilities: ["auth", "catalog"],
  adapter: {
    async runScenario({ scenario }) {
      // Call only a dedicated test adapter / disposable test instance.
      return { status: "skip", summary: "Integration adapter not wired yet" };
    }
  }
});
lab.registerScenario({
  id: "auth-regression",
  category: "authentication",
  description: "Validate a known-safe authentication regression fixture.",
  safety: { safe: true, network: false, destructive: false, executesSample: false }
});
const report = await lab.run();
console.log(JSON.stringify(report, null, 2));
```

## Initial validation scope

- Malware Engine: EICAR harmless test string, configured test-only hash/byte signatures, inert suspicious text, benign false-positive fixtures, unknown/incomplete coverage and size/boundary cases.
- Security Guard: mocked request/upload inputs, malformed metadata, size limits, scanner timeout/error, digest mismatch and fail-closed decisions.
- Expert QA: intentionally vulnerable source fixtures analyzed statically; compare expected findings against a repaired fixture. Visual QA remains deterministic/local; no AI visual calls.
- Applications such as NEXORA or a client ERP: isolated test database, authentication/authorization, CRUD invariants, inventory arithmetic, validation, file uploads, exports, accessibility and performance budgets.

The local integration suites now exercise all four JB engines: Malware Engine (EICAR, benign false-positive, inert suspicious-script classification), Advisor Engine (deterministic recommendation, evidence-review gating and technology product-type isolation), Security Guard (synthetic XSS blocking, malicious upload rejection through the Malware Engine adapter, and no-match quarantine), and Expert QA (unsafe HTML sink detection followed by a repaired textContent regression check). These tests use temporary directories, synthetic inputs, and in-memory upload storage. A green lab run only certifies the scenarios that actually ran; it does not prove absence of malware, vulnerabilities, or defects. Static file triage is not dynamic malware behavior analysis and cannot claim detection of every trojan, virus, ransomware family, spyware, or worm.

## Bounded execution and report contract

The orchestration core rejects duplicate matrix selections and bounds work to 50 registered targets, 100 registered scenarios, and 2,500 target-scenario executions per run. Each run's metadata is limited to 16 KiB. Adapter responses are limited to 64 KiB overall, 100 findings (48 KiB), and 50 metric keys (16 KiB); cumulative adapter outcome payloads are capped at 2 MiB per report. When the total report budget is reached, the lab records a failed budget diagnostic and skips remaining adapter calls. Scenario tags, target capabilities, and target-scoping lists are also bounded. Invalid or oversized adapter output is recorded as a controlled failed scenario instead of being treated as a pass.

These limits protect report generation from unexpectedly large or malformed adapter payloads. They do not make untrusted adapter code safe; adapters must still be reviewed and run in an appropriate isolated environment.

## Development

```bash
npm test
```

Node.js 22 or newer. No cloud services, paid APIs, telemetry, external malware feeds, or sample uploads are required.


The Advisor Engine profile uses synthetic smartphone fixtures and an in-memory research provider. It verifies that research candidates remain `unconfirmed` and `pending_review` until explicit human approval. The test reports zero network requests and does not contact external research providers.


## Four-engine certification update — 2026-11-14

PR #41 adds JB Advisor Engine as a fourth independently versioned target to `integration/jb-threat-lab`. The current four-engine matrix contains **20 scenarios**: 6 Malware Engine, 6 Security Guard, 5 Expert QA (including Language QA), and 3 Advisor Engine.

Advisor scenarios use synthetic smartphone fixtures and an in-memory research provider. Research candidates remain `unconfirmed` / `pending_review` until human review, mixed phone/laptop comparisons are rejected by domain isolation, and the integration records zero network requests.

Verified CI for PR #41:
- Core validation #43626122864: Node.js 22 and 24 passed.
- Four-package distribution #43626122830: all four engine packages packed and installed in clean directories on Node.js 22 and 24.
- PostgreSQL integration #43626122866: PostgreSQL 16 CLI E2E passed on Node.js 22 and 24.
- JB Engines Certification #43626122920: Expert QA, Security Guard, Malware Engine Windows/Ubuntu regressions and the existing three-engine package-boundary jobs passed.
- Security QA #43626122868 and Language QA #43626122855 passed.

PR #23 is closed as superseded. Its Advisor implementation is represented by PR #41; do not merge the obsolete `integration/jb-advisor-engine` branch.

The original PR #38 run records the historical three-engine baseline (17 scenarios). PR #41 adds the three Advisor scenarios and is the current four-engine integration.


## Six-tier difficulty and engine readiness

Every registered scenario now has a difficulty tier. Existing scenarios that do not declare one remain compatible and default to `basic`.

| Tier | Weight | Validation focus |
| --- | ---: | --- |
| Basic | 1 | Known behavior, deterministic checks, essential controls |
| Intermediate | 2 | Input variations, normalization, malformed data, common boundaries |
| Advanced | 4 | Combined signals, state transitions, cross-feature behavior |
| Expert | 8 | Chained failures, false-positive resistance, recovery and invariants |
| Extreme | 16 | Adversarial combinations, concurrency, resource ceilings, degraded dependencies |
| Superextreme | 32 | Compound failure paths, long sequences, recovery invariants, strict disposable boundaries |

Use `lab.run({ difficulty: "advanced" })` to execute all registered scenarios from Basic through Advanced. Omitting the option runs every registered tier. Scenario selection by ID still works and is intersected with the chosen maximum tier.

The report adds:
- `difficulty`: selected ceiling and included levels.
- `assessment`: weighted score, execution coverage, covered/missing tiers, and a separate assessment for each target.
- `skipReason`: distinguishes a structural target-scope skip from an adapter that declined a test or a report-budget stop.

Weights increase exponentially so a missed high-difficulty case cannot be hidden by many easy passes. Structural target-scope skips are excluded from scoring. Adapter skips and report-budget skips remain visible, lower execution coverage, and prevent readiness. A target is ready only when every required tier has at least one applicable scenario and all such scenarios pass without skips. This is readiness for the registered scenario set only, not proof that an engine is free of defects.

### Initial coverage map


The integration suites still run independently so a failure remains attributable to its owning target/profile. The certification workflow now persists each original Threat Lab v2 report and then builds one unified report using `jb.threat-lab.unified-certification-report/v1`. The aggregator preserves every source outcome, records its source report, validates stable target kind/version, rejects duplicate target/scenario pairs, lists missing required targets, and computes six-tier readiness across the combined evidence. Structural target-scope skips remain visible but do not count as failed tests; adapter/report-budget skips and failures block readiness. A single-green source suite cannot conceal a missing engine or tier in the consolidated result.

The unified report is emitted for each OS/Node matrix lane and retained as a 30-day workflow artifact. Its required target set is the four JB engines (Malware Engine, Security Guard, Expert QA and Advisor Engine), plus the Malware-focused Trojan/PE integration suites. NEXORA Catalog and Site Engine profiles are validated separately by the dedicated NEXORA product workflow because their repositories are not mounted in the monorepo runner; they are not treated as missing or passed by this four-engine report. Each report still certifies only the named, safe scenarios that actually ran; it is not a production security certification.
The first classification of existing scenarios currently gives these per-engine tier footprints:

| Engine | Covered tiers | Current gaps |
| --- | --- | --- |
| JB Malware Engine | Basic, Intermediate, Advanced, Expert, Extreme, Superextreme | Expand scenario depth within each tier |
| JB Security Guard | Basic, Intermediate, Advanced, Expert, Extreme, Superextreme | Expand protocol-chain and bounded-state depth |
| JB Expert QA | Basic, Intermediate, Advanced, Expert, Extreme, Superextreme | Expand compound-analysis and recovery depth |
| JB Advisor Engine | Basic, Intermediate, Advanced, Expert, Extreme, Superextreme | Expand evidence and candidate-capacity depth |

A missing tier is an explicit testing gap, not a pass. Each four-engine footprint now has at least one real engine-backed scenario in its independent local test suite; this indicates tier presence only, not comprehensive product coverage or absence of defects. Keep all fixtures inert, bounded, local, and non-destructive; do not execute samples or send traffic to production services.


## NEXORA product adapters

Threat Lab has two independent, immutable NEXORA product targets:

- **Configurable Catalog:** `JASBH121101/Nexora@63f0608d0b00d633b1ad147ab2318fc099b8a99e`. Six tiers exercise sample data, setup/templates, localStorage/escaping, responsive admin, full demo regression and explicit prototype-only boundaries. It is not real authentication or server persistence.
- **Laravel Site Engine:** `JASBH121101/Nexora@afa0572d35f94b5c02a40d75001a2b2acd7f8b66`, proposed PR #14 stacked on PR #13. Ten scenarios across six tiers exercise installation, public catalogue, permissions, currency precision, locale/country catalogues, exports, private images, MFA/TOTP, domain/TLS fake-adapter boundaries and the full Laravel suite.

The official runner is `tests/nexora-profiles.integration.test.js`, invoked by `.github/workflows/nexora-product-certification.yml`. It verifies each checked-out Git HEAD against the exact SHA before running; missing checkouts fail in the dedicated workflow rather than being silently skipped.

Targeted Site Engine scenarios use in-memory SQLite. The dedicated workflow also runs the full Laravel Feature and Unit suite against ephemeral PostgreSQL 16. Domain/TLS tests use deterministic fakes. Child processes receive an allow-listed test environment without CI credentials. Separate JSON reports are uploaded for each product.

Readiness applies only to the registered scenarios at the exact pinned revision. The Catalog remains a frontend prototype; the Site Engine pin is an open draft change, not a merged release. This integration does not merge Nexora source, publish, deploy or certify production operation.
