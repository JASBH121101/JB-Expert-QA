import { execFileSync } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { validateWindowsStorageSecurityReport, WindowsStorageSecurityError } from "./windows-storage-security.js";

const SERVICE_SIDS = new Set(["S-1-5-19", "S-1-5-20"]);


/**
 * Query the effective process SID and the complete NTFS directory DACL using
 * Windows PowerShell and .NET security APIs. This function is read-only:
 * it never changes ownership, inheritance, ACEs, or directory permissions.
 *
 * The directory value is passed to PowerShell as UTF-16LE base64 data, not
 * interpolated into executable script text. PowerShell is invoked without a
 * shell, with a fixed script, a bounded timeout, and a bounded output buffer.
 */
export function readWindowsStorageSecurityReport({ directory, expectedServiceSid } = {}) {
  if (!SERVICE_SIDS.has(expectedServiceSid)) {
    throw new WindowsStorageSecurityError("WINDOWS_STORAGE_SECURITY_CONFIGURATION_INVALID",
      "a supported Windows service SID is required");
  }
  if (process.platform !== "win32") {
    throw new WindowsStorageSecurityError("WINDOWS_STORAGE_SECURITY_PLATFORM_UNSUPPORTED",
      "Windows storage security inspection is available only on Windows");
  }
  if (typeof directory !== "string" || !isAbsolute(directory) || !/^[A-Za-z]:\\/u.test(directory) || directory.length > 4096 || directory.includes("\0")) {
    throw new WindowsStorageSecurityError("WINDOWS_STORAGE_SECURITY_CONFIGURATION_INVALID",
      "an absolute local Windows directory is required");
  }

  const encodedPath = Buffer.from(directory, "utf16le").toString("base64");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$path = [System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String('" + encodedPath + "'))",
    "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()",
    "$acl = Get-Acl -LiteralPath $path",
    "$ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value",
    "$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))",
    "$entries = @(",
    "  foreach ($rule in $rules) {",
    "    $rights = [int]$rule.FileSystemRights",
    "    $full = [int][System.Security.AccessControl.FileSystemRights]::FullControl",
    "    $modify = [int][System.Security.AccessControl.FileSystemRights]::Modify",
    "    if (($rights -band $full) -eq $full) { $access = 'full-control' }",
    "    elseif (($rights -band $modify) -eq $modify) { $access = 'modify' }",
    "    else { $access = 'read' }",
    "    [PSCustomObject]@{",
    "      sid = $rule.IdentityReference.Value",
    "      type = $rule.AccessControlType.ToString().ToLowerInvariant()",
    "      access = $access",
    "      inherited = [bool]$rule.IsInherited",
    "      containerInherit = [bool]($rule.InheritanceFlags -band [System.Security.AccessControl.InheritanceFlags]::ContainerInherit)",
    "      objectInherit = [bool]($rule.InheritanceFlags -band [System.Security.AccessControl.InheritanceFlags]::ObjectInherit)",
    "      inheritOnly = [bool]($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly)",
    "    }",
    "  }",
    ")",
    "[PSCustomObject]@{",
    "  directory = $path",
    "  processIdentitySid = $identity.User.Value",
    "  ownerSid = $ownerSid",
    "  daclProtected = [bool]$acl.AreAccessRulesProtected",
    "  accessEntries = @($entries)",
    "} | ConvertTo-Json -Depth 5 -Compress"
  ].join("\n");
  const encodedCommand = Buffer.from(script, "utf16le").toString("base64");

  let output;
  try {
    const windowsRoot = process.env.SystemRoot || "C:\\Windows";
    const powershellExecutable = join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (!isAbsolute(powershellExecutable)) throw new Error("invalid Windows PowerShell path");
    output = execFileSync(powershellExecutable, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand
    ], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 32768,
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    throw new WindowsStorageSecurityError("WINDOWS_STORAGE_SECURITY_QUERY_FAILED",
      "Windows identity or storage ACL inspection failed");
  }

  try {
    const report = JSON.parse(String(output).replace(/^\uFEFF/u, "").trim());
    if (!report || report.directory !== directory || report.processIdentitySid !== expectedServiceSid) {
      throw new Error("unexpected identity or path");
    }
    return report;
  } catch {
    throw new WindowsStorageSecurityError("WINDOWS_STORAGE_SECURITY_REPORT_INVALID",
      "Windows identity or storage ACL inspection returned an invalid report");
  }
}

export { validateWindowsStorageSecurityReport, WindowsStorageSecurityError };