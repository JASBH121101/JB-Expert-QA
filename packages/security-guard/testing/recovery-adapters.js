/**
 * Test-only recovery delivery adapters.
 *
 * These adapters never access the network, write files, or log credentials.
 * Messages remain in bounded process memory and are intended for automated
 * tests and local demonstrations only. This directory is excluded from the
 * package's published files and is not part of the runtime package exports.
 */

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateChannel(channel) {
  if (channel !== "email" && channel !== "sms") {
    throw new TypeError("channel must be email or sms");
  }
}

export function createMockRecoveryProviders(options = {}) {
  if (!isRecord(options)) throw new TypeError("mock provider options must be an object");
  const maxMessages = options.maxMessages ?? 100;
  if (!Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > 10_000) {
    throw new TypeError("maxMessages must be an integer between 1 and 10000");
  }

  const queues = { email: [], sms: [] };
  let closed = false;

  function createProvider(channel) {
    return Object.freeze({
      async send(message) {
        if (closed) throw new Error("mock recovery provider is closed");
        if (!isRecord(message) ||
            typeof message.to !== "string" ||
            typeof message.requestId !== "string" ||
            !Number.isSafeInteger(message.expiresAt)) {
          throw new TypeError("mock recovery message is invalid");
        }
        if (channel === "email" && !/^[A-Za-z0-9_-]{43}$/.test(message.token ?? "")) {
          throw new TypeError("mock email message must contain a 256-bit recovery token");
        }
        if (channel === "sms" && !/^\d{6}$/.test(message.code ?? "")) {
          throw new TypeError("mock SMS message must contain a six-digit recovery code");
        }
        if (queues[channel].length >= maxMessages) {
          throw new Error("mock recovery message capacity reached");
        }

        // Copy and freeze the message; credentials are available only to the
        // test process through getMessages()/takeMessages().
        queues[channel].push(Object.freeze({ ...message }));
      }
    });
  }

  function getMessages(channel) {
    validateChannel(channel);
    return Object.freeze([...queues[channel]]);
  }

  function takeMessages(channel) {
    validateChannel(channel);
    return Object.freeze(queues[channel].splice(0));
  }

  function clear(channel) {
    if (channel === undefined) {
      queues.email.length = 0;
      queues.sms.length = 0;
      return;
    }
    validateChannel(channel);
    queues[channel].length = 0;
  }

  function close() {
    closed = true;
    clear();
  }

  return Object.freeze({
    emailProvider: createProvider("email"),
    smsProvider: createProvider("sms"),
    getMessages,
    takeMessages,
    clear,
    close
  });
}
