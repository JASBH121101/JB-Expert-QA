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
  const passed = Array.isArray(report.viewports) ? report.passed : report.scoring?.passed;
  const status = passed ? "PASS" : "REVIEW REQUIRED";
  const score = report.scoring?.score;
  const rows = findings.length
    ? findings.map((item) => "<tr>" + [
        item.viewport,
        item.specialist,
        item.severity,
        item.title,
        item.location,
        item.recommendation
      ].map((value) => "<td>" + escapeHtml(value) + "</td>").join("") + "</tr>").join("\n")
    : '<tr><td colspan="6">No findings reported.</td></tr>';

  const summary = Array.isArray(report.viewports)
    ? "Viewports: " + (report.summary?.viewportsChecked ?? report.viewports.length) +
      " · Passed: " + (report.summary?.passedViewports ?? 0) +
      " · Findings: " + (report.summary?.totalFindings ?? findings.length)
    : "Rules: " + (report.summary?.rulesExecuted ?? 0) +
      " · Execution errors: " + (report.summary?.rulesWithErrors ?? 0) +
      " · Findings: " + (report.summary?.findings ?? findings.length);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>JB Expert QA report</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:1200px;margin:32px auto;padding:0 20px;color:#172033}
h1,h2{line-height:1.2} .status{font-weight:700} .meta{color:#586174}
table{width:100%;border-collapse:collapse;margin-top:16px} th,td{text-align:left;vertical-align:top;padding:10px;border-bottom:1px solid #dce1ea;overflow-wrap:anywhere}
th{background:#f2f4f8} code{overflow-wrap:anywhere}
</style>
</head>
<body>
<h1>JB Expert QA report</h1>
<p class="status">Status: ${escapeHtml(status)} · Score: ${escapeHtml(score === undefined || score === null ? "Per viewport" : score + "/100")}</p>
<p class="meta">Target: <code>${escapeHtml(report.target?.url)}</code></p>
<p class="meta">Generated: ${escapeHtml(report.generatedAt)} · ${escapeHtml(summary)}</p>
<h2>Findings</h2>
<table>
<thead><tr><th>Viewport</th><th>Specialist</th><th>Severity</th><th>Finding</th><th>Location</th><th>Recommendation</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</body>
</html>
`;
}
