# JB API Testing Engine

Dependency-free API testing package for explicitly authorized HTTP and HTTPS targets. Phase 3 Blocks 1–6 provide bounded request execution, assertions, versioned API contracts, passive security checks, sequential workflows and deterministic regression comparison.

## Requirements

- Node.js 22 or newer.
- No runtime dependencies.

## Quick start

```js
import { createApiRequestEngine } from "@jb/api-testing-engine";

const api = createApiRequestEngine({
  allowedOrigins: ["https://api.example.com"]
});

const result = await api.request({
  method: "GET",
  url: "https://api.example.com/v1/health",
  headers: {
    authorization: "Bearer YOUR_TEST_TOKEN"
  }
});

console.log(result.status, result.json);
```

Only exact HTTP(S) origins configured through `allowedOrigins` can be called. URL credentials and fragments are rejected. Redirects are returned, not followed automatically. Cookies are not persisted or sent implicitly.

## Request shape

Supported methods: GET, HEAD, OPTIONS, POST, PUT, PATCH and DELETE.

- `headers`: plain object of string header values.
- `json`: JSON-compatible value serialized as UTF-8 JSON.
- `body`: plain text request body; cannot be combined with `json`.
- `timeoutMs`: per-request timeout, up to 30 seconds.
- `maxResponseBytes`: response-body limit, up to 5 MiB.

GET and HEAD cannot contain a body. Transport/framing headers such as `Host`, `Content-Length` and `Transfer-Encoding` are rejected. Request bodies are limited to 1 MiB by default. Response bodies are limited to 2 MiB by default. The engine accepts an external `AbortSignal`.

The response includes HTTP status, duration, response headers, body text, response byte count and parsed JSON when the server declares a JSON content type. Sensitive response-header values and sensitive query-parameter values are redacted in returned metadata. The response body itself is preserved for programmatic assertions; consumers must avoid publishing it when it contains secrets.

## Run checks

```sh
npm --workspace @jb/api-testing-engine run check
npm run test:api-testing
```

Tests use ephemeral loopback HTTP servers and do not call production APIs. This block does not discover endpoints, validate API contracts, assert business rules, scan for vulnerabilities, or chain requests.


## Phase 3 — Block 2: Assertions & Validation Engine

The assertions engine evaluates an existing response object from the Request Engine. It does not make network requests.

```js
import { createApiRequestEngine, createApiAssertionsEngine } from "@jb/api-testing-engine";

const api = createApiRequestEngine({ allowedOrigins: ["https://api.example.com"] });
const response = await api.request({ method: "GET", url: "https://api.example.com/v1/users/7" });
const assertions = createApiAssertionsEngine();
const report = assertions.evaluate(response, [
  { type: "status", expected: 200 },
  { type: "json", path: "$.data.id", expected: 7 },
  { type: "type", path: "$.data.active", expected: "boolean" },
  { type: "number", path: "$.data.score", operator: "greaterThanOrEqual", expected: 0 },
  { type: "arrayLength", path: "$.data.roles", operator: "greaterThan", expected: 0 }
]);
console.log(report.passed, report.passRate, report.results);
```

Supported assertion types: `status`, `statusRange`, `header`, `json`, `text`, `contains`, `type`, `exists`, `number`, `arrayLength`, and `regex`. JSON paths support safe object properties and numeric array indexes (for example `$.data.items[0]`). No eval or dynamic code execution is used. Assertions are capped at 1000 per evaluation. Use `stopOnFailure: true` to short-circuit.

Reports include individual PASS/FAIL results, actual/expected values, counts, pass rate, and a global verdict. Contract/schema validation and security probes remain separate future blocks.


## Phase 3 — Block 3: API Contract Testing Engine

The contract engine compiles a local, versioned jb.api-contract/v1 document and validates an existing Request Engine response. It does not make network requests, fetch remote schemas or execute dynamic code.

~~~js
import {
  createApiRequestEngine,
  createApiContractTestingEngine
} from "@jb/api-testing-engine";

const api = createApiRequestEngine({
  allowedOrigins: ["https://api.example.com"]
});
const response = await api.request({
  method: "GET",
  url: "https://api.example.com/v1/users/42"
});

