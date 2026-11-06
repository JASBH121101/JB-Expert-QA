import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { auditSecurityProject } from "../src/adapters/filesystem/audit-security-project.js";

const ITERATIONS = Number(process.env.EXPERT_QA_BENCH_ITERATIONS ?? 5);
const MiB = 1024 * 1024;

if (!Number.isSafeInteger(ITERATIONS) || ITERATIONS < 3 || ITERATIONS > 10) {
  throw new Error("EXPERT_QA_BENCH_ITERATIONS must be an integer between 3 and 10");
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    meanMs: Number(mean.toFixed(2)),
    medianMs: Number(percentile(values, 0.5).toFixed(2)),
    p95Ms: Number(percentile(values, 0.95).toFixed(2)),
    p99Ms: Number(percentile(values, 0.99).toFixed(2)),
    minMs: Number(Math.min(...values).toFixed(2)),
    maxMs: Number(Math.max(...values).toFixed(2))
  };
}

async function buildFixture(root, fileCount) {
  const sourceDir = path.join(root, "src");
  await mkdir(sourceDir, { recursive: true });
  const benignSource = [
    "export function featureEnabled(env) {",
    "  return env.APP_FEATURE_FLAG === '1';",
    "}",
    "export function normalizeLabel(value) {",
    "  return String(value ?? '').trim().slice(0, 120);",
    "}",
    "export const retryPolicy = Object.freeze({ attempts: 3, delayMs: 250 });",
    ""
  ].join("\n");

  for (let index = 0; index < fileCount; index += 1) {
    await writeFile(path.join(sourceDir, "module-" + String(index).padStart(4, "0") + ".js"), benignSource);
  }

  await writeFile(path.join(sourceDir, "request-proxy.js"), [
    "export async function proxyRequest(req) {",
    "  const requestedTarget = req.query.target;",
    "  const targetAlias = requestedTarget;",
    "  return fetch(targetAlias);",
    "}"
  ].join("\n"));
}

