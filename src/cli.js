#!/usr/bin/env node
import { auditUrl, auditViewports } from "./adapters/playwright/audit-url.js";

const [url, ...args] = process.argv.slice(2);
if (!url) {
  console.error("Usage: npm run audit -- https://example.com [--mobile|--matrix]");
  process.exitCode = 2;
} else {
  try {
    const report = args.includes("--matrix")
      ? await auditViewports(url)
      : await auditUrl(url, {
          viewport: args.includes("--mobile")
            ? { width: 390, height: 844 }
            : { width: 1365, height: 900 }
        });

    console.log(JSON.stringify(report, null, 2));
    const passed = "passed" in report
      ? report.passed
      : report.scoring.passed;
    if (!passed) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
