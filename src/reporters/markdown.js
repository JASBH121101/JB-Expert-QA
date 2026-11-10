function findingsFor(report) {
  if (Array.isArray(report.viewports)) {
    return report.viewports.flatMap((viewport) =>
      (viewport.findings ?? []).map((finding) => ({ ...finding, viewport: viewport.name }))
    );
  }
  return (report.diagnostics ?? []).map((finding) => ({ ...finding, viewport: "single" }));
}

function cell(value) {
  return String(value ?? "—")
    .replace(/\\/g, "\\\\")
    .replace(/[\r\n]+/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "\\|")
    .replace(/([\x60*_{}\[\]()#+\-.!])/g, "\\$1");
}

export function formatMarkdownReport(report) {
  const findings = findingsFor(report);
  const target = cell(report.target?.url ?? report.target?.project ?? "Not specified");
  const score = report.scoring?.score ?? null;
  const basePassed = Array.isArray(report.viewports)
    ? report.passed
    : report.scoring?.passed;
  const coverageIncomplete = Boolean(report.analysisScope && (
    report.analysisScope.complete === false ||
    ["partial", "insufficient-source"].includes(report.analysisScope.assessmentStatus) ||
    report.analysisScope.deadCodeAnalysis?.status === "partial"
  ));
  const passed = Boolean(basePassed && !coverageIncomplete);
  const statusLabel = passed
    ? "PASS"
    : coverageIncomplete
      ? "REVIEW REQUIRED — PARTIAL COVERAGE"
      : "REVIEW REQUIRED";

  const lines = [
    "# JB Expert QA report",
    "",
    "- **Target:** " + target,
    "- **Generated:** " + cell(report.generatedAt ?? "Unknown"),
    "- **Status:** " + statusLabel,
    "- **Score:** " + (score === null ? "Per viewport" : cell(score) + "/100"),
    "",
    "## Summary",
    ""
  ];

  if (Array.isArray(report.viewports)) {
    lines.push(
      "- Viewports checked: " + cell(report.summary?.viewportsChecked ?? report.viewports.length),
      "- Passed viewports: " + cell(report.summary?.passedViewports ?? 0),
      "- Failed viewports: " + cell(report.summary?.failedViewports ?? 0),
      "- Total findings: " + cell(report.summary?.totalFindings ?? findings.length),
      ""
    );
  } else {
    lines.push(
      "- Rules executed: " + cell(report.summary?.rulesExecuted ?? 0),
      "- Rule execution errors: " + cell(report.summary?.rulesWithErrors ?? 0),
      "- Findings: " + cell(report.summary?.findings ?? findings.length),
      ""
    );
  }

  if (report.projectScan) {
    lines.push(
      "- Project files read: " + cell(report.projectScan.filesRead ?? 0),
      "- Bytes read: " + cell(report.projectScan.totalBytes ?? 0),
      "- Environment files skipped: " + cell(report.projectScan.environmentFiles ?? 0),
      "- Sensitive files skipped: " + cell(report.projectScan.sensitiveFiles ?? 0),
      "- Scan truncated: " + cell(report.projectScan.truncated ?? false),
      ""
    );
  }

  if (report.analysisScope) {
    const coverage = report.analysisScope.languageCoverage ?? {};
    const moduleGraph = coverage.javascriptModuleGraph ?? {};
    const css = coverage.cssSelectors ?? {};
    const database = coverage.database ?? {};
    lines.push(
      "## Analysis coverage",
      "",
      "- Assessment: " + cell(report.analysisScope.assessmentStatus ?? "unknown"),
      "- Scan complete: " + cell(report.analysisScope.complete ?? false),
      "- Source files analyzed: " + cell(report.analysisScope.sourceFiles ?? 0),
      "- Extensions scanned: " + cell((report.analysisScope.scannedExtensions ?? []).join(", ") || "none"),
      "- JavaScript module graph: " + cell((moduleGraph.supportedExtensions ?? []).join(", ") || "not configured") +
        "; unsupported module files: " + cell(moduleGraph.unsupportedModuleFiles ?? 0),
      "- CSS selector parsing: " + cell((css.parsedExtensions ?? []).join(", ") || "not configured") +
        "; indented Sass files not parsed: " + cell(css.indentedSassFiles ?? 0),
      "- SQL/Prisma analysis: " + cell((database.supportedExtensions ?? []).join(", ") || "not configured") +
        "; scanned files: " + cell(database.scannedFiles ?? 0),
      ""
    );
    if (report.analysisScope.incompleteReasons?.length) {
      lines.push("- Scan gaps: " + cell(report.analysisScope.incompleteReasons.join("; ")), "");
    }

    const deadCode = report.analysisScope.deadCodeAnalysis;
    if (deadCode) {
      lines.push(
        "### Dead-code and dependency analysis",
        "",
        "- Analysis status: " + cell(deadCode.status ?? "unknown"),
        "- Coverage warnings: " + cell(deadCode.coverageWarnings ?? 0),
        "- Possible unused exports: " + cell(deadCode.possibleUnusedExports ?? 0),
        "- Possible unused bindings: " + cell(deadCode.possibleUnusedBindings ?? 0),
        "- Possible unused CSS selectors: " + cell(deadCode.possibleUnusedCssSelectors ?? 0),
        "- Possible unused declarations: " + cell(deadCode.possibleUnusedDeclarations ?? 0),
        "- Unresolved relative imports: " + cell(deadCode.unresolvedRelativeImports ?? 0),
        "- Dependency cycles: " + cell(deadCode.dependencyCycles ?? 0),
        ""
      );
    }
  }

  if (Array.isArray(report.viewports) &&
      report.viewports.some((viewport) => viewport.visualComparison || viewport.screenshotPath)) {
    lines.push(
      "## Visual regression",
      "",
      "| Viewport | Capture | Baseline status | Difference | Result |",
      "|---|---|---|---:|---|"
    );
    for (const viewport of report.viewports) {
      const visual = viewport.visualComparison;
      lines.push("| " + [
        cell(viewport.name),
        cell(viewport.screenshotPath || "not captured"),
        cell(visual ? visual.status : "not compared"),
        visual && visual.diffPixelRatio !== null && visual.diffPixelRatio !== undefined
          ? cell((visual.diffPixelRatio * 100).toFixed(3) + "%")
          : "—",
        visual ? (visual.passed ? "PASS" : "REVIEW") : "—"
      ].join(" | ") + " |");
    }
    lines.push("");
  }

  if (report.aiVisualReview) {
    lines.push(
      "## AI-assisted visual review",
      "",
      "- Provider: " + cell(report.aiVisualReview.provider || "not configured"),
      "- Model: " + cell(report.aiVisualReview.model || "not selected"),
      "- Status: " + cell(report.aiVisualReview.status || "unknown"),
      "- Human review required: yes",
      ""
    );
    for (const item of report.aiVisualReview.reviews || []) {
      lines.push("### " + cell(item.viewport || "Viewport"), "");
      if (item.review) {
        lines.push(
          "- Visual score: " + cell(item.review.visualScore ?? "not scored"),
          "- Assessment: " + cell(item.review.assessment || "No assessment"),
          ""
        );
        for (const issue of item.review.issues || []) {
          lines.push("- **" + cell(issue.severity) + "** — " +
            cell(issue.region) + ": " + cell(issue.evidence) +
            " Recommendation: " + cell(issue.recommendation));
        }
      } else {
        lines.push("- Review status: " + cell(item.status || "unavailable"),
          item.error ? "- Error: " + cell(item.error) : "");
      }
      lines.push("");
    }
  }

  lines.push(
    "## Findings",
    "",
    "| Viewport | Specialist | Severity | Finding | Location | Recommendation |",
    "|---|---|---|---|---|---|"
  );

  if (!findings.length) {
    lines.push("| — | — | — | No findings reported | — | — |");
  } else {
    for (const item of findings) {
      lines.push("| " + [
        item.viewport,
        cell(item.specialist),
        cell(item.severity),
        cell(item.title),
        cell(item.location),
        cell(item.recommendation)
      ].join(" | ") + " |");
    }
  }

  lines.push("", "## Rule execution", "");
  const executions = Array.isArray(report.viewports)
    ? report.viewports.flatMap((viewport) => (viewport.execution ?? []).map((item) => ({
        ...item,
        viewport: viewport.name
      })))
    : (report.execution ?? []);

  if (!executions.length) {
    lines.push("No rule execution details were included.");
  } else {
    for (const item of executions) {
      lines.push("- [" + cell(item.status ?? "unknown") + "] " +
        (item.viewport ? cell(item.viewport) + " · " : "") +
        cell(item.ruleId ?? "unknown") + (item.error ? " — " + cell(item.error) : ""));
    }
  }
  lines.push("");
  return lines.join("\n");
}
