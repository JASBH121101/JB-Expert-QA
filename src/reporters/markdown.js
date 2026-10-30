function findingsFor(report) {
  if (Array.isArray(report.viewports)) {
    return report.viewports.flatMap((viewport) =>
      (viewport.findings ?? []).map((finding) => ({ ...finding, viewport: viewport.name }))
    );
  }
  return (report.diagnostics ?? []).map((finding) => ({ ...finding, viewport: "single" }));
}

function cell(value) {
  return String(value ?? "—").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

export function formatMarkdownReport(report) {
  const findings = findingsFor(report);
  const target = report.target?.url ?? "Not specified";
  const score = report.scoring?.score ?? null;
  const passed = Array.isArray(report.viewports)
    ? report.passed
    : report.scoring?.passed;

  const lines = [
    "# JB Expert QA report",
    "",
    "- **Target:** " + target,
    "- **Generated:** " + (report.generatedAt ?? "Unknown"),
    "- **Status:** " + (passed ? "PASS" : "REVIEW REQUIRED"),
    "- **Score:** " + (score === null ? "Per viewport" : score + "/100"),
    "",
    "## Summary",
    ""
  ];

  if (Array.isArray(report.viewports)) {
    lines.push(
      "- Viewports checked: " + (report.summary?.viewportsChecked ?? report.viewports.length),
      "- Passed viewports: " + (report.summary?.passedViewports ?? 0),
      "- Failed viewports: " + (report.summary?.failedViewports ?? 0),
      "- Total findings: " + (report.summary?.totalFindings ?? findings.length),
      ""
    );
  } else {
    lines.push(
      "- Rules executed: " + (report.summary?.rulesExecuted ?? 0),
      "- Rule execution errors: " + (report.summary?.rulesWithErrors ?? 0),
      "- Findings: " + (report.summary?.findings ?? findings.length),
      ""
    );
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
      lines.push("- [" + (item.status ?? "unknown") + "] " +
        (item.viewport ? item.viewport + " · " : "") +
        item.ruleId + (item.error ? " — " + item.error : ""));
    }
  }
  lines.push("");
  return lines.join("\n");
}
