import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  copyFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createSystemdHostServiceProfile,
  createWindowsHostServiceProfile
} from "../src/agent/autonomous-execution-service-deployment.js";
import { readWindowsStorageSecurityReport } from "../src/agent/windows-storage-security-native.js";
import { validateWindowsStorageSecurityReport } from "../src/agent/windows-storage-security.js";

const execFileAsync = promisify(execFile);
const timeoutMs = 30_000;
const pollMs = 100;
const winSwUrl = "https://github.com/winsw/winsw/releases/download/v2.14.0/WinSW-x64.exe";
const winSwSha256 = "4ebd9dc3e817f80b2bd8c18f5bfe0d550241c1d08b57bd9694777a6e56a7b24f";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function command(executable, args, timeout = timeoutMs) {
  try {
    const result = await execFileAsync(executable, args, {
      timeout,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      shell: false
    });
    return {
      exitCode: 0,
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? "")
    };
  } catch (error) {
    const code = Number.isSafeInteger(error?.code) ? error.code
      : Number.isSafeInteger(error?.exitCode) ? error.exitCode : 1;
    return {
      exitCode: code,
      stdout: String(error?.stdout ?? ""),
      stderr: String(error?.stderr ?? error?.message ?? "")
    };
  }
}

function assertCommand(result, label) {
  if (result.exitCode !== 0) {
    throw new Error(label + " failed (exit " + result.exitCode + "): " +
      (result.stderr || result.stdout || "no command output"));
  }
  return result;
}

async function waitFor(check, label, timeout = timeoutMs) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() <= deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  throw new Error("Timed out waiting for " + label + (lastError ? ": " + lastError.message : ""));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function startupFiles(directory) {
  return readdirSync(directory)
    .filter(name => /^started-\d+\.json$/u.test(name))
    .sort()
    .map(name => join(directory, name));
}

async function startupRecordsAsRoot(directory, runPrivileged) {
  const listing = assertCommand(
    await runPrivileged("find", [directory, "-maxdepth", "1", "-type", "f", "-name", "started-*.json", "-print0"]),
    "list private host startup evidence"
  );
  const paths = listing.stdout.split("\0").filter(Boolean).sort();
  const records = [];
  for (const filePath of paths) {
    const body = assertCommand(await runPrivileged("cat", [filePath]), "read private host startup evidence");
    records.push(JSON.parse(body.stdout));
  }
  return records;
}

async function privateFileExistsAsRoot(filePath) {
  const result = await command("sudo", ["-n", "test", "-f", filePath], 10_000);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new Error("Could not inspect private host shutdown marker (exit " + result.exitCode + ")");
}

