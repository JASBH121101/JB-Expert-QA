# @jb/expert-qa

Complete local-first quality assurance for web projects: static code and project checks, browser-based URL audits, responsive and interaction exploration, accessibility checks, visual regression, security review, and optional AI-assisted remediation.

## Install

```bash
npm install --save-dev @jb/expert-qa
```

Node.js 22 or newer is required. The package is independently installable and does not require JB Security Guard or JB Malware Engine.

## QA Control Center — local dashboard

Start the local control panel from the project root with `npm run dashboard`, or run `npx jb-qa-dashboard` from an independently installed package. The server prints a loopback URL such as `http://127.0.0.1:4173`; open that address in your browser and keep the terminal running. It binds only to `127.0.0.1`, rejects cross-origin actions, and does not expose a remote dashboard service.

The Control Center runs the seven registered audit engines sequentially, stores compact local history and finding comparisons under `.jb-expert-qa/dashboard/`, and generates individual Markdown reports. Its QA Intelligence panel aggregates the latest snapshot per engine/target, ranks retained findings by severity, summarizes engine coverage and displays recent score trends. Download the consolidated Markdown report for a bounded-history rollup. Visual QA stores its viewport screenshots in the same local area. These records can include project and website metadata; protect the directory and do not commit it. The consolidated assessment is scoped to saved records, not a universal project or third-party certification.

Use a project-relative or absolute directory for Static QA. The path is resolved by the machine running the dashboard, not by the browser device. Website audits continue to enforce the existing URL safety policy. Install Chromium once with `npx jb-qa setup --browser chromium` before running browser-based checks.

## First run: static project audit

```bash
npx jb-qa init
npx jb-qa audit
```

The default report is HTML under `.jb-expert-qa/reports/`. Choose JSON or Markdown explicitly:

```bash
npx jb-qa audit . --format json --output .jb-expert-qa/report.json
npx jb-qa audit ./src --format markdown --output .jb-expert-qa/report.md
```

## Browser, responsive and accessibility audit

Install Chromium once on the machine or CI runner:

```bash
npx jb-qa setup --browser chromium
```

Start your application locally, then audit it:

```bash
npx jb-qa-url http://localhost:5173
npx jb-qa-url http://localhost:5173 --matrix
```

The browser auditor can capture screenshots, inspect accessibility findings with axe-core, explore a bounded set of safe interactive states, and compare PNG screenshots. It blocks service workers and applies URL safety checks. For local development targets, explicitly configure the local/private-network allowance in the API or approved CLI configuration; do not disable URL safety checks for untrusted targets.

## Additional commands

| Command | Purpose |
| --- | --- |
| `jb-qa-project [path]` | Static project audit |
| `jb-qa-url <url> --matrix` | Browser and viewport audit |
| `jb-qa-security [path]` | Focused static security audit |
| `jb-qa-security-url <url>` | Runtime website security audit |
| `jb-qa-autopilot [path]` | AI-assisted analysis and optional remediation |
| `@jb/expert-qa/autonomous-execution` | Policy-bounded action orchestration with approval gates and audit ledger |
| `jb-qa-db [path]` | Focused database schema, migration, ORM, query-safety and performance audit |

AI features are opt-in. The autopilot does not apply patches by default. Applying low-risk changes requires the explicit approval flags enforced by the CLI; review diffs and run project tests before accepting any change. Source upload to an AI provider is a separate explicit opt-in.

## JavaScript API

```js
import { auditProject, auditDatabaseProject, auditUrl, auditViewports, comparePngBuffers, createAuditEngineRegistry } from "@jb/expert-qa";

const staticReport = await auditProject("./");
const databaseReport = await auditDatabaseProject("./");
const browserReport = await auditUrl("https://example.com");
const responsiveReport = await auditViewports("https://example.com");

// Or use the unified adapters:
const qa = createAuditEngineRegistry();
const unifiedStaticReport = await qa.run("static", { path: "./" });
const liveSiteReport = await qa.run("live-site", { url: "https://example.com" });
// comparePngBuffers(baselineBuffer, actualBuffer) returns a structured visual diff.
```

