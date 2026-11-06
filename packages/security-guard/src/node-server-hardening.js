const CONFIGURED_SERVERS = new WeakSet();

const DEFAULTS = Object.freeze({
  headersTimeout: 10_000,
  requestTimeout: 30_000,
  keepAliveTimeout: 5_000,
  socketTimeout: 60_000,
  maxRequestsPerSocket: 100,
  maxHeadersCount: 100,
  maxBodyBytes: 1_048_576,
  handleExpectContinue: true
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(name + " must be a positive integer no greater than " + maximum);
  }
  return value;
}

function headerValues(request, name) {
  const normalizedName = name.toLowerCase();
  const values = [];
  if (Array.isArray(request.rawHeaders)) {
    for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
      if (String(request.rawHeaders[index]).toLowerCase() === normalizedName) {
        values.push(String(request.rawHeaders[index + 1] ?? "").trim());
      }
    }
  }
  if (values.length) return values;
  const value = request.headers?.[normalizedName];
  if (Array.isArray(value)) return value.map((item) => String(item).trim());
  if (value === undefined || value === null) return [];
  return String(value).split(",").map((item) => item.trim());
}

function getBodyPreflightFailure(request, maxBodyBytes) {
  const contentLengths = headerValues(request, "content-length");
  const transferEncodings = headerValues(request, "transfer-encoding");
  if (contentLengths.length && transferEncodings.length) {
    return { statusCode: 400, error: "ambiguous_message_framing" };
  }
  if (!contentLengths.length) return null;

  if (new Set(contentLengths).size > 1 || contentLengths.some((value) => !/^\d+$/.test(value))) {
    return { statusCode: 400, error: "invalid_content_length" };
  }
  const length = Number(contentLengths[0]);
  if (!Number.isSafeInteger(length)) {
    return { statusCode: 400, error: "invalid_content_length" };
  }
  if (length > maxBodyBytes) {
    return { statusCode: 413, error: "request_body_too_large" };
  }
  return null;
}

function rejectRequest(request, response, statusCode, error) {
  request.pause?.();
  if (response.headersSent || response.writableEnded) {
    request.socket?.destroy();
    response.destroy?.();
    return;
  }
  response.statusCode = statusCode;
  response.shouldKeepAlive = false;
  response.setHeader("Connection", "close");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify({
    error,
    message: "Request rejected by server security policy"
  }), () => {
    // Do not keep reading an attacker-controlled body after returning 4xx.
    request.socket?.destroy();
  });
}

function installRequestBodyLimit(server, maxBodyBytes) {
  const originalServerEmit = server.emit;

  server.emit = function guardedServerEmit(eventName, ...args) {
    if (eventName === "request") {
      const [request, response] = args;
      const preflightFailure = getBodyPreflightFailure(request, maxBodyBytes);
      if (preflightFailure) {
        // Returning before EventEmitter dispatch prevents any application
        // request listener from observing a body already known to be oversized.
        rejectRequest(request, response, preflightFailure.statusCode, preflightFailure.error);
        return true;
      }

      const originalRequestEmit = request.emit;
      const hadOwnEmit = Object.hasOwn(request, "emit");
      let receivedBytes = 0;
      let rejected = false;
      let restored = false;

      const restoreRequestEmit = () => {
        if (restored) return;
        restored = true;
        if (hadOwnEmit) request.emit = originalRequestEmit;
        else delete request.emit;
      };

      request.emit = function guardedRequestEmit(requestEvent, ...eventArgs) {
        if (requestEvent === "data" && !rejected) {
          const chunk = eventArgs[0];
          const chunkBytes = Buffer.isBuffer(chunk)
            ? chunk.length
            : Buffer.byteLength(String(chunk));
          if (receivedBytes + chunkBytes > maxBodyBytes) {
            rejected = true;
            request.pause();
            rejectRequest(request, response, 413, "request_body_too_large");
            return false;
          }
          receivedBytes += chunkBytes;
        }

        // A truncated stream must never emit "end" to downstream parsers.
        if (rejected && requestEvent === "end") return false;

        try {
          return originalRequestEmit.call(this, requestEvent, ...eventArgs);
        } finally {
          if (requestEvent === "end" || requestEvent === "close" || requestEvent === "error") {
            restoreRequestEmit();
          }
        }
      };
    }

    return originalServerEmit.call(this, eventName, ...args);
  };
}