async function measureScenario({ name, fileCount }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-expert-qa-bench-"));
  try {
    await buildFixture(root, fileCount);
    const warmup = await auditSecurityProject(root);
    assert.equal(warmup.securityAssessment.complete, true, name + ": warm-up scan must be complete");
    assert.ok(warmup.diagnostics.some((item) => item.id.startsWith("AST-SSRF-")),
      name + ": seeded request-to-fetch flow must be detected");

    const beforeMemory = process.memoryUsage();
    const beforeCpu = process.cpuUsage();
    let peakRssBytes = beforeMemory.rss;
    const sampler = setInterval(() => {
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    }, 10);
    const durations = [];
    let lastReport;
    try {
      for (let index = 0; index < ITERATIONS; index += 1) {
        const started = performance.now();
        lastReport = await auditSecurityProject(root);
        durations.push(performance.now() - started);
        assert.equal(lastReport.securityAssessment.complete, true,
          name + ": iteration " + (index + 1) + " must report complete coverage");
        assert.ok(lastReport.diagnostics.some((item) => item.id.startsWith("AST-SSRF-")),
          name + ": iteration " + (index + 1) + " must detect the seeded data flow");
      }
    } finally {
      clearInterval(sampler);
    }

    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    const afterMemory = process.memoryUsage();
    const cpu = process.cpuUsage(beforeCpu);
    const metrics = summarize(durations);
    const elapsedMs = durations.reduce((sum, value) => sum + value, 0);

    return {
      name,
      filesGenerated: fileCount + 1,
      filesScanned: lastReport.projectScan.filesRead,
      iterations: ITERATIONS,
      ...metrics,
      filesPerSecond: Number((lastReport.projectScan.filesRead / (metrics.meanMs / 1000)).toFixed(2)),
      MiBPerSecond: Number((lastReport.projectScan.totalBytes / MiB / (metrics.meanMs / 1000)).toFixed(2)),
      findingsPerRun: lastReport.diagnostics.length,
      astFindingsPerRun: lastReport.diagnostics.filter((item) => item.id.startsWith("AST-")).length,
      seededTaintFinding: lastReport.diagnostics.some((item) => item.id.startsWith("AST-SSRF-")),
      assessmentComplete: lastReport.securityAssessment.complete,
      cpuUserMs: Number((cpu.user / 1000).toFixed(2)),
      cpuSystemMs: Number((cpu.system / 1000).toFixed(2)),
      rssBeforeMiB: Number((beforeMemory.rss / MiB).toFixed(2)),
      rssAfterMiB: Number((afterMemory.rss / MiB).toFixed(2)),
      rssPeakMiB: Number((peakRssBytes / MiB).toFixed(2)),
      heapUsedDeltaMiB: Number(((afterMemory.heapUsed - beforeMemory.heapUsed) / MiB).toFixed(2)),
      status: "passed",
      elapsedTotalMs: Number(elapsedMs.toFixed(2))
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const cases = [
  await measureScenario({ name: "expert-qa-100-js-files", fileCount: 100 }),
  await measureScenario({ name: "expert-qa-300-js-files", fileCount: 300 })
];

const cpus = os.cpus();
const report = {
  benchmark: "JB Expert QA static-analysis performance and seeded-flow check",
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  ci: {
    commit: process.env.GITHUB_SHA ?? null,
    ref: process.env.GITHUB_REF_NAME ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runner: process.env.RUNNER_NAME ?? null
  },
  runtime: {
    node: process.version,
    v8: process.versions.v8,
    platform: process.platform,
    architecture: process.arch,
    runnerImage: process.env.ImageOS ?? process.env.RUNNER_OS ?? "local",
    cpuModel: cpus[0]?.model ?? "unknown",
    logicalCpus: cpus.length
  },
  configuration: {
    iterationsPerCase: ITERATIONS,
    warmupAuditsPerCase: 1,
    fixtureTypes: "generated benign JavaScript plus one seeded request-to-fetch alias flow",
    externalServices: false,
    projectCodeExecuted: false,
    networkRequests: 0,
    databaseConnections: 0,
    thresholds: "informational only"
  },
  validation: {
    scenariosPassed: cases.filter((item) => item.status === "passed").length,
    scenariosExpected: cases.length,
    seededTaintFlowsDetected: cases.filter((item) => item.seededTaintFinding).length,
    completeAssessments: cases.filter((item) => item.assessmentComplete).length
  },
  cases
};

const outputDir = path.resolve(process.env.EXPERT_QA_BENCH_OUTPUT_DIR ?? "benchmark-results/expert-qa");
await mkdir(outputDir, { recursive: true });
const lines = [
  "# JB Expert QA — benchmark report",
  "",
  "- Generated: " + report.generatedAt,
  "- Commit: " + (report.ci.commit ?? "local"),
  "- Node: " + report.runtime.node,
  "- Platform: " + report.runtime.platform + " / " + report.runtime.architecture,
  "- CPU: " + report.runtime.cpuModel,
  "- Iterations per case: " + report.configuration.iterationsPerCase,
  "",
  "| Scenario | Files | Mean | Median | p95 | p99 | Files/sec | MiB/sec | Peak RSS | Findings |",
  "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|"
];
for (const item of report.cases) {
  lines.push("| " + item.name + " | " + item.filesScanned + " | " + item.meanMs + " ms | " +
    item.medianMs + " ms | " + item.p95Ms + " ms | " + item.p99Ms + " ms | " +
    item.filesPerSecond + " | " + item.MiBPerSecond + " | " + item.rssPeakMiB + " MiB | " +
    item.findingsPerRun + " |");
}
lines.push(
  "",
  "## Validation",
  "",
  "- Scenarios passed: " + report.validation.scenariosPassed + " / " + report.validation.scenariosExpected,
  "- Seeded request-to-fetch data flows detected: " + report.validation.seededTaintFlowsDetected,
  "- Complete project assessments: " + report.validation.completeAssessments,
  "",
  "The fixture contains only generated benign JavaScript and a deliberately unsafe source-to-sink test flow. The benchmark does not execute project code, use network access, or connect to a database. Results are informational and are not a security certification.",
  ""
);
await writeFile(path.join(outputDir, "expert-qa-benchmark.json"), JSON.stringify(report, null, 2) + "\n");
await writeFile(path.join(outputDir, "summary.md"), lines.join("\n") + "\n");
const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) await appendFile(summaryPath, lines.join("\n") + "\n");

console.log("JB Expert QA benchmark completed.");
console.log(JSON.stringify(report, null, 2));
