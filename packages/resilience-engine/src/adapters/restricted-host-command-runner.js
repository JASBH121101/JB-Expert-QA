import { execFile as nodeExecFile } from "node:child_process";
import path from "node:path";

const SERVICE_ID = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/;
const PLATFORM_CONFIG = Object.freeze({
  "linux-systemd": Object.freeze({
    binaryKey: "systemctl",
    posix: true
  }),
  "windows-scm": Object.freeze({
    binaryKey: "sc.exe",
    posix: false
  })
});
const MAX_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 16 * 1024;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed, label) {
  const keys = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError(label + " contains missing or unsupported fields");
  }
}

function safeEnvironment(platform, configuredWindowsSystemRoot) {
  if (platform === "linux-systemd") {
    return Object.freeze({
      PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
      LANG: "C",
      LC_ALL: "C"
    });
  }
  const systemRoot = configuredWindowsSystemRoot ?? process.env.SystemRoot ?? process.env.WINDIR;
  if (typeof systemRoot !== "string" || !path.win32.isAbsolute(systemRoot) ||
      /[\r\n]/.test(systemRoot)) {
    throw new Error("Windows SystemRoot is unavailable; refusing to launch the service manager");
  }
  return Object.freeze({
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    PATH: path.win32.join(systemRoot, "System32")
  });
}

function validateInvocation(platform, executable, args, allowedServices) {
  if (typeof executable !== "string" || !Array.isArray(args) ||
      args.some((argument) => typeof argument !== "string" || /[\0\r\n]/.test(argument))) {
    throw new TypeError("host command invocation is invalid");
  }
  const serviceId = platform === "linux-systemd"
    ? (args.length === 2 && args[0] === "restart" ? args[1]
      : args.length === 3 && args[0] === "is-active" && args[1] === "--quiet" ? args[2] : null)
    : (args.length === 2 && ["query", "stop", "start"].includes(args[0]) ? args[1] : null);
  const expectedExecutable = PLATFORM_CONFIG[platform].binaryKey;
  if (executable !== expectedExecutable || !serviceId || !SERVICE_ID.test(serviceId) ||
      !allowedServices.has(serviceId)) {
    throw new Error("host command is outside the fixed service-manager operation allowlist");
  }
}

function boundedOutput(value) {
  const normalized = String(value ?? "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  return Buffer.from(normalized, "utf8").subarray(0, MAX_OUTPUT_BYTES).toString("utf8");
}

/**
 * Creates an execFile-only runner for the two existing typed service adapters.
 *
 * The runner is deliberately narrower than a general command executor:
 * only fixed systemctl/sc.exe operations against exact allowlisted services
 * are accepted. It never uses a shell, sudo, runas, dynamic executable paths,
 * caller-provided environment variables, or arbitrary command arguments.
 */
export function createRestrictedHostCommandRunner({
  platform,
  binaries,
  allowedServices = [],
  timeoutMs = 10_000,
  execFileImpl = nodeExecFile,
  windowsSystemRoot
} = {}) {
  const config = PLATFORM_CONFIG[platform];
  if (!config) throw new TypeError("platform must be linux-systemd or windows-scm");
  if (!isRecord(binaries)) throw new TypeError("binaries must provide the fixed platform executable path");
  exactKeys(binaries, [config.binaryKey], "binaries");
  const executable = binaries[config.binaryKey];
  const pathApi = config.posix ? path.posix : path.win32;
  if (typeof executable !== "string" || !pathApi.isAbsolute(executable) ||
      /[\r\n\0]/.test(executable)) {
    throw new TypeError("service-manager executable must be an absolute, fixed path");
  }
  if (!Array.isArray(allowedServices) || allowedServices.length < 1 ||
      allowedServices.some((serviceId) => typeof serviceId !== "string" || !SERVICE_ID.test(serviceId)) ||
      new Set(allowedServices).size !== allowedServices.length) {
    throw new TypeError("allowedServices must contain unique valid service names");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError("timeoutMs must be between 100 and 60000");
  }
  if (typeof execFileImpl !== "function") throw new TypeError("execFileImpl must be a function");

  const allowed = new Set(allowedServices);
  const env = safeEnvironment(platform, windowsSystemRoot);

  function run(command, args, options = {}) {
    if (!isRecord(options)) throw new TypeError("host command options must be a plain object");
    const optionKeys = Object.keys(options);
    if (optionKeys.some((key) => !["shell", "timeoutMs", "windowsHide"].includes(key))) {
      throw new TypeError("host command options contain unsupported fields");
    }
    if (options.shell !== false) throw new Error("shell execution is prohibited");
    if (options.timeoutMs !== undefined &&
        (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 100)) {
      throw new TypeError("command timeout must be a positive safe integer of at least 100 ms");
    }
    if (options.windowsHide !== undefined && typeof options.windowsHide !== "boolean") {
      throw new TypeError("windowsHide must be boolean");
    }

    validateInvocation(platform, command, args, allowed);
    const effectiveTimeout = Math.min(options.timeoutMs ?? timeoutMs, timeoutMs);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (error, stdout, stderr) => {
        if (settled) return;
        settled = true;
        const numericExitCode = Number.isSafeInteger(error?.code) ? error.code : null;
        const timedOut = error?.code === "ETIMEDOUT";
        const reason = !error ? null
          : timedOut ? "timeout"
          : error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "output-limit"
          : "command-failed";
        resolve(Object.freeze({
          exitCode: error ? numericExitCode ?? 1 : 0,
          stdout: boundedOutput(stdout),
          stderr: boundedOutput(stderr),
          timedOut,
          reason,
          status: error ? timedOut ? "timed_out" : "failed" : "succeeded"
        }));
      };

      try {
        execFileImpl(executable, [...args], {
          shell: false,
          timeout: effectiveTimeout,
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
          env
        }, finish);
      } catch (error) {
        finish(error, "", "");
      }
    });
  }

  return Object.freeze({
    platform,
    allowedServiceCount: allowed.size,
    timeoutMs,
    run
  });
}
