import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { auditSecurityProject } from "../src/adapters/filesystem/audit-security-project.js";
import { formatReport } from "../src/reporters/index.js";

async function withProject(run) {
  const root = await mkdtemp(join(tmpdir(), "jb-security-qa-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("security profile detects multiple high-risk patterns in a controlled fixture", async () => {
  await withProject(async (root) => {
    await writeFile(join(root, "src", "unsafe.js"), [
      'const api = "http://api.example.com/v1";',
      'res.setHeader("Access-Control-Allow-Origin", "*");',
      'res.setHeader("Access-Control-Allow-Credentials", "true");',
      'res.setHeader("Set-Cookie", "session=abc; Path=/");',
      'const passwordHash = crypto.createHash("md5").update(password).digest("hex");',
      'const resetToken = Math.random().toString(36);',
      'const claims = jwt.decode(token);',
      'if (claims.role === "admin") grantAccess();',
      'res.redirect(req.query.next);',
      'fetch(req.query.url);'
    ].join("\n"));

    const report = await auditSecurityProject(root);
    const ids = report.diagnostics.map((item) => item.id);

    assert.ok(ids.some((id) => id.startsWith("SEC-HTTP-")));
    assert.ok(ids.some((id) => id.startsWith("SEC-CORS-")));
    assert.ok(ids.some((id) => id.startsWith("SEC-COOKIE-")));
    assert.ok(ids.some((id) => id.startsWith("SEC-PASSWORD-HASH-")));
    assert.ok(ids.some((id) => id.startsWith("SEC-RANDOM-")));
    assert.ok(ids.some((id) => id.startsWith("SEC-JWT-")));
    assert.ok(ids.some((id) => id.startsWith("SEC-REDIRECT-")));
    assert.ok(ids.some((id) => id.startsWith("SEC-SSRF-")));
    assert.equal(report.securityAssessment.mode, "local-static");
    assert.equal(report.securityAssessment.networkRequests, 0);
    assert.equal(report.securityAssessment.databaseConnections, 0);
    assert.equal(report.securityAssessment.projectCodeExecuted, false);
    assert.equal(report.scoring.passed, false);
  });
});

test("safe configuration patterns do not trigger the added security rules", async () => {
  await withProject(async (root) => {
    await writeFile(join(root, "src", "safe.js"), [
      'const api = "https://api.example.com/v1";',
      'res.cookie("session", sessionValue, { httpOnly: true, secure: true, sameSite: "lax" });',
      'const passwordHash = await argon2.hash(password);',
      'const resetToken = crypto.randomBytes(32).toString("hex");',
      'const claims = jwt.verify(token, publicKey, { algorithms: ["RS256"] });',
      'const next = allowedRedirects.has(req.query.next) ? req.query.next : "/";',
      'fetch(TRUSTED_SERVICE_URL);'
    ].join("\n"));

    const report = await auditSecurityProject(root);
    const addedRuleFindings = report.diagnostics.filter((item) =>
      item.id.startsWith("SEC-HTTP-") ||
      item.id.startsWith("SEC-CORS-") ||
      item.id.startsWith("SEC-COOKIE-") ||
      item.id.startsWith("SEC-PASSWORD-HASH-") ||
      item.id.startsWith("SEC-RANDOM-") ||
      item.id.startsWith("SEC-JWT-") ||
      item.id.startsWith("SEC-REDIRECT-") ||
      item.id.startsWith("SEC-SSRF-")
    );

    assert.equal(addedRuleFindings.length, 0);
    assert.equal(report.scoring.score, 100);
    assert.equal(report.scoring.passed, true);
  });
});

test("commented-out examples are not reported by the added line-based checks", async () => {
  await withProject(async (root) => {
    await writeFile(join(root, "src", "comments.js"), [
      '// fetch(req.query.url);',
      '// res.redirect(req.query.next);',
      '// const resetToken = Math.random();',
      '// const api = "http://api.example.com";'
    ].join("\n"));

    const report = await auditSecurityProject(root);
    assert.equal(report.diagnostics.some((item) =>
      ["SEC-HTTP-", "SEC-RANDOM-", "SEC-REDIRECT-", "SEC-SSRF-"].some((prefix) =>
        item.id.startsWith(prefix)
      )
    ), false);
  });
});

test("credential findings never include the detected value and local env files are not opened", async () => {
  await withProject(async (root) => {
    const secret = "ghp_" + "A".repeat(36);
    await writeFile(join(root, "src", "config.js"), 'const GITHUB_TOKEN = "' + secret + '";');
    await writeFile(join(root, ".env"), "TOKEN=must-not-be-read-or-reported");

    const report = await auditSecurityProject(root);
    const credentialFinding = report.diagnostics.find((item) => item.id.startsWith("SEC-SECRET-"));

    assert.ok(credentialFinding);
    assert.equal(credentialFinding.severity, "critical");
    assert.equal(credentialFinding.evidence.redacted, true);
    assert.equal(JSON.stringify(report).includes(secret), false);
    assert.equal(JSON.stringify(report).includes("must-not-be-read-or-reported"), false);
    assert.equal(report.projectScan.environmentFiles, 1);
    assert.equal(report.securityAssessment.credentialContentsRead, false);
  });
});

test("an incomplete file scan cannot pass the security assessment", async () => {
  await withProject(async (root) => {
    await mkdir(join(root, "level-1", "level-2"), { recursive: true });
    await writeFile(join(root, "level-1", "level-2", "deep.js"), "export const value = true;");

    const report = await auditSecurityProject(root, {
      scanOptions: { maxDepth: 1 }
    });

    assert.equal(report.securityAssessment.complete, false);
    assert.ok(report.securityAssessment.incompleteReasons.length > 0);
    assert.equal(report.scoring.blockedByCritical, true);
    assert.equal(report.scoring.passed, false);
    assert.ok(report.diagnostics.some((item) => item.id === "CODE-SCAN-001"));
  });
});

test("security reports are available in JSON, Markdown, and HTML formats", async () => {
  await withProject(async (root) => {
    await writeFile(join(root, "src", "app.js"), "export const secure = true;");
    const report = await auditSecurityProject(root);

    assert.match(formatReport(report, "json"), /Security Auditor/);
    assert.match(formatReport(report, "markdown"), /JB Expert QA report/);
    assert.match(formatReport(report, "html"), /<h1>JB Expert QA report<\/h1>/);
  });
});

test("security audit rejects an empty project path", async () => {
  await assert.rejects(auditSecurityProject(" "), /directory path is required/);
});
