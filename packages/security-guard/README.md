# @jb/security-guard

Runtime HTTP request protection middleware for Node.js applications (Node.js 22+).

## Install

The package is part of the JB Expert QA monorepo and is exposed as an npm workspace:

~~~bash
npm install
~~~

After it is published as a standalone package, an application will be able to install the published package using its registry package name. It is not published yet.

## Use with Express-compatible middleware

~~~js
import express from "express";
import { createSecurityGuard } from "@jb/security-guard";

const app = express();
const guard = createSecurityGuard({
  mode: process.env.JB_GUARD_MODE ?? "monitor",
  onEvent(event) {
    // Send the sanitized event to your approved application logger.
    console.warn("[JB Security Guard]", event);
  }
});

// Register before body parsers and application routes.
app.use(guard.middleware);
~~~

The returned object also exposes `getStats()` and `reset()`.

## Modes

- `monitor`: detect and emit sanitized events without blocking.
- `balanced`: block high- and critical-severity detections.
- `strict`: block all configured severities, including medium.
- `custom`: use the supplied `blockSeverities` list.

The default mode is `monitor` to reduce deployment risk. Blocking is opt-in.

## Initial protections

- High-confidence request-target signatures for common XSS, SQL injection, and path-traversal patterns.
- Request-target length and malformed-target checks.
- Header count and byte limits.
- Content-Length limit before body parsing.
- Per-process, in-memory request rate limiting.
- Sanitized incident events without query strings, header values, cookies, request bodies, or client IP addresses by default.

## Important deployment notes

- Register the middleware before body parsers and application routes.
- This first version does not read or inspect request bodies. Enforce streamed/chunked body limits in the framework/server body parser as well.
- The rate limiter is local to one Node.js process. Multi-instance deployments need a shared atomic store (for example Redis) before treating limits as global.
- Forwarded IP headers are not trusted by default. Supply a `keyGenerator` only when the application has a narrowly configured trusted-proxy chain.
- Signature detection is heuristic and can produce false positives or miss novel attacks. It is not a replacement for parameterized database queries, output encoding, authorization checks, a WAF, or a controlled security assessment.
- Do not expose Guard as a client-side browser script. It must run on the server.
- Monitor mode is recommended for baseline observation before enabling blocking.
