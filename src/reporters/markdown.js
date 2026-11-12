function findingsFor(report) {
  if (Array.isArray(report.viewports)) {
    return report.viewports.flatMap((viewport) =>
      (viewport.findings ?? []).map((finding) => ({
        ...finding,
        viewport: viewport.name + (viewport.theme ? " / " + viewport.theme : "")
      }))
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
      "- Themes checked: " + cell(report.summary?.themesChecked ?? 1),
      "- Theme pairs compared: " + cell(report.summary?.themePairsCompared ?? 0),
      "- Passed viewports: " + cell(report.summary?.passedViewports ?? 0),
      "- Failed viewports: " + cell(report.summary?.failedViewports ?? 0),
      "- Interactive visual comparisons: " + cell(report.summary?.interactionVisualComparisons ?? 0),
      "- Interactive visual failures: " + cell(report.summary?.interactionVisualFailures ?? 0),
      "- Missing interactive baselines: " + cell(report.summary?.interactionBaselinesMissing ?? 0),
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

  if (Array.isArray(report.viewports)) {
    const comparisons = report.viewports.filter((viewport) =>
      viewport.themeTokenComparison && (!viewport.theme || viewport.theme === "light"));
    const tokenRows = comparisons.flatMap((viewport) => {
      const comparison = viewport.themeTokenComparison;
      return [
        ...(comparison.changedTokens ?? []).map((token) => ({
          viewport: viewport.name,
          status: "Changed",
          scope: token.scope,
          name: token.name,
          light: token.lightValue,
          dark: token.darkValue
        })),
        ...(comparison.onlyInLight ?? []).map((name) => ({
          viewport: viewport.name,
          status: "Only in light",
          scope: name.split(":")[0],
          name: name.slice(name.indexOf(":") + 1),
          light: "present",
          dark: "missing"
        })),
        ...(comparison.onlyInDark ?? []).map((name) => ({
          viewport: viewport.name,
          status: "Only in dark",
          scope: name.split(":")[0],
          name: name.slice(name.indexOf(":") + 1),
          light: "missing",
          dark: "present"
        }))
      ];
    }).slice(0, 300);
    if (tokenRows.length) {
      lines.push(
        "### CSS custom-property differences",
        "",
        "| Viewport | Status | Scope | Token | Light | Dark |",
        "|---|---|---|---|---|---|"
      );
      for (const item of tokenRows) {
        lines.push("| " + [
          cell(item.viewport), cell(item.status), cell(item.scope),
          cell(item.name), cell(item.light), cell(item.dark)
        ].join(" | ") + " |");
      }
      lines.push("");
    }

    const declarationRows = report.viewports.flatMap((viewport) =>
      (viewport.evidence?.themeAudit?.hardcodedColorDeclarations ?? [])
        .slice(0, 25)
        .map((item) => ({ theme: viewport.theme ?? "—", viewport: viewport.name, ...item }))
    ).slice(0, 200);
    if (declarationRows.length) {
      lines.push(
        "### Literal CSS color declarations (inventory, not automatic failures)",
        "",
        "| Theme | Viewport | Selector | Property | Value | Source |",
        "|---|---|---|---|---|---|"
      );
      for (const item of declarationRows) {
        lines.push("| " + [
          cell(item.theme), cell(item.viewport), cell(item.selector),
          cell(item.property), cell(item.value), cell(item.source)
        ].join(" | ") + " |");
      }
      lines.push("");
    }
  }

  if (Array.isArray(report.viewports) &&
      report.viewports.some((viewport) => viewport.evidence?.themeAudit || viewport.evidence?.contrastSummary)) {
    lines.push(
      "## Theme and contrast audit",
      "",
      "| Theme | Viewport | Measured | Failures | Inconclusive | Exempt | Root marker | Color tokens | Hardcoded declarations | Changed tokens | Round-trip restore |",
      "|---|---|---:|---:|---:|---:|---|---:|---:|---:|---|"
    );
    for (const viewport of report.viewports) {
      const contrast = viewport.evidence?.contrastSummary ?? {};
      const theme = viewport.evidence?.themeAudit ?? {};
      const marker = theme.themeMarker
        ? theme.themeMarker + " (" + (theme.themeMarkerSource || "detected") + ")"
        : "not explicit / media-query based";
      const comparison = viewport.themeTokenComparison ?? {};
      const transition = viewport.evidence?.themeTransitionAudit ?? {};
      lines.push("| " + [
        cell(viewport.theme ?? "—"),
        cell(viewport.name),
        cell(contrast.measured ?? 0),
        cell(contrast.failed ?? 0),
        cell(contrast.inconclusive ?? 0),
        cell(contrast.exempt ?? 0),
        cell(marker),
        cell((theme.colorTokens ?? []).length),
        cell(theme.hardcodedColorDeclarationCount ?? 0),
        cell(comparison.changedTokens?.length ?? "—"),
        cell(transition.enabled ? (transition.restoredStable ? "Stable" : "Drift detected") : "Not run")
      ].join(" | ") + " |");
    }
    lines.push("");
    const truncated = report.viewports.some((viewport) =>
      viewport.evidence?.contrastSamplesTruncated);
    if (truncated) {
      lines.push("> Note: interaction contrast evidence reached its configured sample limit; inspect the coverage metadata.", "");
    }
  }

  if (Array.isArray(report.viewports) &&
      report.viewports.some((viewport) => viewport.visualComparison || viewport.screenshotPath)) {
    lines.push(
      "## Visual regression",
      "",
      "| Theme | Viewport | Capture | Baseline status | Difference | Result |",
      "|---|---|---|---|---:|---|"
    );
    for (const viewport of report.viewports) {
      const visual = viewport.visualComparison;
      lines.push("| " + [
        cell(viewport.theme ?? "—"),
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

  if (Array.isArray(report.viewports) &&
      report.viewports.some((viewport) =>
        (viewport.evidence?.interactionExploration?.states ?? []).length > 0)) {
    lines.push(
      "## Interactive state exploration",
      "",
      "| Theme | Viewport | State | Trigger | Detected theme | Root color-scheme | Toggle effect | Changed tokens | Visible controls | Overlaps | Baseline | Difference | Result |",
      "|---|---|---|---|---|---|---|---:|---:|---:|---|---:|---|"
    );
    for (const viewport of report.viewports) {
      for (const state of viewport.evidence?.interactionExploration?.states ?? []) {
        const visual = state.visualComparison;
        const difference = visual && typeof visual.diffPixelRatio === "number"
          ? (visual.diffPixelRatio * 100).toFixed(3) + "%"
          : "—";
        lines.push("| " + [
          cell(viewport.theme ?? "—"),
          cell(viewport.name),
          cell(state.kind),
          cell(state.triggerSelector),
          cell(state.themeMarker || "not explicit"),
          cell(state.rootColorScheme || "—"),
          cell(state.themeToggleEffect?.status || "—"),
          cell(state.themeToggleEffect?.changedTokenCount ?? state.themeToggleEffect?.changedTokens?.length ?? "—"),
          cell(state.visibleControls ?? 0),
          cell(state.overlapCount ?? 0),
          cell(visual?.status || "not compared"),
          cell(difference),
          cell(visual ? (visual.passed ? "PASS" : "REVIEW") : "—")
        ].join(" | ") + " |");
      }
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
