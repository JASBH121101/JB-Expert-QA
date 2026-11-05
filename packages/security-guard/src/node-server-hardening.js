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

function rejectExpectation(response, statusCode, error) {
  if (response.headersSent || response.writableEnded) {
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
  }));
}

/**
 * Configure conservative Node.js HTTP/HTTPS server limits before listen().
 * This does not replace framework-level streamed-body or file-upload limits.
 */
export function configureNodeHttpServer(server, options = {}) {
  if (!server || typeof server !== "object" ||
      typeof server.on !== "function" ||
      typeof server.emit !== "function" ||
      typeof server.listenerCount !== "function") {
    throw new TypeError("server must be a Node.js HTTP or HTTPS Server instance");
  }
  if (server.listening === true) {
    throw new TypeError("Configure the HTTP server before calling listen()");
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

  // Node enforces these timeouts at the HTTP parser/socket boundary, before app middleware.
  server.headersTimeout = settings.headersTimeout;
  server.requestTimeout = settings.requestTimeout;
  server.keepAliveTimeout = settings.keepAliveTimeout;
  server.timeout = settings.socketTimeout;
  server.maxRequestsPerSocket = settings.maxRequestsPerSocket;
  server.maxHeadersCount = settings.maxHeadersCount;

  if (settings.handleExpectContinue) {
    if (server.listenerCount("checkContinue") > 0) {
      throw new TypeError("A checkContinue listener already exists; configure it explicitly or set handleExpectContinue to false");
    }

    server.on("checkContinue", (request, response) => {
      const contentLengths = headerValues(request, "content-length");
      const transferEncodings = headerValues(request, "transfer-encoding");

      if (contentLengths.length && transferEncodings.length) {
        rejectExpectation(response, 400, "ambiguous_message_framing");
        return;
      }

      if (contentLengths.length) {
        if (new Set(contentLengths).size > 1 ||
            contentLengths.some((value) => !/^\d+$/.test(value))) {
          rejectExpectation(response, 400, "invalid_content_length");
          return;
        }
        const length = Number(contentLengths[0]);
        if (!Number.isSafeInteger(length)) {
          rejectExpectation(response, 400, "invalid_content_length");
          return;
        }
        if (length > settings.maxBodyBytes) {
          rejectExpectation(response, 413, "request_body_too_large");
          return;
        }
      }

      response.writeContinue();
      // When checkContinue is handled, Node does not emit request automatically.
      // Re-emit it after sending 100 Continue so the normal application handler runs.
      server.emit("request", request, response);
    });
  }

  return Object.freeze({ server, settings: Object.freeze(settings) });
}
