import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  normalizeLocale,
  flattenTranslationMap,
  auditTranslationMaps,
  auditTranslationCatalogs,
  TranslationMemory
} from "../src/language/index.js";

const ITERATIONS = Number(process.env.JB_LANGUAGE_QA_BENCH_ITERATIONS ?? 100);
const WARMUPS = 2;
const OUTPUT_DIR = path.resolve(
  process.env.JB_LANGUAGE_QA_BENCHMARK_OUTPUT_DIR ?? path.join(os.tmpdir(), "jb-language-qa-benchmark")
);
const LOCALE_CALLS = 12000;
const SMALL_KEY_COUNT = 100;
const LARGE_KEY_COUNT = 1000;
const CATALOG_KEY_COUNT = 500;
const MEMORY_ENTRY_COUNT = 1000;
const MEMORY_LOOKUPS = 2000;

if (!Number.isSafeInteger(ITERATIONS) || ITERATIONS < 20 || ITERATIONS > 200) {
  throw new Error("JB_LANGUAGE_QA_BENCH_ITERATIONS must be an integer from 20 to 200");
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
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

function createTranslationMaps(keyCount) {
  const source = Object.create(null);
  const target = Object.create(null);
  for (let index = 0; index < keyCount; index += 1) {
    const key = "catalog.label_" + String(index).padStart(5, "0");
    source[key] = "Etiqueta de muestra " + index;
    target[key] = "Sample description " + index;
  }
  return { source, target };
}

function createCatalogs(keyCount) {
  const catalogs = Object.create(null);
  for (const locale of SUPPORTED_LOCALES) {
    const catalog = Object.create(null);
    for (let index = 0; index < keyCount; index += 1) {
      const key = "catalog.label_" + String(index).padStart(5, "0");
      catalog[key] = "Sample message " + index + " {count}";
    }
    const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
    catalog.itemCount = Object.fromEntries(
      categories.map((category) => [category, "Items: {count}"])
    );
    catalogs[locale] = catalog;
  }
  return catalogs;
}

function createMemory(entryCount) {
  const memory = new TranslationMemory();
  for (let index = 0; index < entryCount; index += 1) {
    memory.add({
      source: "Source label " + index,
      target: "Etiqueta de origen " + index,
      sourceLocale: "en-GB",
      targetLocale: "es-NI",
      context: "benchmark.label." + index
    });
  }
  return memory;
}

function makeCases() {
  const smallMaps = createTranslationMaps(SMALL_KEY_COUNT);
  const largeMaps = createTranslationMaps(LARGE_KEY_COUNT);
  const nestedMap = Object.create(null);
  for (let index = 0; index < LARGE_KEY_COUNT; index += 1) {
    const group = "group_" + Math.floor(index / 25);
    if (!Object.hasOwn(nestedMap, group)) nestedMap[group] = Object.create(null);
    nestedMap[group]["label_" + index] = "Sample label " + index;
  }
  const catalogs = createCatalogs(CATALOG_KEY_COUNT);
  const memory = createMemory(MEMORY_ENTRY_COUNT);
  const aliases = [
    "es-NI", "es_419", "es-MX", "es-ES", "es-CO", "en-US",
    "en_GB", "pt-BR", "pt_PT", "fr-FR", "de-DE", "it-IT", "ar"
  ];
  const memoryQueries = Array.from({ length: MEMORY_LOOKUPS }, (_, index) => {
    const entryIndex = index % MEMORY_ENTRY_COUNT;
    return {
      source: "Source label " + entryIndex,
      sourceLocale: "en-GB",
      targetLocale: "es-NI",
      context: "benchmark.label." + entryIndex
    };
  });

  return [
    {
      name: "locale-normalization",
      description: "Repeated canonicalization across 13 supported tags and aliases",
      operationsPerSample: LOCALE_CALLS,
      execute() {
        let normalized = 0;
        for (let index = 0; index < LOCALE_CALLS; index += 1) {
          if (normalizeLocale(aliases[index % aliases.length])) normalized += 1;
        }
        return normalized;
      },
      validate(result) {
        assert.equal(result, LOCALE_CALLS, "every benchmark locale must normalize");
      }
    },
    {
      name: "translation-map-flatten-1000",
      description: "Flatten a nested 1,000-leaf translation map",
      operationsPerSample: LARGE_KEY_COUNT,
      execute() {
        return flattenTranslationMap(nestedMap);
      },
      validate(result) {
        assert.equal(Object.keys(result).length, LARGE_KEY_COUNT);
      }
    },
    {
      name: "translation-audit-100",
      description: "Compare 100 source/target keys including placeholder and semantic checks",
      operationsPerSample: SMALL_KEY_COUNT,
      execute() {
        return auditTranslationMaps(smallMaps.source, smallMaps.target, {
          sourceLocale: DEFAULT_LOCALE,
          targetLocale: "en-GB"
        });
      },
      validate(result) {
        assert.equal(result.status, "checked");
        assert.equal(result.counts.sourceKeys, SMALL_KEY_COUNT);
        assert.equal(result.counts.missingKeys, 0);
        assert.equal(result.counts.placeholderMismatches, 0);
        assert.equal(result.reviewStatus, "review-required");
      }
    },
    {
      name: "translation-audit-1000",
      description: "Compare 1,000 source/target keys including placeholder and semantic checks",
      operationsPerSample: LARGE_KEY_COUNT,
      execute() {
        return auditTranslationMaps(largeMaps.source, largeMaps.target, {
          sourceLocale: DEFAULT_LOCALE,
          targetLocale: "en-GB"
        });
      },
      validate(result) {
        assert.equal(result.status, "checked");
        assert.equal(result.counts.sourceKeys, LARGE_KEY_COUNT);
        assert.equal(result.counts.missingKeys, 0);
        assert.equal(result.counts.placeholderMismatches, 0);
        assert.equal(result.reviewStatus, "review-required");
      }
    },
    {
      name: "catalog-audit-12-locales-500",
      description: "Validate 500 keys and plural categories across all 12 supported locales",
      operationsPerSample: CATALOG_KEY_COUNT * SUPPORTED_LOCALES.length,
      execute() {
        return auditTranslationCatalogs(catalogs, {
          sourceLocale: DEFAULT_LOCALE,
          requiredLocales: SUPPORTED_LOCALES.filter((locale) => locale !== DEFAULT_LOCALE)
        });
      },
      validate(result) {
        assert.equal(result.status, "passed");
        assert.equal(result.requiredLocales.length, SUPPORTED_LOCALES.length - 1);
        assert.equal(result.autoApproved, false);
      }
    },
    {
      name: "translation-memory-exact-lookup",
      description: "Perform 2,000 exact lookups in a 1,000-entry in-memory translation store",
      operationsPerSample: MEMORY_LOOKUPS,
      execute() {
        let hits = 0;
        for (const query of memoryQueries) {
          if (memory.findExact(query)) hits += 1;
        }
        return hits;
      },
      validate(result) {
        assert.equal(result, MEMORY_LOOKUPS, "every exact translation-memory lookup must hit");
      }
    }
  ];
}

async function measureCase(testCase) {
  for (let index = 0; index < WARMUPS; index += 1) {
    testCase.validate(await testCase.execute());
  }

  const memoryBefore = process.memoryUsage();
  const cpuBefore = process.cpuUsage();
  const samples = [];
  const started = performance.now();

  for (let index = 0; index < ITERATIONS; index += 1) {
    const iterationStarted = performance.now();
    const result = await testCase.execute();
    const elapsed = performance.now() - iterationStarted;
    testCase.validate(result);
    samples.push(elapsed);
  }

  const elapsedMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  const memoryAfter = process.memoryUsage();
  const stats = summarize(samples);
  const totalOperations = testCase.operationsPerSample * ITERATIONS;

  return {
    name: testCase.name,
    description: testCase.description,
    operationsPerSample: testCase.operationsPerSample,
    iterations: ITERATIONS,
    ...stats,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    operationsPerSecond: Number((totalOperations / (elapsedMs / 1000)).toFixed(2)),
    cpuUserMs: Number((cpu.user / 1000).toFixed(2)),
    cpuSystemMs: Number((cpu.system / 1000).toFixed(2)),
    rssBeforeMiB: Number((memoryBefore.rss / (1024 * 1024)).toFixed(2)),
    rssAfterMiB: Number((memoryAfter.rss / (1024 * 1024)).toFixed(2)),
    heapUsedDeltaMiB: Number(((memoryAfter.heapUsed - memoryBefore.heapUsed) / (1024 * 1024)).toFixed(2)),
    status: "passed"
  };
}

function toMarkdown(report) {
  const lines = [
    "# JB Language QA benchmark baseline",
    "",
    "- Generated: " + report.generatedAt,
    "- Commit: " + (report.ci.commit ?? "local"),
    "- Runner: " + (report.ci.runner ?? "local"),
    "- Runtime: " + report.runtime.node + " / " + report.runtime.platform + " / " + report.runtime.architecture,
    "- CPU: " + report.runtime.cpuModel + " (" + report.runtime.logicalCpus + " logical CPUs)",
    "- Iterations per case: " + report.configuration.iterationsPerCase,
    "- Warmups per case: " + report.configuration.warmupsPerCase,
    "- External services: none",
    "",
    "| Scenario | Mean | Median | p95 | p99 | Ops/sec | RSS before/after |",
    "|---|---:|---:|---:|---:|---:|---:|"
  ];
  for (const item of report.cases) {
    lines.push(
      "| " + item.name + " | " + item.meanMs + " ms | " + item.medianMs + " ms | " +
      item.p95Ms + " ms | " + item.p99Ms + " ms | " + item.operationsPerSecond + " | " +
      item.rssBeforeMiB + "/" + item.rssAfterMiB + " MiB |"
    );
  }
  lines.push(
    "",
    "## Interpretation",
    "",
    "This is the baseline for deterministic local Language QA paths, not a translation-quality score. It excludes browser rendering, network latency and AI-provider calls. Compare only reports with matching runner image, Node version, architecture, iteration count and workload.",
    "",
    "All audit checks are validated during each sample. A structurally clean catalog remains review-required unless explicitly approved by a human reviewer; the benchmark never changes approval state.",
    ""
  );
  return lines.join("\n");
}

const cpus = os.cpus();
const report = {
  benchmark: "JB Language QA deterministic performance baseline",
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
    warmupsPerCase: WARMUPS,
    supportedLocales: [...SUPPORTED_LOCALES],
    localeCallsPerSample: LOCALE_CALLS,
    translationAuditKeys: [SMALL_KEY_COUNT, LARGE_KEY_COUNT],
    catalogAudit: { locales: SUPPORTED_LOCALES.length, keysPerLocale: CATALOG_KEY_COUNT },
    translationMemory: { entries: MEMORY_ENTRY_COUNT, lookupsPerSample: MEMORY_LOOKUPS },
    externalServices: false,
    thresholds: "informational only"
  },
  cases: []
};

for (const testCase of makeCases()) {
  report.cases.push(await measureCase(testCase));
}

assert.equal(report.cases.length, 6);
assert.ok(report.cases.every((item) => item.status === "passed"));

await mkdir(OUTPUT_DIR, { recursive: true });
await writeFile(
  path.join(OUTPUT_DIR, "language-qa-benchmark.json"),
  JSON.stringify(report, null, 2) + "\n"
);
const markdown = toMarkdown(report);
await writeFile(path.join(OUTPUT_DIR, "summary.md"), markdown + "\n");
console.log(markdown);
console.log("Full Language QA benchmark JSON: " + path.join(OUTPUT_DIR, "language-qa-benchmark.json"));
