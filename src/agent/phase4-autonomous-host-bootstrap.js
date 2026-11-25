import { createQaEngineRegistry } from "../engine-registry/index.js";
import { createQaEngineOrchestrator } from "../engine-registry/orchestrator.js";
import { registerApiTestingEngine } from "../engine-registry/adapters/api-testing.js";
import { registerStaticQaEngine } from "../engine-registry/adapters/static-qa.js";
import { registerStaticSecurityQaEngine } from "../engine-registry/adapters/static-security-qa.js";
import { registerRuntimeSecurityQaEngine } from "../engine-registry/adapters/runtime-security-qa.js";
import { registerAccessibilityQaEngine } from "../engine-registry/adapters/accessibility-qa.js";
import { registerPerformanceQaEngine } from "../engine-registry/adapters/performance-qa.js";
import { registerVisualQaEngine } from "../engine-registry/adapters/visual-qa.js";
import { registerReportCertificationEngine } from "../engine-registry/adapters/report-certification.js";
import { createAutonomousExecutionHostBootstrap } from "./autonomous-execution-host-bootstrap.js";

export class Phase4AutonomousHostIntegrationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "Phase4AutonomousHostIntegrationError";
    this.code = code;
  }
}

function readOptions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Phase4AutonomousHostIntegrationError("INVALID_OPTIONS", "options must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Phase4AutonomousHostIntegrationError("INVALID_OPTIONS", "options must be a plain object");
  }
  const allowed = new Set(["storageDirectory", "enabled", "signalSource", "apiAllowedOrigins", "policy", "requestApproval", "approvalGate", "signals", "hostOptions", "onDiagnostic", "windowsStorageSecurityVerifier", "expectedWindowsServiceSid"]);
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new Phase4AutonomousHostIntegrationError("UNSUPPORTED_OPTION", "options contain an unsupported field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new Phase4AutonomousHostIntegrationError("ACCESSOR_NOT_ALLOWED", "options cannot contain getters or setters");
    }
    output[key] = descriptor.value;
  }
  return output;
}

function readApprovalGate(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Phase4AutonomousHostIntegrationError("INVALID_APPROVAL_GATE", "approvalGate must be a trusted local approval gate");
  }
  const methods = Object.create(null);
  for (const name of ["requestApproval", "listPending", "getStatus", "approve", "deny"]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function") {
      throw new Phase4AutonomousHostIntegrationError("INVALID_APPROVAL_GATE", "approvalGate must expose its own " + name + "() method");
    }
    methods[name] = descriptor.value.bind(value);
  }
  return Object.freeze(methods);
}

function validateOrigins(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) {
    throw new Phase4AutonomousHostIntegrationError("API_ORIGIN_ALLOWLIST_REQUIRED", "apiAllowedOrigins must contain 1 to 128 explicit origins");
  }
  const origins = [];
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length > 2048) {
      throw new Phase4AutonomousHostIntegrationError("INVALID_API_ORIGIN", "API allowlist entries must be origin strings");
    }
    let parsed;
    try { parsed = new URL(entry); }
    catch { throw new Phase4AutonomousHostIntegrationError("INVALID_API_ORIGIN", "API allowlist contains an invalid origin"); }
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.origin !== entry ||
        parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash ||
        parsed.hostname === "*" || parsed.hostname.includes("*")) {
      throw new Phase4AutonomousHostIntegrationError("INVALID_API_ORIGIN", "API allowlist entries must be exact HTTP(S) origins without credentials, paths, query or wildcards");
    }
    if (seen.has(parsed.origin)) {
      throw new Phase4AutonomousHostIntegrationError("DUPLICATE_API_ORIGIN", "API allowlist origins must be unique");
    }
    seen.add(parsed.origin);
    origins.push(parsed.origin);
  }
  return Object.freeze(origins);
}

function buildSealedRegistry(apiAllowedOrigins) {
  const registry = createQaEngineRegistry();
  registerApiTestingEngine(registry, { allowedOrigins: apiAllowedOrigins });
  registerStaticQaEngine(registry);
  registerStaticSecurityQaEngine(registry);
  registerRuntimeSecurityQaEngine(registry);
  registerAccessibilityQaEngine(registry);
  registerPerformanceQaEngine(registry);
  registerVisualQaEngine(registry);
  registerReportCertificationEngine(registry);
  registry.seal();
  return registry;
}

