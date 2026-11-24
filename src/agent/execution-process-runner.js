import { fork } from "node:child_process";
import {
  lstatSync,
  realpathSync
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const PROTOCOL = "jb-expert-qa.local-process/v1";
const ENGINE_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const EXPORT_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u;
const REQUEST_ID_PATTERN = /^[0-9a-f-]{36}$/iu;
const MAX_LOG_BYTES = 16 * 1024;
const CHILD_BOOTSTRAP = fileURLToPath(new URL("./execution-process-runner-child.js", import.meta.url));

export class LocalProcessEngineRunnerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LocalProcessEngineRunnerError";
    this.code = code;
  }
}

function readRecord(value, label, allowedKeys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LocalProcessEngineRunnerError("INVALID_OPTIONS", label + " must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new LocalProcessEngineRunnerError("INVALID_OPTIONS", label + " must be a plain object");
  }
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      throw new LocalProcessEngineRunnerError("UNSUPPORTED_OPTION", label + " contains an unsupported field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new LocalProcessEngineRunnerError("ACCESSOR_NOT_ALLOWED", label + " cannot contain accessors");
    }
    output[key] = descriptor.value;
  }
  return output;
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." &&
    !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

function resolveTrustedPaths(config) {
  if (typeof config.moduleRoot !== "string" || !path.isAbsolute(config.moduleRoot)) {
    throw new LocalProcessEngineRunnerError("INVALID_MODULE_ROOT", "moduleRoot must be an absolute host-controlled directory");
  }
  if (typeof config.modulePath !== "string" || !path.isAbsolute(config.modulePath)) {
    throw new LocalProcessEngineRunnerError("INVALID_MODULE_PATH", "modulePath must be an absolute host-controlled file");
  }

  try {
    const rootInfo = lstatSync(config.moduleRoot);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw new LocalProcessEngineRunnerError("UNSAFE_MODULE_ROOT", "moduleRoot must be a regular directory, not a symbolic link");
    }
    const moduleRoot = realpathSync(config.moduleRoot);
    const moduleInfo = lstatSync(config.modulePath);
    if (moduleInfo.isSymbolicLink() || !moduleInfo.isFile()) {
      throw new LocalProcessEngineRunnerError("UNSAFE_MODULE_PATH", "modulePath must be a regular file, not a symbolic link");
    }
    const modulePath = realpathSync(config.modulePath);
    if (!isWithin(moduleRoot, modulePath) || !/\.(?:mjs|cjs|js)$/u.test(modulePath)) {
      throw new LocalProcessEngineRunnerError("MODULE_OUTSIDE_ROOT", "modulePath must be a JavaScript file inside moduleRoot");
    }

    const requestedCwd = config.cwd ?? moduleRoot;
    if (typeof requestedCwd !== "string" || !path.isAbsolute(requestedCwd)) {
      throw new LocalProcessEngineRunnerError("INVALID_WORKING_DIRECTORY", "cwd must be an absolute directory inside moduleRoot");
    }
    const cwdInfo = lstatSync(requestedCwd);
    if (cwdInfo.isSymbolicLink() || !cwdInfo.isDirectory()) {
      throw new LocalProcessEngineRunnerError("UNSAFE_WORKING_DIRECTORY", "cwd must be a regular directory, not a symbolic link");
    }
    const cwd = realpathSync(requestedCwd);
    if (cwd !== moduleRoot && !isWithin(moduleRoot, cwd)) {
      throw new LocalProcessEngineRunnerError("WORKING_DIRECTORY_OUTSIDE_ROOT", "cwd must remain inside moduleRoot");
    }
    return { moduleRoot, modulePath, cwd };
  } catch (error) {
    if (error instanceof LocalProcessEngineRunnerError) throw error;
    throw new LocalProcessEngineRunnerError("INVALID_RUNNER_PATH", "runner module paths could not be safely resolved");
  }
}

