# Node.js HTTP server hardening

`configureNodeHttpServer(server, options)` must run before `server.listen()` and before the application begins accepting traffic.

## Controls

- Header parsing timeout, total request-receive timeout, keep-alive timeout and socket inactivity timeout. Guard explicitly destroys sockets when the inactivity timeout fires, including when the host application has registered its own server-level `timeout` listener.
- Maximum requests per persistent socket and maximum header count.
- Maximum request body bytes, enforced both from a valid `Content-Length` header and by counting actual streamed bytes. This includes chunked transfer-encoded requests.
- Early rejection of oversized `Expect: 100-continue` requests before sending the continue response.

The streamed-body listener is prepended to the server's `request` event so it observes bytes before ordinary application request handlers register their body-parser listeners. On an oversized declared body, Guard rejects the request before dispatching it to application request listeners. For streamed/chunked bodies, it counts bytes at the IncomingMessage readable-stream boundary before exposing them to application consumers. This covers flowing data listeners and paused/readable consumers using read(), pipe() or async iteration; the chunk that would cross the limit is withheld. Guard pauses the incoming request, returns HTTP 413 with `Connection: close`, and closes the socket after the response is flushed.

## Integration example

```js
import { createServer } from "node:http";
import express from "express";
import { configureNodeHttpServer } from "@jb/security-guard";

const app = express();
const server = createServer(app);

configureNodeHttpServer(server, {
  maxBodyBytes: 1_048_576,
  headersTimeout: 10_000,
  requestTimeout: 30_000
});

// Configure Guard before listen(), and keep body parsers after server-level limits.
server.listen(3000);
```

Do not perform irreversible application actions while consuming an unvalidated streaming body. Application upload handlers must still handle request aborts and parser errors, and should use their own route-specific limits, file-count limits, content inspection and quarantine.

## Important boundaries

- The byte cap is per HTTP request body, not a complete upload-scanning solution.
- A streaming handler can observe the chunk that crosses the threshold before the connection is closed. It must not commit side effects until the complete request has passed validation.
- Reverse proxies/CDNs should enforce compatible limits and timeouts at the edge.
- HTTP/2 servers need protocol-specific configuration; this helper targets Node HTTP/HTTPS Server instances.
- Tune limits for the application's legitimate payloads. Large file uploads should use dedicated, bounded storage flows rather than raising the global body limit indiscriminately.
- Validate the behavior on the exact Node.js runtime and framework version used in production.
