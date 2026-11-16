import test from "node:test";
import assert from "node:assert/strict";
import { createLinuxSystemdAdapter } from "../src/adapters/linux-systemd.js";
import { createWindowsScmAdapter } from "../src/adapters/windows-scm.js";
import { createRestrictedHostCommandRunner } from "../src/adapters/restricted-host-command-runner.js";

function execStub(handler, calls = []) {
  return {
    calls,
    run(file, args, options, callback) {
      calls.push({ file, args: [...args], options });
      const result = handler(file, args, options) ?? {};
      callback(result.error ?? null, result.stdout ?? "", result.stderr ?? "");
    }
  };
}

test("restricted Linux runner backs the systemd adapter with fixed execFile calls", async () => {
  const stub = execStub((_file, args) => ({
    stdout: args[0] === "is-active" ? "" : "Restarted\n"
  }));
  const runner = createRestrictedHostCommandRunner({
    platform: "linux-systemd",
    binaries: { systemctl: "/usr/bin/systemctl" },
    allowedServices: ["catalog-api.service"],
    timeoutMs: 12_000,
    execFileImpl: stub.run
  });
  const adapter = createLinuxSystemdAdapter({
    allowedServices: ["catalog-api.service"],
    timeoutMs: 12_000,
    run: runner.run
  });

  await adapter.restartService("catalog-api.service");
  assert.deepEqual(await adapter.verifyService("catalog-api.service"), {
    healthy: true, state: "active"
  });
  assert.deepEqual(stub.calls.map((call) => [call.file, call.args]), [
    ["/usr/bin/systemctl", ["restart", "catalog-api.service"]],
    ["/usr/bin/systemctl", ["is-active", "--quiet", "catalog-api.service"]]
  ]);
  for (const call of stub.calls) {
    assert.equal(call.options.shell, false);
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.timeout, 12_000);
    assert.equal(call.options.env.LANG, "C");
    assert.equal(call.options.env.LC_ALL, "C");
    assert.equal(Object.hasOwn(call.options.env, "HOME"), false);
  }
});

test("restricted Windows runner backs the SCM adapter with fixed stop/query/start calls", async () => {
  let state = "RUNNING";
  const stub = execStub((_file, args) => {
    if (args[0] === "stop") state = "STOPPED";
    if (args[0] === "start") state = "RUNNING";
    if (args[0] === "query") {
      return { stdout: "SERVICE_NAME: JBService\n        STATE              : " +
        (state === "RUNNING" ? "4  RUNNING" : "1  STOPPED") };
    }
    return {};
  });
  const runner = createRestrictedHostCommandRunner({
    platform: "windows-scm",
    binaries: { "sc.exe": "C:\\Windows\\System32\\sc.exe" },
    windowsSystemRoot: "C:\\Windows",
    allowedServices: ["JBService"],
    timeoutMs: 5_000,
    execFileImpl: stub.run
  });
  const adapter = createWindowsScmAdapter({
    allowedServices: ["JBService"],
    timeoutMs: 5_000,
    pollIntervalMs: 10,
    sleep: async () => {},
    clock: () => 100,
    run: runner.run
  });

  const restarted = await adapter.restartService("JBService");
  assert.equal(restarted.running, true);
  assert.equal(restarted.platform, "windows-scm");
  assert.deepEqual(await adapter.verifyService("JBService"), {
    healthy: true, state: "RUNNING"
  });
  assert.deepEqual(stub.calls.map((call) => call.args), [
    ["stop", "JBService"],
    ["query", "JBService"],
    ["start", "JBService"],
    ["query", "JBService"],
    ["query", "JBService"]
  ]);
  for (const call of stub.calls) {
    assert.equal(call.file, "C:\\Windows\\System32\\sc.exe");
    assert.equal(call.options.shell, false);
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.env.SystemRoot, "C:\\Windows");
    assert.equal(Object.hasOwn(call.options.env, "USERPROFILE"), false);
  }
});