const contracts = createApiContractTestingEngine();
const compiled = contracts.compile({
  schema: "jb.api-contract/v1",
  contractId: "users-api",
  version: "1.0.0",
  operations: [{
    operationId: "getUser",
    method: "GET",
    path: "/v1/users/{userId}",
    responses: {
      "200": {
        headers: {
          "content-type": { contains: "application/json" }
        },
        body: {
          type: "object",
          required: ["data"],
          additionalProperties: false,
          properties: {
            data: {
              type: "object",
              required: ["id", "name"],
              properties: {
                id: { type: "integer", minimum: 1 },
                name: { type: "string", minLength: 1 }
              }
            }
          }
        }
      }
    }
  }]
});

const report = compiled.validate(response, { operationId: "getUser" });
console.log(report.passed, report.passRate, report.results);
~~~

A contract declares unique operations by operationId, uppercase HTTP method, path template and status-specific response cases (or default). Each response case may define header rules and a JSON body schema.

The supported JSON schema subset includes type, required, properties, additionalProperties, items, enum, const, string length limits, numeric bounds, array length limits and object property-count limits. Remote references, regex patterns, unknown keywords and unknown contract fields are rejected rather than ignored. Schema depth and node count, contract operations, response cases and result counts are bounded.

Reports include method/path checks, declared-status checks, header checks and body-schema failures with stable error codes. Response string values are summarized rather than copied into the report. Compile once and reuse the compiled contract for multiple responses.

Run the contract and request test suite with:

~~~sh
npm --workspace @jb/api-testing-engine run check
npm run test:api-testing
~~~


## Phase 3 — Block 4: Passive API Security Testing Engine

The security engine inspects a response object already returned by the API Request Engine. It does not send requests, mutate remote state, replay credentials, follow redirects, exploit vulnerabilities or make network connections.

~~~js
import {
  createApiRequestEngine,
  createApiSecurityTestingEngine
} from "@jb/api-testing-engine";

const request = createApiRequestEngine({
  allowedOrigins: ["https://api.example.com"]
});
const response = await request.request({
  method: "GET",
  url: "https://api.example.com/v1/profile"
});

const security = createApiSecurityTestingEngine();
const report = security.analyze(response, {
  requestOrigin: "https://app.example.com",
  allowedCorsOrigins: ["https://app.example.com"],
  sensitiveResponse: true
});

console.log(report.status, report.failedCount, report.warningCount);
console.log(report.checks);
~~~

The passive checks cover HTTPS transport, HSTS, MIME sniffing protection, CORS origin policy, cache policy for explicitly marked sensitive responses, cookie Secure/HttpOnly/SameSite attributes, implementation-disclosure headers and populated credential-like JSON fields.

Policies are explicit and bounded. The requestOrigin and allowedCorsOrigins options require exact HTTP(S) origins. Local HTTP exceptions can be enabled only for localhost/loopback. Token fields such as access_token and refresh_token are reported as review warnings because they may be legitimate in authentication responses; populated password, private-key and credential-like fields are high-severity failures.

Reports never include raw cookie values, response header values or sensitive response strings. They include stable check IDs, severity, pass/warning/fail status, limited evidence and remediation guidance. The engine is heuristic and passive: a clean report is not proof that an API is secure, and checks requiring authentication context, authorization probing, rate-limit measurement, TLS handshake inspection or active fuzzing are out of scope for this block.

Run the API testing package suite with:

~~~sh
npm --workspace @jb/api-testing-engine run check
npm run test:api-testing
~~~


## Phase 3 — Block 5: API Workflow Testing Engine

The workflow engine executes a local, declarative sequence of API requests using an existing API Request Engine instance. Steps run sequentially. It does not evaluate JavaScript, execute shell commands, create arbitrary functions or send requests outside the Request Engine origin allowlist.

~~~js
import {
  createApiRequestEngine,
  createApiWorkflowTestingEngine
} from "@jb/api-testing-engine";

const requests = createApiRequestEngine({
  allowedOrigins: ["https://api.example.com"]
});
const workflows = createApiWorkflowTestingEngine({
  requestEngine: requests
});

