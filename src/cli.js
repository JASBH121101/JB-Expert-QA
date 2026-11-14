#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { auditUrl, auditViewports, FULL_VIEWPORTS } from "./adapters/playwright/audit-url.js";
import { formatReport } from "./reporters/index.js";

const [url, ...args] = process.argv.slice(2);
if (!url) {
  console.error("Usage: npm run audit -- https://example.com [--mobile|--matrix|--full-matrix] [--themes=light,dark] [--language=es|en] [--preserve-term=term] [--theme-attribute=data-theme|class] [--theme-storage-key=KEY] [--format=json|markdown|html] [--output=path] [--allow-private-network] [--screenshots=DIR] [--baseline-dir=DIR] [--diff-dir=DIR] [--update-baselines] [--visual-threshold=0.1] [--max-diff-ratio=0.005] [--full-page] [--ai-visual-fallback] [--explore-interactions] [--max-interaction-actions=8]");
  process.exitCode = 2;
} else {
  try {
    const fullMatrix = args.includes("--full-matrix");
    if (fullMatrix && args.includes("--matrix")) throw new Error("Use --matrix or --full-matrix, not both");
    const matrix = args.includes("--matrix") || fullMatrix;
    const themesArg = args.find((arg) => arg.startsWith("--themes="));
    const themeAttributeArg = args.find((arg) => arg.startsWith("--theme-attribute="));
    const themeStorageKeyArg = args.find((arg) => arg.startsWith("--theme-storage-key="));
    const themeAttribute = themeAttributeArg ? themeAttributeArg.slice("--theme-attribute=".length) : null;
    const themeStorageKey = themeStorageKeyArg ? themeStorageKeyArg.slice("--theme-storage-key=".length) : null;
    if (themeAttributeArg && !themeAttribute) throw new Error("--theme-attribute must not be empty");
    if (themeStorageKeyArg && !themeStorageKey) throw new Error("--theme-storage-key must not be empty");
    const themes = themesArg
      ? themesArg.slice("--themes=".length).split(",").map((theme) => theme.trim()).filter(Boolean)
      : (matrix ? ["light", "dark"] : ["light"]);
    const languageArg = args.find((arg) => arg.startsWith("--language="));
    const targetLanguage = languageArg ? languageArg.slice("--language=".length).trim() : null;
    if (languageArg && !["es", "en"].includes(targetLanguage?.toLowerCase())) {
      throw new Error("--language must be es or en");
    }
    const preserveTerms = args
      .filter((arg) => arg.startsWith("--preserve-term="))
      .map((arg) => arg.slice("--preserve-term=".length).trim())
      .filter(Boolean);
    if (args.some((arg) => arg.startsWith("--preserve-term=")) &&
        preserveTerms.length !== args.filter((arg) => arg.startsWith("--preserve-term=")).length) {
      throw new Error("--preserve-term must not be empty");
    }
    const mobile = args.includes("--mobile");
    const allowPrivateNetworks = args.includes("--allow-private-network");
    const screenshotsArg = args.find((arg) => arg.startsWith("--screenshots="));
    const baselineArg = args.find((arg) => arg.startsWith("--baseline-dir="));
    const diffArg = args.find((arg) => arg.startsWith("--diff-dir="));
    const screenshotDir = screenshotsArg
      ? screenshotsArg.slice("--screenshots=".length)
      : (matrix ? ".jb-expert-qa/visual-evidence" : null);
    const baselineDir = baselineArg ? baselineArg.slice("--baseline-dir=".length) : null;
    const diffDir = diffArg ? diffArg.slice("--diff-dir=".length) : null;
    const updateBaselines = args.includes("--update-baselines");
    const aiVisualReview = args.includes("--ai-visual-fallback") || args.includes("--ai-visual-review");
    const screenshotFullPage = args.includes("--full-page");
    const interactionExploration = args.includes("--explore-interactions") || fullMatrix;
    const maxInteractionArg = args.find((arg) => arg.startsWith("--max-interaction-actions="));
    const maxInteractionActions = maxInteractionArg ? Number(maxInteractionArg.slice("--max-interaction-actions=".length)) : 8;
    if (!Number.isInteger(maxInteractionActions) || maxInteractionActions < 1 || maxInteractionActions > 30) {
      throw new Error("--max-interaction-actions must be an integer between 1 and 30");
    }
    const visualThresholdArg = args.find((arg) => arg.startsWith("--visual-threshold="));
    const maxDiffArg = args.find((arg) => arg.startsWith("--max-diff-ratio="));
    const visualThreshold = visualThresholdArg ? Number(visualThresholdArg.slice("--visual-threshold=".length)) : 0.1;
    const maxDiffPixelRatio = maxDiffArg ? Number(maxDiffArg.slice("--max-diff-ratio=".length)) : 0.005;
    if ((themesArg || themeAttributeArg || themeStorageKeyArg || baselineDir || diffDir || updateBaselines || aiVisualReview) && !matrix) {
      throw new Error("Theme overrides, visual baselines and AI visual review require --matrix");
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

    const auditOptions = {
      allowPrivateNetworks, interactionExploration, maxInteractionActions,
      themeAttribute, themeStorageKey, targetLanguage, preserveTerms
    };
    let report = matrix
      ? await auditViewports(url, {
          ...auditOptions,
          ...(fullMatrix ? { viewports: FULL_VIEWPORTS } : {}),
          screenshotDir,
          screenshotFullPage,
          baselineDir,
          diffDir,
          updateBaselines,
          visualThreshold,
          maxDiffPixelRatio,
          themes
        })
      : await auditUrl(url, {
          ...auditOptions,
          screenshotPath: screenshotDir ? screenshotDir + "/desktop.png" : null,
          screenshotFullPage,
          viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 900 }
        });

    if (aiVisualReview) {
      // Emergency-only path: AI modules are loaded only after an explicit CLI flag.
      const [{ reviewViewportScreenshots }, { createAiProviderRouter }] = await Promise.all([
        import("./ai/visual-review.js"),
        import("./ai/provider-router.js")
      ]);
      const provider = createAiProviderRouter({ enabled: true });
      const visualReview = await reviewViewportScreenshots(report, {
        provider,
        maxScreenshots: 3
      });
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
