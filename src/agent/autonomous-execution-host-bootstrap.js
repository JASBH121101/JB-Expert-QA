import {
  constants,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { isAbsolute, join, parse, resolve } from "node:path";
import { createAutonomousExecutionHost } from "./autonomous-execution-host.js";
import { validateWindowsStorageSecurityReport } from "./windows-storage-security.js";
import { readWindowsStorageSecurityReport } from "./windows-storage-security-native.js";
import { createAutonomousExecutionHostService } from "./autonomous-execution-host-service.js";
import {
  getQaEngineActionType,
  QA_ENGINE_EXECUTION_PERMISSION
} from "../engine-registry/orchestrator.js";

const ENGINE_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const SAFE_TOKEN_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;
const HOST_OPTION_KEYS = new Set([
  "runnerId", "supervisorId", "workerId", "pollIntervalMs",
  "maxJobsPerTick", "maxConsecutiveErrors", "workerTimeoutMs",
  "maxQueueSize", "maxJobs", "maxAttempts", "maxEvents"
]);
const REQUIRED_POLICY_LIMITS = Object.freeze([
  "maxActions", "maxExecutionMs", "maxActionMs",
  "approvalTimeoutMs", "maxInputBytes", "maxOutputBytes"
]);

export class AutonomousExecutionHostBootstrapError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AutonomousExecutionHostBootstrapError";
    this.code = code;
  }
}

function readOptions(value, allowed, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AutonomousExecutionHostBootstrapError("INVALID_OPTIONS", label + " must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AutonomousExecutionHostBootstrapError("INVALID_OPTIONS", label + " must be a plain object");
  }
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new AutonomousExecutionHostBootstrapError("UNSUPPORTED_OPTION", label + " contains an unsupported field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new AutonomousExecutionHostBootstrapError("ACCESSOR_NOT_ALLOWED", label + " cannot contain getters or setters");
    }
    output[key] = descriptor.value;
  }
  return output;
}

function readDataProperty(value, key, label) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, "value")) {
    throw new AutonomousExecutionHostBootstrapError("INVALID_PREFLIGHT_DATA", label + " is missing a data property");
  }
  return descriptor.value;
}

function readMethod(target, name, label = "orchestrator") {
  const descriptor = target && Object.getOwnPropertyDescriptor(target, name);
  if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function") {
    throw new AutonomousExecutionHostBootstrapError("INVALID_ORCHESTRATOR", label + " must expose a trusted " + name + "() method");
  }
  return descriptor.value.bind(target);
}

function safeErrorCode(error) {
  const code = error && typeof error === "object" ? error.code : undefined;
  return typeof code === "string" && SAFE_TOKEN_PATTERN.test(code) ? code : "BOOTSTRAP_CHECK_FAILED";
}

function freezeCheck(name, passed, code = undefined) {
  return Object.freeze({
    name,
    status: passed ? "passed" : "failed",
    ...(code ? { code } : {})
  });
}

function validPath(value) {
  return typeof value === "string" && value.trim().length > 0 &&
    value.length <= 4096 && !value.includes("\0") && isAbsolute(value);
}

