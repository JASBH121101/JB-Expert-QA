#!/usr/bin/env node
import { auditUrl } from "./adapters/playwright/audit-url.js";

const [url, ...args] = process.argv.slice(2);
if (!url) {
  console.error("Usage: npm run audit -- https://example.com [--mobile]");
  process.exitCode = 2;
} else {
  const mobile = args.includes("--mobile");
  try {
    const report = await auditUrl(url, {
      viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 900 }
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.scoring.passed || report.summary.rulesWithErrors > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