async function certifySystemd() {
  const suffix = String(process.env.GITHUB_RUN_ID ?? process.pid).replace(/[^0-9]/gu, "").slice(-12) || String(process.pid);
  const serviceId = "jbqa-profile-lab-" + suffix;
  const unitName = serviceId + ".service";
  const serviceUser = ("jbq" + suffix).slice(0, 31);
  const appDirectory = "/opt/" + serviceId;
  const storageDirectory = "/var/lib/" + serviceId;
  const fixtureSource = join(tmpdir(), serviceId + "-host.mjs");
  let accountCreated = false;
  let appCreated = false;
  let storageCreated = false;
  let unitInstalled = false;
  let firstPid = null;
  let secondPid = null;

  const privileged = async (executable, args, label = executable, timeout = timeoutMs) =>
    assertCommand(await command("sudo", ["-n", executable, ...args], timeout), label);

  const fixture = [
    'import { existsSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'const storage = process.env.JB_EXPERT_QA_STORAGE_DIRECTORY;',
    'if (!storage) throw new Error("missing host storage directory");',
    'const failing = existsSync(join(storage, "fail-on-start"));',
    'const record = { pid: process.pid, uid: process.getuid(), storage, node: process.version, failing }',
    'writeFileSync(join(storage, "started-" + process.pid + ".json"), JSON.stringify(record));',
    "if (failing) process.exit(23);",
    'function close(signal) {',
    '  writeFileSync(join(storage, "shutdown-" + process.pid + ".txt"), signal);',
    '  process.exit(0);',
    '}',
    'process.on("SIGTERM", () => close("SIGTERM"));',
    'process.on("SIGINT", () => close("SIGINT"));',
    'setInterval(() => {}, 60000);',
    ''
  ].join("\n");

  try {
    const version = assertCommand(await command("systemd-analyze", ["--version"]), "systemd-analyze --version");
    await privileged("useradd", [
      "--system", "--user-group", "--no-create-home",
      "--home-dir", "/nonexistent", "--shell", "/usr/sbin/nologin", serviceUser
    ], "create disposable non-root systemd identity");
    accountCreated = true;
    assertCommand(await privileged("install", ["-d", "-o", serviceUser, "-g", serviceUser, "-m", "0700", storageDirectory]),
      "create restricted systemd state directory");
    storageCreated = true;
    assertCommand(await privileged("install", ["-d", "-o", "root", "-g", "root", "-m", "0755", appDirectory]),
      "create read-only systemd application directory");
    appCreated = true;
    writeFileSync(fixtureSource, fixture, { mode: 0o600 });
    assertCommand(await privileged("install", ["-o", "root", "-g", "root", "-m", "0644", fixtureSource, join(appDirectory, "host.mjs")]),
      "install disposable Node.js host fixture");

    const stateStat = assertCommand(await command("stat", ["-c", "%U:%G:%a", storageDirectory]), "inspect systemd state directory permissions");
    assert(stateStat.stdout.trim() === serviceUser + ":" + serviceUser + ":700", "systemd state directory is not restricted to the service account");
    const appStat = assertCommand(await command("stat", ["-c", "%U:%G:%a", appDirectory]), "inspect systemd application directory permissions");
    assert(appStat.stdout.trim() === "root:root:755", "systemd application directory is not root-owned and read-only to the service identity");
    const profile = createSystemdHostServiceProfile({
      unitName,
      description: "JB Expert QA generated profile CI validation",
      nodeExecutable: process.execPath,
      entryPoint: join(appDirectory, "host.mjs"),
      workingDirectory: appDirectory,
      storageDirectory,
      serviceUser,
      serviceGroup: serviceUser,
      restartPolicy: "on-failure",
      restartDelaySeconds: 2,
      startLimitBurst: 3,
      startLimitIntervalSeconds: 120,
      stopTimeoutSeconds: 30
    });

    const profileSource = join(tmpdir(), unitName);
    writeFileSync(profileSource, profile.content, { mode: 0o600 });
    const verify = await command("systemd-analyze", ["verify", profileSource], 20_000);
    assertCommand(verify, "systemd-analyze verify generated unit");
    assertCommand(await privileged("install", ["-m", "0644", profileSource, "/etc/systemd/system/" + unitName]),
      "install disposable generated systemd unit");
    unitInstalled = true;
    assertCommand(await privileged("systemctl", ["daemon-reload"]), "systemd daemon-reload");
    const security = await command("systemd-analyze", ["security", "--no-pager", unitName], 20_000);
    assertCommand(security, "systemd-analyze security generated unit");
    assertCommand(await privileged("systemctl", ["enable", unitName]), "enable generated systemd unit");
    assertCommand(await privileged("systemctl", ["is-enabled", unitName]), "verify generated unit is enabled");
    assertCommand(await privileged("systemctl", ["start", unitName]), "start generated systemd unit");

    const first = await waitFor(async () => {
      const found = await startupRecordsAsRoot(storageDirectory, privileged);
      return found.length >= 1 ? found[0] : null;
    }, "first systemd host process start");
    firstPid = first.pid;
    assert(first.uid > 0, "systemd profile ran the host fixture as root");
    const expectedUidResult = assertCommand(await command("id", ["-u", serviceUser]), "resolve disposable systemd service UID");
    const expectedUid = Number(expectedUidResult.stdout.trim());
    assert(first.uid === expectedUid, "systemd process UID did not match the configured service user");
    assert(first.storage === storageDirectory, "systemd profile did not pass the configured storage directory");
    assertCommand(await privileged("systemctl", ["is-active", "--quiet", unitName]), "verify generated systemd service is active");

    assertCommand(await privileged("systemctl", ["restart", unitName]), "restart generated systemd unit");
    await waitFor(() => privateFileExistsAsRoot(join(storageDirectory, "shutdown-" + firstPid + ".txt")), "SIGTERM graceful shutdown marker after systemd restart");
    const second = await waitFor(async () => {
      const found = await startupRecordsAsRoot(storageDirectory, privileged);
      return found.find(item => item.pid !== firstPid) ?? null;
    }, "second systemd host process start");
    secondPid = second.pid;
    assert(secondPid !== firstPid, "systemd restart did not replace the host process");
    assertCommand(await privileged("systemctl", ["is-active", "--quiet", unitName]), "verify systemd service active after restart");

    assertCommand(await privileged("systemctl", ["stop", unitName]), "stop generated systemd unit");
    await waitFor(() => privateFileExistsAsRoot(join(storageDirectory, "shutdown-" + secondPid + ".txt")), "SIGTERM graceful shutdown marker after systemd stop");
    assertCommand(await privileged("systemctl", ["is-enabled", unitName]), "verify generated unit remains configured for boot start");

    await privileged("systemctl", ["reset-failed", unitName]);
    assertCommand(await privileged("install", ["-o", serviceUser, "-g", serviceUser, "-m", "0600", "/dev/null", join(storageDirectory, "fail-on-start")]),
      "enable intentional disposable failure fixture");
    await command("sudo", ["-n", "systemctl", "start", unitName], 20_000);
    await waitFor(async () => {
      const active = await privileged("systemctl", ["show", "--property=ActiveState", "--value", unitName]);
      return active.stdout.trim() === "failed";
    }, "systemd generated start-limit exhaustion", 25_000);
    const failedAttempts = (await startupRecordsAsRoot(storageDirectory, privileged)).filter(item => item.failing);
    assert(failedAttempts.length === profile.restartLimit.burst, "systemd start-limit burst was not enforced exactly");
    await privileged("systemctl", ["reset-failed", unitName]);

    return {
      platform: "linux-systemd",
      systemdVersion: version.stdout.split("\n")[0].trim(),
      unitName,
      serviceUser,
      serviceGroup: serviceUser,
      storageDirectory,
      profileSha256: createHash("sha256").update(profile.content).digest("hex"),
      stateDirectoryPermissions: stateStat.stdout.trim(),
      applicationDirectoryPermissions: appStat.stdout.trim(),
      effectiveUid: expectedUid,
      systemdAnalyzeVerify: "passed",
      systemdAnalyzeSecurity: "passed",
      enabledState: "enabled",
      startup: "passed",
      restart: "passed",
      gracefulSignal: "SIGTERM",
      pidBefore: firstPid,
      pidAfter: secondPid,
      finalState: "inactive",
      restartLimitAttempts: failedAttempts.length,
      restartLimitEnforced: true,
      interruptedJobReplay: false
    };
  } finally {
    if (unitInstalled) {
      await privileged("systemctl", ["stop", unitName]).catch(() => {});
      await privileged("systemctl", ["disable", unitName]).catch(() => {});
      await privileged("rm", ["-f", "/etc/systemd/system/" + unitName]).catch(() => {});
      await privileged("systemctl", ["daemon-reload"]).catch(() => {});
    }
    if (storageCreated) await privileged("rm", ["-rf", storageDirectory]).catch(() => {});
    if (appCreated) await privileged("rm", ["-rf", appDirectory]).catch(() => {});
    if (accountCreated) {
      await privileged("userdel", [serviceUser]).catch(() => {});
      await privileged("groupdel", [serviceUser]).catch(() => {});
    }
    rmSync(fixtureSource, { force: true });
  }
}

