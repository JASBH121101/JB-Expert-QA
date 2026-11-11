function escapeHtml(value) {
  return String(value ?? "—").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function findingsFor(report) {
  if (Array.isArray(report.viewports)) {
    return report.viewports.flatMap((viewport) =>
      (viewport.findings ?? []).map((finding) => ({ ...finding, viewport: viewport.name }))
    );
  }
  return (report.diagnostics ?? []).map((finding) => ({ ...finding, viewport: "single" }));
}

export function formatHtmlReport(report) {
  const findings = findingsFor(report);
  const basePassed = Array.isArray(report.viewports) ? report.passed : report.scoring?.passed;
  const coverageIncomplete = Boolean(report.analysisScope && (
    report.analysisScope.complete === false ||
    ["partial", "insufficient-source"].includes(report.analysisScope.assessmentStatus) ||
    report.analysisScope.deadCodeAnalysis?.status === "partial"
  ));
  const passed = Boolean(basePassed && !coverageIncomplete);
  const status = passed ? "PASS" : coverageIncomplete ? "REVIEW REQUIRED — PARTIAL COVERAGE" : "REVIEW REQUIRED";
  const score = report.scoring?.score;
  const target = report.target?.url ?? report.target?.project ?? "Not specified";
  const rows = findings.length
    ? findings.map((item) => "<tr>" + [
        item.viewport, item.specialist, item.severity, item.title, item.location, item.recommendation
      ].map((value) => "<td>" + escapeHtml(value) + "</td>").join("") + "</tr>").join("\n")
    : '<tr><td colspan="6">No findings reported.</td></tr>';

  const summary = Array.isArray(report.viewports)
    ? "Viewports: " + (report.summary?.viewportsChecked ?? report.viewports.length) +
      " · Passed: " + (report.summary?.passedViewports ?? 0) +
      " · Findings: " + (report.summary?.totalFindings ?? findings.length)
    : "Rules: " + (report.summary?.rulesExecuted ?? 0) +
      " · Execution errors: " + (report.summary?.rulesWithErrors ?? 0) +
      " · Findings: " + (report.summary?.findings ?? findings.length);

  const projectSummary = report.projectScan
    ? '<p class="meta">Project files read: ' + escapeHtml(report.projectScan.filesRead) +
      " · Environment files skipped: " + escapeHtml(report.projectScan.environmentFiles) +
      " · Sensitive files skipped: " + escapeHtml(report.projectScan.sensitiveFiles) +
      " · Scan truncated: " + escapeHtml(report.projectScan.truncated) + "</p>"
    : "";

  const coverage = report.analysisScope?.languageCoverage ?? {};
  const moduleGraph = coverage.javascriptModuleGraph ?? {};
  const cssCoverage = coverage.cssSelectors ?? {};
  const databaseCoverage = coverage.database ?? {};
  const coverageSection = report.analysisScope
    ? "<h2>Analysis coverage</h2><ul>" + [
        "Assessment: " + (report.analysisScope.assessmentStatus ?? "unknown"),
        "Scan complete: " + (report.analysisScope.complete ?? false),
        "Source files analyzed: " + (report.analysisScope.sourceFiles ?? 0),
        "Extensions scanned: " + ((report.analysisScope.scannedExtensions ?? []).join(", ") || "none"),
        "JavaScript module graph: " + ((moduleGraph.supportedExtensions ?? []).join(", ") || "not configured") +
          "; unsupported module files: " + (moduleGraph.unsupportedModuleFiles ?? 0),
        "CSS selector parsing: " + ((cssCoverage.parsedExtensions ?? []).join(", ") || "not configured") +
          "; indented Sass files not parsed: " + (cssCoverage.indentedSassFiles ?? 0),
        "SQL/Prisma analysis: " + ((databaseCoverage.supportedExtensions ?? []).join(", ") || "not configured") +
          "; scanned files: " + (databaseCoverage.scannedFiles ?? 0),
        "Scan gaps: " + ((report.analysisScope.incompleteReasons ?? []).join("; ") || "none")
      ].map((value) => "<li>" + escapeHtml(value) + "</li>").join("") + "</ul>"
    : "";

  const deadCode = report.analysisScope?.deadCodeAnalysis;
  const deadCodeSection = deadCode
    ? "<h2>Dead-code and dependency analysis</h2><ul>" + [
        "Analysis status: " + (deadCode.status ?? "unknown"),
        "Coverage warnings: " + (deadCode.coverageWarnings ?? 0),
        "Possible unused exports: " + (deadCode.possibleUnusedExports ?? 0),
        "Possible unused bindings: " + (deadCode.possibleUnusedBindings ?? 0),
        "Possible unused CSS selectors: " + (deadCode.possibleUnusedCssSelectors ?? 0),
        "Possible unused declarations: " + (deadCode.possibleUnusedDeclarations ?? 0),
        "Unresolved relative imports: " + (deadCode.unresolvedRelativeImports ?? 0),
        "Dependency cycles: " + (deadCode.dependencyCycles ?? 0)
      ].map((value) => "<li>" + escapeHtml(value) + "</li>").join("") + "</ul>"
    : "";

  const visualSection = Array.isArray(report.viewports) &&
    report.viewports.some((viewport) => viewport.visualComparison || viewport.screenshotPath)
    ? "<h2>Visual regression</h2><table><thead><tr><th>Viewport</th><th>Capture</th><th>Baseline</th><th>Difference</th><th>Result</th></tr></thead><tbody>" +
      report.viewports.map((viewport) => {
        const visual = viewport.visualComparison;
        const difference = visual && typeof visual.diffPixelRatio === "number"
          ? (visual.diffPixelRatio * 100).toFixed(3) + "%" : "—";
        return "<tr>" + [
          viewport.name,
          viewport.screenshotPath || "not captured",
          visual ? visual.status : "not compared",
          difference,
          visual ? (visual.passed ? "PASS" : "REVIEW") : "—"
        ].map((value) => "<td>" + escapeHtml(value) + "</td>").join("") + "</tr>";
      }).join("") + "</tbody></table>"
    : "";

  const aiReviews = report.aiVisualReview;
  const aiSection = aiReviews
    ? "<h2>AI-assisted visual review</h2><p class='meta'>Provider: " +
      escapeHtml(aiReviews.provider || "not configured") + " · Model: " +
      escapeHtml(aiReviews.model || "not selected") + " · Status: " +
      escapeHtml(aiReviews.status || "unknown") +
      " · Human review required: yes</p>" +
      (aiReviews.reviews || []).map((item) => {
        const review = item.review;
        if (!review) {
          return "<h3>" + escapeHtml(item.viewport || "Viewport") + "</h3><p>" +
            escapeHtml(item.error || item.status || "Review unavailable") + "</p>";
        }
        const issues = (review.issues || []).map((issue) =>
          "<li><strong>" + escapeHtml(issue.severity) + "</strong> · " +
          escapeHtml(issue.region) + ": " + escapeHtml(issue.evidence) +
          " Recommendation: " + escapeHtml(issue.recommendation) + "</li>"
        ).join("");
        return "<h3>" + escapeHtml(item.viewport || "Viewport") + "</h3><p>" +
          "Score: " + escapeHtml(review.visualScore ?? "not scored") + "/100 · " +
          escapeHtml(review.assessment || "") + "</p><ul>" +
          (issues || "<li>No visible issues reported.</li>") + "</ul>";
      }).join("")
    : "";

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>JB Expert QA report</title>",
    "<style>",
    "body{font:16px/1.5 system-ui,sans-serif;max-width:1200px;margin:32px auto;padding:0 20px;color:#172033}",
    "h1,h2{line-height:1.2}.status{font-weight:700}.meta{color:#586174}",
    "table{width:100%;border-collapse:collapse;margin-top:16px}th,td{text-align:left;vertical-align:top;padding:10px;border-bottom:1px solid #dce1ea;overflow-wrap:anywhere}",
    "th{background:#f2f4f8}code{overflow-wrap:anywhere}",
    "</style>",
    "</head>",
    "<body>",
    "<h1>JB Expert QA report</h1>",
    '<p class="status">Status: ' + escapeHtml(status) + " · Score: " +
      escapeHtml(score === undefined || score === null ? "Per viewport" : score + "/100") + "</p>",
    '<p class="meta">Target: <code>' + escapeHtml(target) + "</code></p>",
    '<p class="meta">Generated: ' + escapeHtml(report.generatedAt) + " · " + escapeHtml(summary) + "</p>",
    projectSummary,
    coverageSection,
    deadCodeSection,
    visualSection,
    aiSection,
    "<h2>Findings</h2>",
    "<table>",
    "<thead><tr><th>Viewport</th><th>Specialist</th><th>Severity</th><th>Finding</th><th>Location</th><th>Recommendation</th></tr></thead>",
    "<tbody>" + rows + "</tbody>",
    "</table>",
    "</body>",
    "</html>",
    ""
  ].join("\n");
}
