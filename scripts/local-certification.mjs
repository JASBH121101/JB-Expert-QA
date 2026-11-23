#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { redactSensitiveText } from "../src/core/redaction.js";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");
export const DEFAULT_TASK_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_OUTPUT_TAIL = 6000;

const CORE_TASKS = [
  {
    id: "root-regression",
    title: "Syntax and root regression suite",
    npmScript: "check",
    timeoutMs: 20 * 60 * 1000
  },
  {
    id: "package-distributions",
    title: "Independent package distribution boundaries",
    npmScript: "test:package-distributions",
    timeoutMs: 5 * 60 * 1000
  },
  {
    id: "engine-contracts",
    title: "Shared engine contract tests",
    npmScript: "test:engine-contracts",
    timeoutMs: 5 * 60 * 1000
  },
  {
    id: "threat-lab",
    title: "Threat Lab safe integration tests",
    npmScript: "test:threat-lab",
    timeoutMs: 10 * 60 * 1000
  }
];

export const LOCAL_CERTIFICATION_PROFILES = Object.freeze({
  core: Object.freeze(CORE_TASKS.map((task) => Object.freeze({ ...task }))),
  full: Object.freeze([
    ...CORE_TASKS,
    {
      id: "security-guard",
      title: "Security Guard regression suite",
      npmScript: "test:security-guard",
      timeoutMs: 15 * 60 * 1000
    },
    {
      id: "resilience-engine",
      title: "Resilience Engine regression suite",
      npmScript: "test:resilience-engine",
      timeoutMs: 10 * 60 * 1000
    },
    {
      id: "internationalization",
      title: "Language, Localization and Currency regression suites",
      npmScript: "test:internationalization",
      timeoutMs: 15 * 60 * 1000
    },
    {
      id: "dead-code-analysis",
      title: "Static dead-code analysis regression tests",
      npmScript: "test:dead-code",
      timeoutMs: 5 * 60 * 1000
    }
  ].map((task) => Object.freeze({ ...task })))
});

export function parseRunnerArgs(args = []) {
  const options = new Map();
  for (const token of args) {
    if (token === "--help" || token === "-h") {
      if (options.has("--help")) throw new TypeError("--help may only be supplied once");
      options.set("--help", true);
      continue;
    }
    const match = /^(--profile|--report-dir|--timeout-ms)=(.*)$/.exec(token);
    if (!match) throw new TypeError("Unknown option: " + token);
    const [, key, value] = match;
    if (options.has(key)) throw new TypeError(key + " may only be supplied once");
    if (!value.trim()) throw new TypeError(key + " requires a non-empty value");
    options.set(key, value.trim());
  }

  const profile = options.get("--profile") ?? "core";
  if (!Object.hasOwn(LOCAL_CERTIFICATION_PROFILES, profile)) {
    throw new TypeError("--profile must be core or full");
  }
  const timeoutMs = options.has("--timeout-ms") ? Number(options.get("--timeout-ms")) : null;
  if (timeoutMs !== null && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60 * 60 * 1000)) {
    throw new TypeError("--timeout-ms must be an integer between 1000 and 3600000");
  }

  return Object.freeze({
    help: options.has("--help"),
    profile,
    reportDirectory: resolve(options.get("--report-dir") ?? ".jb-expert-qa/certification"),
    timeoutMs
  });
}

function appendTail(current, chunk) {
  const next = current + chunk.toString("utf8");
  return next.length > MAX_OUTPUT_TAIL ? next.slice(-MAX_OUTPUT_TAIL) : next;
}

function terminateProcessTree(child, signal) {
  if (!child || child.exitCode !== null) return;
  if (process.platform !== "win32" && Number.isInteger(child.pid)) {
    try {
      // POSIX detached children lead their own process group; terminate npm and its test descendants.
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error?.code !== "ESRCH" && error?.code !== "EPERM") {
        try { child.kill(signal); } catch { /* best-effort termination */ }
        return;
      }
    }
  }
  if (process.platform === "win32" && Number.isInteger(child.pid)) {
    try {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore"
      });
      killer.unref?.();
    } catch {
      // Fall through to the direct child termination below.
    }
  }
  try { child.kill(signal); } catch { /* best-effort termination */ }
}

