# JB API Testing Engine

Dependency-free API testing package for explicitly authorized HTTP and HTTPS targets. Phase 3 Blocks 1–3 provide bounded request execution, response assertions and versioned API contract validation. Security probes, request chaining and regression history remain separate follow-up blocks.

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
