#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { auditSecurityUrl } from "./adapters/filesystem/audit-security-url.js";
import { formatReport } from "./reporters/index.js";

const [url, ...args] = process.argv.slice(2);
try {
  if (!url) throw new TypeError("Usage: npm run audit:security:url -- https://example.com [--format=json|markdown|html] [--output=path]");
  const options = new Map();
  for (const arg of args) {
    if (!arg.startsWith("--format=") && !arg.startsWith("--output=")) {
      throw new TypeError("Unknown runtime security audit option: " + arg);
    }
    const name = arg.startsWith("--format=") ? "--format" : "--output";
    if (options.has(name)) throw new TypeError("Option may only be supplied once: " + name);
    const value = arg.slice(name.length + 1);
    if (!value.trim()) throw new TypeError(name + " requires a non-empty value");
    options.set(name, value);
  }
  const format = options.get("--format") || "json";
  const output = options.get("--output") || null;
  const report = await auditSecurityUrl(url);
  const rendered = formatReport(report, format);
  if (output) {
    const destination = resolve(output);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, rendered + "\n", "utf8");
    console.log("Runtime security report saved to " + destination);
  } else {
    console.log(rendered);
  }
  if (!report.scoring.passed) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