export function runProcess({ command, args = [], cwd = REPOSITORY_ROOT, timeoutMs = DEFAULT_TASK_TIMEOUT_MS, spawnProcess = spawn, shell = false }) {
  if (typeof command !== "string" || !command.trim()) throw new TypeError("command must be a non-empty string");
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new TypeError("args must be an array of strings");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("timeoutMs must be a positive integer");

  return new Promise((resolveResult) => {
    const startedAt = new Date();
    const start = Date.now();
    let output = "";
    let timedOut = false;
    let launchError = null;
    let settled = false;
    let timeoutHandle;
    let forceKillHandle;
    let child;

    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      clearTimeout(forceKillHandle);
      const status = timedOut ? "TIMEOUT" : launchError || code !== 0 ? "FAIL" : "PASS";
      const safeOutput = redactSensitiveText(output);
      if (safeOutput && process.env.JB_QA_LOCAL_QUIET !== "1") {
        (status === "PASS" ? process.stdout : process.stderr).write(safeOutput + (safeOutput.endsWith("\n") ? "" : "\n"));
      }
      resolveResult(Object.freeze({
        status,
        exitCode: Number.isInteger(code) ? code : null,
        signal: signal ?? null,
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - start,
        error: launchError ? redactSensitiveText(launchError.message ?? String(launchError)) : null,
        outputTail: safeOutput
      }));
    };

    try {
      child = spawnProcess(command, args, {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
        shell
      });
    } catch (error) {
      launchError = error;
      finish(null, null);
      return;
    }

    child.stdout?.on("data", (chunk) => {
      output = appendTail(output, chunk);
      // Output is emitted only after the complete tail has passed redaction.
      void chunk;
    });
    child.stderr?.on("data", (chunk) => {
      output = appendTail(output, chunk);
      // Output is emitted only after the complete tail has passed redaction.
      void chunk;
    });
    child.once("error", (error) => {
      launchError = error;
      finish(null, null);
    });
    child.once("close", (code, signal) => finish(code, signal));

    timeoutHandle = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child, "SIGTERM");
      forceKillHandle = setTimeout(() => {
        terminateProcessTree(child, "SIGKILL");
      }, 2000);
    }, timeoutMs);
  });
}

function npmInvocation(npmScript) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    return { command: process.execPath, args: [npmExecPath, "run", npmScript] };
  }
  if (process.platform === "win32") {
    // Only the fixed, repository-owned allowlisted script names reach this fallback.
    return { command: "npm.cmd", args: ["run", npmScript], shell: true };
  }
  return { command: "npm", args: ["run", npmScript] };
}

