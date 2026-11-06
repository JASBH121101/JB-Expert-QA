import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { auditSecurityProject } from "../src/adapters/filesystem/audit-security-project.js";
import { auditProject } from "../src/adapters/filesystem/audit-project.js";
import { formatReport } from "../src/reporters/index.js";
import { ExpertQAEngine, RuleRegistry } from "../src/index.js";
import { securityRuntimeRules } from "../src/specialists/runtime-security-rules.js";

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

test("general project audits also include the dedicated security defense rules", async () => {
  await withProject(async (root) => {
    await writeFile(join(root, "src", "endpoint.js"), 'const endpoint = "http://api.example.com/v1";');
    const report = await auditProject(root);
    assert.ok(report.diagnostics.some((item) => item.id.startsWith("SEC-HTTP-")));
    assert.ok(report.summary.specialists.includes("security"));
  });
});

test("security audit rejects an empty project path", async () => {
  await assert.rejects(auditSecurityProject(" "), /directory path is required/);
});


test("OSV dependency advisory lookup is opt-in and sends only package coordinates", async () => {
  await withProject(async (root) => {
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "fixture", version: "1.0.0", dependencies: { lodash: "4.17.21" }
    }));
    const sourceSentinel = "private-customer-source-must-not-leave-this-repository";
    await writeFile(join(root, "src", "private.js"), "const privateData = \"" + sourceSentinel + "\";");
    await writeFile(join(root, "package-lock.json"), JSON.stringify({
      name: "fixture",
      lockfileVersion: 3,
      packages: {
        "": { name: "fixture", version: "1.0.0" },
        "node_modules/lodash": { version: "4.17.21" }
      }
    }));

    let calls = 0;
    let submittedPayload = null;
    const fetchImpl = async (url, options = {}) => {
      calls += 1;
      if (String(url).endsWith("/querybatch")) {
        const payload = JSON.parse(options.body);
        submittedPayload = payload;
        assert.deepEqual(payload.queries, [{
          package: { name: "lodash", ecosystem: "npm" },
          version: "4.17.21"
        }]);
        return new Response(JSON.stringify({
          results: [{ vulns: [{ id: "GHSA-TEST-1" }] }]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      assert.match(String(url), /\/vulns\/GHSA-TEST-1$/);
      return new Response(JSON.stringify({
        id: "GHSA-TEST-1",
        summary: "Test package security advisory",
        database_specific: { severity: "HIGH" },
        affected: [],
        references: []
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const offline = await auditSecurityProject(root, {
      fetchImpl: async () => { throw new Error("Network must not be used by default"); }
    });
    assert.equal(offline.dependencyAdvisories.status, "disabled");
    assert.equal(offline.securityAssessment.networkRequests, 0);
    assert.equal(calls, 0);

    const online = await auditSecurityProject(root, {
      onlineAdvisories: true,
      fetchImpl
    });
    assert.equal(online.dependencyAdvisories.status, "complete");
    assert.equal(online.dependencyAdvisories.networkRequests, 2);
    assert.equal(online.securityAssessment.onlineDependencyAdvisories, true);
    assert.ok(online.diagnostics.some((item) => item.id.startsWith("DEP-OSV-GHSA-TEST-1")));
    assert.equal(calls, 2);
    assert.equal(JSON.stringify(submittedPayload).includes(sourceSentinel), false);
    assert.equal(JSON.stringify(online).includes(sourceSentinel), false);
  });
});

test("runtime security rules accept a deliberate baseline response", async () => {
  const registry = new RuleRegistry();
  for (const rule of securityRuntimeRules) registry.register(rule);
  const report = await new ExpertQAEngine({
    registry,
    config: {
      profile: "runtime-fixture",
      weights: { "security-runtime": 100 },
      thresholds: { minimumScore: 90, failOnCritical: true }
    }
  }).audit({
    securityHttpResponse: {
      finalUrl: "https://safe.example/",
      headers: {
        "strict-transport-security": ["max-age=31536000; includeSubDomains"],
        "content-security-policy": [
          "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'"
        ],
        "x-content-type-options": ["nosniff"],
        "referrer-policy": ["strict-origin-when-cross-origin"],
        "permissions-policy": ["camera=(), microphone=(), geolocation=()"]
      },
      cookies: [{ name: "session", secure: true, httpOnly: true, sameSite: "Lax" }],
      mixedContent: []
    }
  });
  assert.equal(report.scoring.score, 100);
  assert.equal(report.scoring.passed, true);
  assert.equal(report.summary.rulesExecuted, securityRuntimeRules.length);
});

test("runtime security rules block HTTP pages and identify weak response controls", async () => {
  const registry = new RuleRegistry();
  for (const rule of securityRuntimeRules) registry.register(rule);
  const report = await new ExpertQAEngine({
    registry,
    config: {
      profile: "runtime-fixture",
      weights: { "security-runtime": 100 },
      thresholds: { minimumScore: 90, failOnCritical: true }
    }
  }).audit({
    securityHttpResponse: {
      finalUrl: "http://unsafe.example/",
      headers: {
        "content-security-policy": ["default-src * 'unsafe-inline' 'unsafe-eval'"]
      },
      cookies: [],
      mixedContent: [{ url: "http://cdn.example/script.js", resourceType: "script" }]
    }
  });
  const ids = report.diagnostics.map((item) => item.id);
  assert.ok(ids.includes("SEC-RUNTIME-HTTPS-001"));
  assert.ok(ids.includes("SEC-RUNTIME-CSP-002"));
  assert.ok(ids.includes("SEC-RUNTIME-CSP-003"));
  assert.ok(ids.includes("SEC-RUNTIME-CSP-007"));
  assert.ok(ids.includes("SEC-RUNTIME-XCTO-001"));
  assert.ok(ids.includes("SEC-RUNTIME-FRAME-001"));
  assert.ok(ids.includes("SEC-RUNTIME-MIXED-1"));
  assert.equal(report.scoring.passed, false);
});

test("runtime cookie findings include cookie names but never cookie values", async () => {
  const registry = new RuleRegistry();
  for (const rule of securityRuntimeRules) registry.register(rule);
  const report = await new ExpertQAEngine({
    registry,
    config: {
      weights: { "security-runtime": 100 },
      thresholds: { minimumScore: 0, failOnCritical: true }
    }
  }).audit({
    securityHttpResponse: {
      finalUrl: "https://app.example/",
      headers: {},
      cookies: [{
        name: "session",
        secure: false,
        httpOnly: false,
        sameSite: null,
        value: "sensitive-cookie-value-must-not-leak"
      }],
      mixedContent: []
    }
  });
  const cookieFinding = report.diagnostics.find((item) => item.id.startsWith("SEC-RUNTIME-COOKIE-"));
  assert.ok(cookieFinding);
  assert.deepEqual(cookieFinding.metadata.missingAttributes, ["Secure", "HttpOnly", "SameSite"]);
  assert.equal(JSON.stringify(report).includes("sensitive-cookie-value-must-not-leak"), false);
});


test("AST data-flow analysis follows request-controlled aliases into critical sinks", async () => {
  await withProject(async (root) => {
    await writeFile(join(root, "src", "tainted-flow.js"), [
      "const target = req.query.url;",
      "const redirectTarget = target;",
      "fetch(redirectTarget);",
      "const { apiEndpoint } = req.query;",
      "fetch(apiEndpoint);",
      "const mutable = {};",
      "mutable.endpoint = req.body.endpoint;",
      "fetch(mutable.endpoint);",
      "const next = req.body.next;",
      "res.redirect(next);",
      "const html = req.body.html;",
      "document.querySelector('#preview').innerHTML = html;",
      "const command = req.query.command;",
      "exec(command);",
      "spawn('node', [command]);",
      "new Function(command);",
      "const statement = req.body.statement;",
      "database.query(statement);",
      "element.insertAdjacentHTML('beforeend', html);",
      "element.innerHTML = req.body.rawHtml;"
    ].join("\n"));

    const report = await auditSecurityProject(root);
    const findings = report.diagnostics.filter((item) => item.id.startsWith("AST-"));
    const ids = findings.map((item) => item.id);

    assert.ok(ids.some((id) => id.startsWith("AST-SSRF-")));
    assert.ok(ids.some((id) => id.startsWith("AST-REDIRECT-")));
    assert.ok(ids.filter((id) => id.startsWith("AST-DOM-XSS-")).length >= 3);
    assert.ok(ids.filter((id) => id.startsWith("AST-COMMAND-")).length >= 2);
    assert.ok(ids.some((id) => id.startsWith("AST-CODE-")));
    assert.ok(ids.some((id) => id.startsWith("AST-SQL-")));
    assert.ok(findings.every((item) => item.metadata.analysis === "intra-file variable alias tracking"));
  });
});

test("AST data-flow analysis does not flag trusted constants as request-tainted", async () => {
  await withProject(async (root) => {
    await writeFile(join(root, "src", "trusted-flow.js"), [
      "const target = process.env.TRUSTED_API_URL;",
      "fetch(target);",
      "const label = req.body.label;",
      "document.querySelector('#label').textContent = label;"
    ].join("\n"));

    const report = await auditSecurityProject(root);
    assert.equal(report.diagnostics.some((item) => item.id.startsWith("AST-")), false);
  });
});


test("AST parser gaps are reported as incomplete analysis instead of silently passing", async () => {
  await withProject(async (root) => {
    await writeFile(join(root, "src", "unsupported.js"), "const = invalid javascript;");
    const report = await auditSecurityProject(root);
    assert.equal(report.securityAssessment.complete, false);
    assert.equal(report.securityAssessment.astAnalysis.parseSkips, 1);
    assert.ok(report.securityAssessment.incompleteReasons.some((reason) => reason.includes("AST analysis")));
    assert.ok(report.diagnostics.some((item) => item.id.startsWith("AST-PARSE-")));
  });
});


test("unsupported TypeScript and JSX files are recorded as uncovered AST input", async () => {
  await withProject(async (root) => {
    await writeFile(join(root, "src", "endpoint.ts"), "const target: string = req.query.url;");
    await writeFile(join(root, "src", "widget.jsx"), "const target = req.query.url;");
    const report = await auditSecurityProject(root);
    assert.equal(report.securityAssessment.complete, false);
    assert.equal(report.securityAssessment.astAnalysis.unsupportedFiles, 2);
    assert.ok(report.securityAssessment.incompleteReasons.some((reason) => reason.includes("not yet supported")));
    assert.equal(report.diagnostics.filter((item) => item.id.startsWith("AST-UNSUPPORTED-")).length, 2);
  });
});

test("AST data-flow follows more than eight aliases and member assignments", async () => {
  await withProject(async (root) => {
    const lines = ["const source = req.query.target;"];
    for (let index = 0; index < 16; index += 1) {
      lines.push("const alias" + index + " = " + (index === 0 ? "source" : "alias" + (index - 1)) + ";");
    }
    lines.push("fetch(alias15);");
    await writeFile(join(root, "src", "long-alias.js"), lines.join("\n"));
    const report = await auditSecurityProject(root);
    assert.ok(report.diagnostics.some((item) => item.id.startsWith("AST-SSRF-")));
    assert.equal(report.securityAssessment.astAnalysis.propagationLimitFiles, 0);
  });
});
