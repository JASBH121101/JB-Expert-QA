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
  const target = cell(report.target?.url ?? "Not specified");
  const score = report.scoring?.score ?? null;
  const passed = Array.isArray(report.viewports)
    ? report.passed
    : report.scoring?.passed;

  const lines = [
    "# JB Expert QA report",
    "",
    "- **Target:** " + target,
    "- **Generated:** " + cell(report.generatedAt ?? "Unknown"),
    "- **Status:** " + (passed ? "PASS" : "REVIEW REQUIRED"),
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
