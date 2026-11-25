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
      shell: process.platform === "win32" && (
        command.toLowerCase() === npm.toLowerCase() ||
        command.toLowerCase().endsWith(".cmd")
      )
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
    'import { auditProject, auditUrl, auditViewports, comparePngBuffers, runAutopilot, createSecurityBridgeCoordinator, createExecutionLifecycleSupervisor, createExecutionEventJournal, createLocalProcessEngineRunner, createLinuxCgroupV2ResourceController, createAutonomousExecutionHost, createAutonomousExecutionHostService } from "@jb/expert-qa"; import { createAutonomousExecutionHost as createStandaloneHost } from "@jb/expert-qa/autonomous-execution-host"; import { createAutonomousExecutionHostService as createStandaloneHostService } from "@jb/expert-qa/autonomous-execution-host-service"; import { createExecutionLifecycleSupervisor as createStandaloneSupervisor } from "@jb/expert-qa/execution-supervisor"; import { createExecutionEventJournal as createStandaloneJournal } from "@jb/expert-qa/execution-event-journal"; import { createLocalProcessEngineRunner as createStandaloneProcessRunner } from "@jb/expert-qa/execution-process-runner"; import { createLinuxCgroupV2ResourceController as createStandaloneCgroupController } from "@jb/expert-qa/linux-cgroup-v2-resource-controller"; for (const fn of [auditProject,auditUrl,auditViewports,comparePngBuffers,runAutopilot,createSecurityBridgeCoordinator,createExecutionLifecycleSupervisor,createStandaloneSupervisor,createExecutionEventJournal,createStandaloneJournal,createLocalProcessEngineRunner,createStandaloneProcessRunner,createLinuxCgroupV2ResourceController,createStandaloneCgroupController, createAutonomousExecutionHost, createStandaloneHost, createAutonomousExecutionHostService, createStandaloneHostService]) if (typeof fn !== "function") process.exit(1); const queue={enqueue(){},stats(){return {queued:0,total:0};},getJob(){return null;},listJobs(){return [];},requeueInterrupted(){return null;},failInterrupted(){return null;},retryFailed(){return null;},close(){}}; const worker={getStatus(){return {state:"stopped"};},start(){},runNext(){return null;},drain(){return null;},cancelActive(){return false;},stop(){}}; const runtime={getStatus(){return {enabled:true,state:"ready"};},close(){}}; const supervisor=createStandaloneSupervisor({queue,worker,runtime}); for (const name of ["getJob","listJobs","recoverInterrupted","failInterrupted","retryFailed"]) if (typeof supervisor[name] !== "function") process.exit(1); await supervisor.close(); const { mkdtemp, writeFile, rm } = await import("node:fs/promises"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path"); const processRoot = await mkdtemp(join(tmpdir(), "jbqa-process-package-smoke-")); try { const modulePath = join(processRoot, "runner.mjs"); await writeFile(modulePath, "export async function run(input) { return { value: input.value }; }", "utf8"); const isolated = createLocalProcessEngineRunner({ engineId: "jb.package.smoke", moduleRoot: processRoot, modulePath, cwd: processRoot, timeoutMs: 5000 }); const isolatedResult = await isolated.run({ value: "distribution-boundary" }); if (isolatedResult.value !== "distribution-boundary") process.exit(1); await isolated.close(); } finally { await rm(processRoot, { recursive: true, force: true }); }'
  ], { cwd: expertInstall });

  run(node, [
    "--input-type=module", "-e",
    'import { createAutonomousExecutionHost as rootHost } from "@jb/expert-qa"; import { createAutonomousExecutionHost as subpathHost } from "@jb/expert-qa/autonomous-execution-host"; import { mkdtemp, rm } from "node:fs/promises"; import { tmpdir } from "node:os"; import { join } from "node:path"; if (typeof rootHost !== "function" || rootHost !== subpathHost) process.exit(1); const orchestrator = { listEngines: () => [], getPolicy: () => ({ id: "package-host-policy" }), verifyLedger: () => ({ valid: true, entries: 0 }), execute: async (_plan, options) => ({ status: "succeeded", executionId: options.executionId }) }; const directory = await mkdtemp(join(tmpdir(), "jb-qa-autonomous-host-package-")); try { const first = rootHost({ orchestrator, storageDirectory: directory }); first.enqueue({ plan: "package-host-persistence" }, { id: "package-host-job" }); if (first.getStatus().enabled !== false || first.getStatus().queuePersistenceEnabled !== true) process.exit(1); await first.close(); const reopened = subpathHost({ orchestrator, storageDirectory: directory }); try { if (reopened.getJob("package-host-job")?.state !== "queued" || reopened.getStatus().eventJournalPersistenceEnabled !== true) process.exit(1); } finally { await reopened.close(); } } finally { await rm(directory, { recursive: true, force: true }); }'
  ], { cwd: expertInstall });

  run(node, [
    "--input-type=module", "-e",
    'import { attachHostSignalLifecycle as rootAdapter } from "@jb/expert-qa"; import { attachHostSignalLifecycle as subpathAdapter } from "@jb/expert-qa/autonomous-host-signal-lifecycle"; if (typeof rootAdapter !== "function" || rootAdapter !== subpathAdapter) process.exit(1);'
  ], { cwd: expertInstall });

  run(node, [
    "--input-type=module", "-e",
    'import { createPersistentExecutionEventJournal as rootFactory } from "@jb/expert-qa"; import { createPersistentExecutionEventJournal as subpathFactory } from "@jb/expert-qa/execution-event-journal-persistence"; import { mkdtemp, rm } from "node:fs/promises"; import { tmpdir } from "node:os"; import { join } from "node:path"; if (typeof rootFactory !== "function" || rootFactory !== subpathFactory) process.exit(1); const directory = await mkdtemp(join(tmpdir(), "jb-qa-durable-journal-package-")); const filePath = join(directory, "events.json"); try { const first = rootFactory({ filePath, maxEvents: 4 }); first.recordEvent({ eventType: "JOB_CREATED", jobId: "package-durable-smoke" }); first.close(); const second = subpathFactory({ filePath, maxEvents: 4 }); if (second.getStatus().mode !== "persistent" || second.getEventsForJob("package-durable-smoke").length !== 1) process.exit(1); second.close(); } finally { await rm(directory, { recursive: true, force: true }); }'
  ], { cwd: expertInstall });

  run(node, [
    "--input-type=module", "-e",
    'import { createWindowsJobObjectResourceController as rootController } from "@jb/expert-qa"; import { createWindowsJobObjectResourceController as subpathController } from "@jb/expert-qa/windows-job-object-resource-controller"; if (typeof rootController !== "function" || typeof subpathController !== "function") process.exit(1);'
  ], { cwd: expertInstall });

  run(node, [
    "--input-type=module", "-e",
    'import { createContainmentPolicy as rootPolicy } from "@jb/expert-qa"; import { createContainmentPolicy as subpathPolicy } from "@jb/expert-qa/containment-policy"; for (const factory of [rootPolicy, subpathPolicy]) { if (typeof factory !== "function") process.exit(1); const policy = factory({ required: true, memoryLimit: "512MiB", cpuLimit: 50, processLimit: 8 }); if (policy.schemaVersion !== 1 || policy.limits.memoryBytes !== 536870912 || policy.limits.processCount !== 8) process.exit(1); }'
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

  run(node, [
    "--input-type=module", "-e",
    'import { EventEmitter } from "node:events"; import { mkdtemp, rm } from "node:fs/promises"; import { tmpdir } from "node:os"; import { join } from "node:path"; import { createAutonomousExecutionHost, createAutonomousExecutionHostService as rootService } from "@jb/expert-qa"; import { createAutonomousExecutionHostService as subpathService } from "@jb/expert-qa/autonomous-execution-host-service"; if (typeof rootService !== "function" || rootService !== subpathService) process.exit(1); const orchestrator = { listEngines: () => [], getPolicy: () => ({ id: "service-package-policy" }), verifyLedger: () => ({ valid: true, entries: 0 }), execute: async (_plan, options) => ({ status: "succeeded", executionId: options.executionId }) }; const directory = await mkdtemp(join(tmpdir(), "jb-qa-host-service-package-")); try { const host = createAutonomousExecutionHost({ orchestrator, storageDirectory: directory, enabled: true }); const signalSource = new EventEmitter(); const service = rootService({ host, signalSource }); if (service.getStatus().state !== "idle") process.exit(1); service.start(); if (service.getStatus().state !== "running" || signalSource.listenerCount("SIGTERM") !== 1) process.exit(1); const status = await service.stop(); if (status.state !== "closed" || signalSource.listenerCount("SIGTERM") !== 0) process.exit(1); } finally { await rm(directory, { recursive: true, force: true }); }'
  ], { cwd: expertInstall });

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
    'import { createResilienceEngine, createHealthMonitor, createAdvancedPolicySigningPayload } from "@jb/resilience-engine"; import { createLinuxSystemdAdapter } from "@jb/resilience-engine/adapters/linux-systemd"; import { createWindowsScmAdapter } from "@jb/resilience-engine/adapters/windows-scm"; import { createPostgresResilienceStorageAdapter } from "@jb/resilience-engine/adapters/postgres-storage"; import { createHealthMonitorProbeAdapter } from "@jb/resilience-engine/adapters/health-monitor-probes"; import { createRestrictedHostCommandRunner } from "@jb/resilience-engine/adapters/restricted-host-command-runner"; import { createEd25519PolicySignatureVerifier, createResilienceIdentityPolicyBridge } from "@jb/resilience-engine/adapters/identity-policy-bridge"; if ([createResilienceEngine, createHealthMonitor, createAdvancedPolicySigningPayload, createLinuxSystemdAdapter, createWindowsScmAdapter, createPostgresResilienceStorageAdapter, createHealthMonitorProbeAdapter, createRestrictedHostCommandRunner, createEd25519PolicySignatureVerifier, createResilienceIdentityPolicyBridge].some((value) => typeof value !== "function")) process.exit(1);'
  ], { cwd: resilienceInstall });
  progress("Resilience Engine package checks passed");

  // Shared localization runtime.
  progress("Packing standalone Localization Engine tarball");
  const localizationTarball = await pack("packages/localization-engine");
  const localizationInstall = await install(localizationTarball, "install-localization-engine");
  run(node, [
    "--input-type=module", "-e",
    'import { createLocalization, canonicalizeLocale } from "@jb/localization-engine"; const i18n = createLocalization({ catalogs: { "es-419": { greeting: "Hola, {name}" }, "en-US": { greeting: "Hello, {name}" } }, defaultLocale: "es-419" }); if (canonicalizeLocale("es_ni") !== "es-NI" || i18n.t("greeting", { locale: "en-US", params: { name: "JB" } }) !== "Hello, JB" || i18n.direction("ar") !== "rtl") process.exit(1);'
  ], { cwd: localizationInstall });
  progress("Localization Engine clean-consumer checks passed");

  // Exact money and injected FX boundary.
  progress("Packing standalone Currency Engine tarball");
  const currencyTarball = await pack("packages/currency-engine");
  const currencyInstall = await install(currencyTarball, "install-currency-engine");
  run(node, [
    "--input-type=module", "-e",
    'import { createMoney, addMoney, moneyToDecimalString, serializeMoney, convertMoney } from "@jb/currency-engine"; const a = createMoney("10.25", "USD"); const b = createMoney("2.75", "USD"); if (moneyToDecimalString(addMoney(a,b)) !== "13.00" || serializeMoney(a).minorUnits !== "1025") process.exit(1); const result = await convertMoney(createMoney("1.00", "USD"), "USD"); if (result.money.minorUnits !== 100n || result.rate !== null) process.exit(1);'
  ], { cwd: currencyInstall });
  progress("Currency Engine clean-consumer checks passed");

  // JB API Testing Engine.
  progress("Packing standalone API Testing Engine tarball");
  const apiTestingTarball = await pack("packages/api-testing-engine");
  const apiTestingInstall = await install(apiTestingTarball, "install-api-testing-engine");
  run(node, [
    "--input-type=module", "-e",
    'import { API_TESTING_ENGINE_ID, createApiRequestEngine, ApiTestingError, API_ASSERTIONS_ENGINE_ID, createApiAssertionsEngine, ApiAssertionError, API_CONTRACT_TESTING_ENGINE_ID, createApiContractTestingEngine, ApiContractError, API_SECURITY_TESTING_ENGINE_ID, createApiSecurityTestingEngine, ApiSecurityError, API_WORKFLOW_TESTING_ENGINE_ID, createApiWorkflowTestingEngine, ApiWorkflowError } from "@jb/api-testing-engine"; if (API_TESTING_ENGINE_ID !== "jb.api-testing-engine" || typeof createApiRequestEngine !== "function" || typeof ApiTestingError !== "function" || API_ASSERTIONS_ENGINE_ID !== "jb.api-testing-assertions-engine" || typeof createApiAssertionsEngine !== "function" || typeof ApiAssertionError !== "function" || API_CONTRACT_TESTING_ENGINE_ID !== "jb.api-contract-testing-engine" || typeof createApiContractTestingEngine !== "function" || typeof ApiContractError !== "function" || API_SECURITY_TESTING_ENGINE_ID !== "jb.api-security-testing-engine" || typeof createApiSecurityTestingEngine !== "function" || typeof ApiSecurityError !== "function" || API_WORKFLOW_TESTING_ENGINE_ID !== "jb.api-workflow-testing-engine" || typeof createApiWorkflowTestingEngine !== "function" || typeof ApiWorkflowError !== "function") process.exit(1); const engine = createApiRequestEngine({ allowedOrigins: ["https://api.example.test"] }); if (typeof engine.request !== "function") process.exit(1); const assertions = createApiAssertionsEngine(); const report = assertions.evaluate({ status: 200, headers: {}, bodyText: JSON.stringify({ data: { id: 7 } }), json: { data: { id: 7 } } }, [{ type: "status", expected: 200 }, { type: "json", path: "$.data.id", expected: 7 }]); if (!report.passed || report.total !== 2) process.exit(1); const contracts = createApiContractTestingEngine(); const compiled = contracts.compile({ schema: "jb.api-contract/v1", contractId: "smoke.users", version: "1.0.0", operations: [{ operationId: "getUser", method: "GET", path: "/users/{id}", responses: { "200": { body: { type: "object", required: ["id"], properties: { id: { type: "integer", minimum: 1 } } } } } }] }); const contractReport = compiled.validate({ method: "GET", url: "https://api.example.test/users/7", status: 200, headers: {}, jsonParsed: true, json: { id: 7 } }, { operationId: "getUser" }); if (!contractReport.passed || contractReport.total < 3) process.exit(1); const security = createApiSecurityTestingEngine(); const securityReport = security.analyze({ method: "GET", url: "https://api.example.test/users/7", status: 200, headers: { "strict-transport-security": "max-age=31536000", "x-content-type-options": "nosniff" }, jsonParsed: true, json: { id: 7 } }); if (!securityReport.passed || securityReport.failedCount !== 0) process.exit(1); const workflowEngine = createApiWorkflowTestingEngine({ requestEngine: { async request(input) { return { method: input.method, url: input.url, status: 200, headers: {}, jsonParsed: true, json: { data: { id: 7 } } }; } } }); const workflowReport = await workflowEngine.run({ schema: "jb.api-workflow/v1", workflowId: "smoke.flow", version: "1.0.0", steps: [{ id: "first", request: { method: "GET", url: "https://api.example.test/users/7" }, capture: { userId: "$.json.data.id" } }, { id: "second", request: { method: "GET", url: "https://api.example.test/users/7" }, when: { stepId: "first", status: 200 } }] }); if (!workflowReport.passed || workflowReport.totalSteps !== 2 || workflowReport.completedSteps !== 2) process.exit(1);'
  ], { cwd: apiTestingInstall });
  progress("API Testing Engine clean-consumer contract, security and workflow checks passed");

  progress("All eight standalone package checks completed");
  console.log("PASS: all eight npm tarballs installed in clean directories; Expert QA browser, Advisor Engine API/offline dataset, Localization, Currency and API Request, Assertions, Contract, Security and Workflow Testing Engines smoke checks passed.");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
