import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMalwareEngine } from "../../malware-engine/src/index.js";
import { createThreatLab } from "../src/index.js";

function buildMinimalPE() {
  const peOffset = 0x80;
  const optionalSize = 224;
  const sectionTable = peOffset + 4 + 20 + optionalSize;
  const headersSize = 0x200;
  const sectionRawSize = 0x200;
  const buffer = Buffer.alloc(headersSize + 2 * sectionRawSize, 0);
  buffer.writeUInt16LE(0x5a4d, 0);
  buffer.writeUInt32LE(peOffset, 0x3c);
  buffer.write("PE\0\0", peOffset, "binary");
  const coff = peOffset + 4;
  buffer.writeUInt16LE(0x014c, coff);
  buffer.writeUInt16LE(2, coff + 2);
  buffer.writeUInt32LE(0x67200000, coff + 4);
  buffer.writeUInt16LE(optionalSize, coff + 16);
  buffer.writeUInt16LE(0x0102, coff + 18);

  const optional = coff + 20;
  buffer.writeUInt16LE(0x010b, optional);
  buffer.writeUInt32LE(0x1000, optional + 16);
  buffer.writeUInt32LE(0x400000, optional + 28);
  buffer.writeUInt32LE(0x1000, optional + 32);
  buffer.writeUInt32LE(0x200, optional + 36);
  buffer.writeUInt32LE(0x3000, optional + 56);
  buffer.writeUInt32LE(headersSize, optional + 60);
  buffer.writeUInt16LE(3, optional + 68);
  buffer.writeUInt16LE(0x0140, optional + 70);
  buffer.writeUInt32LE(16, optional + 92);

  for (let index = 0; index < 2; index += 1) {
    const offset = sectionTable + index * 40;
    buffer.write(index === 0 ? ".text" : ".data", offset, "ascii");
    buffer.writeUInt32LE(0x100, offset + 8);
    buffer.writeUInt32LE(0x1000 + index * 0x1000, offset + 12);
    buffer.writeUInt32LE(sectionRawSize, offset + 16);
    buffer.writeUInt32LE(headersSize + index * sectionRawSize, offset + 20);
    buffer.writeUInt32LE(index === 0 ? 0x60000020 : 0xc0000040, offset + 36);
  }

  const importDirectoryOffset = optional + 96 + 8;
  buffer.writeUInt32LE(0x2000, importDirectoryOffset);
  buffer.writeUInt32LE(40, importDirectoryOffset + 4);

  const raw = headersSize + 0x200;
  const descriptor = raw;
  buffer.writeUInt32LE(0x2040, descriptor);
  buffer.writeUInt32LE(0, descriptor + 4);
  buffer.writeUInt32LE(0, descriptor + 8);
  buffer.writeUInt32LE(0x2030, descriptor + 12);
  buffer.writeUInt32LE(0x2060, descriptor + 16);
  buffer.write("KERNEL32.dll\0", raw + 0x30, "ascii");

  return { buffer, raw };
}

function addImportNames(pe, functionNames) {
  functionNames.forEach((name, index) => {
    const nameRva = 0x2070 + index * 0x20;
    pe.buffer.writeUInt32LE(nameRva, pe.raw + 0x40 + index * 4);
    const nameOffset = pe.raw + (nameRva - 0x2000);
    pe.buffer.writeUInt16LE(0, nameOffset);
    pe.buffer.write(name + "\0", nameOffset + 2, "ascii");
  });
  pe.buffer.writeUInt32LE(0, pe.raw + 0x40 + functionNames.length * 4);
}

function outcome(passed, summary, metrics, finding) {
  return {
    status: passed ? "pass" : "fail",
    summary,
    metrics,
    findings: passed ? [] : [finding]
  };
}

