import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

const BASELINE_SHA = "c5869b4c40218c8401e59db7b04bf6d19c5dcccd";
const rootArgument = process.argv.find((item) => item.startsWith("--root="));
const root = resolve(rootArgument ? rootArgument.slice("--root=".length) : process.cwd());
const { LanguageLibrary } = await import(pathToFileURL(resolve(root, "src/language/glossary.js")));

const sizes = [250, 1000, 2500];
const warmups = 5;
const iterations = 25;
const phrases = Object.freeze([
  "Update customer order in the warehouse",
  "Save invoice and apply a discount",
  "Create a supplier report for delivery",
  "Review the dashboard and update the product price",
  "Delete the obsolete customer record",
  "Cancel the purchase order",
  "Create a new sales report and save changes",
  "Update the employee account and inventory"
]);

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function runSize(size) {
  const workload = Array.from({ length: size }, (_, index) => phrases[index % phrases.length]);
  const library = new LanguageLibrary();
  const options = { sourceLocale: "en-US", targetLocale: "es-NI" };

  for (let warmup = 0; warmup < warmups; warmup += 1) {
    for (const phrase of workload) library.suggestTranslation(phrase, options);
  }

  const durations = [];
  let suggestions = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const start = performance.now();
    let count = 0;
    for (const phrase of workload) {
      count += library.suggestTranslation(phrase, options).suggestions.length;
      library.validateTermConsistency(phrase, "Guardar cliente, pedido, factura y descuento", options);
    }
    durations.push(performance.now() - start);
    suggestions = count;
  }
  const meanMs = durations.reduce((sum, value) => sum + value, 0) / durations.length;
  return {
    inputMessages: size,
    iterations,
    operationsPerIteration: size * 2,
    meanMs: Number(meanMs.toFixed(3)),
    p95Ms: Number(percentile(durations, 0.95).toFixed(3)),
    meanMsPer1000Messages: Number((meanMs / size * 1000).toFixed(3)),
    suggestionsLastIteration: suggestions
  };
}

console.log(JSON.stringify({
  benchmark: "JB Language QA glossary suggestion and consistency matcher",
  baselineCommit: BASELINE_SHA,
  node: process.version,
  root,
  warmups,
  results: sizes.map(runSize),
  note: "Run the same script on baseline and head in the same runner and Node version. Timings are environment-dependent and are not a certification of translation quality."
}, null, 2));
