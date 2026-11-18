import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const REPORT_SCHEMA = "jb.threat-lab.report/v2";

/**
 * Persist a test's original Threat Lab report only when CI explicitly requests
 * it. Local test runs remain side-effect free. Writes are atomic and private.
 */
export async function persistThreatLabReport(report, reportId) {
  const reportDirectory = process.env.JB_THREAT_LAB_REPORT_DIR;
  if (!reportDirectory) return null;
  if (!report || report.schema !== REPORT_SCHEMA || !Array.isArray(report.results)) {
    throw new TypeError("Only complete Threat Lab v2 reports can be persisted");
  }
  if (typeof reportId !== "string" || !/^[a-z0-9][a-z0-9._-]{1,79}$/i.test(reportId)) {
    throw new TypeError("reportId must be a stable 2-80 character identifier");
  }

  const directory = path.resolve(reportDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = path.join(directory, reportId + ".json");
  const temporary = path.join(directory, "." + reportId + "." + randomUUID() + ".tmp");
  const payload = JSON.stringify({ reportId, report }, null, 2) + "\n";

  try {
    await writeFile(temporary, payload, { flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } catch (error) {
    throw new Error("Unable to persist Threat Lab report " + reportId, { cause: error });
  }

  return destination;
}
