import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createUnifiedThreatLabCertificationReport } from "../packages/threat-lab/src/certification-report.js";

const reportDirectory = process.env.JB_THREAT_LAB_REPORT_DIR;
if (typeof reportDirectory !== "string" || !reportDirectory.trim()) {
  throw new Error("JB_THREAT_LAB_REPORT_DIR must point to the directory containing original Threat Lab reports");
}

const sourceDirectory = path.resolve(reportDirectory);
const fileNames = (await readdir(sourceDirectory))
  .filter((name) => /^[a-z0-9][a-z0-9._-]{1,79}\.json$/i.test(name))
  .sort();

if (fileNames.length < 1 || fileNames.length > 50) {
  throw new Error("Expected 1-50 persisted Threat Lab source reports; found " + fileNames.length);
}

const reports = [];
for (const fileName of fileNames) {
  const parsed = JSON.parse(await readFile(path.join(sourceDirectory, fileName), "utf8"));
  reports.push({
    reportId: parsed.reportId,
    report: parsed.report
  });
}

const report = createUnifiedThreatLabCertificationReport({
  reports,
  commit: process.env.GITHUB_SHA || null,
  runtime: process.version,
  platform: process.platform,
  architecture: process.arch
});

const outputPath = path.resolve(
  process.env.JB_THREAT_LAB_CERTIFICATION_OUTPUT ||
  path.join(sourceDirectory, "unified-certification-report.v1.json")
);
await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });

console.log(JSON.stringify({
  schema: report.schema,
  reportPath: outputPath,
  commit: report.commit,
  sourceReports: report.scope.sourceReports,
  totals: report.totals,
  missingTargets: report.scope.missingTargets,
  targetReadiness: report.assessment.targets.map((target) => ({
    id: target.target.id,
    ready: target.ready,
    coveredLevels: target.coveredLevels,
    missingLevels: target.missingLevels,
    failed: target.failed,
    skipped: target.skipped
  })),
  ready: report.assessment.ready
}, null, 2));

if (!report.assessment.ready) process.exitCode = 1;
