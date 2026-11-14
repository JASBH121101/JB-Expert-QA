import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMalwareEngine } from "../../malware-engine/src/index.js";
import { createThreatLab } from "../src/index.js";

const VARIANTS = [
  {
    id: "malware.trojan.scheduled-task-persistence",
    marker: "Register-ScheduledTask",
    signal: "scheduled-task-persistence"
  },
  {
    id: "malware.trojan.service-persistence",
    marker: "New-Service",
    signal: "service-persistence"
  },
  {
    id: "malware.trojan.wmi-persistence",
    marker: "Register-WmiEvent",
    signal: "wmi-event-subscription-persistence"
  }
];

function outcome(passed, summary, metrics, finding) {
  return {
    status: passed ? "pass" : "fail",
    summary,
    metrics,
    findings: passed ? [] : [finding]
  };
}

test("JB Threat Lab validates Trojan-like script chains across persistence mechanisms", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-trojan-persistence-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const engine = createMalwareEngine({ quarantineDir: path.join(root, "quarantine") });
  const lab = createThreatLab({ name: "JB Trojan Persistence Validation", version: "0.1.0" });

  lab.registerTarget({
    id: "jb-malware-engine",
    kind: "security-engine",
    version: "0.6.2",
    capabilities: ["script-static-analysis", "persistence-correlation", "trojan-family-triage"],
    adapter: {
      async runScenario({ scenario }) {
        const variant = VARIANTS.find((item) => item.id === scenario.id);
        if (!variant) return { status: "skip", summary: "No handler for this persistence scenario" };

        const fixture = [
          "$downloadMarker = 'DownloadString'",
          "$executionMarker = 'Invoke-Expression'",
          `$persistenceMarker = '${variant.marker}'`
        ].join("\n");
        const filePath = path.join(root, `${scenario.id}.ps1`);
        await writeFile(filePath, fixture, { flag: "wx" });
        const report = await engine.scanFile(filePath);
        const familyIds = report.threatAssessment.families.map((family) => family.id);
        const signalIds = report.signals.map((signal) => signal.id);
        const passed = report.status === "suspicious"
          && report.detections.length === 0
          && familyIds.includes("trojan-like")
          && signalIds.includes("script-download-primitive")
          && signalIds.includes("dynamic-code-execution")
          && signalIds.includes(variant.signal);
        return outcome(
          passed,
          passed
            ? `Correlated download, dynamic execution and ${variant.signal} as a Trojan-like candidate without confirming malware`
            : `Trojan-like correlation failed for ${variant.signal}`,
          {
            verdict: report.status,
            persistenceSignal: variant.signal,
            candidateFamilies: familyIds,
            detectedSignals: signalIds,
            confirmedDetections: report.detections.length,
            sampleExecuted: false,
            networkRequests: 0
          },
          {
            code: "TROJAN_PERSISTENCE_CORRELATION_MISMATCH",
            expectedSignal: variant.signal,
            actualSignals: signalIds,
            candidateFamilies: familyIds,
            verdict: report.status
          }
        );
      }
    }
  });

  for (const variant of VARIANTS) {
    lab.registerScenario({
      id: variant.id,
      category: "trojan-persistence",
      description: `Correlate inert download and dynamic-execution markers with ${variant.signal}.`,
      appliesTo: ["jb-malware-engine"],
      safety: { safe: true, network: false, destructive: false, executesSample: false },
      tags: ["trojan-defense", "inert-script", "offline"]
    });
  }

  const report = await lab.run({
    metadata: {
      suite: "trojan-script-persistence-correlation",
      sampleExecution: false,
      networkRequests: 0,
      productionTargets: false
    }
  });

  assert.equal(report.totals.fail, 0, JSON.stringify(report.results.filter((item) => item.status === "fail"), null, 2));
  assert.equal(report.totals.pass, VARIANTS.length);
  assert.equal(report.totals.skip, 0);
  assert.equal(report.results.length, VARIANTS.length);
});
