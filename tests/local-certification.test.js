import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCAL_CERTIFICATION_PROFILES,
  parseRunnerArgs,
  parseNodeTestSkips,
  renderMarkdownReport,
  runLocalCertification,
  runProcess
} from "../scripts/local-certification.mjs";

function fakeSpawn({ code = 0, stdout = "ok\n", stderr = "", delayMs = 0, error = null } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new Readable({ read() {} });
    child.stderr = new Readable({ read() {} });
    child.killed = false;
    child.exitCode = null;
    child.kill = () => { child.killed = true; child.exitCode = 1; };
    setTimeout(() => {
      if (error) child.emit("error", error);
      else {
        if (stdout) child.stdout.push(Buffer.from(stdout));
        if (stderr) child.stderr.push(Buffer.from(stderr));
        child.stdout.push(null);
        child.stderr.push(null);
        child.exitCode = code;
        child.emit("close", code, null);
      }
    }, delayMs);
    return child;
  };
}

test("local profiles use only allowlisted repository npm scripts", () => {
  assert.deepEqual(LOCAL_CERTIFICATION_PROFILES.core.map((task) => task.npmScript), [
    "check", "test:package-distributions", "test:engine-contracts", "test:autonomous-execution", "test:threat-lab"
  ]);
  assert.equal(LOCAL_CERTIFICATION_PROFILES.full.length > LOCAL_CERTIFICATION_PROFILES.core.length, true);
  assert.ok(LOCAL_CERTIFICATION_PROFILES.core.some((task) => task.npmScript === "test:autonomous-execution"));
  for (const task of Object.values(LOCAL_CERTIFICATION_PROFILES).flat()) {
    assert.match(task.npmScript, /^[a-z][a-z0-9:-]*$/u);
  }
});

test("repository exposes local commands without GitHub or Cloudflare API wiring", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const runnerSource = await readFile(new URL("../scripts/local-certification.mjs", import.meta.url), "utf8");
  assert.equal(packageJson.scripts["qa:local"], "node scripts/local-certification.mjs --profile=core");
  assert.equal(packageJson.scripts["qa:local:full"], "node scripts/local-certification.mjs --profile=full");
  assert.doesNotMatch(runnerSource, /api\.github\.com|actions\/checkout|actions\/setup-node|cloudflare\.com\/client/u);
});

test("TAP skip summaries are counted and prevent a full pass", () => {
  assert.equal(parseNodeTestSkips("# tests 8\n# pass 7\n# fail 0\n# skipped 1\n"), 1);
  assert.equal(parseNodeTestSkips("# tests 3\n# skipped 0\n"), 0);
  assert.equal(parseNodeTestSkips("no TAP summary"), 0);
  assert.throws(() => parseNodeTestSkips(null), /output must be a string/u);
});

test("argument parser accepts safe profiles and report directories", () => {
  const parsed = parseRunnerArgs(["--profile=full", "--report-dir=.reports/local", "--timeout-ms=12000"]);
  assert.equal(parsed.profile, "full");
  assert.equal(parsed.timeoutMs, 12000);
  assert.match(parsed.reportDirectory, /\.reports[\\/]local$/u);
  assert.equal(parseRunnerArgs([]).profile, "core");
  assert.equal(parseRunnerArgs(["--help"]).help, true);
});

test("argument parser rejects unknown, duplicate and unsafe timeout values", () => {
  assert.throws(() => parseRunnerArgs(["--unknown=yes"]), /Unknown option/u);
  assert.throws(() => parseRunnerArgs(["--profile=core", "--profile=full"]), /only be supplied once/u);
  assert.throws(() => parseRunnerArgs(["--profile=production"]), /must be core or full/u);
  assert.throws(() => parseRunnerArgs(["--timeout-ms=1"]), /between 1000 and 3600000/u);
  assert.throws(() => parseRunnerArgs(["--report-dir="]), /non-empty value/u);
});

test("process runner records PASS and redacts sensitive output", async () => {
  const result = await runProcess({
    command: process.execPath,
    args: ["-e", "console.log('token=super-secret-value')"],
    timeoutMs: 1000,
    spawnProcess: fakeSpawn({ stdout: "token=super-secret-value\n" })
  });
  assert.equal(result.status, "PASS");
  assert.match(result.outputTail, /token=\[REDACTED\]/u);
  assert.equal(result.outputTail.includes("super-secret-value"), false);
  assert.equal(typeof result.durationMs, "number");
});

test("process runner preserves failures instead of treating non-zero exit as a pass", async () => {
  const result = await runProcess({
    command: process.execPath,
    args: ["-e", "process.exit(7)"],
    timeoutMs: 1000,
    spawnProcess: fakeSpawn({ code: 7, stderr: "failed\n" })
  });
  assert.equal(result.status, "FAIL");
  assert.equal(result.exitCode, 7);
});