function cloneJson(value, label, maxBytes) {
  const seen = new Set();
  let nodes = 0;

  function visit(current, depth) {
    nodes += 1;
    if (nodes > 20000 || depth > 24) {
      throw new LocalProcessEngineRunnerError("INVALID_JSON", label + " exceeds the structural JSON limit");
    }
    if (current === null || typeof current === "string" || typeof current === "boolean") return;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw new LocalProcessEngineRunnerError("INVALID_JSON", label + " contains a non-finite number");
      }
      return;
    }
    if (Array.isArray(current)) {
      if (seen.has(current) || current.length > 10000) {
        throw new LocalProcessEngineRunnerError("INVALID_JSON", label + " contains an invalid array");
      }
      seen.add(current);
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
          throw new LocalProcessEngineRunnerError("INVALID_JSON", label + " arrays cannot contain holes or accessors");
        }
        visit(descriptor.value, depth + 1);
      }
      for (const key of Reflect.ownKeys(current)) {
        if (key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/u.test(key) ||
            Number(key) >= current.length)) {
          throw new LocalProcessEngineRunnerError("INVALID_JSON", label + " arrays cannot contain custom properties");
        }
      }
      seen.delete(current);
      return;
    }
    if (typeof current !== "object" ||
        (Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null)) {
      throw new LocalProcessEngineRunnerError("INVALID_JSON", label + " must contain plain JSON values only");
    }
    if (seen.has(current)) {
      throw new LocalProcessEngineRunnerError("INVALID_JSON", label + " cannot contain circular references");
    }
    seen.add(current);
    for (const key of Reflect.ownKeys(current)) {
      if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key)) {
        throw new LocalProcessEngineRunnerError("INVALID_JSON", label + " contains a forbidden object key");
      }
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
        throw new LocalProcessEngineRunnerError("INVALID_JSON", label + " cannot contain accessors or hidden properties");
      }
      visit(descriptor.value, depth + 1);
    }
    seen.delete(current);
  }

  visit(value, 0);
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new LocalProcessEngineRunnerError("INVALID_JSON", label + " could not be serialized");
  }
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new LocalProcessEngineRunnerError("PAYLOAD_LIMIT", label + " exceeds the configured byte limit");
  }
  return JSON.parse(serialized);
}

function normalizeSignal(signal) {
  if (signal === undefined) return null;
  if (!signal || typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function") {
    throw new LocalProcessEngineRunnerError("INVALID_SIGNAL", "signal must be an AbortSignal");
  }
  return signal;
}

function childEnvironment() {
  const output = Object.create(null);
  const allowed = [
    "PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR",
    "HOME", "USERPROFILE", "LANG", "LC_ALL", "PLAYWRIGHT_BROWSERS_PATH"
  ];
  for (const key of allowed) {
    const value = process.env[key];
    if (typeof value === "string" && value.length <= 4096 && !/[\0\r\n]/u.test(value)) {
      output[key] = value;
    }
  }
  return output;
}

function normalizeCode(value, fallback = "PROCESS_FAILED") {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,79}$/u.test(value)
    ? value
    : fallback;
}

function messageShape(value, allowedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  return keys.every((key) => typeof key === "string" && allowedKeys.has(key));
}

/**
 * Creates a host-configured runner that executes one trusted adapter module
 * inside a fresh Node child process per invocation. The runner is compatible
 * with the engine registry's run(input, { signal }) function contract.
 *
 * This is process fault isolation and hard termination, not an OS security
 * sandbox: the child uses the same OS identity and filesystem/network rights.
 */