test("Linux command grammar rejects unapproved operations, services and argument injection", async () => {
  const stub = execStub(() => ({}));
  const runner = createRestrictedHostCommandRunner({
    platform: "linux-systemd",
    binaries: { systemctl: "/usr/bin/systemctl" },
    allowedServices: ["catalog-api.service"],
    execFileImpl: stub.run
  });
  assert.throws(
    runner.run("systemctl", ["restart", "other.service"], { shell: false }),
    /allowlist/
  );
  assert.throws(
    runner.run("systemctl", ["restart", "catalog-api.service;id"], { shell: false }),
    /allowlist/
  );
  assert.throws(
    runner.run("systemctl", ["status", "catalog-api.service"], { shell: false }),
    /allowlist/
  );
  assert.throws(
    runner.run("sh", ["-c", "id"], { shell: false }),
    /allowlist/
  );
  assert.throws(
    runner.run("systemctl", ["restart", "catalog-api.service"], { shell: true }),
    /shell execution is prohibited/
  );
  assert.equal(stub.calls.length, 0);
});

test("Windows command grammar rejects powershell, arbitrary sc verbs and unknown services", async () => {
  const stub = execStub(() => ({}));
  const runner = createRestrictedHostCommandRunner({
    platform: "windows-scm",
    binaries: { "sc.exe": "C:\\Windows\\System32\\sc.exe" },
    windowsSystemRoot: "C:\\Windows",
    allowedServices: ["JBService"],
    execFileImpl: stub.run
  });
  assert.throws(
    runner.run("sc.exe", ["delete", "JBService"], { shell: false }),
    /allowlist/
  );
  assert.throws(
    runner.run("sc.exe", ["stop", "OtherService"], { shell: false }),
    /allowlist/
  );
  assert.throws(
    runner.run("powershell.exe", ["-Command", "Stop-Service JBService"], { shell: false }),
    /allowlist/
  );
  assert.throws(
    runner.run("sc.exe", ["stop", "JBService", "&&", "whoami"], { shell: false }),
    /allowlist/
  );
  assert.equal(stub.calls.length, 0);
});

test("runner rejects relative binaries, duplicate service names and unexpected binary fields", () => {
  const base = {
    platform: "linux-systemd",
    binaries: { systemctl: "systemctl" },
    allowedServices: ["catalog.service"],
    execFileImpl: execStub(() => ({})).run
  };
  assert.throws(() => createRestrictedHostCommandRunner(base), /absolute/);
  assert.throws(() => createRestrictedHostCommandRunner({
    ...base,
    binaries: { systemctl: "/usr/bin/systemctl", curl: "/usr/bin/curl" }
  }), /unsupported fields/);
  assert.throws(() => createRestrictedHostCommandRunner({
    ...base,
    binaries: { systemctl: "/usr/bin/systemctl" },
    allowedServices: ["catalog.service", "catalog.service"]
  }), /unique valid/);
  assert.throws(() => createRestrictedHostCommandRunner({
    ...base,
    binaries: { systemctl: "/usr/bin/systemctl" },
    timeoutMs: 60_001
  }), /100 and 60000/);
});

test("Windows runner requires an absolute SystemRoot and a fixed absolute sc.exe path", () => {
  const exec = execStub(() => ({})).run;
  assert.throws(() => createRestrictedHostCommandRunner({
    platform: "windows-scm",
    binaries: { "sc.exe": "sc.exe" },
    windowsSystemRoot: "C:\\Windows",
    allowedServices: ["JBService"],
    execFileImpl: exec
  }), /absolute/);
  assert.throws(() => createRestrictedHostCommandRunner({
    platform: "windows-scm",
    binaries: { "sc.exe": "C:\\Windows\\System32\\sc.exe" },
    windowsSystemRoot: "Windows",
    allowedServices: ["JBService"],
    execFileImpl: exec
  }), /SystemRoot/);
});

test("runner clamps command timeouts and rejects oversized or unsupported options", async () => {
  const stub = execStub(() => ({}));
  const runner = createRestrictedHostCommandRunner({
    platform: "linux-systemd",
    binaries: { systemctl: "/usr/bin/systemctl" },
    allowedServices: ["catalog.service"],
    timeoutMs: 15_000,
    execFileImpl: stub.run
  });
  await runner.run("systemctl", ["restart", "catalog.service"], {
    shell: false,
    timeoutMs: 60_000,
    windowsHide: false
  });
  assert.equal(stub.calls[0].options.timeout, 15_000);
  assert.equal(stub.calls[0].options.windowsHide, true);
  assert.throws(
    runner.run("systemctl", ["restart", "catalog.service"], {
      shell: false,
      timeoutMs: 50,
      cwd: "/tmp"
    }),
    /unsupported fields/
  );
  assert.throws(
    runner.run("systemctl", ["restart", "catalog.service"], { shell: false, timeoutMs: 20 }),
    /at least 100/
  );
});

