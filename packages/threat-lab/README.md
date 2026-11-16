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


These tier footprints are an inventory across separate local test files. The current test runner executes those files independently; it does not yet merge their results into one cross-suite certification report. Each report certifies only the scenarios selected and executed in that individual run.
The first classification of existing scenarios currently gives these per-engine tier footprints:

| Engine | Covered tiers | Current gaps |
| --- | --- | --- |
| JB Malware Engine | Basic, Intermediate, Advanced, Expert, Extreme, Superextreme | Expand scenario depth within each tier |
| JB Security Guard | Basic, Intermediate, Advanced, Expert, Extreme, Superextreme | Expand protocol-chain and bounded-state depth |
| JB Expert QA | Basic, Intermediate, Advanced, Expert, Extreme, Superextreme | Expand compound-analysis and recovery depth |
| JB Advisor Engine | Basic, Intermediate, Advanced, Expert, Extreme, Superextreme | Expand evidence and candidate-capacity depth |

A missing tier is an explicit testing gap, not a pass. Each four-engine footprint now has at least one real engine-backed scenario in its independent local test suite; this indicates tier presence only, not comprehensive product coverage or absence of defects. Keep all fixtures inert, bounded, local, and non-destructive; do not execute samples or send traffic to production services.


## NEXORA profiles — separate certification targets

The NEXORA repository contains two distinct deliverables and they must not be collapsed into one Threat Lab target:

- **NEXORA Configurable Catalog (frontend/catalog studio):** the independently scoped configurable-catalog prototype, including editable business templates, catalog fields, product presentation, responsive behavior, and browser-side demo persistence. Its tests must treat localStorage/demo behavior as prototype-only and must not mistake it for real authentication, server persistence, or secure file upload.
- **NEXORA Site Engine (Laravel/PHP distributable):** the separate Laravel application and server-side engine. Its profile must validate installation and database setup, owner authentication, role/permission boundaries, product/category CRUD, public-site exposure, export generation, upload validation/storage, and package/deployment safety using disposable local databases and filesystem fixtures.

They are separate registered targets (nexora-configurable-catalog and nexora-site-engine) with independent adapters, scenario IDs, tier coverage, and readiness. A pass in one profile must never certify the other. The Site Engine profile must follow its documented product scope: do not invent ERP, inventory, POS, payment, or SaaS multi-tenant tests unless those capabilities are explicitly brought into scope. The catalog prototype must not be certified as if it already had the Laravel backend.

**Integration status:** these two profiles are now explicitly tracked as separate targets in the Threat Lab test registry and coverage plan. Product-level adapter execution remains pending; placeholder/registry tests do not count as NEXORA security certification. All integration tests remain local, disposable, offline, non-destructive, and non-executing.


## NEXORA product integration

The laboratory now has a dedicated real-product integration test at `tests/nexora-integration.test.js`. It executes the Configurable Catalog demo and Laravel setup tests, and the Site Engine's public-site, permission, export, domain/DNS/TLS and full-regression tests against separate pinned NEXORA checkouts. The two target assessments remain independent; Configurable Catalog coverage currently stops at Advanced, while Site Engine has registered scenarios across all six tiers. The Core Validation job provisions only temporary SQLite test environments and fake DNS/TLS adapters.