test("JB Threat Lab validates PE-based RAT and Trojan capability correlation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-trojan-pe-defense-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const fullRatPath = path.join(root, "synthetic-rat-capability-fixture.exe");
  const isolatedPath = path.join(root, "isolated-injection-capability-fixture.exe");
  const engine = createMalwareEngine({ quarantineDir: path.join(root, "quarantine") });
  const lab = createThreatLab({ name: "JB PE Trojan Defense Validation", version: "0.1.0" });

  lab.registerTarget({
    id: "jb-malware-engine",
    kind: "security-engine",
    version: "0.6.2",
    capabilities: ["pe-import-analysis", "rat-correlation", "trojan-static-triage"],
    adapter: {
      async runScenario({ scenario }) {
        if (scenario.id === "malware.trojan.pe-rat-capability-chain") {
          const pe = buildMinimalPE();
          addImportNames(pe, [
            "VirtualAllocEx",
            "WriteProcessMemory",
            "CreateRemoteThread",
            "WSAStartup",
            "connect",
            "send",
            "CreateProcessW"
          ]);
          await writeFile(fullRatPath, pe.buffer, { flag: "wx" });
          const report = await engine.scanFile(fullRatPath);
          const capabilities = report.peAnalysis?.imports?.capabilities?.map((item) => item.id) ?? [];
          const families = report.threatAssessment.families.map((item) => item.id);
          const passed = report.peAnalysis?.status === "complete"
            && report.status === "suspicious"
            && capabilities.includes("process-injection-api-chain")
            && capabilities.includes("remote-network-command-channel")
            && families.includes("rat")
            && families.includes("trojan-like")
            && report.detections.length === 0;
          return outcome(
            passed,
            passed
              ? "Correlated synthetic PE process-injection and remote-command-channel imports as RAT/Trojan-like behavior without a confirmed-malware verdict"
              : "PE import capabilities did not produce the expected conservative RAT/Trojan candidate",
            {
              verdict: report.status,
              peStatus: report.peAnalysis?.status ?? null,
              capabilities,
              candidateFamilies: families,
              confirmedDetections: report.detections.length,
              sampleExecuted: false,
              networkRequests: 0
            },
            { code: "PE_RAT_CORRELATION_MISMATCH", expected: ["rat", "trojan-like"], actual: families, capabilities }
          );
        }

        if (scenario.id === "malware.trojan.pe-injection-alone-not-rat") {
          const pe = buildMinimalPE();
          addImportNames(pe, ["VirtualAllocEx", "WriteProcessMemory", "CreateRemoteThread"]);
          await writeFile(isolatedPath, pe.buffer, { flag: "wx" });
          const report = await engine.scanFile(isolatedPath);
          const families = report.threatAssessment.families.map((item) => item.id);
          const passed = report.peAnalysis?.status === "complete"
            && report.status !== "malicious"
            && !families.includes("rat")
            && !families.includes("trojan-like")
            && report.detections.length === 0;
          return outcome(
            passed,
            passed
              ? "An isolated process-injection capability did not become a RAT/Trojan family without a correlated remote command channel"
              : "An isolated PE capability was over-classified as a RAT/Trojan",
            {
              verdict: report.status,
              peStatus: report.peAnalysis?.status ?? null,
              capabilities: report.peAnalysis?.imports?.capabilities?.map((item) => item.id) ?? [],
              candidateFamilies: families,
              confirmedDetections: report.detections.length
            },
            { code: "PE_RAT_SINGLE_CAPABILITY_FALSE_POSITIVE", candidateFamilies: families }
          );
        }

        return { status: "skip", summary: "No handler for this PE Trojan-defense scenario" };
      }
    }
  });

  const scenarios = [
    ["malware.trojan.pe-rat-capability-chain", "pe-rat-detection", "Correlate process-injection and remote-command-channel import capabilities."],
    ["malware.trojan.pe-injection-alone-not-rat", "pe-rat-false-positive", "Do not infer RAT/Trojan behavior from process-injection capability alone."]
  ];
  for (const [id, category, description] of scenarios) {
    lab.registerScenario({
      id,
      category,
      description,
      appliesTo: ["jb-malware-engine"],
      safety: { safe: true, network: false, destructive: false, executesSample: false },
      tags: ["trojan-defense", "synthetic-pe", "offline"]
    });
  }

  const report = await lab.run({
    metadata: {
      suite: "pe-rat-and-trojan-capability-correlation",
      syntheticPeFixtures: true,
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