test("runner returns bounded sanitized output and a stable timeout result", async () => {
  const oversized = "secret-output-" + "x".repeat(20_000) + "\u001b[31m";
  const stub = execStub(() => ({ stdout: oversized, stderr: "warn\u0000ing" }));
  const runner = createRestrictedHostCommandRunner({
    platform: "linux-systemd",
    binaries: { systemctl: "/usr/bin/systemctl" },
    allowedServices: ["catalog.service"],
    execFileImpl: stub.run
  });
  const result = await runner.run("systemctl", ["restart", "catalog.service"], { shell: false });
  assert.equal(result.exitCode, 0);
  assert.equal(result.status, "succeeded");
  assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 16 * 1024);
  assert.equal(result.stderr.includes("\u0000"), false);

  const timeoutError = Object.assign(new Error("timed out"), { code: "ETIMEDOUT", killed: true });
  const timedOutRunner = createRestrictedHostCommandRunner({
    platform: "linux-systemd",
    binaries: { systemctl: "/usr/bin/systemctl" },
    allowedServices: ["catalog.service"],
    execFileImpl: execStub(() => ({ error: timeoutError })).run
  });
  const timeout = await timedOutRunner.run(
    "systemctl", ["restart", "catalog.service"], { shell: false }
  );
  assert.equal(timeout.exitCode, 1);
  assert.equal(timeout.timedOut, true);
  assert.equal(timeout.reason, "timeout");
  assert.equal(timeout.status, "timed_out");

  const outputLimitedRunner = createRestrictedHostCommandRunner({
    platform: "linux-systemd",
    binaries: { systemctl: "/usr/bin/systemctl" },
    allowedServices: ["catalog.service"],
    execFileImpl: execStub(() => ({
      error: Object.assign(new Error("maxBuffer exceeded"), {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        killed: true
      })
    })).run
  });
  const outputLimited = await outputLimitedRunner.run(
    "systemctl", ["restart", "catalog.service"], { shell: false }
  );
  assert.equal(outputLimited.timedOut, false);
  assert.equal(outputLimited.reason, "output-limit");
  assert.equal(outputLimited.status, "failed");
});

test("non-zero system-manager exit remains a failed result and adapter rejects it", async () => {
  const runner = createRestrictedHostCommandRunner({
    platform: "linux-systemd",
    binaries: { systemctl: "/usr/bin/systemctl" },
    allowedServices: ["catalog.service"],
    execFileImpl: execStub(() => ({
      error: Object.assign(new Error("failed"), { code: 5 }),
      stderr: "private command output"
    })).run
  });
  const adapter = createLinuxSystemdAdapter({
    allowedServices: ["catalog.service"],
    run: runner.run
  });
  await assert.rejects(() => adapter.restartService("catalog.service"), /restart failed/);
  const raw = await runner.run("systemctl", ["restart", "catalog.service"], { shell: false });
  assert.equal(raw.exitCode, 5);
  assert.equal(raw.status, "failed");
  assert.equal(raw.stderr, "private command output");
});

test("runner constructor rejects unsupported platform and malformed inputs", () => {
  assert.throws(() => createRestrictedHostCommandRunner({
    platform: "darwin",
    binaries: {},
    allowedServices: ["catalog.service"]
  }), /platform/);
  assert.throws(() => createRestrictedHostCommandRunner({
    platform: "linux-systemd",
    binaries: { systemctl: "/usr/bin/systemctl" },
    allowedServices: ["catalog;id"]
  }), /valid service/);
  assert.throws(() => createRestrictedHostCommandRunner({
    platform: "linux-systemd",
    binaries: { systemctl: "/usr/bin/systemctl" },
    allowedServices: ["catalog.service"],
    execFileImpl: null
  }), /execFileImpl/);
});