function inspectStorageDirectory(storageDirectory, {
  create = false,
  probeWrite = false,
  windowsStorageSecurityVerifier,
  expectedWindowsServiceSid
} = {}) {
  const directory = resolve(storageDirectory);
  if (!validPath(storageDirectory) || directory === parse(directory).root) {
    throw new AutonomousExecutionHostBootstrapError("INVALID_STORAGE_DIRECTORY", "storage directory must be an absolute non-root path");
  }

  if (process.platform === "win32" &&
      (typeof windowsStorageSecurityVerifier !== "function" || expectedWindowsServiceSid === undefined)) {
    throw new AutonomousExecutionHostBootstrapError(
      "WINDOWS_STORAGE_SECURITY_REQUIRED",
      "Windows host storage requires a trusted token and NTFS ACL verifier"
    );
  }

  if (create && !existsSync(directory)) {
    if (process.platform === "win32") {
      throw new AutonomousExecutionHostBootstrapError(
        "STORAGE_DIRECTORY_MISSING",
        "Windows storage must be provisioned with its protected ACL before host startup"
      );
    }
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    } catch {
      throw new AutonomousExecutionHostBootstrapError("STORAGE_CREATE_FAILED", "storage directory could not be created");
    }
  }

  let info;
  try {
    info = lstatSync(directory);
  } catch {
    throw new AutonomousExecutionHostBootstrapError("STORAGE_DIRECTORY_MISSING", "storage directory does not exist");
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new AutonomousExecutionHostBootstrapError("STORAGE_DIRECTORY_UNSAFE", "storage path must be a real directory, not a link or file");
  }

  if (process.platform !== "win32") {
    let canonical;
    try {
      canonical = realpathSync(directory);
    } catch {
      throw new AutonomousExecutionHostBootstrapError("STORAGE_DIRECTORY_UNSAFE", "storage directory could not be resolved safely");
    }
    if (canonical !== directory) {
      throw new AutonomousExecutionHostBootstrapError("STORAGE_SYMLINK_PATH", "storage path cannot traverse symbolic links");
    }
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new AutonomousExecutionHostBootstrapError("STORAGE_OWNER_MISMATCH", "storage directory must belong to the service identity");
    }
    if ((info.mode & 0o077) !== 0) {
      throw new AutonomousExecutionHostBootstrapError("STORAGE_PERMISSIONS_UNSAFE", "storage directory must not grant group or other access");
    }
  }

  let windowsSecurity = null;
  if (process.platform === "win32") {
    let report;
    try {
      report = windowsStorageSecurityVerifier(Object.freeze({
        directory,
        expectedServiceSid: expectedWindowsServiceSid
      }));
    } catch {
      throw new AutonomousExecutionHostBootstrapError(
        "WINDOWS_STORAGE_SECURITY_VERIFICATION_FAILED",
        "Windows storage security verification failed"
      );
    }
    try {
      windowsSecurity = validateWindowsStorageSecurityReport(report, {
        directory,
        expectedServiceSid: expectedWindowsServiceSid
      });
    } catch {
      throw new AutonomousExecutionHostBootstrapError(
        "WINDOWS_STORAGE_SECURITY_INVALID",
        "Windows storage identity or NTFS ACL does not meet the required policy"
      );
    }
  }

  if (probeWrite) {
    const probePath = join(directory, ".jbqa-bootstrap-probe-" + process.pid + "-" + randomUUID());
    let descriptor;
    try {
      descriptor = openSync(
        probePath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
        0o600
      );
      writeFileSync(descriptor, "jb-expert-qa-bootstrap-probe\n", "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      unlinkSync(probePath);
    } catch {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch {}
      }
      try { unlinkSync(probePath); } catch {}
      throw new AutonomousExecutionHostBootstrapError("STORAGE_NOT_WRITABLE", "storage directory failed its private write probe");
    }
  }

  return Object.freeze({
    directory,
    ownerVerified: process.platform === "win32"
      ? windowsSecurity.ownerVerified
      : typeof process.getuid === "function",
    permissionsVerified: process.platform === "win32"
      ? windowsSecurity.permissionsVerified
      : true,
    identityVerified: process.platform === "win32" ? windowsSecurity.identityVerified : null,
    aclVerified: process.platform === "win32" ? windowsSecurity.daclProtected : null,
    writeProbe: probeWrite
  });
}

function inspectOwnedLock(lockPath) {
  let info;
  let lock;
  try {
    info = lstatSync(lockPath);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 4096) return false;
    if (process.platform !== "win32") {
      if ((info.mode & 0o077) !== 0) return false;
      if (typeof process.getuid === "function" && info.uid !== process.getuid()) return false;
    }
    lock = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return false;
  }
  return lock && lock.pid === process.pid && lock.host === hostname() &&
    typeof lock.token === "string" && lock.token.length >= 16;
}

function sanitizeEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const timestamp = typeof event.timestamp === "string" &&
    Number.isFinite(Date.parse(event.timestamp)) ? event.timestamp : null;
  const eventType = typeof event.eventType === "string" &&
    /^[A-Z][A-Z0-9_]{0,63}$/u.test(event.eventType) ? event.eventType : "UNKNOWN_EVENT";
  const severity = ["info", "warning", "error"].includes(event.severity) ? event.severity : "info";
  const code = typeof event.code === "string" && SAFE_TOKEN_PATTERN.test(event.code) ? event.code : undefined;
  const stage = typeof event.stage === "string" &&
    /^[a-z][a-z0-9_-]{0,31}$/u.test(event.stage) ? event.stage : undefined;
  return Object.freeze({
    sequence: Number.isSafeInteger(event.sequence) && event.sequence > 0 ? event.sequence : null,
    timestamp,
    eventType,
    severity,
    ...(code ? { code } : {}),
    ...(stage ? { stage } : {})
  });
}

