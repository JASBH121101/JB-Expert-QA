import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);
const timeoutMs = 20_000;

async function command(executable, args, timeout = timeoutMs) {
  try {
    const { stdout = "", stderr = "" } = await execFileAsync(executable, args, {
      timeout,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      shell: false
    });
    return { exitCode: 0, code: 0, stdout, stderr };
  } catch (error) {
    return {
      exitCode: Number.isInteger(error?.code) ? error.code : 1,
      code: Number.isInteger(error?.code) ? error.code : 1,
      stdout: String(error?.stdout ?? ""),
      stderr: String(error?.stderr ?? error?.message ?? "")
    };
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseInteger(output, pattern, label) {
  const match = output.match(pattern);
  const value = match ? Number(match[1]) : NaN;
  assert(Number.isSafeInteger(value) && value > 1, `Could not obtain a valid ${label}`);
  return value;
}

async function certifySystemd() {
  const { createLinuxSystemdAdapter } = await import(
    "../packages/resilience-engine/src/adapters/linux-systemd.js"
  );
  const runId = String(process.env.GITHUB_RUN_ID ?? process.pid).replace(/[^0-9]/g, "");
  const unit = `jb-resilience-lab-${runId || process.pid}.service`;
  const temp = mkdtempSync(join(tmpdir(), "jb-resilience-systemd-"));
  const unitSource = join(temp, unit);
  const unitTarget = `/run/systemd/system/${unit}`;
  let created = false;

  const privileged = async (executable, args, options = {}) => {
    const result = await command("sudo", ["-n", executable, ...args], options.timeoutMs ?? timeoutMs);
    if (result.exitCode !== 0) {
      throw new Error(`${executable} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
    }
    return result;
  };

  const adapter = createLinuxSystemdAdapter({
    allowedServices: [unit],
    timeoutMs,
    run: async (executable, args, options) =>
      privileged(executable, args, { timeoutMs: options.timeoutMs })
  });

  try {
    const systemd = await privileged("systemctl", ["show", "--property=Version", "--value"]);
    assert(systemd.stdout.trim().length > 0, "systemd did not report a version");

    writeFileSync(unitSource, [
      "[Unit]",
      "Description=JB Resilience Engine disposable CI service-manager certification",
      "",
      "[Service]",
      "Type=simple",
      "ExecStart=/usr/bin/sleep infinity",
      "Restart=no",
      "",
      "[Install]",
      "WantedBy=multi-user.target",
      ""
    ].join("\\n"), { mode: 0o600 });

    await privileged("install", ["-m", "0644", unitSource, unitTarget]);
    created = true;
    await privileged("systemctl", ["daemon-reload"]);
    await privileged("systemctl", ["start", unit]);

    const before = await privileged("systemctl", ["show", "--property=MainPID", "--value", unit]);
    const pidBefore = parseInteger(before.stdout, /^\\s*(\\d+)\\s*$/m, "systemd MainPID");

    await adapter.restartService(unit);
    const verification = await adapter.verifyService(unit);
    assert(verification.healthy === true && verification.state === "active",
      "systemd adapter did not verify the service as active");

    const after = await privileged("systemctl", ["show", "--property=MainPID", "--value", unit]);
    const pidAfter = parseInteger(after.stdout, /^\\s*(\\d+)\\s*$/m, "systemd MainPID");
    assert(pidAfter !== pidBefore, "systemd restart did not replace the service process");

    return {
      platform: "systemd",
      systemdVersion: systemd.stdout.trim(),
      service: unit,
      pidBefore,
      pidAfter,
      restart: "passed",
      postRestartVerification: "active"
    };
  } finally {
    if (created) {
      await privileged("systemctl", ["stop", unit]).catch(() => {});
      await privileged("rm", ["-f", unitTarget]).catch(() => {});
      await privileged("systemctl", ["daemon-reload"]).catch(() => {});
    }
    rmSync(temp, { recursive: true, force: true });
  }
}

async function certifyWindowsScm() {
  const { createWindowsScmAdapter } = await import(
    "../packages/resilience-engine/src/adapters/windows-scm.js"
  );
  const framework = "C:\\\\Windows\\\\Microsoft.NET\\\\Framework64\\\\v4.0.30319";
  const compiler = join(framework, "csc.exe");
  const serviceReference = join(framework, "System.ServiceProcess.dll");
  assert(existsSync(compiler), "Windows .NET Framework C# compiler was not found");
  assert(existsSync(serviceReference), "System.ServiceProcess reference assembly was not found");

  const runId = String(process.env.GITHUB_RUN_ID ?? process.pid).replace(/[^A-Za-z0-9]/g, "");
  const serviceName = (`JBResilienceLab${runId.slice(-12)}`).slice(0, 80);
  const temp = mkdtempSync(join(tmpdir(), "jb-resilience-scm-"));
  const source = join(temp, "LabService.cs");
  const executable = join(temp, "LabService.exe");
  let created = false;

  const sourceCode = [
    "using System.ServiceProcess;",
    "public sealed class LabService : ServiceBase {",
    `  public LabService() { ServiceName = "${serviceName}"; CanStop = true; AutoLog = false; }`,
    "  protected override void OnStart(string[] args) { }",
    "  protected override void OnStop() { }",
    "  public static void Main() { ServiceBase.Run(new LabService()); }",
    "}"
  ].join("\\n");
  writeFileSync(source, sourceCode, { mode: 0o600 });

  const runSc = async (args) => {
    const result = await command("sc.exe", args);
    if (result.exitCode !== 0) {
      throw new Error(`sc.exe ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
    }
    return result;
  };

  const adapter = createWindowsScmAdapter({
    allowedServices: [serviceName],
    timeoutMs,
    pollIntervalMs: 100
  });

  try {
    const compile = await command(compiler, [
      "/nologo",
      "/target:exe",
      `/out:${executable}`,
      `/r:${serviceReference}`,
      source
    ], 30_000);
    assert(compile.exitCode === 0 && existsSync(executable),
      `Could not compile the disposable Windows service: ${compile.stderr || compile.stdout}`);

    await runSc([
      "create", serviceName,
      "binPath=", executable,
      "start=", "demand",
      "DisplayName=", "JB Resilience disposable CI service-manager test"
    ]);
    created = true;
    await runSc(["start", serviceName]);

    const before = await command("sc.exe", ["queryex", serviceName]);
    assert(before.exitCode === 0, "SCM could not query the created service");
    const pidBefore = parseInteger(before.stdout, /PID\\s*:\\s*(\\d+)/i, "SCM process ID");

    await adapter.restartService(serviceName);
    const verification = await adapter.verifyService(serviceName);
    assert(verification.healthy === true && verification.state === "RUNNING",
      "Windows SCM adapter did not verify the service as RUNNING");

    const after = await command("sc.exe", ["queryex", serviceName]);
    assert(after.exitCode === 0, "SCM could not query the restarted service");
    const pidAfter = parseInteger(after.stdout, /PID\\s*:\\s*(\\d+)/i, "SCM process ID");
    assert(pidAfter !== pidBefore, "SCM restart did not replace the service process");

    return {
      platform: "windows-scm",
      service: serviceName,
      pidBefore,
      pidAfter,
      restart: "passed",
      postRestartVerification: "RUNNING"
    };
  } finally {
    if (created) {
      await command("sc.exe", ["stop", serviceName]);
      await command("sc.exe", ["delete", serviceName]);
    }
    rmSync(temp, { recursive: true, force: true });
  }
}

async function main() {
  assert(process.versions.node, "Node.js runtime is unavailable");
  const result = process.platform === "linux"
    ? await certifySystemd()
    : process.platform === "win32"
      ? await certifyWindowsScm()
      : (() => { throw new Error(`Unsupported platform: ${process.platform}`); })();
  console.log(JSON.stringify({ certification: "passed", ...result }, null, 2));
}

main().catch((error) => {
  console.error("JB Resilience real service-manager certification failed:");
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
