import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { performance } from "node:perf_hooks";
import { createUploadInspector } from "../packages/security-guard/src/upload-inspector.js";

const KiB = 1024;
const MiB = 1024 * KiB;
const ITERATIONS = Number(process.env.BENCH_ITERATIONS ?? 10);
const WARMUPS = 2;
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

function fixture(size) {
  const bytes = Buffer.alloc(size, 0x41);
  PNG_HEADER.copy(bytes);
  return bytes;
}

function createMemoryStore() {
  const quarantine = new Map();
  const approved = new Map();

  return {
    approved,
    async createWriteStream({ uploadId }) {
      const chunks = [];
      return new Writable({
        write(chunk, encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
        final(callback) {
          quarantine.set(uploadId, Buffer.concat(chunks));
          callback();
        }
      });
    },
    async createReadStream({ uploadId }) {
      const bytes = quarantine.get(uploadId);
      if (!bytes) throw new Error("missing synthetic quarantine object");
      return Readable.from([bytes]);
    },
    async promote({ uploadId, metadata, expectedSha256, expectedSize }) {
      const bytes = quarantine.get(uploadId);
      if (!bytes || bytes.length !== expectedSize ||
          createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
        return { promoted: false };
      }
      approved.set(uploadId, { bytes, metadata });
      quarantine.delete(uploadId);
      return { promoted: true };
    },
    async delete({ uploadId }) {
      quarantine.delete(uploadId);
      return { deleted: true };
    }
  };
}

function createInspector(store) {
  const scanner = {
    async scan({ stream, signal }) {
      let consumed = 0;
      for await (const chunk of stream) {
        if (signal.aborted) throw new Error("synthetic scan aborted");
        consumed += chunk.length;
      }
      return { verdict: "clean", engine: "JB-Benchmark-Scanner", version: "synthetic-1", consumed };
    }
  };
  return createUploadInspector({
    store,
    scanner,
    maxBytes: 2 * MiB,
    scannerTimeoutMs: 15_000,
    ingestTimeoutMs: 15_000
  });
}

async function inspectOne(inspector, store, bytes) {
  const result = await inspector.inspect({
    source: Readable.from([bytes]),
    fileName: "benchmark-fixture.png",
    declaredMimeType: "image/png"
  });
  assert.equal(result.status, "approved");
  assert.equal(result.size, bytes.length);
  store.approved.delete(result.uploadId);
  return result;
}

async function measureSequential({ name, size }) {
  const bytes = fixture(size);
  const store = createMemoryStore();
  const inspector = createInspector(store);

  for (let index = 0; index < WARMUPS; index += 1) {
    await inspectOne(inspector, store, bytes);
  }

  const memoryBefore = process.memoryUsage();
  const cpuBefore = process.cpuUsage();
  let peakRssBytes = memoryBefore.rss;
  const sampler = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }, 10);
  const started = performance.now();
  const samples = [];

  try {
    for (let index = 0; index < ITERATIONS; index += 1) {
      const itemStarted = performance.now();
      await inspectOne(inspector, store, bytes);
      samples.push(performance.now() - itemStarted);
    }
  } finally {
    clearInterval(sampler);
  }

  const elapsedMs = performance.now() - started;
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  const cpu = process.cpuUsage(cpuBefore);
  const memoryAfter = process.memoryUsage();
  const totalMiB = (size * ITERATIONS) / MiB;

  return {
    name,
    fixtureBytes: size,
    iterations: ITERATIONS,
    ...summarize(samples),
    elapsedMs: Number(elapsedMs.toFixed(3)),
    uploadsPerSecond: Number((ITERATIONS / (elapsedMs / 1000)).toFixed(2)),
    MiBPerSecond: Number((totalMiB / (elapsedMs / 1000)).toFixed(2)),
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

async function measureConcurrent() {
  const concurrency = 6;
  const batches = 5;
  const bytes = fixture(64 * KiB);
  const store = createMemoryStore();
  const inspector = createInspector(store);

  for (let index = 0; index < WARMUPS; index += 1) {
    await Promise.all(Array.from({ length: concurrency }, () => inspectOne(inspector, store, bytes)));
  }

  const memoryBefore = process.memoryUsage();
  const cpuBefore = process.cpuUsage();
  let peakRssBytes = memoryBefore.rss;
  const sampler = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }, 10);
  const started = performance.now();
  const samples = [];

  try {
    for (let batch = 0; batch < batches; batch += 1) {
      const batchStarted = performance.now();
      const results = await Promise.all(
        Array.from({ length: concurrency }, () => inspectOne(inspector, store, bytes))
      );
      assert.equal(results.length, concurrency);
      samples.push(performance.now() - batchStarted);
    }
  } finally {
    clearInterval(sampler);
  }

  const elapsedMs = performance.now() - started;
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  const cpu = process.cpuUsage(cpuBefore);
  const memoryAfter = process.memoryUsage();
  const totalUploads = concurrency * batches;
  const totalMiB = (bytes.length * totalUploads) / MiB;

  return {
    name: "concurrent-6x64KiB",
    fixtureBytes: bytes.length,
    concurrency,
    batches,
    iterations: totalUploads,
    ...summarize(samples),
    elapsedMs: Number(elapsedMs.toFixed(3)),
    uploadsPerSecond: Number((totalUploads / (elapsedMs / 1000)).toFixed(2)),
    MiBPerSecond: Number((totalMiB / (elapsedMs / 1000)).toFixed(2)),
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
    "# JB Security Guard — benchmark report",
    "",
    "- Generated: " + report.generatedAt,
    "- Commit: " + (report.ci.commit ?? "local"),
    "- Runner: " + (report.ci.runner ?? "local"),
    "- Node: " + report.runtime.node,
    "- Platform: " + report.runtime.platform + " / " + report.runtime.architecture,
    "- CPU: " + report.runtime.cpuModel + " (" + report.runtime.logicalCpus + " logical CPUs)",
    "",
    "| Scenario | Input | Mean | Median | p95 | p99 | Uploads/sec | MiB/sec | Peak RSS |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|"
  ];
  for (const item of report.cases) {
    lines.push("| " + item.name + " | " + (item.fixtureBytes / KiB).toFixed(0) +
      " KiB | " + item.meanMs + " ms | " + item.medianMs + " ms | " +
      item.p95Ms + " ms | " + item.p99Ms + " ms | " + item.uploadsPerSecond +
      " | " + item.MiBPerSecond + " | " + item.rssPeakMiB + " MiB |");
  }
  lines.push(
    "",
    "## Scope and interpretation",
    "",
    "This measures the actual Security Guard upload-inspection pipeline: stream ingestion, type signature check, SHA-256, quarantine read, deterministic scanner consumption, and promotion. Storage and scanner adapters are in-memory synthetic test doubles; the PNG-signature fixtures are not real images.",
    "",
    "No malware samples, network services, external storage, or paid APIs are used. The benchmark does not yet measure remote scanner latency or the live Expert QA bridge. Results are informational and should only be compared on equivalent runners and Node versions.",
    ""
  );
  return lines.join("\n");
}

