import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const inputDir = path.resolve(argument("--input", "benchmark-results"));
const historyPath = path.resolve(argument("--history", "bench/history/history.jsonl"));
const previewOnly = process.argv.includes("--preview");

async function readJson(filePath) {
  const content = await readFile(filePath, "utf8");
  const value = JSON.parse(content);
  if (!value || typeof value !== "object" || value.schemaVersion !== 1 || !Array.isArray(value.cases)) {
    throw new Error("Unsupported benchmark report schema: " + filePath);
  }
  return value;
}

async function readHistory(filePath) {
  try {
    const content = await readFile(filePath, "utf8");
    return content.split(/\r?\n/).filter(Boolean).map((line, index) => {
      try {
        const value = JSON.parse(line);
        if (value.schemaVersion !== 1 || !value.engines) throw new Error("invalid entry schema");
        return value;
      } catch (error) {
        throw new Error("Invalid benchmark history line " + (index + 1) + ": " + error.message);
      }
    });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function numeric(value) {
  return Number.isFinite(value) ? value : null;
}

function normalizeExpertQa(report) {
  return {
    generatedAt: report.generatedAt,
    validation: report.validation,
    cases: report.cases.map((item) => ({
      name: item.name,
      inputFiles: item.filesScanned,
      meanMs: numeric(item.meanMs),
      medianMs: numeric(item.medianMs),
      p95Ms: numeric(item.p95Ms),
      p99Ms: numeric(item.p99Ms),
      unitsPerSecond: numeric(item.filesPerSecond),
      MiBPerSecond: numeric(item.MiBPerSecond),
      rssPeakMiB: numeric(item.rssPeakMiB),
      findingsPerRun: item.findingsPerRun,
      coverageComplete: item.assessmentComplete,
      seededTaintFinding: item.seededTaintFinding
    }))
  };
}

function normalizeSecurityGuard(report) {
  return {
    generatedAt: report.generatedAt,
    validation: {
      scenarios: report.cases.length,
      allMeasurementsPassed: report.cases.every((item) => item.status === "passed")
    },
    cases: report.cases.map((item) => ({
      name: item.name,
      inputBytes: item.fixtureBytes,
      meanMs: numeric(item.meanMs),
      medianMs: numeric(item.medianMs),
      p95Ms: numeric(item.p95Ms),
      p99Ms: numeric(item.p99Ms),
      unitsPerSecond: numeric(item.uploadsPerSecond),
      MiBPerSecond: numeric(item.MiBPerSecond),
      rssPeakMiB: numeric(item.rssPeakMiB),
      status: item.status
    }))
  };
}

function normalizeMalware(report) {
  return {
    generatedAt: report.generatedAt,
    validation: report.validation,
    cases: report.cases.map((item) => ({
      name: item.name,
      inputBytes: item.fixtureBytes,
      signatureCount: item.signatureCount,
      meanMs: numeric(item.averageMsPerFile),
      medianMs: numeric(item.medianMsPerFile),
      p95Ms: numeric(item.p95MsPerFile),
      p99Ms: numeric(item.p99MsPerFile),
      unitsPerSecond: numeric(item.filesPerSecond),
      MiBPerSecond: numeric(item.MiBPerSecond),
      rssPeakMiB: numeric(item.rssPeakMiB),
      verdict: item.verdict
    }))
  };
}

function percentageDelta(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return Number((((current - previous) / previous) * 100).toFixed(2));
}

function compareEngineRuns(currentEngines, previousEngines) {
  const deltas = [];
  for (const engineName of Object.keys(currentEngines)) {
    const currentCases = currentEngines[engineName]?.cases ?? [];
    const previousByName = new Map((previousEngines[engineName]?.cases ?? []).map((item) => [item.name, item]));
    for (const current of currentCases) {
      const previous = previousByName.get(current.name);
      if (!previous) continue;
      deltas.push({
        engine: engineName,
        scenario: current.name,
        medianMsPct: percentageDelta(current.medianMs, previous.medianMs),
        p95MsPct: percentageDelta(current.p95Ms, previous.p95Ms),
        throughputPct: percentageDelta(current.unitsPerSecond, previous.unitsPerSecond),
        MiBPerSecondPct: percentageDelta(current.MiBPerSecond, previous.MiBPerSecond),
        rssPeakMiBPct: percentageDelta(current.rssPeakMiB, previous.rssPeakMiB)
      });
    }
  }
  return deltas;
}

function fmtDelta(value, suffix = "%") {
  if (value === null || value === undefined) return "n/a";
  return (value > 0 ? "+" : "") + value.toFixed(2) + suffix;
}

function renderSummary(record) {
  const lines = [
    "# JB Engines — permanent benchmark record",
    "",
    "- Recorded: " + record.recordedAt,
    "- Commit: " + (record.commit ?? "local"),
    "- Branch: " + (record.ref ?? "local"),
    "- Actions run: " + (record.runId ?? "local"),
    "- Environment: Node " + record.environment.node + " / " + record.environment.platform + " / " +
      record.environment.architecture + " / " + record.environment.runnerImage,
    "- CPU: " + record.environment.cpuModel,
    "- Baseline: " + (record.comparison.baselineRunId ?? "none yet for this environment"),
    "",
    "| Engine | Scenario | Median | p95 | Throughput | RAM peak | Δ median | Δ throughput |",
    "|---|---|---:|---:|---:|---:|---:|---:|"
  ];

  for (const [engineName, engine] of Object.entries(record.engines)) {
    for (const item of engine.cases) {
      const delta = record.comparison.deltas.find((entry) =>
        entry.engine === engineName && entry.scenario === item.name
      );
      const throughputLabel = engineName === "securityGuard" ? "uploads/s" : "files/s";
      lines.push("| " + engineName + " | " + item.name + " | " + item.medianMs + " ms | " +
        item.p95Ms + " ms | " + item.unitsPerSecond + " " + throughputLabel + " | " +
        item.rssPeakMiB + " MiB | " + (delta ? fmtDelta(delta.medianMsPct) : "n/a") + " | " +
        (delta ? fmtDelta(delta.throughputPct) : "n/a") + " |");
    }
  }

  lines.push("", "## Validation signals", "");
  for (const [engineName, engine] of Object.entries(record.engines)) {
    lines.push("- **" + engineName + ":** " + JSON.stringify(engine.validation ?? {}));
  }
  lines.push(
    "",
    "Comparison deltas are informational. Positive latency deltas mean slower results; positive throughput deltas mean higher throughput. Runs are compared only with a previous record using the same Node version, OS platform, architecture, and runner image.",
    "This benchmark uses generated fixtures and harmless test patterns. It is not a malware detection certification, penetration test, or guarantee of production performance.",
    ""
  );
  return lines.join("\n");
}

const expertQaReport = await readJson(path.join(inputDir, "expert-qa", "expert-qa-benchmark.json"));
const guardReport = await readJson(path.join(inputDir, "security-guard", "security-guard-benchmark.json"));
const malwareReport = await readJson(path.join(inputDir, "malware-engine", "malware-engine-benchmark.json"));

const runtime = expertQaReport.runtime;
for (const report of [guardReport, malwareReport]) {
  if (report.runtime.node !== runtime.node ||
      report.runtime.platform !== runtime.platform ||
      report.runtime.architecture !== runtime.architecture) {
    throw new Error("Benchmark reports were produced by different Node/platform/architecture environments");
  }
}

const runnerImage = runtime.runnerImage ?? "unknown";
const environment = {
  node: runtime.node,
  platform: runtime.platform,
  architecture: runtime.architecture,
  runnerImage,
  cpuModel: runtime.cpuModel ?? "unknown"
};
const environmentKey = [environment.node, environment.platform, environment.architecture, environment.runnerImage].join("|");
const engines = {
  expertQA: normalizeExpertQa(expertQaReport),
  securityGuard: normalizeSecurityGuard(guardReport),
  malwareEngine: normalizeMalware(malwareReport)
};

const history = await readHistory(historyPath);
const previous = [...history].reverse().find((item) => item.environmentKey === environmentKey);
const record = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  commit: expertQaReport.ci?.commit ?? guardReport.ci?.commit ?? malwareReport.ci?.commit ?? null,
  ref: expertQaReport.ci?.ref ?? guardReport.ci?.ref ?? malwareReport.ci?.ref ?? null,
  runId: expertQaReport.ci?.runId ?? guardReport.ci?.runId ?? malwareReport.ci?.runId ?? null,
  environmentKey,
  environment,
  engines,
  comparison: {
    status: previous ? "compared" : "no-compatible-baseline",
    baselineRunId: previous?.runId ?? null,
    baselineCommit: previous?.commit ?? null,
    deltas: previous ? compareEngineRuns(engines, previous.engines) : []
  }
};
const summary = renderSummary(record);
const summaryOutput = path.join(inputDir, "engine-benchmark-summary.md");
await mkdir(path.dirname(summaryOutput), { recursive: true });
const { writeFile } = await import("node:fs/promises");
await writeFile(summaryOutput, summary, "utf8");

const githubSummary = process.env.GITHUB_STEP_SUMMARY;
if (githubSummary) await appendFile(githubSummary, summary + "\n");

if (!previewOnly) {
  await mkdir(path.dirname(historyPath), { recursive: true });
  await appendFile(historyPath, JSON.stringify(record) + "\n", "utf8");
  process.stdout.write("Permanent benchmark history appended to " + historyPath + "\n");
} else {
  process.stdout.write("Preview only; no permanent history file changed.\n");
}
process.stdout.write(summary + "\n");