const report = await workflows.run({
  schema: "jb.api-workflow/v1",
  workflowId: "users.login-and-profile",
  version: "1.0.0",
  stopOnFailure: true,
  steps: [
    {
      id: "login",
      request: {
        method: "POST",
        url: "https://api.example.com/login",
        json: { username: "demo" }
      },
      capture: {
        userId: "$.json.user.id"
      },
      assertions: [
        { type: "status", expected: 200 },
        { type: "exists", path: "$.access_token" }
      ]
    },
    {
      id: "profile",
      when: { stepId: "login", status: 200 },
      request: {
        method: "POST",
        url: "https://api.example.com/profile",
        json: { userId: { "$var": "userId" } }
      },
      assertions: [
        { type: "status", expected: 200 },
        { type: "exists", path: "$.data.id" }
      ]
    }
  ]
});

console.log(report.status, report.passRate, report.results);
~~~

A workflow uses jb.api-workflow/v1, a stable workflow ID, semantic version and 1–100 ordered steps. Each step defines an ID and an API Request Engine request. Optional capture maps private variable names to response paths. Later request values can use a reference object with a prior step ID and JSON path, or a variable object containing a previously captured variable name. References must point backward; forward references and unknown variables are rejected during compilation.

Optional when conditions support a prior step's HTTP status (one code or a bounded range) and a JSON response path with equals or exists. A condition runs only after its dependency passed. Steps are sequential; no parallel fan-out or implicit retries are performed. stopOnFailure defaults to true. Set it to false to continue independent steps after a failure. An AbortSignal can cancel an in-flight request and skip remaining steps.

The report contains step statuses, HTTP status, duration, received byte count, assertion summaries, capture names and sanitized error codes. It never includes complete response bodies or captured values. Captures and response data are cleared from the run context when the workflow finishes. String values that resemble templates remain literal; only the explicit reference and variable objects are resolved.

Run the complete API Testing Engine suite with:

~~~sh
npm --workspace @jb/api-testing-engine run check
npm run test:api-testing
~~~


## Phase 3 — Block 6: API Regression Engine

The regression engine compares an existing API Request Engine response with an explicitly captured, versioned baseline. It performs no network requests and does not overwrite baselines automatically.

```js
import {
  createApiRequestEngine,
  createApiRegressionEngine
} from "@jb/api-testing-engine";

const requests = createApiRequestEngine({
  allowedOrigins: ["https://api.example.com"]
});
const regression = createApiRegressionEngine();

const firstRun = await requests.request({
  method: "GET",
  url: "https://api.example.com/v1/users"
});

const baseline = regression.createBaseline(firstRun, {
  baselineId: "users-api-production",
  headerNames: ["content-type", "cache-control"],
  ignoredJsonPaths: ["$.meta.requestId", "$.meta.generatedAt"],
  valuePaths: ["$.data.total"]
});

// Persist the returned JSON baseline in the caller's approved storage.
// Reuse it in later runs; updating a baseline is always an explicit action.

const nextRun = await requests.request({
  method: "GET",
  url: "https://api.example.com/v1/users"
});

const report = regression.compare(baseline, nextRun, {
  maxLatencyIncreaseMs: 500,
  maxLatencyIncreasePercent: 100
});

console.log(report.status, report.failedCount, report.checks);
```

Baselines use the `jb.api-regression-baseline/v1` schema and are immutable. They contain a request identity digest, HTTP status, selected response-header fingerprints, JSON structure/type paths, optional selected-value SHA-256 fingerprints and response duration. Raw response bodies, selected JSON values, header values, URL query values and credentials are not copied into the baseline or report.

By default, only `content-type` is selected for header comparison. Configure `headerNames` to add safe headers; credential-bearing headers such as Authorization, Cookie, Set-Cookie and token-like headers are rejected. `ignoredJsonPaths` excludes volatile JSON subtrees from structural comparison. `valuePaths` enables exact comparisons for selected stable fields without storing their values; sensitive paths such as passwords, tokens, email addresses and phone numbers are rejected.

Latency checks are skipped unless `maxLatencyIncreaseMs` or `maxLatencyIncreasePercent` is explicitly configured. Exceeding either configured threshold is reported as a regression. The engine does not make a new baseline when a comparison fails, retry requests, or persist snapshots on the caller's behalf. Use `compile(baseline)` to validate and reuse a frozen baseline comparator.

Run the complete API Testing Engine suite with:

```sh
npm --workspace @jb/api-testing-engine run check
npm run test:api-testing
```
