import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { ExpertQAEngine, RuleRegistry } from "../src/index.js";

const MiB = 1024 * 1024;
const ITERATIONS = Number(process.env.BENCH_ITERATIONS ?? 12);
const WARMUPS = 2;
const SPECIALISTS = ["accessibility", "performance", "security", "functional", "responsive"];

if (!Number.isSafeInteger(ITERATIONS) || ITERATIONS < 5 || ITERATIONS > 30) {
  throw new Error("BENCH_ITERATIONS must be an integer between 5 and 30");
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
  return {
    meanMs: Number(mean.toFixed(3)),
    medianMs: Number(percentile(values, 0.5).toFixed(3)),
    p95Ms: Number(percentile(values, 0.95).toFixed(3)),
    p99Ms: Number(percentile(values, 0.99).toFixed(3)),
    minMs: Number(Math.min(...values).toFixed(3)),
    maxMs: Number(Math.max(...values).toFixed(3)),
    standardDeviationMs: Number(Math.sqrt(variance).toFixed(3))
  };
}

function createEngine(ruleCount) {
  const registry = new RuleRegistry();
  for (let index = 0; index < ruleCount; index += 1) {
    const specialist = SPECIALISTS[index % SPECIALISTS.length];
    const absentToken = "__JB_QA_BENCHMARK_NEVER_PRESENT_" + index + "__";
    registry.register({
      id: "benchmark-rule-" + String(index + 1).padStart(4, "0"),
      specialist,
      evaluate(context) {
        // Force a deterministic full-string search in each synthetic rule.
        const found = context.source.includes(absentToken);
        if (found) return null;
        if (context.emitFindings && index % 32 === 0) {
          return {
            id: "BENCH-FINDING-" + index,
            title: "Synthetic benchmark finding",
            description: "A deterministic, non-security finding used to exercise report generation.",
            severity: "low",
            evidence: "synthetic benchmark fixture"
          };
        }
        return null;
      }
    });
  }

  return new ExpertQAEngine({
    registry,
    config: {
      profile: "benchmark",
      weights: Object.fromEntries(SPECIALISTS.map((name) => [name, 1])),
      thresholds: { minimumScore: 80, failOnCritical: true }
    }
  });
}

async function measureCase({ name, ruleCount, sourceBytes }) {
  const engine = createEngine(ruleCount);
  const source = Buffer.alloc(sourceBytes, 0x61).toString("utf8");
  const context = { source, emitFindings: true };

  for (let index = 0; index < WARMUPS; index += 1) {
    const warmup = await engine.audit(context);
    assert.equal(warmup.summary.rulesExecuted, ruleCount);
    assert.equal(warmup.summary.rulesWithErrors, 0);
    assert.equal(warmup.scoring.passed, true);
  }

  const memoryBefore = process.memoryUsage();
  const cpuBefore = process.cpuUsage();
  let peakRssBytes = memoryBefore.rss;
  const sampler = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }, 10);
  const started = performance.now();
  const samples = [];
  let findings = 0;

  try {
    for (let index = 0; index < ITERATIONS; index += 1) {
      const iterationStarted = performance.now();
      const report = await engine.audit(context);
      samples.push(performance.now() - iterationStarted);
      assert.equal(report.summary.rulesExecuted, ruleCount);
      assert.equal(report.summary.rulesWithErrors, 0);
      assert.equal(report.scoring.passed, true);
      findings = report.summary.findings;
    }
  } finally {
    clearInterval(sampler);
  }

  const elapsedMs = performance.now() - started;
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  const cpu = process.cpuUsage(cpuBefore);
  const memoryAfter = process.memoryUsage();
  const stats = summarize(samples);
  const totalRuleEvaluations = ruleCount * ITERATIONS;
  const scannedMiB = (sourceBytes * totalRuleEvaluations) / MiB;

  return {
    name,
    ruleCount,
    sourceBytes,
    iterations: ITERATIONS,
    ...stats,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    ruleEvaluationsPerSecond: Number((totalRuleEvaluations / (elapsedMs / 1000)).toFixed(2)),
    scannedMiBPerSecond: Number((scannedMiB / (elapsedMs / 1000)).toFixed(2)),
    findingsPerAudit: findings,
    cpuUserMs: Number((cpu.user / 1000).toFixed(2)),
    cpuSystemMs: Number((cpu.system / 1000).toFixed(2)),
    rssBeforeMiB: Number((memoryBefore.rss / MiB).toFixed(2)),
    rssAfterMiB: Number((memoryAfter.rss / MiB).toFixed(2)),
    rssPeakMiB: Number((peakRssBytes / MiB).toFixed(2)),
    rssPeakDeltaMiB: Number(((peakRssBytes - memoryBefore.rss) / MiB).toFixed(2)),
    heapUsedDeltaMiB: Number(((memoryAfter.heapUsed - memoryBefore.heapUsed) / MiB).toFixed(2)),
    status: "passed"
  };
}