export function parseNodeTestSkips(output = "") {
  if (typeof output !== "string") throw new TypeError("output must be a string");
  const matches = [...output.matchAll(/^# skipped (\d+)\s*$/gm)];
  return matches.reduce((total, match) => total + Number(match[1]), 0);
}

function summarizeResults(checks) {
  const summary = { total: checks.length, passed: 0, partial: 0, failed: 0, timedOut: 0, skipped: 0, testSkips: 0 };
  for (const check of checks) {
    summary.testSkips += check.skippedTests ?? 0;
    if (check.status === "PASS") summary.passed += 1;
    else if (check.status === "PARTIAL") summary.partial += 1;
    else if (check.status === "TIMEOUT") summary.timedOut += 1;
    else if (check.status === "SKIPPED") summary.skipped += 1;
    else summary.failed += 1;
  }
  return Object.freeze(summary);
}

export function renderMarkdownReport(report) {
  const lines = [
    "# JB Expert QA — Local Certification",
    "",
    "- **Result:** " + report.result,
    "- **Profile:** " + report.profile,
    "- **Version:** " + report.engineVersion,
    "- **Node:** " + report.runtime.node,
    "- **Platform:** " + report.runtime.platform + " (" + report.runtime.arch + ")",
    "- **Started:** " + report.startedAt,
    "- **Completed:** " + report.completedAt,
    "- **Duration:** " + report.durationMs + " ms",
    "",
    "## Summary",
    "",
    "- Total checks: " + report.summary.total,
    "- Passed: " + report.summary.passed,
    "- Partially passed: " + report.summary.partial,
    "- Failed: " + report.summary.failed,
    "- Timed out: " + report.summary.timedOut,
    "- Skipped checks: " + report.summary.skipped,
    "- Individual tests skipped: " + report.summary.testSkips,
    "",
    "## Checks",
    "",
    "| Check | Status | Duration | Exit code |",
    "| --- | --- | ---: | ---: |"
  ];
  for (const check of report.checks) {
    lines.push("| " + check.title + " | **" + check.status + "** | " + check.durationMs + " ms | " + (check.exitCode ?? "—") + " |");
  }
  if (report.notIncluded?.length) {
    lines.push("", "## Not included in this profile", "");
    for (const item of report.notIncluded) lines.push("- " + item.title + " (" + item.npmScript + ")");
  }
  lines.push("", "## Coverage limitations", "");
  for (const limitation of report.coverageLimitations ?? []) lines.push("- " + limitation);
  lines.push("", "## Execution boundary", "", "This report was generated by the local runner. It does not require GitHub Actions, does not call GitHub APIs, and does not deploy or modify external infrastructure.", "");
  return lines.join("\n");
}

export async function runLocalCertification({
  profile = "core",
  cwd = REPOSITORY_ROOT,
  reportDirectory = resolve(cwd, ".jb-expert-qa/certification"),
  timeoutMs = null,
  runTask = runProcess,
  writeReports = true
} = {}) {
  if (!Object.hasOwn(LOCAL_CERTIFICATION_PROFILES, profile)) {
    throw new TypeError("profile must be core or full");
  }
  const packageJson = JSON.parse(await readFile(resolve(cwd, "package.json"), "utf8"));
  if (packageJson.name !== "jb-expert-qa") throw new Error("Local certification must run from the JB-Expert-QA repository root");
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 22) throw new Error("JB Expert QA local certification requires Node.js 22 or newer");

  const startedAt = new Date();
  const started = Date.now();
  const tasks = LOCAL_CERTIFICATION_PROFILES[profile];
  const checks = [];

  for (const task of tasks) {
    console.log("\n[JB Expert QA] " + task.title);
    const invocation = npmInvocation(task.npmScript);
    const outcome = await runTask({
      ...invocation,
      cwd,
      timeoutMs: timeoutMs ?? task.timeoutMs
    });
    const skippedTests = parseNodeTestSkips(outcome.outputTail ?? "");
    const status = outcome.status === "PASS" && skippedTests > 0 ? "PARTIAL" : outcome.status;
    checks.push(Object.freeze({ id: task.id, title: task.title, npmScript: task.npmScript, ...outcome, status, skippedTests }));
    console.log("[JB Expert QA] " + task.id + ": " + status + (skippedTests ? " (" + skippedTests + " skipped tests)" : ""));
  }

  const completedAt = new Date();
  const summary = summarizeResults(checks);
  const selectedIds = new Set(tasks.map((task) => task.id));
  const notIncluded = LOCAL_CERTIFICATION_PROFILES.full.filter((task) => !selectedIds.has(task.id));
  const coverageLimitations = Object.freeze([
    "Runs only on the current operating system and Node.js version; it does not reproduce GitHub-hosted OS/version matrices.",
    "A PASS represents a successful exit code for the selected npm script; individual test-level skips remain visible in that script's output and are not separately parsed.",
    "Browser binaries are not installed by this runner. Install the required Playwright browser separately before running browser-dependent test commands.",
    "No live production targets, deployments, Cloudflare resources, or external accounts are accessed."
  ]);
  const report = Object.freeze({
    schemaVersion: 1,
    engine: "JB Expert QA Local Certification",
    engineVersion: packageJson.version,
    profile,
    result: summary.failed > 0 || summary.timedOut > 0 ? "FAILED" :
      summary.partial > 0 || summary.skipped > 0 ? "PARTIAL" : "PASSED",
    runtime: Object.freeze({ node: process.version, platform: process.platform, arch: process.arch }),
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: Date.now() - started,
    summary,
    notIncluded: Object.freeze(notIncluded.map((task) => Object.freeze({ id: task.id, title: task.title, npmScript: task.npmScript }))),
    coverageLimitations,
    checks: Object.freeze(checks)
  });

  if (writeReports) {
    const stamp = completedAt.toISOString().replace(/[:.]/g, "-");
    await mkdir(reportDirectory, { recursive: true });
    const jsonPath = resolve(reportDirectory, "local-certification-" + stamp + ".json");
    const markdownPath = resolve(reportDirectory, "local-certification-" + stamp + ".md");
    await writeFile(jsonPath, JSON.stringify(report, null, 2) + "\n", "utf8");
    await writeFile(markdownPath, renderMarkdownReport(report) + "\n", "utf8");
    console.log("\nJSON report: " + jsonPath);
    console.log("Markdown report: " + markdownPath);
  }

  console.log("\n[JB Expert QA] " + report.result + " — " + summary.passed + "/" + summary.total + " checks passed");
  return report;
}

export function printHelp() {
  console.log([
    "JB Expert QA — local certification runner",
    "",
    "Usage:",
    "  npm run qa:local",
    "  npm run qa:local:full",
    "  node scripts/local-certification.mjs --profile=core|full [--report-dir=PATH] [--timeout-ms=MS]",
    "",
    "Profiles:",
    "  core  Root regression, package distribution, engine contracts and Threat Lab",
    "  full  Core plus Security Guard, Resilience, internationalization and dead-code tests",
    "",
    "The runner is local-first. It does not call GitHub APIs, GitHub Actions, Cloudflare, or deployment services.",
    "Dependencies must already be installed; install them separately with npm ci."
  ].join("\n"));
}

async function main(args) {
  const options = parseRunnerArgs(args);
  if (options.help) {
    printHelp();
    return 0;
  }
  const report = await runLocalCertification({
    profile: options.profile,
    reportDirectory: options.reportDirectory,
    timeoutMs: options.timeoutMs
  });
  return report.result === "PASSED" ? 0 : 1;
}

const isDirectExecution = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectExecution) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error("[JB Expert QA] " + redactSensitiveText(error instanceof Error ? error.message : String(error)));
    process.exitCode = 2;
  });
}
