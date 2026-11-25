import path from "node:path";

export class AutonomousExecutionServiceDeploymentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AutonomousExecutionServiceDeploymentError";
    this.code = code;
  }
}

function readOptions(value, label, allowedKeys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AutonomousExecutionServiceDeploymentError("INVALID_OPTIONS", label + " must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AutonomousExecutionServiceDeploymentError("INVALID_OPTIONS", label + " must be a plain object");
  }
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      throw new AutonomousExecutionServiceDeploymentError("UNSUPPORTED_OPTION", label + " contains an unsupported field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new AutonomousExecutionServiceDeploymentError("ACCESSOR_NOT_ALLOWED", label + " cannot contain getters or setters");
    }
    output[key] = descriptor.value;
  }
  return output;
}

function requiredText(value, label, pattern, maxLength) {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength ||
      !pattern.test(value)) {
    throw new AutonomousExecutionServiceDeploymentError("INVALID_" + label.toUpperCase().replace(/[^A-Z0-9]+/gu, "_"),
      label + " has an invalid format");
  }
  return value;
}

function validatePosixPath(value, label) {
  if (typeof value !== "string" || !path.posix.isAbsolute(value) ||
      !/^[A-Za-z0-9_./-]+$/u.test(value) ||
      path.posix.normalize(value) !== value || value === "/" || value.endsWith("/")) {
    throw new AutonomousExecutionServiceDeploymentError("INVALID_PATH", label + " must be a normalized absolute POSIX path without whitespace or shell metacharacters");
  }
  return value;
}

function validateWindowsPath(value, label) {
  if (typeof value !== "string" || !path.win32.isAbsolute(value) ||
      !/^[A-Za-z]:\\/u.test(value) ||
       /[\u0000-\u001F\u007F"%<>]/u.test(value) ||
      path.win32.normalize(value) !== value || value.endsWith("\\")) {
    throw new AutonomousExecutionServiceDeploymentError("INVALID_PATH", label + " must be a normalized absolute local Windows path without environment expansion or command delimiters");
  }
  return value;
}

function boundedInteger(value, label, minimum, maximum, fallback) {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new AutonomousExecutionServiceDeploymentError("INVALID_" + label.toUpperCase().replace(/[^A-Z0-9]+/gu, "_"),
      label + " must be an integer from " + minimum + " to " + maximum);
  }
  return normalized;
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

/**
 * Render a conservative systemd unit for an already-provisioned Node.js host.
 * This is pure configuration generation: it never writes files or invokes
 * systemctl, sudo, useradd, chmod or any other operating-system command.
 */
export function createSystemdHostServiceProfile(options = {}) {
  const config = readOptions(options, "systemd options", new Set([
    "unitName", "description", "nodeExecutable", "entryPoint",
    "workingDirectory", "storageDirectory", "serviceUser", "serviceGroup",
    "restartPolicy", "restartDelaySeconds", "startLimitBurst",
    "startLimitIntervalSeconds", "stopTimeoutSeconds"
  ]));

  const unitName = requiredText(config.unitName ?? "jb-expert-qa.service", "unit name",
    /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,100}\.service$/u, 109);
  const description = requiredText(
    config.description ?? "JB Expert QA autonomous execution host",
    "description", /^[A-Za-z0-9][A-Za-z0-9 .,_()/-]{0,119}$/u, 120
  );
  const nodeExecutable = validatePosixPath(config.nodeExecutable ?? "/usr/bin/node", "nodeExecutable");
  const entryPoint = validatePosixPath(config.entryPoint, "entryPoint");
  const workingDirectory = validatePosixPath(config.workingDirectory, "workingDirectory");
  const storageDirectory = validatePosixPath(config.storageDirectory, "storageDirectory");
  const serviceUser = requiredText(config.serviceUser, "service user",
    /^(?!root$)[a-z_][a-z0-9_-]{0,31}$/u, 32);
  const serviceGroup = requiredText(config.serviceGroup, "service group",
    /^(?!root$)[a-z_][a-z0-9_-]{0,31}$/u, 32);

  const restartPolicy = config.restartPolicy ?? "on-failure";
  if (!["on-failure", "no"].includes(restartPolicy)) {
    throw new AutonomousExecutionServiceDeploymentError("INVALID_RESTART_POLICY", "restartPolicy must be on-failure or no");
  }
  const restartDelaySeconds = boundedInteger(config.restartDelaySeconds, "restart delay", 1, 300, 10);
  const startLimitBurst = boundedInteger(config.startLimitBurst, "start limit burst", 1, 10, 3);
  const startLimitIntervalSeconds = boundedInteger(config.startLimitIntervalSeconds, "start limit interval", 10, 3600, 300);
  const stopTimeoutSeconds = boundedInteger(config.stopTimeoutSeconds, "stop timeout", 5, 300, 90);

  const unit = [
    "[Unit]",
    "Description=" + description,
    "After=network.target",
    "StartLimitIntervalSec=" + startLimitIntervalSeconds + "s",
    "StartLimitBurst=" + startLimitBurst,
    "",
    "[Service]",
    "Type=simple",
    "User=" + serviceUser,
    "Group=" + serviceGroup,
    "WorkingDirectory=" + workingDirectory,
    "Environment=NODE_ENV=production",
    "Environment=JB_EXPERT_QA_STORAGE_DIRECTORY=" + storageDirectory,
    "ExecStart=" + nodeExecutable + " " + entryPoint,
    "Restart=" + restartPolicy,
    "RestartSec=" + restartDelaySeconds + "s",
    "TimeoutStopSec=" + stopTimeoutSeconds + "s",
    "KillSignal=SIGTERM",
    "KillMode=mixed",
    "UMask=0077",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "ProtectSystem=strict",
    "ProtectHome=true",
    "ReadWritePaths=" + storageDirectory,
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    ""
  ].join("\n");

  return Object.freeze({
    platform: "linux-systemd",
    fileName: unitName,
    content: unit,
    serviceUser,
    serviceGroup,
    storageDirectory,
    restartPolicy,
    restartLimit: Object.freeze({
      burst: startLimitBurst,
      intervalSeconds: startLimitIntervalSeconds
    }),
    stopTimeoutSeconds
  });
}

