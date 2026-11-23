# JB Expert QA — API Testing Engine Adapter (Phase 4, Block 2)

## Purpose

This block connects the existing seven-module API Testing Engine to the central `jb.qa-engine-adapter/v1` registry. It does not duplicate request, assertion, contract, passive-security, workflow, regression or rate-limit implementations.

The adapter registers as `jb.api-testing-engine`, category `api`, target type `payload`, execution mode `in-process`. Its capabilities are `api-request`, `assertions`, `contracts`, `passive-security`, `workflows`, `regression` and `rate-limit-observation`.

## Registration

```js
import { createQaEngineRegistry, registerApiTestingEngine } from "@jb/expert-qa";

const registry = createQaEngineRegistry();
registerApiTestingEngine(registry, {
  allowedOrigins: ["https://api.example.com"]
});
registry.seal();
```

Registration is metadata-only. It does not send network requests. The host must configure an explicit HTTP(S) origin allowlist; the Request Engine retains its redirect, timeout, request-size, response-size and credential-redaction controls.

## Supported operations

| Operation | Delegated module |
| --- | --- |
| `request` | API Request Engine |
| `assertions` | Assertions & Validation Engine |
| `contract` | API Contract Testing Engine |
| `security` | Passive API Security Testing Engine |
| `workflow` | API Workflow Testing Engine |
| `regression-baseline` | Explicit regression baseline creation |
| `regression-compare` | Regression comparison |
| `rate-limit` | Bounded rate-limit observation |

The runner is discovered through `registry.getRunner("jb.api-testing-engine")`. Each operation delegates to the canonical package module and retains its native validation and report semantics.

## Security boundaries

- No work is performed until the runner is explicitly invoked.
- The Request Engine requires an exact configured origin allowlist.
- The adapter does not bypass bounded request settings or redirect policy.
- Workflow operations remain declarative and sequential; no JavaScript or shell is evaluated.
- Passive security analyzes an existing response and performs no exploitation.
- Regression baselines are created only by an explicit operation and are never overwritten automatically.
- Rate-limit activity is disabled unless the host explicitly sets `activeRateLimitTesting: true`; probes still require an allowlisted origin and bounded sequential read-only requests.
- AbortSignal is accepted only by request, workflow and rate-limit operations.
- Registration and discovery never invoke the runner.

## Standalone distribution

The Expert QA package build copies the canonical API Testing Engine source into its own package tree. The adapter therefore works in the independently built `@jb/expert-qa` artifact without a private workspace dependency or runtime download.

## Verification

```sh
node --test tests/api-testing-adapter.test.js
npm --workspace @jb/api-testing-engine run check
```

The PR also runs full Core Validation, package distribution, security, engine integration and cross-platform certification. Merge is permitted only when every required check succeeds.