async function downloadVerifiedWinSw(directory) {
  const response = await fetch(winSwUrl, { redirect: "follow" });
  assert(response.ok, "WinSW v2.14.0 download returned HTTP " + response.status);
  const declaredSize = Number(response.headers.get("content-length") ?? 0);
  assert(declaredSize === 0 || declaredSize <= 25 * 1024 * 1024, "WinSW download exceeded the 25 MiB safety limit");
  const bytes = Buffer.from(await response.arrayBuffer());
  assert(bytes.length > 0 && bytes.length <= 25 * 1024 * 1024, "WinSW download size is invalid");
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert(digest === winSwSha256, "WinSW v2.14.0 SHA-256 did not match the pinned official release asset");
  const target = join(directory, "WinSW-x64-v2.14.0.exe");
  writeFileSync(target, bytes, { mode: 0o700 });
  return { path: target, sha256: digest, sizeBytes: bytes.length };
}

async function certifyWindowsScm() {
  const suffix = String(process.env.GITHUB_RUN_ID ?? process.pid).replace(/[^A-Za-z0-9]/gu, "").slice(-12) || String(process.pid);
  const serviceId = ("JBQAProfile" + suffix).slice(0, 80);
  const serviceRoot = join("C:\\ProgramData", "JBQAProfileLab" + suffix);
  const appDirectory = join(serviceRoot, "app");
  const storageDirectory = join(serviceRoot, "state");
  const logDirectory = join(serviceRoot, "logs");
  const wrapperDirectory = mkdtempSync(join(tmpdir(), "jbqa-winsw-profile-"));
  const wrapperPath = join(appDirectory, serviceId + ".exe");
  const wrapperConfig = join(appDirectory, serviceId + ".xml");
  let installAttempted = false;
  let installed = false;
  let wrapper = null;
  let firstPid = null;
  let secondPid = null;

  const icacls = async (path, permission) => {
    assertCommand(await command("icacls.exe", [
      path,
      "/grant",
      "NT AUTHORITY\\LOCAL SERVICE:(OI)(CI)" + permission
    ]), "set disposable Windows service ACL");
  };

  const configureProtectedStateAcl = async () => {
    assertCommand(await command("icacls.exe", [storageDirectory, "/inheritance:r"]),
      "remove inherited Windows state-directory ACL entries");
    assertCommand(await command("icacls.exe", [
      storageDirectory,
      "/grant:r",
      "*S-1-5-19:(OI)(CI)(M)",
      "*S-1-5-18:(OI)(CI)(F)",
      "*S-1-5-32-544:(OI)(CI)(F)"
    ]), "apply explicit protected Windows state-directory DACL");
    assertCommand(await command("icacls.exe", [storageDirectory, "/setowner", "*S-1-5-19"]),
      "set LocalService as Windows state-directory owner");
  };

  const fixture = [
    'import { existsSync, writeFileSync } from "node:fs";',
    'import { execFileSync } from "node:child_process";',
    'import { join } from "node:path";',
    'import { readWindowsStorageSecurityReport } from "./windows-storage-security-native.js";',
    'import { validateWindowsStorageSecurityReport } from "./windows-storage-security.js";',
    'const storage = process.env.JB_EXPERT_QA_STORAGE_DIRECTORY;',
    'if (!storage) throw new Error("missing host storage directory");',
    'const storageSecurityReport = readWindowsStorageSecurityReport({ directory: storage, expectedServiceSid: "S-1-5-19" });',
    'const storageSecurity = validateWindowsStorageSecurityReport(storageSecurityReport, { directory: storage, expectedServiceSid: "S-1-5-19" });',
    'const whoami = join(process.env.SystemRoot, "System32", "whoami.exe");',
    'const account = execFileSync(whoami, [], { encoding: "utf8" }).trim();',
    'const failing = existsSync(join(storage, "fail-on-start"));',
    'const record = { pid: process.pid, account, storage, node: process.version, failing, storageAclVerified: storageSecurity.permissionsVerified && storageSecurity.daclProtected, storageOwnerVerified: storageSecurity.ownerVerified, storageIdentityVerified: storageSecurity.identityVerified }',
    'writeFileSync(join(storage, "started-" + process.pid + ".json"), JSON.stringify(record));',
    "if (failing) process.exit(23);",
    'function close(signal) {',
    '  writeFileSync(join(storage, "shutdown-" + process.pid + ".txt"), signal);',
    '  process.exit(0);',
    '}',
    'process.on("SIGINT", () => close("SIGINT"));',
    'process.on("SIGTERM", () => close("SIGTERM"));',
    'setInterval(() => {}, 60000);',
    ''
  ].join("\n");

  try {
    mkdirSync(appDirectory, { recursive: true });
    mkdirSync(storageDirectory, { recursive: true });
    mkdirSync(logDirectory, { recursive: true });
    icacls(serviceRoot, "(OI)(CI)(RX)");
    icacls(appDirectory, "(OI)(CI)(RX)");
    await configureProtectedStateAcl();
    icacls(logDirectory, "(OI)(CI)(M)");

    const agentSourceDirectory = join(process.cwd(), "src", "agent");
    copyFileSync(join(agentSourceDirectory, "windows-storage-security-native.js"),
      join(appDirectory, "windows-storage-security-native.js"));
    copyFileSync(join(agentSourceDirectory, "windows-storage-security.js"),
      join(appDirectory, "windows-storage-security.js"));
    writeFileSync(join(appDirectory, "package.json"), JSON.stringify({ type: "module" }), { mode: 0o644 });
    const appAcl = assertCommand(await command("icacls.exe", [appDirectory]), "verify Windows application directory ACL");
    assert(/LOCAL SERVICE.*RX/iu.test(appAcl.stdout), "LocalService does not have read/execute access to the application directory");
    const storageAcl = assertCommand(await command("icacls.exe", [storageDirectory]), "verify Windows state directory ACL");
    assert(/LOCAL SERVICE.*M/iu.test(storageAcl.stdout), "LocalService does not have modify access to the state directory");
    const logAcl = assertCommand(await command("icacls.exe", [logDirectory]), "verify Windows log directory ACL");
    assert(/LOCAL SERVICE.*M/iu.test(logAcl.stdout), "LocalService does not have modify access to the log directory");

    wrapper = await downloadVerifiedWinSw(wrapperDirectory);
    writeFileSync(wrapperPath, readFileSync(wrapper.path), { mode: 0o700 });
    const profile = createWindowsHostServiceProfile({
      serviceId,
      displayName: "JB Expert QA generated profile CI lab",
      description: "Disposable Windows SCM deployment profile test",
      serviceAccount: "LocalService",
      nodeExecutable: process.execPath,
      entryPoint: join(appDirectory, "host.mjs"),
      workingDirectory: appDirectory,
      storageDirectory,
      logDirectory,
      startMode: "Manual",
      delayedAutoStart: false,
      restartDelaysSeconds: [1, 2],
      stopTimeoutSeconds: 45
    });
    assert(profile.serviceAccount === "LocalService", "Windows profile did not select LocalService");
    writeFileSync(wrapperConfig, profile.content, { mode: 0o600 });
    writeFileSync(join(appDirectory, "host.mjs"), fixture, { mode: 0o644 });

    installAttempted = true;
    const install = await command(wrapperPath, ["install"]);
    assertCommand(install, "WinSW install generated service profile");
    installed = true;
    assertCommand(await command(wrapperPath, ["start"]), "WinSW start generated service profile");

    const firstFile = await waitFor(() => {
      const found = startupFiles(storageDirectory);
      return found.length >= 1 ? found[0] : null;
    }, "first WinSW host process start");
    const first = readJson(firstFile);
    firstPid = first.pid;
    assert(first.storage === storageDirectory, "WinSW profile did not pass the configured storage directory");
    assert(/^nt authority\\local service$/iu.test(first.account), "WinSW host did not run as NT AUTHORITY\\LocalService: " + first.account);
    assert(first.storageAclVerified === true, "native Windows ACL inspection did not validate the protected state DACL under LocalService");
    assert(first.storageOwnerVerified === true, "native Windows ACL inspection did not verify LocalService state ownership");
    assert(first.storageIdentityVerified === true, "native Windows ACL inspection did not verify the active LocalService process token");

    const queryBefore = assertCommand(await command("sc.exe", ["queryex", serviceId]), "query generated Windows service before SCM restart");
    const wrapperPidBefore = Number(queryBefore.stdout.match(/PID\s*:\s*(\d+)/iu)?.[1]);
    assert(Number.isSafeInteger(wrapperPidBefore) && wrapperPidBefore > 1, "Windows service wrapper PID was not available");

    assertCommand(await command("sc.exe", ["stop", serviceId]), "stop generated Windows service through SCM");
    await waitFor(() => existsSync(join(storageDirectory, "shutdown-" + firstPid + ".txt")), "Ctrl+C graceful shutdown marker after SCM stop");
    await waitFor(async () => {
      const current = await command("sc.exe", ["query", serviceId]);
      return /STATE\s*:\s*\d+\s+STOPPED/iu.test(current.stdout);
    }, "Windows SCM stop before restart");
    assertCommand(await command("sc.exe", ["start", serviceId]), "restart generated Windows service through SCM");
    const secondFile = await waitFor(() => {
      const found = startupFiles(storageDirectory);
      return found.find(item => readJson(item).pid !== firstPid) ?? null;
    }, "second WinSW host process start");
    const second = readJson(secondFile);
    secondPid = second.pid;
    assert(secondPid !== firstPid, "SCM restart did not replace the host process");
    assert(/^nt authority\\local service$/iu.test(second.account), "restarted WinSW host changed service identity");

    const queryAfter = assertCommand(await command("sc.exe", ["queryex", serviceId]), "query generated Windows service after SCM restart");
    const wrapperPidAfter = Number(queryAfter.stdout.match(/PID\s*:\s*(\d+)/iu)?.[1]);
    assert(Number.isSafeInteger(wrapperPidAfter) && wrapperPidAfter > 1, "Windows service wrapper PID after restart was not available");
    assert(wrapperPidAfter !== wrapperPidBefore, "SCM restart did not replace the WinSW wrapper process");

    assertCommand(await command("sc.exe", ["stop", serviceId]), "stop generated Windows service through SCM");
    await waitFor(() => existsSync(join(storageDirectory, "shutdown-" + secondPid + ".txt")), "Ctrl+C graceful shutdown marker after SCM stop");
    await waitFor(async () => {
      const current = await command("sc.exe", ["query", serviceId]);
      return /STATE\s*:\s*\d+\s+STOPPED/iu.test(current.stdout);
    }, "Windows SCM stop after graceful shutdown");
    const stopped = await command("sc.exe", ["queryex", serviceId]);
    assert(stopped.exitCode !== 0 || /STATE\s*:\s*\d+\s+STOPPED/iu.test(stopped.stdout),
      "Windows SCM did not report the generated service as STOPPED");
    writeFileSync(join(storageDirectory, "fail-on-start"), "1", { mode: 0o600 });
    await command("sc.exe", ["start", serviceId]);
    await waitFor(async () => {
      const current = await command("sc.exe", ["query", serviceId]);
      const failedCount = startupFiles(storageDirectory).map(readJson).filter(item => item.failing).length;
      return failedCount === profile.restartDelaysSeconds.length + 1 &&
        /STATE\s*:\s*\d+\s+STOPPED/iu.test(current.stdout);
    }, "WinSW generated failure-action exhaustion", 30_000);
    const failedAttempts = startupFiles(storageDirectory).map(readJson).filter(item => item.failing);
    assert(failedAttempts.length === profile.restartDelaysSeconds.length + 1, "WinSW generated failure-action sequence was not enforced exactly");
    assertCommand(await command(wrapperPath, ["uninstall"]), "WinSW uninstall disposable generated service");
    installed = false;
    installAttempted = false;

    return {
      platform: "windows-scm",
      wrapperVersion: "WinSW v2.14.0",
      wrapperAsset: "WinSW-x64.exe",
      wrapperSha256: wrapper.sha256,
      wrapperSizeBytes: wrapper.sizeBytes,
      serviceId,
      serviceAccount: first.account,
      nativeStorageVerifier: "readWindowsStorageSecurityReport",
      nativeStorageAclInspection: "passed",
      storageOwnerVerified: first.storageOwnerVerified,
      storageIdentityVerified: first.storageIdentityVerified,
      storageAclVerified: first.storageAclVerified,
      applicationAcl: "LocalService read/execute",
      stateAcl: "LocalService modify",
      logAcl: "LocalService modify",
      storageDirectory,
      profileSha256: createHash("sha256").update(profile.content).digest("hex"),
      startup: "passed",
      restart: "passed",
      gracefulSignal: "SIGINT",
      nodePidBefore: firstPid,
      nodePidAfter: secondPid,
      wrapperPidBefore,
      wrapperPidAfter,
      finalState: "stopped",
      serviceUninstalled: true,
      restartLimitAttempts: failedAttempts.length,
      restartLimitEnforced: true,
      interruptedJobReplay: false
    };
  } finally {
    if ((installed || installAttempted) && wrapper) {
      await command(wrapperPath, ["stop"]);
      await command(wrapperPath, ["uninstall"]);
      await command("sc.exe", ["delete", serviceId]);
    }
    rmSync(serviceRoot, { recursive: true, force: true });
    rmSync(wrapperDirectory, { recursive: true, force: true });
  }
}

async function main() {
  const result = process.platform === "linux"
    ? await certifySystemd()
    : process.platform === "win32"
      ? await certifyWindowsScm()
      : (() => { throw new Error("Unsupported platform for host deployment profile lab"); })();

  const evidence = {
    schema: "jb.expert-qa.host-service-deployment-lab/v2",
    generatedAt: new Date().toISOString(),
    commit: process.env.GITHUB_SHA || null,
    workflowRunId: process.env.GITHUB_RUN_ID || null,
    runtime: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch
    },
    scope: {
      testEnvironment: "ephemeral-github-hosted-runner",
      target: "disposable-generated-host-service-profile",
      productionHostTested: false,
      customerServiceTouched: false,
      privilegedOperationsScope: "disposable-ci-service-and-temporary-identity-only",
      interruptedJobReplay: false
    },
    result: {
      certification: "passed",
      ...result
    }
  };
  const serialized = JSON.stringify(evidence, null, 2) + "\n";
  console.log(serialized);
  const output = process.env.EQA_PROFILE_LAB_OUTPUT;
  if (output) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, serialized, { flag: "w", mode: 0o600 });
  }
}

main().catch(error => {
  console.error("JB Expert QA host service deployment profile lab failed:");
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