test("process runner marks timed-out commands as TIMEOUT", async () => {
  const result = await runProcess({
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 10000)"],
    timeoutMs: 10,
    spawnProcess: fakeSpawn({ delayMs: 50 })
  });
  assert.equal(result.status, "TIMEOUT");
});

test("process runner executes a real local process without shell evaluation", async () => {
  const previousQuiet = process.env.JB_QA_LOCAL_QUIET;
  process.env.JB_QA_LOCAL_QUIET = "1";
  try {
    const result = await runProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write('local-runner-ok')"],
      timeoutMs: 2000
    });
    assert.equal(result.status, "PASS");
    assert.match(result.outputTail, /local-runner-ok/u);
  } finally {
    if (previousQuiet === undefined) delete process.env.JB_QA_LOCAL_QUIET;
    else process.env.JB_QA_LOCAL_QUIET = previousQuiet;
  }
});

test("process runner terminates a real process after its timeout", async () => {
  const previousQuiet = process.env.JB_QA_LOCAL_QUIET;
  process.env.JB_QA_LOCAL_QUIET = "1";
  try {
    const result = await runProcess({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 30000)"],
      timeoutMs: 25
    });
    assert.equal(result.status, "TIMEOUT");
  } finally {
    if (previousQuiet === undefined) delete process.env.JB_QA_LOCAL_QUIET;
    else process.env.JB_QA_LOCAL_QUIET = previousQuiet;
  }
});

test("local certification report keeps selected profile scope and preserves failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "jbqa-local-certification-"));
  const originalLog = console.log;
  console.log = () => {};
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "jb-expert-qa", version: "0.8.0" }));
    let calls = 0;
    const report = await runLocalCertification({
      profile: "core",
      cwd: root,
      writeReports: false,
      runTask: async () => {
        calls += 1;
        return { status: calls === 2 ? "FAIL" : "PASS", exitCode: calls === 2 ? 1 : 0, durationMs: 1 };
      }
    });
    assert.equal(calls, LOCAL_CERTIFICATION_PROFILES.core.length);
    assert.equal(report.result, "FAILED");
    assert.equal(report.summary.passed, LOCAL_CERTIFICATION_PROFILES.core.length - 1);
    assert.equal(report.summary.failed, 1);
    assert.equal(report.notIncluded.length, LOCAL_CERTIFICATION_PROFILES.full.length - LOCAL_CERTIFICATION_PROFILES.core.length);
    assert.equal(report.coverageLimitations.length >= 3, true);
  } finally {
    console.log = originalLog;
    await rm(root, { recursive: true, force: true });
  }
});

test("a successful command with skipped TAP tests is reported as PARTIAL", async () => {
  const root = await mkdtemp(join(tmpdir(), "jbqa-local-partial-"));
  const originalLog = console.log;
  console.log = () => {};
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "jb-expert-qa", version: "0.8.0" }));
    let calls = 0;
    const report = await runLocalCertification({
      profile: "core",
      cwd: root,
      writeReports: false,
      runTask: async () => {
        calls += 1;
        return {
          status: "PASS",
          exitCode: 0,
          durationMs: 1,
          outputTail: calls === 1 ? "# tests 9\n# pass 8\n# fail 0\n# skipped 1\n" : ""
        };
      }
    });
    assert.equal(report.result, "PARTIAL");
    assert.equal(report.summary.partial, 1);
    assert.equal(report.summary.passed, LOCAL_CERTIFICATION_PROFILES.core.length - 1);
    assert.equal(report.summary.testSkips, 1);
    assert.equal(report.checks[0].status, "PARTIAL");
    assert.equal(report.checks[0].skippedTests, 1);
  } finally {
    console.log = originalLog;
    await rm(root, { recursive: true, force: true });
  }
});

test("markdown report separates passed, failed, timed-out and skipped states", () => {
  const markdown = renderMarkdownReport({
    result: "FAILED",
    profile: "core",
    engineVersion: "0.8.0",
    runtime: { node: "v22.0.0", platform: "linux", arch: "x64" },
    startedAt: "2026-11-23T00:00:00.000Z",
    completedAt: "2026-11-23T00:00:01.000Z",
    durationMs: 1000,
    summary: { total: 2, passed: 1, partial: 0, failed: 0, timedOut: 1, skipped: 0, testSkips: 0 },
    checks: [
      { title: "Unit tests", status: "PASS", durationMs: 100, exitCode: 0 },
      { title: "Integration tests", status: "TIMEOUT", durationMs: 900, exitCode: null }
    ]
  });
  assert.match(markdown, /\*\*Result:\*\* FAILED/u);
  assert.match(markdown, /\*\*TIMEOUT\*\*/u);
  assert.match(markdown, /Skipped checks: 0/u);
  assert.match(markdown, /Individual tests skipped: 0/u);
});
