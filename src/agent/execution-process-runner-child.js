import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PROTOCOL = "jb-expert-qa.local-process/v1";
const ENGINE_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const EXPORT_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u;

let initialization = "waiting";
let engineId = null;
let requestId = null;
let runner = null;
let controller = null;
let maxInputBytes = 32768;
let maxOutputBytes = 32768;

function validRecord(value, allowedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    return false;
  }
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && allowedKeys.has(key));
}

function within(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." &&
    !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function cloneJson(value, maxBytes) {
  const seen = new Set();
  let nodes = 0;
  function visit(current, depth) {
    nodes += 1;
    if (nodes > 20000 || depth > 24) throw codedError("INVALID_JSON");
    if (current === null || typeof current === "string" || typeof current === "boolean") return;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw codedError("INVALID_JSON");
      return;
    }
    if (Array.isArray(current)) {
      if (seen.has(current) || current.length > 10000) throw codedError("INVALID_JSON");
      seen.add(current);
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
          throw codedError("INVALID_JSON");
        }
        visit(descriptor.value, depth + 1);
      }
      for (const key of Reflect.ownKeys(current)) {
        if (key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/u.test(key) ||
            Number(key) >= current.length)) throw codedError("INVALID_JSON");
      }
      seen.delete(current);
      return;
    }
    if (typeof current !== "object" ||
        (Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) ||
        seen.has(current)) throw codedError("INVALID_JSON");
    seen.add(current);
    for (const key of Reflect.ownKeys(current)) {
      if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key)) {
        throw codedError("INVALID_JSON");
      }
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
        throw codedError("INVALID_JSON");
      }
      visit(descriptor.value, depth + 1);
    }
    seen.delete(current);
  }
  visit(value, 0);
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw codedError("PAYLOAD_LIMIT");
  }
  return JSON.parse(serialized);
}

function sendAndExit(message, exitCode = 0) {
  if (!process.connected) {
    process.exit(exitCode);
    return;
  }
  try {
    process.send(message, (error) => {
      if (process.connected) process.disconnect();
      process.exit(error ? 1 : exitCode);
    });
  } catch {
    process.exit(1);
  }
}

function safeCode(value) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,79}$/u.test(value)
    ? value
    : "ENGINE_FAILED";
}

async function initialize(message) {
  const allowed = new Set([
    "protocol", "type", "requestId", "engineId", "moduleRoot",
    "modulePath", "exportName", "maxInputBytes", "maxOutputBytes"
  ]);
  if (!validRecord(message, allowed) || message.protocol !== PROTOCOL ||
      message.type !== "initialize" || typeof message.requestId !== "string" ||
      !/^[0-9a-f-]{36}$/iu.test(message.requestId) ||
      typeof message.engineId !== "string" || !ENGINE_ID_PATTERN.test(message.engineId) ||
      typeof message.moduleRoot !== "string" || !path.isAbsolute(message.moduleRoot) ||
      typeof message.modulePath !== "string" || !path.isAbsolute(message.modulePath) ||
      typeof message.exportName !== "string" || !EXPORT_PATTERN.test(message.exportName) ||
      !Number.isSafeInteger(message.maxInputBytes) || message.maxInputBytes < 1 ||
      message.maxInputBytes > 1048576 ||
      !Number.isSafeInteger(message.maxOutputBytes) || message.maxOutputBytes < 1 ||
      message.maxOutputBytes > 1048576) {
    sendAndExit({ protocol: PROTOCOL, type: "failure", requestId: message?.requestId ?? "", code: "PROCESS_INIT_INVALID" }, 1);
    return;
  }

  try {
    const rootInfo = lstatSync(message.moduleRoot);
    const fileInfo = lstatSync(message.modulePath);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() ||
        fileInfo.isSymbolicLink() || !fileInfo.isFile()) {
      throw new Error("UNSAFE_MODULE");
    }
    const root = realpathSync(message.moduleRoot);
    const modulePath = realpathSync(message.modulePath);
    if (!within(root, modulePath) || !/\.(?:mjs|cjs|js)$/u.test(modulePath)) {
      throw new Error("MODULE_OUTSIDE_ROOT");
    }
    const imported = await import(pathToFileURL(modulePath).href);
    const candidate = imported[message.exportName];
    if (typeof candidate !== "function") throw new Error("RUNNER_EXPORT_MISSING");
    engineId = message.engineId;
    requestId = message.requestId;
    maxInputBytes = message.maxInputBytes;
    maxOutputBytes = message.maxOutputBytes;
    runner = candidate;
    initialization = "ready";
    send({
      protocol: PROTOCOL,
      type: "ready",
      requestId,
      engineId
    });
    process.once("message", execute);
  } catch {
    sendAndExit({
      protocol: PROTOCOL,
      type: "failure",
      requestId: message.requestId,
      code: "WORKER_BOOTSTRAP_FAILED"
    }, 1);
  }
}

function send(message) {
  if (!process.connected) return;
  try {
    process.send(message, (error) => {
      if (error) process.exit(1);
    });
  } catch {
    process.exit(1);
  }
}

async function execute(message) {
  const allowed = new Set(["protocol", "type", "requestId", "input"]);
  if (!validRecord(message, allowed) || message.protocol !== PROTOCOL ||
      message.type !== "execute" || message.requestId !== requestId ||
      initialization !== "ready" || typeof runner !== "function") {
    sendAndExit({ protocol: PROTOCOL, type: "failure", requestId: requestId ?? "", code: "PROCESS_PROTOCOL_INVALID" }, 1);
    return;
  }
  initialization = "running";
  controller = new AbortController();
  try {
    const input = cloneJson(message.input, maxInputBytes);
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw codedError("INVALID_INPUT");
    }
    const output = await runner(input, { signal: controller.signal });
    const safeOutput = cloneJson(output, maxOutputBytes);
    sendAndExit({
      protocol: PROTOCOL,
      type: "result",
      requestId,
      output: safeOutput
    });
  } catch (error) {
    sendAndExit({
      protocol: PROTOCOL,
      type: "failure",
      requestId,
      code: safeCode(error?.code)
    }, 1);
  }
}

process.on("message", (message) => {
  if (initialization === "waiting") {
    initialization = "loading";
    void initialize(message);
    return;
  }
  if (initialization === "running") {
    const allowed = new Set(["protocol", "type", "requestId"]);
    if (validRecord(message, allowed) && message.protocol === PROTOCOL &&
        message.type === "cancel" && message.requestId === requestId) {
      controller?.abort();
    }
  }
});

process.on("disconnect", () => {
  controller?.abort();
  process.exit(1);
});