The root export also exposes specialist rule groups, provider adapters, visual review, remediation planning, autopilot controls, the autonomous execution engine, the audit-engine registry, the local QA Control Center server and the security-bridge contracts. Optional subpath exports are available for `./browser`, `./visual`, `./ai`, `./autopilot`, `./autonomous-execution`, `./security-bridge`, `./version`, `./audit-engines`, `./dashboard`, `./containment-capability-detection`, `./containment-policy`, `./containment-controller-dispatch`, `./contained-process-runner`, `./linux-cgroup-v2-resource-controller`, and `./windows-job-object-resource-controller`.

### Policy-bounded execution

The autonomous execution engine has no built-in shell, deployment or production actions. Callers register trusted handlers explicitly, then allowlist their action types, preauthorize required permissions, constrain resource scopes and configure risk and time limits. Medium- and high-risk actions require a separate approval callback. Use a JSONL audit ledger when durable local traceability is required; keep its directory protected by the host OS.


## OS resource containment for isolated engines

The optional contained process-runner factory connects the isolated Node.js child process to the host's native resource controller:

- Linux uses a host-prepared, delegated cgroup v2 subtree with CPU, memory and process-count limits.
- Windows uses a native Job Object with memory, CPU-rate and process-tree controls.
- Capability checks and policy selection happen inside the JB Expert QA runtime. GitHub Actions is used for validation and delivery, not as the execution host.
- Uncontained fallback is disabled by default. Enable it only when the host policy explicitly permits reduced isolation, and inspect `getStatus().containmentDispatcher.enforced` before treating a run as contained.

On Linux, prepare and delegate a cgroup v2 child directory on the host and pass its absolute path as `cgroupRoot`. The library does not mount cgroupfs, enable parent controllers, invoke sudo or change host-wide limits. Windows does not require `cgroupRoot`.

```js
import { resolve } from "node:path";
import { createContainedLocalProcessEngineRunner } from "@jb/expert-qa/contained-process-runner";

const containment = {
  policy: {
    required: true,
    memoryLimit: "512MiB",
    cpuLimit: 50,
    processLimit: 32
  },
  ...(process.platform === "linux"
    ? { cgroupRoot: process.env.JBQA_CGROUP_ROOT }
    : {})
};

const runner = createContainedLocalProcessEngineRunner({
  runner: {
    engineId: "example.engine",
    moduleRoot: resolve("./engines"),
    modulePath: resolve("./engines/example.mjs")
  },
  containment
});

try {
  const result = await runner.run({ task: "audit" });
  console.log(result);
} finally {
  await runner.close();
}
```

Use `@jb/expert-qa/containment-controller-dispatch` when a host needs direct control of the policy/capability dispatcher. The separate `@jb/expert-qa/containment-policy`, `@jb/expert-qa/containment-capability-detection`, `@jb/expert-qa/linux-cgroup-v2-resource-controller` and `@jb/expert-qa/windows-job-object-resource-controller` subpaths expose the lower-level building blocks.

Resource containment limits execution resources and terminates the child process tree; it is not a filesystem or network sandbox. The child retains the OS identity and filesystem/network permissions of the host process. Keep module paths and cgroup delegation host-controlled.

## Privacy and execution boundaries

- Static audits read supported local project files; they do not execute the audited application.
- Browser audits navigate only to the requested target and enforce URL safety controls. Use only targets you own or are authorized to assess.
- Dependency advisory lookups are disabled by default. Enabling them may send package names and exact versions to the advisory service; source files and credentials are not sent for that lookup.
- AI calls are not made by default. Provider selection and source-sharing permissions must be configured explicitly.
- Reports should be treated as security-sensitive project metadata even though source contents and detected credential values are redacted.

## Limitations

