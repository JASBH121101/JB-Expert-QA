# @jb/threat-lab

An extensible, local-first test laboratory for JB engines and independent applications. It is an orchestration harness, not a protection engine, malware sandbox, antivirus, or production monitor.

## Design

Targets register through a small adapter contract: `runScenario({ scenario, context })`. A target can be a security engine, QA engine, ERP, catalog, API, or any future application. Scenarios are reusable test definitions. The lab produces a versioned JSON report with pass/fail/skip outcomes, findings, metrics, and durations.

The lab does not import or couple itself to a particular JB product. Integrations belong in separate adapters, so adding a future engine or a customer application does not require changing the lab core.

## Safety boundary

A scenario is accepted only when it explicitly declares `safe: true`, `network: false`, and `destructive: false`. Sample execution is prohibited. Adapters must use disposable test data, local fixtures, mocks, and explicitly authorized test environments. The lab itself never opens network connections, executes submitted samples, mutates target source, changes production data, or deploys anything.

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

These are integration profiles to be implemented separately. A green lab run only certifies the scenarios that actually ran; it does not prove absence of malware, vulnerabilities, or defects. Static file triage is not dynamic malware behavior analysis and cannot claim detection of every trojan, virus, ransomware family, spyware, or worm.

## Development

```bash
npm test
```

Node.js 22 or newer. No cloud services, paid APIs, telemetry, external malware feeds, or sample uploads are required.
