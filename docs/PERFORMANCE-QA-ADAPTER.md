# Performance QA Engine Adapter — Phase 4 Block 9

## Purpose

Expose the canonical JB Expert QA performance specialist through the versioned engine registry and policy-bounded orchestrator. This adapter does not implement parallel performance rules.

## Canonical coverage

The adapter runs the existing `performance` specialist in `auditUrl`:

- `performance.large-transfer`: resource transfers at or above the configured byte threshold.
- `performance.slow-resource`: resource durations at or above the configured millisecond threshold.
- `performance.image-dimensions`: visible images without reserved width and height.
- `performance.large-dom`: DOM node counts above the configured threshold.

The adapter does not claim Lighthouse, field Core Web Vitals, synthetic network throttling, route crawling, or concurrency/load-test coverage.

## Execution contract

`registerPerformanceQaEngine(registry)` registers metadata only and does not navigate or contact a target. Invocations accept only `{ url, timeout? }` and an optional `AbortSignal` as the execution option. HTTP(S) URLs are required; embedded credentials, unsupported fields and timeouts outside 1,000–30,000 ms are rejected.

The adapter invokes the canonical Playwright audit with the performance specialist only. It uses a fresh headless browser context, does not authenticate, does not explore interactions, does not run axe-core, and does not capture screenshots or update visual baselines. Private/reserved destinations remain blocked by the canonical URL safety guard. Public third-party resources are observed because restricting the run to same-origin traffic would omit relevant transfer and loading data.

## Bounded, privacy-safe output

The returned report is a summarized view of the canonical audit. It caps findings at 30, strips target URLs, resource names, selectors and raw evidence objects, and retains only allowlisted numerical performance metrics. Diagnostic text is passed through the repository's sensitive-text redactor.

A pre-aborted `AbortSignal` prevents browser startup; the current canonical auditor does not expose mid-run cancellation through this adapter. The report explicitly marks the assessment inconclusive when the canonical specialist scope, execution evidence, DNS revalidation evidence or rule execution is incomplete. DNS is revalidated for intercepted HTTP requests; Chromium connection-time DNS is not pinned by the current browser adapter.

## Orchestration

The adapter is registered with `createQaEngineRegistry()`. When connected to `createQaEngineOrchestrator()`, execution remains high-risk by default and requires the exact engine action policy, the `qa:engine-execute` permission and an external approval receipt. Construction and registration do not execute audits.

## Verification

Focused tests:

```bash
node --test tests/performance-qa-adapter.test.js
```

Package validation:

```bash
node scripts/build-expert-qa-package.js
node --test packages/expert-qa/package-tests/complete-engine.spec.js
```