/**
 * Creates an inert autonomous host wired to the trusted built-in Phase 4 QA catalog.
 * Policy, external human approval, API origin allowlist, local storage and signal
 * lifecycle are supplied by the embedding application. No engine is executed here.
 */
export function createPhase4AutonomousHostBootstrap(options = {}) {
  const config = readOptions(options);
  if (config.enabled !== true) {
    throw new Phase4AutonomousHostIntegrationError("HOST_ENABLE_OPT_IN_REQUIRED", "enabled: true must be explicitly supplied");
  }
  if (!config.policy || typeof config.policy !== "object" || Array.isArray(config.policy)) {
    throw new Phase4AutonomousHostIntegrationError("POLICY_REQUIRED", "a trusted host execution policy is required");
  }
  if (config.windowsStorageSecurityVerifier !== undefined && typeof config.windowsStorageSecurityVerifier !== "function") {
    throw new Phase4AutonomousHostIntegrationError("INVALID_WINDOWS_STORAGE_SECURITY_VERIFIER", "windowsStorageSecurityVerifier must be a function");
  }
  if (config.expectedWindowsServiceSid !== undefined &&
      !["S-1-5-19", "S-1-5-20"].includes(config.expectedWindowsServiceSid)) {
    throw new Phase4AutonomousHostIntegrationError("INVALID_WINDOWS_SERVICE_SID", "expectedWindowsServiceSid must identify LocalService or NetworkService");
  }
  if (config.windowsStorageSecurityVerifier !== undefined && config.expectedWindowsServiceSid === undefined) {
    throw new Phase4AutonomousHostIntegrationError("WINDOWS_STORAGE_SECURITY_CONFIGURATION_INVALID", "expectedWindowsServiceSid is required when a custom Windows storage verifier is supplied");
  }
  const approvalGate = config.approvalGate === undefined ? null : readApprovalGate(config.approvalGate);
  if (approvalGate && config.requestApproval !== undefined) {
    throw new Phase4AutonomousHostIntegrationError("APPROVAL_PROVIDER_CONFLICT", "provide approvalGate or requestApproval, not both");
  }
  const requestApproval = approvalGate?.requestApproval ?? config.requestApproval;
  if (typeof requestApproval !== "function") {
    throw new Phase4AutonomousHostIntegrationError("APPROVAL_PROVIDER_REQUIRED", "a real external approval provider or local approvalGate is required");
  }
  if (!config.signalSource || typeof config.signalSource.on !== "function" || typeof config.signalSource.off !== "function") {
    throw new Phase4AutonomousHostIntegrationError("SIGNAL_SOURCE_REQUIRED", "signalSource must expose on() and off()");
  }
  const apiAllowedOrigins = validateOrigins(config.apiAllowedOrigins);
  const registry = buildSealedRegistry(apiAllowedOrigins);
  const orchestrator = createQaEngineOrchestrator({
    registry,
    policy: config.policy,
    requestApproval
  });
  const bootstrap = createAutonomousExecutionHostBootstrap({
    orchestrator,
    storageDirectory: config.storageDirectory,
    enabled: true,
    signalSource: config.signalSource,
    ...(config.signals === undefined ? {} : { signals: config.signals }),
    ...(config.hostOptions === undefined ? {} : { hostOptions: config.hostOptions }),
    ...(config.onDiagnostic === undefined ? {} : { onDiagnostic: config.onDiagnostic }),
    ...(config.expectedWindowsServiceSid === undefined ? {} : {
      ...(config.windowsStorageSecurityVerifier === undefined ? {} : {
        windowsStorageSecurityVerifier: config.windowsStorageSecurityVerifier
      }),
      expectedWindowsServiceSid: config.expectedWindowsServiceSid
    })
  });
  return Object.freeze({
    registry,
    orchestrator,
    apiAllowedOrigins,
    bootstrap,
    preflight: bootstrap.preflight,
    start: bootstrap.start,
    stop: bootstrap.stop,
    getStatus: bootstrap.getStatus,
    getReadiness: bootstrap.getReadiness,
    getLiveness: bootstrap.getLiveness,
    getDiagnostics: bootstrap.getDiagnostics,
    enqueue: bootstrap.enqueue,
    getJob: bootstrap.getJob,
    listJobs: bootstrap.listJobs,
    listEvents: bootstrap.listEvents,
    ...(approvalGate ? {
      listApprovals: approvalGate.listPending,
      getApprovalStatus: approvalGate.getStatus,
      approveApproval: approvalGate.approve,
      denyApproval: approvalGate.deny
    } : {})
  });
}