export function createLocalProcessEngineRunner(options = {}) {
  const config = readRecord(options, "options", new Set([
    "engineId", "moduleRoot", "modulePath", "exportName", "cwd",
    "timeoutMs", "killGraceMs", "maxInputBytes", "maxOutputBytes"
  ]));

  if (typeof config.engineId !== "string" || !ENGINE_ID_PATTERN.test(config.engineId)) {
    throw new LocalProcessEngineRunnerError("INVALID_ENGINE_ID", "engineId has an invalid format");
  }
  const exportName = config.exportName ?? "run";
  if (typeof exportName !== "string" || !EXPORT_PATTERN.test(exportName)) {
    throw new LocalProcessEngineRunnerError("INVALID_EXPORT_NAME", "exportName must be a valid JavaScript export identifier");
  }
  const timeoutMs = config.timeoutMs ?? 30000;
  const killGraceMs = config.killGraceMs ?? 250;
  const maxInputBytes = config.maxInputBytes ?? 32768;
  const maxOutputBytes = config.maxOutputBytes ?? 32768;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) {
    throw new LocalProcessEngineRunnerError("INVALID_TIMEOUT", "timeoutMs must be an integer from 1 to 600000");
  }
  if (!Number.isSafeInteger(killGraceMs) || killGraceMs < 25 || killGraceMs > 5000) {
    throw new LocalProcessEngineRunnerError("INVALID_KILL_GRACE", "killGraceMs must be an integer from 25 to 5000");
  }
  for (const [name, value] of [["maxInputBytes", maxInputBytes], ["maxOutputBytes", maxOutputBytes]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 1048576) {
      throw new LocalProcessEngineRunnerError("INVALID_PAYLOAD_LIMIT", name + " must be an integer from 1 to 1048576");
    }
  }

  const paths = resolveTrustedPaths(config);
  const env = childEnvironment();
  let closed = false;
  let active = null;
  let closePromise = null;
  let startedProcesses = 0;
  let completedProcesses = 0;
  let failedProcesses = 0;
  let timedOutProcesses = 0;
  let cancelledProcesses = 0;
  let forcedTerminations = 0;

  function getStatus() {
    return Object.freeze({
      engineId: config.engineId,
      state: closed ? "closed" : active ? "busy" : "ready",
      accepting: !closed,
      active: active !== null,
      activePid: active?.child?.pid ?? null,
      timeoutMs,
      killGraceMs,
      maxInputBytes,
      maxOutputBytes,
      startedProcesses,
      completedProcesses,
      failedProcesses,
      timedOutProcesses,
      cancelledProcesses,
      forcedTerminations
    });
  }

  function run(input, executionOptions = {}) {
    if (closed) {
      return Promise.reject(new LocalProcessEngineRunnerError("RUNNER_CLOSED", "isolated engine runner is closed"));
    }
    if (active !== null) {
      return Promise.reject(new LocalProcessEngineRunnerError("RUNNER_BUSY", "isolated engine runner already has an active process"));
    }

    let runConfig;
    let signal;
    let normalizedInput;
    try {
      runConfig = readRecord(executionOptions, "execution options", new Set(["signal"]));
      signal = normalizeSignal(runConfig.signal);
      if (signal?.aborted) {
        throw new LocalProcessEngineRunnerError("EXECUTION_CANCELLED", "execution was cancelled before process startup");
      }
      normalizedInput = cloneJson(input, "engine input", maxInputBytes);
      if (!normalizedInput || typeof normalizedInput !== "object" || Array.isArray(normalizedInput)) {
        throw new LocalProcessEngineRunnerError("INVALID_INPUT", "engine input must be a JSON object");
      }
    } catch (error) {
      return Promise.reject(error);
    }

    const requestId = randomUUID();
    let resolveCompletion;
    let rejectCompletion;
    const completion = new Promise((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });

    let child;
    let exitInfo = null;
    let resultValue;
    let failureCode = null;
    let terminationReason = null;
    let forced = false;
    let finished = false;
    let phase = "starting";
    let logBytes = 0;
    let timeoutHandle = null;
    let killHandle = null;

    const execution = {
      requestId,
      child: null,
      completion,
      terminate: null
    };
    active = execution;

    function clearTimersAndListeners() {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      if (killHandle !== null) clearTimeout(killHandle);
      if (signal) signal.removeEventListener("abort", onAbort);
    }

    function finish(error, value) {
      if (finished) return;
      finished = true;
      clearTimersAndListeners();
      if (active === execution) active = null;
      if (error) rejectCompletion(error);
      else resolveCompletion(value);
    }

    function terminate(reason) {
      if (terminationReason || exitInfo || !child) return;
      terminationReason = reason;
      try {
        if (child.connected) {
          child.send({
            protocol: PROTOCOL,
            type: "cancel",
            requestId
          }, () => undefined);
        }
      } catch {
        // A disconnected child is terminated by the bounded kill timer below.
      }
      killHandle = setTimeout(() => {
        if (!exitInfo && child && child.exitCode === null && child.signalCode === null) {
          forced = true;
          forcedTerminations += 1;
          try {
            child.kill("SIGKILL");
          } catch {
            try { child.kill(); } catch {}
          }
        }
      }, killGraceMs);
    }
    execution.terminate = terminate;

    function maybeFinishAfterExit() {
      if (!exitInfo || finished) return;
      if (terminationReason) {
        if (terminationReason === "EXECUTION_TIMEOUT") {
          timedOutProcesses += 1;
          finish(new LocalProcessEngineRunnerError("EXECUTION_TIMEOUT", "isolated engine process exceeded its execution deadline"));
        } else if (terminationReason === "EXECUTION_CANCELLED") {
          cancelledProcesses += 1;
          finish(new LocalProcessEngineRunnerError("EXECUTION_CANCELLED", "isolated engine process was cancelled"));
        } else if (terminationReason === "RUNNER_CLOSED") {
          finish(new LocalProcessEngineRunnerError("RUNNER_CLOSED", "isolated engine runner closed during execution"));
        } else {
          failedProcesses += 1;
          finish(new LocalProcessEngineRunnerError(terminationReason, "isolated engine process was terminated"));
        }
        return;
      }
      if (failureCode) {
        failedProcesses += 1;
        finish(new LocalProcessEngineRunnerError(failureCode, "isolated engine process failed"));
        return;
      }
      if (resultValue !== undefined && exitInfo.code === 0) {
        completedProcesses += 1;
        finish(null, resultValue);
        return;
      }
      failedProcesses += 1;
      finish(new LocalProcessEngineRunnerError(
        "PROCESS_EXITED",
        "isolated engine process exited before returning a valid result"
      ));
    }

    function onAbort() {
      terminate("EXECUTION_CANCELLED");
    }

    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    timeoutHandle = setTimeout(() => terminate("EXECUTION_TIMEOUT"), timeoutMs);

    try {
      child = fork(CHILD_BOOTSTRAP, [], {
        cwd: paths.cwd,
        env,
        execPath: process.execPath,
        execArgv: [],
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        serialization: "json",
        windowsHide: true,
        detached: false
      });
      execution.child = child;
      startedProcesses += 1;
    } catch {
      failedProcesses += 1;
      finish(new LocalProcessEngineRunnerError("PROCESS_SPAWN_FAILED", "isolated engine process could not be started"));
      return completion;
    }

    function countLogs(chunk) {
      logBytes += Buffer.byteLength(chunk);
      if (logBytes > MAX_LOG_BYTES) terminate("PROCESS_OUTPUT_LIMIT");
    }
    child.stdout?.on("data", countLogs);
    child.stderr?.on("data", countLogs);

    child.on("spawn", () => {
      if (terminationReason || finished) return;
      try {
        child.send({
          protocol: PROTOCOL,
          type: "initialize",
          requestId,
          engineId: config.engineId,
          moduleRoot: paths.moduleRoot,
          modulePath: paths.modulePath,
          exportName,
          maxInputBytes,
          maxOutputBytes
        }, (error) => {
          if (error) {
            failureCode = "PROCESS_IPC_FAILED";
            terminate("PROCESS_IPC_FAILED");
          }
        });
      } catch {
        failureCode = "PROCESS_IPC_FAILED";
        terminate("PROCESS_IPC_FAILED");
      }
    });

    child.on("message", (message) => {
      if (!messageShape(message, new Set(["protocol", "type", "requestId", "engineId", "output", "code"])) ||
          message.protocol !== PROTOCOL || message.requestId !== requestId) {
        failureCode = "PROCESS_PROTOCOL_INVALID";
        terminate("PROCESS_PROTOCOL_INVALID");
        return;
      }
      if (message.type === "ready") {
        if (phase !== "starting" || message.engineId !== config.engineId || terminationReason) {
          failureCode = "PROCESS_PROTOCOL_INVALID";
          terminate("PROCESS_PROTOCOL_INVALID");
          return;
        }
        phase = "running";
        try {
          child.send({
            protocol: PROTOCOL,
            type: "execute",
            requestId,
            input: normalizedInput
          }, (error) => {
            if (error) {
              failureCode = "PROCESS_IPC_FAILED";
              terminate("PROCESS_IPC_FAILED");
            }
          });
        } catch {
          failureCode = "PROCESS_IPC_FAILED";
          terminate("PROCESS_IPC_FAILED");
        }
        return;
      }
      if (message.type === "result") {
        if (phase !== "running" || terminationReason) {
          failureCode = "PROCESS_PROTOCOL_INVALID";
          terminate("PROCESS_PROTOCOL_INVALID");
          return;
        }
        try {
          resultValue = cloneJson(message.output, "engine output", maxOutputBytes);
          phase = "result-received";
        } catch (error) {
          failureCode = error instanceof LocalProcessEngineRunnerError ? error.code : "INVALID_OUTPUT";
          terminate("PROCESS_OUTPUT_INVALID");
        }
        return;
      }
      if (message.type === "failure") {
        failureCode = normalizeCode(message.code, "ENGINE_FAILED");
        phase = "failed";
        return;
      }
      failureCode = "PROCESS_PROTOCOL_INVALID";
      terminate("PROCESS_PROTOCOL_INVALID");
    });

    child.on("error", () => {
      failureCode = "PROCESS_SPAWN_FAILED";
    });
    child.on("exit", (code, signalName) => {
      exitInfo = { code, signal: signalName };
      maybeFinishAfterExit();
    });

    return completion;
  }

  function close() {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = (async () => {
      const pending = active;
      if (pending) {
        pending.terminate?.("RUNNER_CLOSED");
        await pending.completion.then(() => undefined, () => undefined);
      }
      return getStatus();
    })();
    return closePromise;
  }

  return Object.freeze({
    engineId: config.engineId,
    run,
    getStatus,
    close
  });
}