/**
 * Render a WinSW v3 XML profile for the Windows Service Control Manager.
 * The operator must supply and verify the external WinSW wrapper binary.
 * This factory never installs or starts a Windows service.
 */
export function createWindowsHostServiceProfile(options = {}) {
  const config = readOptions(options, "Windows options", new Set([
    "serviceId", "displayName", "description", "nodeExecutable",
    "entryPoint", "workingDirectory", "storageDirectory", "logDirectory",
    "startMode", "delayedAutoStart", "restartDelaysSeconds", "stopTimeoutSeconds"
  ]));

  const serviceId = requiredText(config.serviceId ?? "JBExpertQA",
    "service ID", /^[A-Za-z0-9]{1,80}$/u, 80);
  const displayName = requiredText(config.displayName ?? "JB Expert QA Autonomous Host",
    "display name", /^[^\u0000-\u001F\u007F<>]{1,120}$/u, 120);
  const description = requiredText(config.description ?? "JB Expert QA local autonomous execution host",
    "description", /^[^\u0000-\u001F\u007F]{1,240}$/u, 240);
  const nodeExecutable = validateWindowsPath(config.nodeExecutable, "nodeExecutable");
  const entryPoint = validateWindowsPath(config.entryPoint, "entryPoint");
  const workingDirectory = validateWindowsPath(config.workingDirectory, "workingDirectory");
  const storageDirectory = validateWindowsPath(config.storageDirectory, "storageDirectory");
  const logDirectory = validateWindowsPath(
    config.logDirectory ?? path.win32.join(storageDirectory, "logs"),
    "logDirectory"
  );

  const startMode = config.startMode ?? "Automatic";
  if (!["Automatic", "Manual"].includes(startMode)) {
    throw new AutonomousExecutionServiceDeploymentError("INVALID_START_MODE", "startMode must be Automatic or Manual");
  }
  const delayedAutoStart = config.delayedAutoStart ?? (startMode === "Automatic");
  if (typeof delayedAutoStart !== "boolean" || (startMode === "Manual" && delayedAutoStart)) {
    throw new AutonomousExecutionServiceDeploymentError("INVALID_DELAYED_START", "delayedAutoStart must be boolean and cannot be enabled for Manual start mode");
  }
  const stopTimeoutSeconds = boundedInteger(config.stopTimeoutSeconds, "stop timeout", 5, 300, 90);
  const restartDelays = config.restartDelaysSeconds ?? [10, 30];
  if (!Array.isArray(restartDelays) || restartDelays.length > 5 ||
      restartDelays.some(delay => !Number.isSafeInteger(delay) || delay < 1 || delay > 3600)) {
    throw new AutonomousExecutionServiceDeploymentError("INVALID_RESTART_DELAYS", "restartDelaysSeconds must contain at most five integer delays from 1 to 3600 seconds");
  }

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<service>",
    "  <id>" + xmlEscape(serviceId) + "</id>",
    "  <name>" + xmlEscape(displayName) + "</name>",
    "  <description>" + xmlEscape(description) + "</description>",
    "  <executable>" + xmlEscape(nodeExecutable) + "</executable>",
    "  <arguments>\"" + xmlEscape(entryPoint) + "\"</arguments>",
    "  <workingdirectory>" + xmlEscape(workingDirectory) + "</workingdirectory>",
    "  <startmode>" + startMode + "</startmode>",
    ...(startMode === "Automatic" ? ["  <delayedAutoStart>" + delayedAutoStart + "</delayedAutoStart>"] : []),
    "  <stoptimeout>" + stopTimeoutSeconds + "sec</stoptimeout>",
    "  <logpath>" + xmlEscape(logDirectory) + "</logpath>",
    '  <log mode="roll" />',
    "  <hidewindow>true</hidewindow>",
    '  <env name="NODE_ENV" value="production" />',
    '  <env name="JB_EXPERT_QA_STORAGE_DIRECTORY" value="' + xmlEscape(storageDirectory) + '" />',
    ...restartDelays.map(delay => '  <onfailure action="restart" delay="' + delay + ' sec" />'),
    '  <onfailure action="none" />',
    "</service>",
    ""
  ].join("\n");

  return Object.freeze({
    platform: "windows-scm",
    fileName: serviceId + ".xml",
    wrapper: "WinSW v3 (operator-supplied and separately verified)",
    content: xml,
    serviceId,
    storageDirectory,
    logDirectory,
    startMode,
    delayedAutoStart,
    restartDelaysSeconds: Object.freeze([...restartDelays]),
    restartExhaustionAction: "none",
    stopTimeoutSeconds
  });
}
