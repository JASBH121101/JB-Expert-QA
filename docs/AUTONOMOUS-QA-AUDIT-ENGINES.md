# JB Expert QA — Autonomous QA Audit Engines (Block 3)

## Purpose

Block 3 exposes the existing audit capabilities through one stable adapter registry. It deliberately reuses the canonical auditors instead of maintaining parallel implementations.

## Built-in adapters

| ID | Target | Implementation |
| --- | --- | --- |
| `static` | Local project path | Static project, dependency-manifest, dead-code and language audit |
| `live-site` | Website URL | Playwright runtime audit, HTTP/network observations, forms, UI and accessibility context |
| `responsive` | Website URL | Configurable mobile, tablet and desktop viewport matrix |
| `accessibility` | Website URL | Accessibility specialist plus axe-core browser checks |
| `performance` | Website URL | Browser resource, image and DOM performance specialist |
| `security` | Local path or website URL | Static project security or runtime website security audit |
| `visual` | Website URL | Visual/layout viewport audit, with optional PNG baseline comparison |

API contract testing is not advertised as a separate engine in this block: the current repository does not yet have a dedicated API assertion runner. Live-site auditing does collect HTTP status and failed-request evidence, but that is not equivalent to schema/contract testing.

## API

```js
import { createAuditEngineRegistry } from "@jb/expert-qa";

const qa = createAuditEngineRegistry();

const staticReport = await qa.run("static", { path: "./" });
const liveReport = await qa.run("live-site", { url: "https://example.com" });
const responsiveReport = await qa.run("responsive", { url: "https://example.com" });
const accessibilityReport = await qa.run("accessibility", { url: "https://example.com" });
const performanceReport = await qa.run("performance", { url: "https://example.com" });
const securityReport = await qa.run("security", { path: "./" });
```

Use `qa.list()` to inspect supported adapters and `qa.get(id)` to retrieve immutable metadata. Each `run` returns the underlying auditor's native report shape.

The `visual` adapter uses `auditViewports`. Supply both `screenshotDir` and `baselineDir` in options to compare captured PNGs against approved baselines. Baseline updates are a separate explicit operation through `updateBaselines: true`; do not enable that flag in routine certification runs.

## Safety boundaries

- Static targets are read-only project audits. Dependency advisory lookups remain disabled unless explicitly enabled in the existing auditor configuration.
- Website targets continue through the existing URL safety guard. Private-network access remains disabled by default.
- Security targets require exactly one of `path` or `url`.
- Browser exploration remains bounded by the underlying Playwright auditor configuration.
- The registry does not install dependencies, patch source files, run shell commands, push Git refs, deploy or mutate production services.
- Adapter overrides are an advanced host-integration/testing seam. Only inject trusted, independently validated handlers.

## Verification

Run focused tests:

```bash
node --test tests/audit-engines.test.js
```

Run the standard certification profile:

```bash
npm run qa:local
```

The full Node.js regression matrix, package distribution checks and cross-engine integration checks remain part of pull-request certification.
