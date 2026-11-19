import { performance } from "node:perf_hooks";
import { auditTranslationMaps } from "../src/language/audit.js";

const requestedIterations = Number(process.argv.find((arg) => arg.startsWith("--iterations="))?.split("=")[1] ?? 25);
if (!Number.isInteger(requestedIterations) || requestedIterations < 5 || requestedIterations > 500) {
  throw new RangeError("iterations must be an integer from 5 to 500");
}

const sizes = [250, 1000, 2500];
const warmupIterations = 5;

function buildCatalog(size) {
  const source = Object.create(null);
  const target = Object.create(null);
  for (let index = 0; index < size; index += 1) {
    const key = "benchmark.message." + index;
    source[key] = "Source message for item :item with action :action.";
    target[key] = "Target copy for item :item with action :action.";
  }
  return { source, target };
}

function percentile(values, p) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

function runSize(size) {
  const catalogs = buildCatalog(size);
  for (let index = 0; index < warmupIterations; index += 1) {
    auditTranslationMaps(catalogs.source, catalogs.target, {
      sourceLocale: "en-US",
      targetLocale: "es-NI"
    });
  }

  const heapBefore = process.memoryUsage().heapUsed;
  const durations = [];
  for (let index = 0; index < requestedIterations; index += 1) {
    const start = performance.now();
    const result = auditTranslationMaps(catalogs.source, catalogs.target, {
      sourceLocale: "en-US",
      targetLocale: "es-NI"
    });
    durations.push(performance.now() - start);
    if (result.counts.sourceKeys !== size || result.counts.targetKeys !== size) {
      throw new Error("benchmark catalog integrity check failed");
    }
  }
  const heapAfter = process.memoryUsage().heapUsed;
  const meanMs = durations.reduce((sum, value) => sum + value, 0) / durations.length;
  return {
    entries: size,
    iterations: requestedIterations,
    meanMs: Number(meanMs.toFixed(3)),
    p95Ms: Number(percentile(durations, 0.95).toFixed(3)),
    meanMsPerEntry: Number((meanMs / size).toFixed(6)),
    heapDeltaBytes: heapAfter - heapBefore
  };
}

console.log(JSON.stringify({
  benchmark: "JB Language QA deterministic translation-map audit",
  node: process.version,
  warmupIterations,
  localePair: "en-US -> es-NI",
  results: sizes.map(runSize),
  note: "Timing is environment-dependent; compare runs on the same runner and Node version. Heap delta is a rough process measurement, not retained-memory profiling."
}, null, 2));