/**
 * Configure conservative Node.js HTTP/HTTPS server limits before listen().
 * Enforces maxBodyBytes against Content-Length and streamed/chunked request data.
 * Configure this before application request handlers and body parsers.
 */
export function configureNodeHttpServer(server, options = {}) {
  if (!server || typeof server !== "object" ||
      typeof server.on !== "function" ||
      typeof server.emit !== "function" ||
      typeof server.prependListener !== "function" ||
      typeof server.listenerCount !== "function") {
    throw new TypeError("server must be a Node.js HTTP or HTTPS Server instance");
  }
  if (server.listening === true) {
    throw new TypeError("Configure the HTTP server before calling listen()");
  }
  if (CONFIGURED_SERVERS.has(server)) {
    throw new TypeError("Server hardening has already been configured");
  }
  if (!isRecord(options)) throw new TypeError("server hardening options must be an object");

  const allowed = new Set(Object.keys(DEFAULTS));
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new TypeError("Unknown server hardening option: " + key);
  }

  const settings = {
    headersTimeout: positiveInteger(
      options.headersTimeout ?? DEFAULTS.headersTimeout, "headersTimeout", 120_000
    ),
    requestTimeout: positiveInteger(
      options.requestTimeout ?? DEFAULTS.requestTimeout, "requestTimeout", 600_000
    ),
    keepAliveTimeout: positiveInteger(
      options.keepAliveTimeout ?? DEFAULTS.keepAliveTimeout, "keepAliveTimeout", 120_000
    ),
    socketTimeout: positiveInteger(
      options.socketTimeout ?? DEFAULTS.socketTimeout, "socketTimeout", 600_000
    ),
    maxRequestsPerSocket: positiveInteger(
      options.maxRequestsPerSocket ?? DEFAULTS.maxRequestsPerSocket,
      "maxRequestsPerSocket", 100_000
    ),
    maxHeadersCount: positiveInteger(
      options.maxHeadersCount ?? DEFAULTS.maxHeadersCount, "maxHeadersCount", 10_000
    ),
    maxBodyBytes: positiveInteger(
      options.maxBodyBytes ?? DEFAULTS.maxBodyBytes, "maxBodyBytes", 100 * 1024 * 1024
    ),
    handleExpectContinue: options.handleExpectContinue ?? DEFAULTS.handleExpectContinue
  };

  if (settings.headersTimeout >= settings.requestTimeout) {
    throw new TypeError("headersTimeout must be lower than requestTimeout");
  }
  if (typeof settings.handleExpectContinue !== "boolean") {
    throw new TypeError("handleExpectContinue must be a boolean");
  }

  if (settings.handleExpectContinue && server.listenerCount("checkContinue") > 0) {
    throw new TypeError("A checkContinue listener already exists; configure it explicitly or set handleExpectContinue to false");
  }

  // Validate all options before mutating the server. A server must be
  // configured exactly once to prevent nested stream counters and handlers.
  CONFIGURED_SERVERS.add(server);
  // Node enforces these parser/socket limits before application middleware.
  server.headersTimeout = settings.headersTimeout;
  server.requestTimeout = settings.requestTimeout;
  server.keepAliveTimeout = settings.keepAliveTimeout;
  server.timeout = settings.socketTimeout;
  server.maxRequestsPerSocket = settings.maxRequestsPerSocket;
  server.maxHeadersCount = settings.maxHeadersCount;

  installRequestBodyLimit(server, settings.maxBodyBytes);

  if (settings.handleExpectContinue) {
    server.on("checkContinue", (request, response) => {
      const failure = getBodyPreflightFailure(request, settings.maxBodyBytes);
      if (failure) {
        rejectRequest(request, response, failure.statusCode, failure.error);
        return;
      }

      response.writeContinue();
      // When checkContinue is handled, Node does not emit request automatically.
      // Re-emit it after sending 100 Continue so the body limit listener and
      // normal application request handler both receive the request.
      server.emit("request", request, response);
    });
  }

  return Object.freeze({ server, settings: Object.freeze(settings) });
}