const cases = [];
for (const scenario of [
  { name: "sequential-32KiB", size: 32 * KiB },
  { name: "sequential-256KiB", size: 256 * KiB },
  { name: "sequential-1MiB", size: 1 * MiB }
]) {
  cases.push(await measureSequential(scenario));
}
cases.push(await measureConcurrent());

const cpus = os.cpus();
const report = {
  benchmark: "JB Security Guard upload pipeline benchmark",
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
    iterationsPerSequentialCase: ITERATIONS,
    warmupUploadsPerCase: WARMUPS,
    concurrentUploads: 6,
    concurrentBatches: 5,
    fixtureType: "synthetic PNG signature plus inert bytes",
    adapters: "in-memory quarantine, promotion, and deterministic scanner",
    externalServices: false,
    thresholds: "informational only"
  },
  cases
};

const outputDir = path.resolve(process.env.BENCH_OUTPUT_DIR ?? "benchmark-results");
await mkdir(outputDir, { recursive: true });
await writeFile(path.join(outputDir, "security-guard-benchmark.json"), JSON.stringify(report, null, 2) + "\n");
await writeFile(path.join(outputDir, "summary.md"), markdown(report) + "\n");

console.log("JB Security Guard benchmark completed. Results are informational.");
console.log(JSON.stringify(report, null, 2));
