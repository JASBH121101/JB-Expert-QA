#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { auditUrl, auditViewports } from "./adapters/playwright/audit-url.js";
import { formatReport } from "./reporters/index.js";

const [url, ...args] = process.argv.slice(2);
if (!url) {
  console.error("Usage: npm run audit -- https://example.com [--mobile|--matrix] [--format=json|markdown|html] [--output=path]");
  process.exitCode = 2;
} else {
  try {
    const matrix = args.includes("--matrix");
    const mobile = args.includes("--mobile");
    const formatArg = args.find((arg) => arg.startsWith("--format="));
    const outputArg = args.find((arg) => arg.startsWith("--output="));
    const format = formatArg ? formatArg.slice("--format=".length) : "json";
    const outputPath = outputArg ? outputArg.slice("--output=".length) : null;

    const report = matrix
      ? await auditViewports(url)
      : await auditUrl(url, {
          viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 900 }
        });

    const rendered = formatReport(report, format);
    if (outputPath) {
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, rendered + "\n", "utf8");
      console.log("Report saved to " + outputPath);
    } else {
      console.log(rendered);
    }

    const passed = Array.isArray(report.viewports)
      ? report.passed
      : report.scoring.passed;
    if (!passed) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
