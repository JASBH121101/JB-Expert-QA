# JB Expert QA — QA Intelligence & Consolidated Reporting (Block 5)

## Purpose

Block 5 adds read-only portfolio intelligence over the dashboard's bounded local audit history. It does not introduce another auditor and does not change the outcome of individual engine runs.

## Aggregation model

- History remains bounded by the dashboard's existing retention limit.
- The current-state view keeps the newest record for each engine and target identity.
- Severity totals and recurring findings are calculated from the retained finding detail in those current snapshots.
- Findings omitted by the per-run detail cap remain included in the reported total and are shown as unclassified.
- Engine coverage means the engine appears somewhere in retained history. It does not prove that all engines assessed the same target.
- Score trends list the latest 12 saved runs. Mean scores across different engines and targets are indicative only, not normalized comparative benchmarks.

## Dashboard and endpoints

The Control Center adds:
- Average score across current snapshots.
- Clean-pass rate for snapshots with outcome \`passed\` and no recorded findings.
- Active finding totals and severity distribution.
- Engine coverage, run count, latest status and historical mean score.
- The latest 12 score observations.
- A downloadable consolidated Markdown report.

Read-only local routes:
- \`GET /api/analytics\` — JSON intelligence data.
- \`GET /api/reports/consolidated\` — downloadable Markdown report.

## Assessment labels

- \`NOT_ASSESSED\`: no saved audit snapshot exists.
- \`NOT_PASSED\`: at least one latest engine/target snapshot did not pass.
- \`REVIEW_REQUIRED\`: at least one critical or high-severity finding remains in current snapshots.
- \`OBSERVATIONS\`: findings remain, including finding counts whose detail was omitted by the retention cap.
- \`PASSED_WITHIN_RECORDED_SCOPE\`: no findings were reported in the latest saved snapshots.

These labels summarize recorded local evidence. They are not third-party certification or proof of full project coverage.

## Privacy and operational boundaries

Analytics are computed from the existing local history file. No external API, paid service, database, telemetry endpoint or network destination is added. The report is generated on request and does not write additional records. Existing loopback binding, same-origin enforcement, restrictive response headers and history storage permissions remain in force.

## Verification

\`\`\`bash
node --test tests/dashboard-analytics.test.js tests/dashboard.test.js
npm run qa:local
npm run test:package-distributions
\`\`\`
