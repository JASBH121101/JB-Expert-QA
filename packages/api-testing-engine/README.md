# JB API Testing Engine

Dependency-free API request engine for explicitly authorized HTTP and HTTPS targets. This is Phase 3, Block 1: request execution only. Assertions, OpenAPI contract validation, security probes, request chaining and regression history are separate follow-up blocks.

## Requirements

- Node.js 22 or newer.
- No runtime dependencies.

## Quick start

\`\`\`js
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
\`\`\`

Only exact HTTP(S) origins configured through \`allowedOrigins\` can be called. URL credentials and fragments are rejected. Redirects are returned, not followed automatically. Cookies are not persisted or sent implicitly.

## Request shape

Supported methods: GET, HEAD, OPTIONS, POST, PUT, PATCH and DELETE.

- \`headers\`: plain object of string header values.
- \`json\`: JSON-compatible value serialized as UTF-8 JSON.
- \`body\`: plain text request body; cannot be combined with \`json\`.
- \`timeoutMs\`: per-request timeout, up to 30 seconds.
- \`maxResponseBytes\`: response-body limit, up to 5 MiB.

GET and HEAD cannot contain a body. Transport/framing headers such as \`Host\`, \`Content-Length\` and \`Transfer-Encoding\` are rejected. Request bodies are limited to 1 MiB by default. Response bodies are limited to 2 MiB by default. The engine accepts an external \`AbortSignal\`.

The response includes HTTP status, duration, response headers, body text, response byte count and parsed JSON when the server declares a JSON content type. Sensitive response-header values and sensitive query-parameter values are redacted in returned metadata. The response body itself is preserved for programmatic assertions; consumers must avoid publishing it when it contains secrets.

## Run checks

\`\`\`sh
npm --workspace @jb/api-testing-engine run check
npm run test:api-testing
\`\`\`

Tests use ephemeral loopback HTTP servers and do not call production APIs. This block does not discover endpoints, validate API contracts, assert business rules, scan for vulnerabilities, or chain requests.
