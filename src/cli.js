#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { auditUrl, auditViewports } from "./adapters/playwright/audit-url.js";
import { formatReport } from "./reporters/index.js";
import { reviewViewportScreenshots } from "./ai/visual-review.js";

const [url, ...args] = process.argv.slice(2);
if (!url) {
  console.error("Usage: npm run audit -- https://example.com [--mobile|--matrix] [--format=json|markdown|html] [--output=path] [--allow-private-network] [--screenshots=DIR] [--baseline-dir=DIR] [--diff-dir=DIR] [--update-baselines] [--visual-threshold=0.1] [--max-diff-ratio=0.005] [--full-page] [--ai-visual-review]");
  process.exitCode = 2;
} else {
  try {
    const matrix = args.includes("--matrix");
    const mobile = args.includes("--mobile");
    const allowPrivateNetworks = args.includes("--allow-private-network");
    const screenshotsArg = args.find((arg) => arg.startsWith("--screenshots="));
    const baselineArg = args.find((arg) => arg.startsWith("--baseline-dir="));
    const diffArg = args.find((arg) => arg.startsWith("--diff-dir="));
    const screenshotDir = screenshotsArg ? screenshotsArg.slice("--screenshots=".length) : null;
    const baselineDir = baselineArg ? baselineArg.slice("--baseline-dir=".length) : null;
    const diffDir = diffArg ? diffArg.slice("--diff-dir=".length) : null;
    const updateBaselines = args.includes("--update-baselines");
    const aiVisualReview = args.includes("--ai-visual-review");
    const screenshotFullPage = args.includes("--full-page");
    const visualThresholdArg = args.find((arg) => arg.startsWith("--visual-threshold="));
    const maxDiffArg = args.find((arg) => arg.startsWith("--max-diff-ratio="));
    const visualThreshold = visualThresholdArg ? Number(visualThresholdArg.slice("--visual-threshold=".length)) : 0.1;
    const maxDiffPixelRatio = maxDiffArg ? Number(maxDiffArg.slice("--max-diff-ratio=".length)) : 0.005;
    if ((baselineDir || diffDir || updateBaselines || aiVisualReview) && !matrix) {
      throw new Error("Visual baselines and AI visual review require --matrix");
    }
    if ((screenshotsArg && !screenshotDir) || (baselineArg && !baselineDir) || (diffArg && !diffDir)) {
      throw new Error("Screenshot, baseline and diff directories must not be empty");
    }
    if (diffDir && !baselineDir) throw new Error("--diff-dir requires --baseline-dir");
    if ((baselineDir || aiVisualReview) && !screenshotDir) {
      throw new Error("Use --screenshots=DIR when comparing baselines or requesting AI visual review");
    }
    const formatArg = args.find((arg) => arg.startsWith("--format="));
    const outputArg = args.find((arg) => arg.startsWith("--output="));
    const format = formatArg ? formatArg.slice("--format=".length) : "json";
    const outputPath = outputArg ? outputArg.slice("--output=".length) : null;

    const auditOptions = { allowPrivateNetworks };
    let report = matrix
      ? await auditViewports(url, {
          ...auditOptions,
          screenshotDir,
          screenshotFullPage,
          baselineDir,
          diffDir,
          updateBaselines,
          visualThreshold,
          maxDiffPixelRatio
        })
      : await auditUrl(url, {
          ...auditOptions,
          screenshotPath: screenshotDir ? screenshotDir + "/desktop.png" : null,
          screenshotFullPage,
          viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 900 }
        });

    if (aiVisualReview) {
      const visualReview = await reviewViewportScreenshots(report, { maxScreenshots: 3 });
      report = { ...report, aiVisualReview: visualReview };
    }

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
