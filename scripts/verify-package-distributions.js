import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign as signBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const node = process.execPath;
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jb-package-distribution-"));
const tarballDirectory = path.join(tempRoot, "tarballs");
await mkdir(tarballDirectory, { recursive: true });

function progress(message) {
  process.stdout.write("[package-distribution] " + message + "\n");
}

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd ?? repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        npm_config_audit: "false",
        npm_config_fund: "false"
      },
      shell: process.platform === "win32"
    });
  } catch (error) {
    const stdout = error.stdout?.toString?.() ?? "";
    const stderr = error.stderr?.toString?.() ?? "";
    throw new Error([
      "Command failed: " + command + " " + args.join(" "),
      stdout,
      stderr,
      error.message
    ].join("\n"));
  }
}

async function pack(workspace) {
  const before = new Set(await readdir(tarballDirectory));
  run(npm, [
    "pack",
    "--workspace",
    workspace,
    "--pack-destination",
    tarballDirectory
  ]);
  const after = await readdir(tarballDirectory);
  const added = after.filter((name) => !before.has(name) && name.endsWith(".tgz"));
  assert.equal(added.length, 1, "npm pack must create exactly one tarball for " + workspace);
  const tarball = path.join(tarballDirectory, added[0]);
  assert.ok((await readFile(tarball)).length > 0, "package tarball must not be empty");
  return tarball;
}

async function install(tarball, label) {
  const target = path.join(tempRoot, label);
  await mkdir(target, { recursive: true });
  run(npm, [
    "install",
    "--prefix",
    target,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    tarball
  ]);
  return target;
}

function binPath(directory, name) {
  return path.join(
    directory,
    "node_modules",
    ".bin",
    process.platform === "win32" ? name + ".cmd" : name
  );
}