/**
 * Creates an explicit, local-first bootstrap controller for the autonomous
 * host. Construction is inert. start() performs preflight, verifies protected
 * storage and the current execution-ledger snapshot, acquires both persistent
 * store locks through the host factory, then attaches the service signal
 * lifecycle and starts the already enabled runtime.
 *
 * This controller never auto-recovers interrupted jobs, installs OS services,
 * elevates privileges, changes ACLs, invokes a shell or calls process.exit().
 */
export function createAutonomousExecutionHostBootstrap(options = {}) {
  const config = readOptions(options, new Set([
    "orchestrator", "storageDirectory", "enabled", "signalSource",
    "signals", "hostOptions", "onDiagnostic",
    "windowsStorageSecurityVerifier", "expectedWindowsServiceSid"
  ]), "bootstrap options");

  const orchestrator = config.orchestrator;
  if (orchestrator === null || typeof orchestrator !== "object" || Array.isArray(orchestrator)) {
    throw new AutonomousExecutionHostBootstrapError("INVALID_ORCHESTRATOR", "a trusted QA engine orchestrator is required");
  }
  const storageDirectory = config.storageDirectory;
  if (config.windowsStorageSecurityVerifier !== undefined && typeof config.windowsStorageSecurityVerifier !== "function") {
    throw new AutonomousExecutionHostBootstrapError("INVALID_WINDOWS_STORAGE_SECURITY_VERIFIER", "windowsStorageSecurityVerifier must be a function");
  }
  if (config.expectedWindowsServiceSid !== undefined &&
      !["S-1-5-19", "S-1-5-20"].includes(config.expectedWindowsServiceSid)) {
    throw new AutonomousExecutionHostBootstrapError("INVALID_WINDOWS_SERVICE_SID", "expectedWindowsServiceSid must identify LocalService or NetworkService");
  }
  if (config.windowsStorageSecurityVerifier !== undefined && config.expectedWindowsServiceSid === undefined) {
    throw new AutonomousExecutionHostBootstrapError("WINDOWS_STORAGE_SECURITY_CONFIGURATION_INVALID", "expectedWindowsServiceSid is required when a custom Windows storage verifier is supplied");
  }
  const windowsStorageSecurityVerifier = config.windowsStorageSecurityVerifier ??
    (config.expectedWindowsServiceSid === undefined ? undefined : readWindowsStorageSecurityReport);
  if (!validPath(storageDirectory) || resolve(storageDirectory) === parse(resolve(storageDirectory)).root) {
    throw new AutonomousExecutionHostBootstrapError("INVALID_STORAGE_DIRECTORY", "storageDirectory must be an absolute non-root path");
  }
  if (config.enabled !== true) {
    throw new AutonomousExecutionHostBootstrapError("BOOTSTRAP_NOT_ENABLED", "host bootstrap requires an explicit enabled: true opt-in");
  }
  const signalSource = config.signalSource;
  if (!signalSource || typeof signalSource !== "object" ||
      typeof signalSource.on !== "function" || typeof signalSource.off !== "function") {
    throw new AutonomousExecutionHostBootstrapError("INVALID_SIGNAL_SOURCE", "signalSource must expose on() and off()");
  }
  if (config.onDiagnostic !== undefined && typeof config.onDiagnostic !== "function") {
    throw new AutonomousExecutionHostBootstrapError("INVALID_DIAGNOSTIC_SINK", "onDiagnostic must be a function");
  }

  const hostOptions = config.hostOptions === undefined
    ? Object.create(null)
    : readOptions(config.hostOptions, HOST_OPTION_KEYS, "hostOptions");

  const listEngines = readMethod(orchestrator, "listEngines");
  const getPolicy = readMethod(orchestrator, "getPolicy");
  const verifyLedger = readMethod(orchestrator, "verifyLedger");

  let state = "idle";
  let preflightSnapshot = null;
  let host = null;
  let service = null;
  let hostStatus = null;
  let lastFailureCode = null;
  let stopPromise = null;
  const recentDiagnostics = [];
  const maxDiagnostics = 50;

  function emitDiagnostic(event, code) {
    const record = Object.freeze({
      timestamp: new Date().toISOString(),
      component: "host-bootstrap",
      event,
      ...(code ? { code } : {})
    });
    recentDiagnostics.push(record);
    if (recentDiagnostics.length > maxDiagnostics) recentDiagnostics.shift();
    try {
      config.onDiagnostic?.(record);
    } catch {
      // A diagnostic sink cannot change host availability or leak its error.
    }
  }

  async function runPreflight() {
    const checks = [];
    let engineCount = 0;
    let allowedEngineCount = 0;
    let policyId = null;
    let ledgerEntries = null;
    let storage = null;

    try {
      storage = inspectStorageDirectory(storageDirectory, {
        create: true,
        probeWrite: true,
        windowsStorageSecurityVerifier,
        expectedWindowsServiceSid: config.expectedWindowsServiceSid
      });
      checks.push(freezeCheck("storage-directory", true));
    } catch (error) {
      checks.push(freezeCheck("storage-directory", false, safeErrorCode(error)));
    }

    let engines = null;
    try {
      engines = listEngines();
      if (!Array.isArray(engines) || engines.length < 1 || engines.length > 256) {
        throw new AutonomousExecutionHostBootstrapError("ENGINE_CATALOG_INVALID", "engine catalog must contain between 1 and 256 engines");
      }
      const seen = new Set();
      for (const engine of engines) {
        if (engine === null || typeof engine !== "object" || Array.isArray(engine)) {
          throw new AutonomousExecutionHostBootstrapError("ENGINE_METADATA_INVALID", "engine metadata is invalid");
        }
        const id = readDataProperty(engine, "id", "engine metadata");
        if (typeof id !== "string" || !ENGINE_ID_PATTERN.test(id) || seen.has(id)) {
          throw new AutonomousExecutionHostBootstrapError("ENGINE_ID_INVALID", "engine identifiers must be valid and unique");
        }
        seen.add(id);
      }
      engineCount = engines.length;
      checks.push(freezeCheck("engine-catalog", true));
    } catch (error) {
      checks.push(freezeCheck("engine-catalog", false, safeErrorCode(error)));
    }

    let policy = null;
    try {
      policy = getPolicy();
      if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
        throw new AutonomousExecutionHostBootstrapError("POLICY_SNAPSHOT_INVALID", "policy snapshot is invalid");
      }
      policyId = readDataProperty(policy, "id", "policy snapshot");
      const permissions = readDataProperty(policy, "grantedPermissions", "policy snapshot");
      const allowedActions = readDataProperty(policy, "allowedActions", "policy snapshot");
      const limits = readDataProperty(policy, "limits", "policy snapshot");
      if (typeof policyId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u.test(policyId) ||
          !Array.isArray(permissions) || !Array.isArray(allowedActions) ||
          !limits || typeof limits !== "object" || Array.isArray(limits)) {
        throw new AutonomousExecutionHostBootstrapError("POLICY_SNAPSHOT_INVALID", "policy snapshot is incomplete");
      }
      if (!permissions.includes(QA_ENGINE_EXECUTION_PERMISSION) ||
          new Set(permissions).size !== permissions.length) {
        throw new AutonomousExecutionHostBootstrapError("POLICY_PERMISSION_MISSING", "policy does not grant a unique QA engine execution permission");
      }
      for (const key of REQUIRED_POLICY_LIMITS) {
        const limit = readDataProperty(limits, key, "policy limits");
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 600000 ||
            (key === "maxActions" && limit > 50)) {
          throw new AutonomousExecutionHostBootstrapError("POLICY_LIMIT_INVALID", "policy contains an invalid execution limit");
        }
      }
      const registeredActions = new Set((engines ?? []).map(engine => getQaEngineActionType(readDataProperty(engine, "id", "engine metadata"))));
      if (!allowedActions.every(action => typeof action === "string" && registeredActions.has(action)) ||
          new Set(allowedActions).size !== allowedActions.length) {
        throw new AutonomousExecutionHostBootstrapError("POLICY_ACTION_INVALID", "policy contains an action outside the registered engine catalog or duplicate actions");
      }
      allowedEngineCount = allowedActions.length;
      if (allowedEngineCount < 1) {
        throw new AutonomousExecutionHostBootstrapError("POLICY_HAS_NO_ALLOWED_ENGINES", "policy does not allow any registered QA engine");
      }
      checks.push(freezeCheck("execution-policy", true));
    } catch (error) {
      checks.push(freezeCheck("execution-policy", false, safeErrorCode(error)));
    }

    try {
      const ledger = await verifyLedger();
      if (!ledger || typeof ledger !== "object" || ledger.valid !== true ||
          !Number.isSafeInteger(ledger.entries) || ledger.entries < 0) {
        throw new AutonomousExecutionHostBootstrapError("EXECUTION_LEDGER_INVALID", "execution ledger integrity check failed");
      }
      ledgerEntries = ledger.entries;
      checks.push(freezeCheck("execution-ledger", true));
    } catch (error) {
      checks.push(freezeCheck("execution-ledger", false, safeErrorCode(error)));
    }

    const passed = checks.every(check => check.status === "passed");
    const failures = checks.filter(check => check.status === "failed");
    preflightSnapshot = Object.freeze({
      passed,
      checkedAt: new Date().toISOString(),
      engineCount,
      allowedEngineCount,
      policyId,
      ledgerEntries,
      storageDirectory: storage ? Object.freeze({
        ownerVerified: storage.ownerVerified,
        permissionsVerified: storage.permissionsVerified,
        identityVerified: storage.identityVerified,
        aclVerified: storage.aclVerified,
        writeProbe: storage.writeProbe
      }) : null,
      checks: Object.freeze(checks),
      failures: Object.freeze(failures.map(check => check.code ?? "PREFLIGHT_CHECK_FAILED"))
    });
    emitDiagnostic(passed ? "preflight_passed" : "preflight_failed",
      passed ? "PREFLIGHT_PASSED" : (failures[0]?.code ?? "PREFLIGHT_FAILED"));
    return preflightSnapshot;
  }

  function getHostServiceStatus() {
    if (!service) return null;
    try {
      return service.getStatus();
    } catch {
      return null;
    }
  }

  function synchronizeServiceLifecycle() {
    const current = getHostServiceStatus();
    if (current?.state === "failed" && state !== "failed") {
      state = "failed";
      lastFailureCode ??= "HOST_SERVICE_FAILED";
      emitDiagnostic("host_service_failed", lastFailureCode);
    } else if (current?.state === "closed" && state === "running") {
      state = "closed";
      emitDiagnostic("host_service_closed", "HOST_SERVICE_CLOSED");
    }
    return current;
  }

  function getLiveness() {
    synchronizeServiceLifecycle();
    const alive = !["failed", "closed"].includes(state);
    return Object.freeze({
      status: alive ? "alive" : "not_alive",
      alive,
      state
    });
  }

  async function readinessChecks() {
    const checks = [];
    const current = synchronizeServiceLifecycle();
    const currentHost = current?.host ?? hostStatus;
    const running = state === "running" && current?.state === "running";
    checks.push(freezeCheck("service-running", running));
    const runtimeState = currentHost?.runtime?.state;
    checks.push(freezeCheck("runtime-ready", runtimeState === "ready" || runtimeState === "running"));
    checks.push(freezeCheck("supervisor-running", currentHost?.supervisor?.state === "running"));
    checks.push(freezeCheck("runner-running", currentHost?.runner?.state === "running"));
    checks.push(freezeCheck("queue-persistent", currentHost?.queuePersistenceEnabled === true));
    checks.push(freezeCheck("event-journal-persistent", currentHost?.eventJournalPersistenceEnabled === true));

    try {
      inspectStorageDirectory(storageDirectory, {
        windowsStorageSecurityVerifier,
        expectedWindowsServiceSid: config.expectedWindowsServiceSid
      });
      checks.push(freezeCheck("storage-directory-secure", true));
    } catch (error) {
      checks.push(freezeCheck("storage-directory-secure", false, safeErrorCode(error)));
    }
    const jobsLock = join(storageDirectory, "execution-jobs.json.lock");
    const eventsLock = join(storageDirectory, "execution-events.json.lock");
    const locksHeld = Boolean(currentHost) && inspectOwnedLock(jobsLock) && inspectOwnedLock(eventsLock);
    checks.push(freezeCheck("persistent-locks-owned", locksHeld));

    try {
      const ledger = host ? await host.verifyLedger() : null;
      checks.push(freezeCheck("execution-ledger-valid",
        ledger?.valid === true && Number.isSafeInteger(ledger.entries) && ledger.entries >= 0));
    } catch (error) {
      checks.push(freezeCheck("execution-ledger-valid", false, safeErrorCode(error)));
    }
    return checks;
  }

  async function getReadiness() {
    const checks = await readinessChecks();
    const ready = state === "running" && checks.every(check => check.status === "passed");
    return Object.freeze({
      status: ready ? "ready" : "not_ready",
      ready,
      state,
      checks: Object.freeze(checks)
    });
  }

  async function getDiagnostics() {
    const current = synchronizeServiceLifecycle();
    const currentHost = current?.host ?? hostStatus;
    const readiness = await getReadiness();
    let recentEvents = [];
    try {
      if (host && state !== "closed") {
        recentEvents = host.listEvents({ limit: 20 }).map(sanitizeEvent).filter(Boolean);
      }
    } catch {
      recentEvents = [];
    }

    return Object.freeze({
      generatedAt: new Date().toISOString(),
      component: "jb-expert-qa-autonomous-host",
      state,
      liveness: getLiveness(),
      readiness,
      preflight: preflightSnapshot,
      engineCount: preflightSnapshot?.engineCount ?? 0,
      allowedEngineCount: preflightSnapshot?.allowedEngineCount ?? 0,
      policyId: preflightSnapshot?.policyId ?? null,
      queue: currentHost?.queue ? Object.freeze({
        queued: currentHost.queue.queued ?? 0,
        running: currentHost.queue.running ?? 0,
        completed: currentHost.queue.completed ?? 0,
        failed: currentHost.queue.failed ?? 0,
        interrupted: currentHost.queue.interrupted ?? 0
      }) : null,
      ledger: currentHost ? Object.freeze({
        verified: readiness.checks.some(check => check.name === "execution-ledger-valid" && check.status === "passed")
      }) : null,
      lastFailureCode,
      recentDiagnostics: Object.freeze([...recentDiagnostics]),
      recentEvents: Object.freeze(recentEvents)
    });
  }

  function assertRunning() {
    if (state !== "running" || !host) {
      throw new AutonomousExecutionHostBootstrapError("BOOTSTRAP_NOT_RUNNING", "host bootstrap is not running");
    }
  }

  async function start() {
    if (state === "running") return await getStatus();
    if (state !== "idle") {
      throw new AutonomousExecutionHostBootstrapError("BOOTSTRAP_TERMINAL", "host bootstrap cannot be restarted after stopping or failure");
    }
    state = "starting";
    try {
      const report = await runPreflight();
      if (!report.passed) {
        throw new AutonomousExecutionHostBootstrapError(
          report.failures[0] ?? "PREFLIGHT_FAILED",
          "host bootstrap preflight did not pass"
        );
      }

      host = createAutonomousExecutionHost({
        orchestrator,
        storageDirectory: resolve(storageDirectory),
        enabled: true,
        ...hostOptions
      });
      hostStatus = host.getStatus();
      if (hostStatus.queuePersistenceEnabled !== true || hostStatus.eventJournalPersistenceEnabled !== true) {
        throw new AutonomousExecutionHostBootstrapError("PERSISTENCE_NOT_READY", "persistent queue and event journal are required");
      }
      if (!inspectOwnedLock(join(storageDirectory, "execution-jobs.json.lock")) ||
          !inspectOwnedLock(join(storageDirectory, "execution-events.json.lock"))) {
        throw new AutonomousExecutionHostBootstrapError("PERSISTENT_LOCK_NOT_OWNED", "host did not acquire both persistent store locks");
      }
      const hostLedger = await host.verifyLedger();
      if (!hostLedger || hostLedger.valid !== true) {
        throw new AutonomousExecutionHostBootstrapError("EXECUTION_LEDGER_INVALID", "host execution ledger verification failed");
      }

      service = createAutonomousExecutionHostService({
        host,
        signalSource,
        ...(config.signals === undefined ? {} : { signals: config.signals }),
        onError: error => {
          const code = safeErrorCode(error);
          lastFailureCode = code;
          emitDiagnostic("service_error", code);
        }
      });
      service.start();
      hostStatus = service.getStatus().host;
      state = "running";
      emitDiagnostic("host_started", "HOST_STARTED");
      return await getStatus();
    } catch (error) {
      const code = safeErrorCode(error);
      lastFailureCode = code;
      emitDiagnostic("bootstrap_failed", code);
      try {
        if (service) await service.stop();
        else if (host) await host.close();
      } catch {
        emitDiagnostic("bootstrap_cleanup_failed", "BOOTSTRAP_CLEANUP_FAILED");
      }
      state = "failed";
      throw new AutonomousExecutionHostBootstrapError(code, "host bootstrap failed; inspect sanitized diagnostics");
    }
  }

  async function stop() {
    if (stopPromise) return stopPromise;
    if (state === "closed") return getStatus();
    state = "stopping";
    stopPromise = (async () => {
      try {
        if (service) await service.stop();
        else if (host) await host.close();
        state = "closed";
        emitDiagnostic("host_stopped", "HOST_STOPPED");
        return await getStatus();
      } catch (error) {
        lastFailureCode = safeErrorCode(error);
        state = "failed";
        emitDiagnostic("shutdown_failed", lastFailureCode);
        throw new AutonomousExecutionHostBootstrapError(lastFailureCode, "host shutdown failed; inspect sanitized diagnostics");
      }
    })();
    return stopPromise;
  }

  async function getStatus() {
    const current = synchronizeServiceLifecycle();
    const readiness = await getReadiness();
    return Object.freeze({
      state,
      enabled: true,
      started: state === "running",
      host: current ? Object.freeze({
        state: current.state,
        runtimeState: current.host?.runtime?.state ?? "unavailable",
        supervisorState: current.host?.supervisor?.state ?? "unavailable",
        runnerState: current.host?.runner?.state ?? "unavailable",
        queuePersistenceEnabled: current.host?.queuePersistenceEnabled === true,
        eventJournalPersistenceEnabled: current.host?.eventJournalPersistenceEnabled === true
      }) : null,
      preflight: preflightSnapshot,
      liveness: getLiveness(),
      readiness,
      lastFailureCode
    });
  }

  function enqueue(plan, jobOptions = {}) {
    assertRunning();
    return host.enqueue(plan, jobOptions);
  }

  function getJob(id) {
    assertRunning();
    return host.getJob(id);
  }

  function listJobs(query = {}) {
    assertRunning();
    return host.listJobs(query);
  }

  function recoverInterrupted(id) {
    assertRunning();
    const result = host.recoverInterrupted(id);
    emitDiagnostic("manual_interrupted_job_recovery", "OPERATOR_RECOVERY_REQUESTED");
    return result;
  }

  function failInterrupted(id, reason) {
    assertRunning();
    const result = host.failInterrupted(id, reason);
    emitDiagnostic("manual_interrupted_job_disposition", "OPERATOR_DISPOSITION_REQUESTED");
    return result;
  }

  function retryFailed(id, retryOptions = {}) {
    assertRunning();
    const result = host.retryFailed(id, retryOptions);
    emitDiagnostic("manual_failed_job_retry", "OPERATOR_RETRY_REQUESTED");
    return result;
  }

  function listEvents(query = {}) {
    assertRunning();
    return host.listEvents(query).map(sanitizeEvent).filter(Boolean);
  }

  return Object.freeze({
    preflight: runPreflight,
    start,
    stop,
    getStatus,
    getReadiness,
    getLiveness,
    getDiagnostics,
    enqueue,
    getJob,
    listJobs,
    recoverInterrupted,
    failInterrupted,
    retryFailed,
    listEvents
  });
}

/** Explicit application-owned service entrypoint; importing this module starts nothing. */
export async function bootstrapAutonomousExecutionHost(options = {}) {
  const bootstrap = createAutonomousExecutionHostBootstrap(options);
  await bootstrap.start();
  return bootstrap;
}