function markdown(report) {
  const lines = [
    "# JB Expert QA — benchmark report",
    "",
    "- Generated: " + report.generatedAt,
    "- Commit: " + (report.ci.commit ?? "local"),
    "- Runner: " + (report.ci.runner ?? "local"),
    "- Node: " + report.runtime.node,
    "- Platform: " + report.runtime.platform + " / " + report.runtime.architecture,
    "- CPU: " + report.runtime.cpuModel + " (" + report.runtime.logicalCpus + " logical CPUs)",
    "- Iterations per case: " + report.configuration.iterationsPerCase,
    "",
    "| Scenario | Rules | Input | Mean | Median | p95 | p99 | Rules/sec | Peak RSS |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|"
  ];
  for (const item of report.cases) {
    lines.push("| " + item.name + " | " + item.ruleCount + " | " +
      (item.sourceBytes / 1024).toFixed(0) + " KiB | " + item.meanMs + " ms | " +
      item.medianMs + " ms | " + item.p95Ms + " ms | " + item.p99Ms + " ms | " +
      item.ruleEvaluationsPerSecond + " | " + item.rssPeakMiB + " MiB |");
  }
  lines.push(
    "",
    "## Scope and interpretation",
    "",
    "This is a deterministic microbenchmark of the ExpertQAEngine rule loop, diagnostic creation, and scoring. It uses synthetic in-memory source strings and locally generated rules; it does not launch a browser, access the network, or run AI providers.",
    "",
    "Results are informational. Compare only runs with the same runner image, Node version, architecture, and workload. No machine-dependent pass/fail threshold is applied.",
    ""
  );
  return lines.join("\n");
}

const cases = [];
for (const scenario of [
  { name: "32-rules-64KiB", ruleCount: 32, sourceBytes: 64 * 1024 },
  { name: "128-rules-64KiB", ruleCount: 128, sourceBytes: 64 * 1024 },
  { name: "128-rules-256KiB", ruleCount: 128, sourceBytes: 256 * 1024 }
]) {
  cases.push(await measureCase(scenario));
}

const cpus = os.cpus();
const report = {
  benchmark: "JB Expert QA deterministic engine benchmark",
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
    cpuModel: cpus[0]?.model ?? "unknown",
    logicalCpus: cpus.length
  },
  configuration: {
    iterationsPerCase: ITERATIONS,
    warmupAuditsPerCase: WARMUPS,
    fixture: "synthetic in-memory text; unique absent tokens force full-string search",
    externalServices: false,
    thresholds: "informational only"
  },
  cases
};

const outputDir = path.resolve(process.env.BENCH_OUTPUT_DIR ?? "benchmark-results");
await mkdir(outputDir, { recursive: true });
await writeFile(path.join(outputDir, "expert-qa-benchmark.json"), JSON.stringify(report, null, 2) + "\n");
await writeFile(path.join(outputDir, "summary.md"), markdown(report) + "\n");

console.log("JB Expert QA benchmark completed. Results are informational.");
console.log(JSON.stringify(report, null, 2));
