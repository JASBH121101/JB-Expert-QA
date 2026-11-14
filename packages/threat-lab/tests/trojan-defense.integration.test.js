import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMalwareEngine } from "../../malware-engine/src/index.js";
import { createThreatLab } from "../src/index.js";

const TROJAN_LIKE_INERT_TEXT = [
  "$downloadMarker = 'DownloadString'",
  "$executionMarker = 'Invoke-Expression'",
  "$persistenceMarker = '\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'"
].join("\n");

const BENIGN_SINGLE_INDICATOR_TEXT = "$updaterDocumentation = 'DownloadFile'";

function outcome(passed, summary, metrics, finding) {
  return {
    status: passed ? "pass" : "fail",
    summary,
    metrics,
    findings: passed ? [] : [finding]
  };
}

test("JB Threat Lab validates Trojan-oriented static triage and conservative handling", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-trojan-defense-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const quarantineDir = path.join(root, "quarantine");
  const trojanFixturePath = path.join(root, "trojan-like-inert-fixture.ps1");
  const benignFixturePath = path.join(root, "benign-single-indicator.ps1");
  const engine = createMalwareEngine({ quarantineDir });
  const lab = createThreatLab({ name: "JB Trojan Defense Validation", version: "0.1.0" });
  let trojanReport = null;

  lab.registerTarget({
    id: "jb-malware-engine",
    kind: "security-engine",
    version: "0.6.2",
    capabilities: ["trojan-static-triage", "family-correlation", "conservative-quarantine"],
    adapter: {
      async runScenario({ scenario }) {
        if (scenario.id === "malware.trojan.delivery-execution-persistence") {
          await writeFile(trojanFixturePath, TROJAN_LIKE_INERT_TEXT, { flag: "wx" });
          trojanReport = await engine.scanFile(trojanFixturePath);
          const familyIds = trojanReport.threatAssessment.families.map((family) => family.id);
          const signalIds = trojanReport.signals.map((signal) => signal.id);
          const passed = trojanReport.status === "suspicious"
            && trojanReport.detections.length === 0
            && familyIds.includes("trojan-like")
            && familyIds.includes("downloader")
            && signalIds.includes("script-download-primitive")
            && signalIds.includes("dynamic-code-execution")
            && signalIds.includes("windows-run-key-persistence");
          return outcome(
            passed,
            passed
              ? "Correlated inert download, dynamic-execution and Run-key indicators as a Trojan-like candidate without claiming confirmed malware"
              : "Trojan-like static behavior correlation did not match the expected conservative result",
            {
              verdict: trojanReport.status,
              candidateFamilies: familyIds,
              signals: signalIds,
              confirmedDetections: trojanReport.detections.length,
              sampleExecuted: false,
              networkRequests: 0
            },
            { code: "TROJAN_BEHAVIOR_CORRELATION_MISMATCH", expected: "suspicious + trojan-like", actual: trojanReport.status, familyIds, signalIds }
          );
        }

        if (scenario.id === "malware.trojan.single-indicator-false-positive") {
          await writeFile(benignFixturePath, BENIGN_SINGLE_INDICATOR_TEXT, { flag: "wx" });
          const report = await engine.scanFile(benignFixturePath);
          const familyIds = report.threatAssessment.families.map((family) => family.id);
          const passed = report.status === "no_match"
            && report.detections.length === 0
            && report.threatAssessment.status === "no_family_pattern"
            && !familyIds.includes("trojan-like");
          return outcome(
            passed,
            passed
              ? "A single low-specificity download marker did not become a Trojan or confirmed-malware verdict"
              : "A single low-specificity marker was over-classified",
            {
              verdict: report.status,
              familyStatus: report.threatAssessment.status,
              candidateFamilies: familyIds,
              confirmedDetections: report.detections.length
            },
            { code: "TROJAN_SINGLE_INDICATOR_FALSE_POSITIVE", expected: "no_match + no_family_pattern", actual: report.status, familyIds }
          );
        }

        if (scenario.id === "malware.trojan.suspicious-never-quarantine") {
          let rejectionCode = null;
          try {
            await engine.quarantineFile(trojanReport);
          } catch (error) {
            rejectionCode = error.code ?? "UNKNOWN";
          }
          let sourceStillExists = true;
          try { await access(trojanFixturePath); } catch { sourceStillExists = false; }
          const passed = trojanReport?.status === "suspicious"
            && rejectionCode === "VERDICT_REQUIRED"
            && sourceStillExists;
          return outcome(
            passed,
            passed
              ? "A Trojan-like candidate remained in place because suspicious is not a confirmed malicious verdict"
              : "The quarantine boundary did not reject a non-confirmed report",
            {
              verdict: trojanReport?.status ?? null,
              quarantineRejectionCode: rejectionCode,
              sourceStillExists,
              quarantineCreated: false
            },
            { code: "SUSPICIOUS_REPORT_QUARANTINE_BOUNDARY", expected: "VERDICT_REQUIRED", actual: rejectionCode }
          );
        }

        return { status: "skip", summary: "No handler for this Trojan-defense scenario" };
      }
    }
  });

  const scenarios = [
    ["malware.trojan.delivery-execution-persistence", "trojan-detection", "Correlate inert download, dynamic execution and persistence indicators."],
    ["malware.trojan.single-indicator-false-positive", "trojan-false-positive", "Do not infer a Trojan family from one generic low-specificity indicator."],
    ["malware.trojan.suspicious-never-quarantine", "trojan-containment", "Do not quarantine a suspicious candidate without a confirmed malicious signature."]
  ];

  for (const [id, category, description] of scenarios) {
    lab.registerScenario({
      id,
      category,
      description,
      appliesTo: ["jb-malware-engine"],
      safety: { safe: true, network: false, destructive: false, executesSample: false },
      tags: ["trojan-defense", "inert-fixture", "offline"]
    });
  }

  const report = await lab.run({
    metadata: {
      suite: "trojan-static-triage-and-containment",
      sampleExecution: false,
      networkRequests: 0,
      productionTargets: false
    }
  });

  assert.equal(report.totals.fail, 0, JSON.stringify(report.results.filter((item) => item.status === "fail"), null, 2));
  assert.equal(report.totals.pass, scenarios.length);
  assert.equal(report.totals.skip, 0);
  assert.equal(report.results.length, scenarios.length);
});
