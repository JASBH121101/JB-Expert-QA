import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";

const SERVICE_SIDS = new Set(["S-1-5-19", "S-1-5-20"]);
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 15000;
const MAX_OUTPUT_BYTES = 65536;
const POWERSHELL_SOURCE = "$ErrorActionPreference = 'Stop'\n[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\ntry {\n  $directoryInput = [Environment]::GetEnvironmentVariable('JBQA_STORAGE_DIRECTORY')\n  $expectedServiceSid = [Environment]::GetEnvironmentVariable('JBQA_EXPECTED_SERVICE_SID')\n  if ([string]::IsNullOrWhiteSpace($directoryInput) -or $expectedServiceSid -notin @('S-1-5-19', 'S-1-5-20')) { throw 'invalid-input' }\n  $directory = [System.IO.Path]::GetFullPath($directoryInput)\n  if (-not [System.IO.Directory]::Exists($directory)) { throw 'directory-missing' }\n  $cursor = [System.IO.DirectoryInfo]::new($directory)\n  while ($null -ne $cursor) {\n    if (-not $cursor.Exists -or (($cursor.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'reparse-or-missing-directory' }\n    $cursor = $cursor.Parent\n  }\n  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()\n  if ($null -eq $identity.User) { throw 'process-identity-missing' }\n  $acl = Get-Acl -LiteralPath $directory\n  $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value\n  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))\n  $entries = @()\n  foreach ($rule in $rules) {\n    $accessType = if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow) { 'allow' } else { 'deny' }\n    $rights = [long]$rule.FileSystemRights\n    $fullControlRights = [long][System.Security.AccessControl.FileSystemRights]::FullControl\n    $modifyRights = [long][System.Security.AccessControl.FileSystemRights]::Modify\n    if ($rights -eq $fullControlRights) { $access = 'full-control' } elseif ($rights -eq $modifyRights) { $access = 'modify' } else { $access = 'unsupported' }\n    $entries += [ordered]@{ sid = $rule.IdentityReference.Value; type = $accessType; access = $access; inherited = [bool]$rule.IsInherited }\n  }\n  $result = [ordered]@{ directory = $directory; processIdentitySid = $identity.User.Value; ownerSid = $ownerSid; daclProtected = [bool]$acl.AreAccessRulesProtected; accessEntries = @($entries) }\n  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $result -Depth 5 -Compress))\n  $identity.Dispose()\n  exit 0\n} catch {\n  [Console]::Error.WriteLine('WINDOWS_STORAGE_INSPECTION_FAILED')\n  exit 20\n}";
const ENCODED_COMMAND = Buffer.from(POWERSHELL_SOURCE, "utf16le").toString("base64");

export class WindowsPowerShellStorageVerifierError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WindowsPowerShellStorageVerifierError";
    this.code = code;
  }
}

function readPlainRecord(value, allowedKeys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WindowsPowerShellStorageVerifierError("WINDOWS_STORAGE_VERIFIER_INVALID", label + " must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new WindowsPowerShellStorageVerifierError("WINDOWS_STORAGE_VERIFIER_INVALID", label + " must be a plain object");
  }
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      throw new WindowsPowerShellStorageVerifierError("WINDOWS_STORAGE_VERIFIER_INVALID", label + " contains an unsupported field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new WindowsPowerShellStorageVerifierError("WINDOWS_STORAGE_VERIFIER_INVALID", label + " cannot contain accessors");
    }
    output[key] = descriptor.value;
  }
  return output;
}

function getWindowsPowerShellPath() {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (typeof systemRoot !== "string" || !win32.isAbsolute(systemRoot) ||
      systemRoot.length > 512 || systemRoot.includes("\0")) {
    throw new WindowsPowerShellStorageVerifierError(
      "WINDOWS_POWERSHELL_UNAVAILABLE",
      "Windows system root is unavailable"
    );
  }
  const executable = win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  if (!existsSync(executable)) {
    throw new WindowsPowerShellStorageVerifierError(
      "WINDOWS_POWERSHELL_UNAVAILABLE",
      "Windows PowerShell 5.1 is unavailable"
    );
  }
  return executable;
}

/**
 * Creates an optional, read-only NTFS verifier for the Windows host bootstrap.
 *
 * The returned callback runs a fixed PowerShell 5.1 program with shell execution
 * disabled. Request data is passed through the child environment, never
 * interpolated into command source or arguments. The script performs no ACL
 * changes, directory creation, service installation or privilege elevation.
 */
export function createWindowsPowerShellStorageSecurityVerifier(options = {}) {
  const config = readPlainRecord(options, new Set(["timeoutMs"]), "options");
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new WindowsPowerShellStorageVerifierError(
      "WINDOWS_STORAGE_VERIFIER_INVALID",
      "timeoutMs must be an integer between 1000 and 15000"
    );
  }
  if (process.platform !== "win32") {
    throw new WindowsPowerShellStorageVerifierError(
      "WINDOWS_ONLY",
      "the native storage verifier is available only on Windows"
    );
  }

  const executable = getWindowsPowerShellPath();

  return function windowsStorageSecurityVerifier(input) {
    const request = readPlainRecord(
      input,
      new Set(["directory", "expectedServiceSid"]),
      "verification request"
    );
    if (typeof request.directory !== "string" ||
        request.directory.length < 3 ||
        request.directory.length > 4096 ||
        request.directory.includes("\0") ||
        !win32.isAbsolute(request.directory) ||
        !SERVICE_SIDS.has(request.expectedServiceSid)) {
      throw new WindowsPowerShellStorageVerifierError(
        "WINDOWS_STORAGE_VERIFIER_INVALID",
        "verification request contains an invalid directory or service SID"
      );
    }

    const env = {
      ...process.env,
      JBQA_STORAGE_DIRECTORY: request.directory,
      JBQA_EXPECTED_SERVICE_SID: request.expectedServiceSid
    };
    const result = spawnSync(executable, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      ENCODED_COMMAND
    ], {
      cwd: win32.dirname(executable),
      env,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });

    if (result.error || result.status !== 0 ||
        typeof result.stdout !== "string" ||
        result.stdout.length < 2 ||
        Buffer.byteLength(result.stdout, "utf8") > MAX_OUTPUT_BYTES) {
      throw new WindowsPowerShellStorageVerifierError(
        result.error?.code === "ETIMEDOUT"
          ? "WINDOWS_STORAGE_VERIFIER_TIMEOUT"
          : "WINDOWS_STORAGE_VERIFICATION_FAILED",
        "Windows token and NTFS ACL inspection failed"
      );
    }

    try {
      return JSON.parse(result.stdout.trim());
    } catch {
      throw new WindowsPowerShellStorageVerifierError(
        "WINDOWS_STORAGE_VERIFICATION_FAILED",
        "Windows security inspection returned an invalid report"
      );
    }
  };
}