Findings are heuristic and can include false positives or miss issues. A passing score is not a security certification. Browser exploration is bounded and does not prove every application state is correct. AI-generated remediation is untrusted until reviewed and tested.

JB Expert QA is a development/CI quality tool, not runtime middleware. Use JB Security Guard for server-side request controls and a separately validated malware scanner for file inspection.

## Database Auditor

```bash
npx jb-qa-db . --format=html
npx jb-qa-db ./ --format=json --output=.jb-expert-qa/reports/database.json
```

The focused auditor checks SQL and Prisma schema/migration files plus source and configuration files for destructive DDL, unsafe raw queries, ORM auto-sync, disabled database TLS verification, selected SQL performance patterns, PostgreSQL privilege issues, missing foreign-key indexes and visible migration rollback gaps. It is local and static: it does not connect to a live database, read rows, execute queries, run EXPLAIN, modify schemas or make network requests. Findings are heuristic and require human review.


## Performance QA Engine Adapter

The standalone package exports the canonical performance-specialist adapter from `@jb/expert-qa/performance-qa-adapter` and the root API. Use `registerPerformanceQaEngine(registry)` to add it to a QA engine registry. It measures large resource transfers, slow resources, image dimension reservation and large DOM trees using the existing Playwright specialist. The adapter uses public HTTP(S) targets, bounded execution and a sanitized report; it does not perform authenticated, interaction, screenshot, Lighthouse, field Core Web Vitals or load/stress testing. See [Performance QA Adapter](../../docs/PERFORMANCE-QA-ADAPTER.md).


## Visual QA Engine Adapter

The standalone package exports the canonical visual/layout adapter from `@jb/expert-qa/visual-qa-adapter` and the root API. Register it with `registerVisualQaEngine(registry)`. The adapter supports the canonical three-viewport or nine-viewport matrix and light/dark themes, with optional read-only PNG baseline comparison. Screenshots are temporary, baselines are never modified, and AI screenshot review is not invoked. The report is bounded and omits target, selector and artifact paths. See [Visual QA Adapter](../../docs/VISUAL-QA-ADAPTER.md).


## Report & Certification Engine Adapter

The standalone package exports the scope-aware report and certification adapter from `@jb/expert-qa/report-certification-adapter` and the root API. Register it with `registerReportCertificationEngine(registry)` and provide bounded dashboard history to generate JSON, Markdown or HTML artifacts plus a SHA-256 checkpoint. Assessment states preserve `NOT_ASSESSED`, `NOT_PASSED`, `REVIEW_REQUIRED`, `OBSERVATIONS` and `PASSED_WITHIN_RECORDED_SCOPE`. This adapter does not rerun audits, write files, or average scores across engines. See [Report & Certification Adapter](../../docs/REPORT-CERTIFICATION-ADAPTER.md).


## Policy-Gated Phase 4 Dashboard Execution

The package exports `createDashboardPhase4Catalog` and `createDashboardPhase4Execution`. The Dashboard execution bridge is disabled unless the host supplies a sealed engine registry, an exact high-risk allowlist policy with `qa:engine-execute`, and a real external `requestApproval` provider. The browser cannot submit or override policy, permissions, risk, action IDs or approval receipts. See [Phase 4 Block 13 — Policy-Gated Dashboard Execution](../../docs/PHASE4-BLOCK13-POLICY-GATED-EXECUTION.md).

## Phase 4 Execution Audit & Evidence

The policy-gated Dashboard bridge exposes `getAuditTrail({ limit, beforeSequence })` and the local Dashboard serves the read-only `GET /api/phase4/audit` endpoint. Audit records are explicitly projected: event identifiers, timestamps, policy/action metadata, SHA-256 input/output/scope digests and hash-chain links are retained, while raw inputs, outputs, approval receipts and secrets are excluded. Results are paginated (1–100 records), and the chain verification status is reported independently of the page. See [Phase 4 Block 14 — Execution Audit & Evidence](../../docs/PHASE4-BLOCK14-EXECUTION-AUDIT-EVIDENCE.md).