try {
  progress("Preparing canonical Expert QA package source");
  // Generate ignored package source/config from canonical root files before packing.
  run(node, [path.join(repositoryRoot, "scripts/build-expert-qa-package.js")]);

  // Install the actual Expert QA tarball in a clean directory, separate from the monorepo.
  progress("Packing standalone Expert QA tarball");
  const expertTarball = await pack("packages/expert-qa");
  progress("Installing standalone Expert QA tarball");
  const expertInstall = await install(expertTarball, "install-expert-qa");
  const fixture = path.join(tempRoot, "vite-like-project");
  await mkdir(path.join(fixture, "src"), { recursive: true });
  await mkdir(path.join(fixture, "tests"), { recursive: true });
  await writeFile(path.join(fixture, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(path.join(fixture, "src", "app.js"),
    "export function add(a, b) { return a + b; }\n");
  await writeFile(path.join(fixture, "tests", "app.test.js"),
    'import { add } from "../src/app.js";\nif (add(1, 2) !== 3) throw new Error("failed");\n');
  run(binPath(expertInstall, "jb-qa"), ["init"], { cwd: fixture });
  const expertReportPath = path.join(fixture, ".jb-expert-qa", "reports", "package-check.json");
  run(binPath(expertInstall, "jb-qa"), [
    "audit", ".", "--format=json", "--output=" + expertReportPath
  ], { cwd: fixture });
  const expertReport = JSON.parse(await readFile(expertReportPath, "utf8"));
  assert.equal(expertReport.analysisScope.dependencyAdvisoryLookup, false);
  assert.equal(expertReport.analysisScope.networkRequests, 0);
  run(node, [
    "--input-type=module",
    "-e",
    'import { auditProject, auditUrl, auditViewports, comparePngBuffers, runAutopilot, createSecurityBridgeCoordinator } from "@jb/expert-qa"; for (const fn of [auditProject,auditUrl,auditViewports,comparePngBuffers,runAutopilot,createSecurityBridgeCoordinator]) if (typeof fn !== "function") process.exit(1);'
  ], { cwd: expertInstall });

  for (const bin of [
    "jb-qa", "jb-qa-project", "jb-qa-url", "jb-qa-security",
    "jb-qa-security-url", "jb-qa-autopilot"
  ]) {
    assert.ok((await stat(binPath(expertInstall, bin))).isFile(), "missing installed CLI: " + bin);
  }

  // Exercise the updater from the installed tarball, not from the monorepo source tree.
  const updaterProject = path.join(tempRoot, "updater-consumer");
  const installedGuardPath = path.join(
    updaterProject, "node_modules", "@jb", "security-guard"
  );
  await mkdir(installedGuardPath, { recursive: true });
  const updaterProjectManifest = {
    name: "jb-updater-distribution-fixture",
    version: "1.0.0",
    private: true,
    dependencies: { "@jb/security-guard": "0.1.0" }
  };
  await writeFile(
    path.join(updaterProject, "package.json"),
    JSON.stringify(updaterProjectManifest, null, 2) + "\n"
  );
  await writeFile(
    path.join(installedGuardPath, "package.json"),
    JSON.stringify({ name: "@jb/security-guard", version: "0.1.0" }, null, 2) + "\n"
  );

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const issuedAt = new Date();
  const updaterManifest = {
    schemaVersion: 1,
    channel: "stable",
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    packages: {
      "@jb/security-guard": {
        version: "0.1.1",
        nodeMinMajor: 22,
        dist: {
          tarball: "https://registry.npmjs.org/@jb%2fsecurity-guard/-/security-guard-0.1.1.tgz",
          integrity: "sha512-" + Buffer.alloc(64, 0x42).toString("base64")
        }
      }
    }
  };
  const updaterManifestRaw = JSON.stringify(updaterManifest, null, 2) + "\n";
  const updaterManifestPath = path.join(updaterProject, "engine-manifest.json");
  const updaterPublicKeyPath = path.join(updaterProject, "trusted-update-key.pem");
  await writeFile(updaterManifestPath, updaterManifestRaw, "utf8");
  await writeFile(
    updaterManifestPath + ".sig",
    signBytes(null, Buffer.from(updaterManifestRaw, "utf8"), privateKey).toString("base64"),
    "utf8"
  );
  await writeFile(
    updaterPublicKeyPath,
    publicKey.export({ type: "spki", format: "pem" }),
    "utf8"
  );

  const updaterOutput = run(binPath(expertInstall, "jb-qa"), [
    "update",
    "--check",
    "--manifest",
    updaterManifestPath,
    "--public-key",
    updaterPublicKeyPath
  ], { cwd: updaterProject });
  assert.match(updaterOutput, /Signed update manifest verified/);
  assert.match(
    updaterOutput,
    /@jb\/security-guard 0\.1\.0 -> 0\.1\.1 \| update-available \| candidate/
  );
  assert.deepEqual(
    JSON.parse(await readFile(path.join(updaterProject, "package.json"), "utf8")),
    updaterProjectManifest,
    "A read-only updater check must not change the consuming project's dependencies"
  );

  progress("Checking standalone Expert QA browser installer");
  // Exercise the package's own browser installer, then run real browser tests from the tarball install.
  run(binPath(expertInstall, "jb-qa"), [
    "setup", "--browser", "chromium"
  ], { cwd: expertInstall });

  const browserCheck = path.join(expertInstall, "verify-complete-browser.mjs");
  await writeFile(browserCheck, `import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { auditUrl, auditViewports, comparePngBuffers, createAiProviderRouter, runAutopilot } from "@jb/expert-qa";
import pngjs from "pngjs";
const { PNG } = pngjs;
const html = \`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Installed browser QA</title></head><body><main><h1>Browser fixture</h1><button id="menu-toggle" type="button" aria-label="Open navigation menu" aria-expanded="false" aria-controls="qa-menu">Open menu</button><nav id="qa-menu" hidden><a href="#section">Section</a></nav><section id="section"><h2>Content</h2><p>Local-only package verification page.</p></section></main><script>const b=document.getElementById("menu-toggle");const m=document.getElementById("qa-menu");b.addEventListener("click",()=>{const open=b.getAttribute("aria-expanded")!=="true";b.setAttribute("aria-expanded",String(open));m.hidden=!open;});</script></body></html>\`;
const server=createServer((_request,response)=>{response.writeHead(200,{"content-type":"text/html; charset=utf-8"});response.end(html);});
const temp=await mkdtemp(path.join(os.tmpdir(),"jb-qa-installed-browser-"));
await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
const url="http://127.0.0.1:"+server.address().port+"/";
try {
  const single=await auditUrl(url,{allowPrivateNetworks:true,sameOriginOnly:true,interactionExploration:true,maxInteractionActions:3,runAxe:true,screenshotPath:path.join(temp,"single.png")});
  assert.ok(single.evidence.interactionCandidates>=1);
  assert.ok(single.evidence.interactionActionsAttempted>=1);
  assert.ok(single.evidence.interactionStatesChecked>=1);
  assert.ok((await stat(path.join(temp,"single.png"))).size>0);
  const matrix=await auditViewports(url,{allowPrivateNetworks:true,sameOriginOnly:true,interactionExploration:true,maxInteractionActions:3,screenshotDir:path.join(temp,"matrix"),viewports:[{name:"mobile",width:390,height:844},{name:"desktop",width:1365,height:900}]});
  assert.equal(matrix.summary.viewportsChecked,2);
  assert.ok(matrix.viewports.every(v=>v.evidence.interactionActionsAttempted>=1));
  assert.ok(matrix.viewports.every(v=>v.screenshotPath));
  const png=new PNG({width:2,height:2});png.data.fill(255);
  const diff=comparePngBuffers(PNG.sync.write(png),PNG.sync.write(png));
  assert.equal(diff.status,"compared");assert.equal(diff.passed,true);assert.equal(diff.diffPixels,0);
  assert.equal(typeof createAiProviderRouter,"function");assert.equal(typeof runAutopilot,"function");
  console.log("PASS: installed package executed Playwright, interaction exploration, viewport screenshots, axe-core, PNG diff and complete API imports.");
} finally {await new Promise(resolve=>server.close(resolve));await rm(temp,{recursive:true,force:true});}
`, "utf8");
  run(node, [browserCheck], { cwd: expertInstall });

  progress("Expert QA browser checks passed");
  // JB Security Guard.
  progress("Packing standalone Security Guard tarball");
  const guardTarball = await pack("packages/security-guard");
  const guardInstall = await install(guardTarball, "install-security-guard");
  run(node, [
    "--input-type=module", "-e",
    'import { createSecurityGuard } from "@jb/security-guard"; const guard = createSecurityGuard({ mode: "monitor" }); if (typeof guard.middleware !== "function") process.exit(1);'
  ], { cwd: guardInstall });
  run(node, [
    "--input-type=module", "-e",
    'import { normalizeRateLimitCheckInput } from "@jb/security-guard/rate-limit-contract"; const normalized = normalizeRateLimitCheckInput({ identity: " smoke-user ", scope: "distribution" }); if (normalized.identity !== "smoke-user") process.exit(1);'
  ], { cwd: guardInstall });
  run(node, [
    "--input-type=module", "-e",
    'import { createCloudflareWorkerRateLimit } from "@jb/security-guard/cloudflare-worker-rate-limit"; if (typeof createCloudflareWorkerRateLimit !== "function") process.exit(1); const limiter = createCloudflareWorkerRateLimit({ binding: { async limit() { return { success: true }; } } }); const decision = await limiter.check({ identity: "package-smoke-test", scope: "distribution" }); if (!decision.allowed || decision.unavailable) process.exit(1);'
  ], { cwd: guardInstall });

  run(node, [
    "--input-type=module", "-e",
    'import { createCloudflarePagesRateLimit } from "@jb/security-guard/cloudflare-pages-rate-limit"; if (typeof createCloudflarePagesRateLimit !== "function") process.exit(1); const pages = createCloudflarePagesRateLimit({ serviceBinding: { async fetch() { return new Response(JSON.stringify({ allowed: true, exceeded: false, enforced: false, unavailable: false, policy: null, scope: "distribution", status: null, retryAfterSeconds: null }), { status: 200 }); } } }); const decision = await pages.check({ identity: "package-smoke-test", scope: "distribution" }); if (!decision.allowed || decision.unavailable) process.exit(1);'
  ], { cwd: guardInstall });

  run(node, [
    "--input-type=module", "-e",
    'import { createThreatAssessmentEngine } from "@jb/security-guard/threat-assessment"; const policy = { schema: "jb.security.policy.threat-assessment/v1", id: "distribution-policy", tenantId: "distribution-tenant", applicationId: "distribution-app", version: 1, enabled: true, windowMs: 300000, maxSignals: 8, minimumConfidence: 0.5, severityWeights: { info: 5, low: 15, medium: 35, high: 65, critical: 90 }, typeWeights: { brute_force: 100, endpoint_scan: 90, enumeration: 80, sql_injection: 110, parameter_tampering: 100, api_abuse: 95, bot_traffic: 75, anomaly: 50, upload_risk: 100 }, thresholds: { challenge: 35, review: 60, block: 85 }, blockRequirements: { minSignals: 3, minDistinctRules: 2, minDistinctTypes: 2, minimumConfidence: 0.9 } }; const engine = createThreatAssessmentEngine({ policy, clock: () => 1000000 }); if (typeof engine.assess !== "function" || engine.assess([]) !== null) process.exit(1);'
  ], { cwd: guardInstall });

  run(node, [
    "--input-type=module", "-e",
    'import { deriveCoreIdentityKey, normalizeCoreRateLimitDecision, createCoreRateLimitCounterKey } from "@jb/security-guard/core-contract-v1"; import { webcrypto } from "node:crypto"; const key = await deriveCoreIdentityKey({ secret: new Uint8Array(32).fill(7), keyId: "dist-1", tenantId: "tenant", applicationId: "catalog", identityType: "account", canonicalIdentity: "user-1", cryptoApi: webcrypto }); if (key.length !== 64) process.exit(1); const counter = createCoreRateLimitCounterKey({ tenantId: "tenant", applicationId: "catalog", policyId: "public", scope: "login", identityType: "account", keyId: "dist-1", identityKey: key }); if (!counter.startsWith("15:jbsg-counter-v1")) process.exit(1); const decision = normalizeCoreRateLimitDecision({ schema: "jb.security.rate-limit.decision/v1", requestId: "b37a5d9e-40c4-4d3b-bf9c-62d79ecf9f3a", tenantId: "tenant", applicationId: "catalog", policyId: "public", scope: "login", allowed: true, exceeded: false, enforced: false, unavailable: true, status: null, retryAfterSeconds: null }); if (!decision.unavailable) process.exit(1);'
  ], { cwd: guardInstall });
  const universalServiceSmokeSecret = randomBytes(32).toString("hex");
  run(node, [
    "--input-type=module", "-e",
    `import { createUniversalRateLimitService } from "@jb/security-guard/universal-rate-limit-service"; if (typeof createUniversalRateLimitService !== "function") process.exit(1); const serviceSecret = ${JSON.stringify(universalServiceSmokeSecret)}; const store = { async consumeLimit() { return { allowed: true, count: 1, retryAfterMs: 1000 }; } }; const service = createUniversalRateLimitService({ store, clients: { "smoke-app": { secret: serviceSecret, policies: { "default": { scopes: ["catalog-read"] } } } } }); const response = await service.fetch(new Request("https://guard.example/__jb/security-guard/v1/check", { method: "POST", headers: { "content-type": "application/json", "x-jb-client-id": "smoke-app", authorization: "Bearer " + serviceSecret }, body: JSON.stringify({ identity: "private-user-1", scope: "catalog-read", policy: "default" }) })); if (response.status !== 200) process.exit(1);`
  ], { cwd: guardInstall });
  run(node, [
    "--input-type=module", "-e",
    'import { createUniversalRateLimitService } from "@jb/security-guard"; if (typeof createUniversalRateLimitService !== "function") process.exit(1);'
  ], { cwd: guardInstall });

  run(node, [
    "--input-type=module", "-e",
    'import { createPostgresRateLimitStore } from "@jb/security-guard/postgres-rate-limit-store"; const store = createPostgresRateLimitStore({ query: async () => ({ rows: [] }) }); if (typeof store.initialize !== "function" || typeof store.consumeLimit !== "function" || typeof store.pruneExpired !== "function") process.exit(1);'
  ], { cwd: guardInstall });
  progress("Security Guard package checks passed");
  // JB Malware Engine.
  progress("Packing standalone Malware Engine tarball");
  const malwareTarball = await pack("packages/malware-engine");
  const malwareInstall = await install(malwareTarball, "install-malware-engine");
  const sample = path.join(tempRoot, "benign-sample.txt");
  await writeFile(sample, "A harmless package distribution smoke-test fixture.\n");
  const malwareOutput = run(binPath(malwareInstall, "jb-malware-scan"), [sample, "--json"], { cwd: tempRoot });
  const malwareReport = JSON.parse(malwareOutput);
  assert.equal(malwareReport.status, "no_match");
  run(node, [
    "--input-type=module", "-e",
    'import { createMalwareEngine } from "@jb/malware-engine"; if (typeof createMalwareEngine !== "function") process.exit(1);'
  ], { cwd: malwareInstall });

  progress("Malware Engine package checks passed");
  // JB Advisor Engine.
  progress("Packing standalone Advisor Engine tarball");
  const advisorTarball = await pack("packages/advisor-engine");
  const advisorInstall = await install(advisorTarball, "install-advisor-engine");
  run(node, [
    "--input-type=module", "-e",
    'import * as advisor from "@jb/advisor-engine"; const required = ["getEngineInfo", "createAdvisorCore", "ResearchEngine", "compareProducts", "KnowledgeStore", "CapacitorSQLiteKnowledgeAdapter", "createDefaultResearchProviders"]; if (advisor.ENGINE_ID !== "JBAE" || required.some((name) => typeof advisor[name] === "undefined")) process.exit(1); const research = new advisor.ResearchEngine({ providers: [] }); if (research.getProviderIds().length !== 0) process.exit(1);'
  ], { cwd: advisorInstall });

  const advisorPackageInstall = path.join(
    advisorInstall, "node_modules", "@jb", "advisor-engine"
  );
  run(npm, ["run", "build:fragrance-library"], { cwd: advisorPackageInstall });
  const advisorSnapshot = path.join(
    advisorPackageInstall,
    "dist",
    "fragrance-library",
    "scento-knowledge-snapshot.json"
  );
  assert.ok((await stat(advisorSnapshot)).size > 0, "Advisor Engine offline dataset builder must produce a knowledge snapshot");

  // JB Resilience Engine.
  progress("Packing standalone Resilience Engine tarball");
  const resilienceTarball = await pack("packages/resilience-engine");
  const resilienceInstall = await install(resilienceTarball, "install-resilience-engine");
  run(node, [
    "--input-type=module", "-e",
    'import { createResilienceEngine, createHealthMonitor } from "@jb/resilience-engine"; import { createLinuxSystemdAdapter } from "@jb/resilience-engine/adapters/linux-systemd"; import { createWindowsScmAdapter } from "@jb/resilience-engine/adapters/windows-scm"; import { createPostgresResilienceStorageAdapter } from "@jb/resilience-engine/adapters/postgres-storage"; import { createHealthMonitorProbeAdapter } from "@jb/resilience-engine/adapters/health-monitor-probes"; import { createRestrictedHostCommandRunner } from "@jb/resilience-engine/adapters/restricted-host-command-runner"; if ([createResilienceEngine, createHealthMonitor, createLinuxSystemdAdapter, createWindowsScmAdapter, createPostgresResilienceStorageAdapter, createHealthMonitorProbeAdapter, createRestrictedHostCommandRunner].some((value) => typeof value !== "function")) process.exit(1);'
  ], { cwd: resilienceInstall });
  progress("Resilience Engine package checks passed");

  progress("All five standalone package checks completed");
  console.log("PASS: all five npm tarballs installed in clean directories; Expert QA browser, Advisor Engine API and offline dataset smoke checks passed.");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
