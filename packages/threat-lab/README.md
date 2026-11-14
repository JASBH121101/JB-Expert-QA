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

The first local integration suite now exercises all three advanced JB engines together: Malware Engine (EICAR, benign false-positive, inert suspicious-script classification), Security Guard (synthetic XSS blocking, malicious upload rejection through the Malware Engine adapter, and no-match quarantine), and Expert QA (unsafe HTML sink detection followed by a repaired textContent regression check). These tests use temporary directories, synthetic inputs, and in-memory upload storage. A green lab run only certifies the scenarios that actually ran; it does not prove absence of malware, vulnerabilities, or defects. Static file triage is not dynamic malware behavior analysis and cannot claim detection of every trojan, virus, ransomware family, spyware, or worm.

## Bounded execution and report contract

The orchestration core rejects duplicate matrix selections and bounds work to 50 registered targets, 100 registered scenarios, and 2,500 target-scenario executions per run. Each run's metadata is limited to 16 KiB. Adapter responses are limited to 64 KiB overall, 100 findings (48 KiB), and 50 metric keys (16 KiB); cumulative adapter outcome payloads are capped at 2 MiB per report. When the total report budget is reached, the lab records a failed budget diagnostic and skips remaining adapter calls. Scenario tags, target capabilities, and target-scoping lists are also bounded. Invalid or oversized adapter output is recorded as a controlled failed scenario instead of being treated as a pass.

These limits protect report generation from unexpectedly large or malformed adapter payloads. They do not make untrusted adapter code safe; adapters must still be reviewed and run in an appropriate isolated environment.

## Development

```bash
npm test
```

Node.js 22 or newer. No cloud services, paid APIs, telemetry, external malware feeds, or sample uploads are required.
