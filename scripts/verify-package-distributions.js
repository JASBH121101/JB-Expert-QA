import assert from "node:assert/strict";
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
  // Install the actual Expert QA tarball in a clean directory, separate from the monorepo.
  const expertTarball = await pack("packages/expert-qa");
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

  // Exercise the package's own browser installer, then run real browser tests from the tarball install.
  run(binPath(expertInstall, "jb-qa"), [
    "setup", "--browser", "chromium", "--with-deps"
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

  // JB Security Guard.
  const guardTarball = await pack("packages/security-guard");
  const guardInstall = await install(guardTarball, "install-security-guard");
  run(node, [
    "--input-type=module", "-e",
    'import { createSecurityGuard } from "@jb/security-guard"; const guard = createSecurityGuard({ mode: "monitor" }); if (typeof guard.middleware !== "function") process.exit(1);'
  ], { cwd: guardInstall });
  run(node, [
    "--input-type=module", "-e",
    'import { createCloudflareWorkerRateLimit } from "@jb/security-guard/cloudflare-worker-rate-limit"; if (typeof createCloudflareWorkerRateLimit !== "function") process.exit(1); const limiter = createCloudflareWorkerRateLimit({ binding: { async limit() { return { success: true }; } } }); const decision = await limiter.check({ identity: "package-smoke-test", scope: "distribution" }); if (!decision.allowed || decision.unavailable) process.exit(1);'
  ], { cwd: guardInstall });

  // JB Malware Engine.
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

  console.log("PASS: all three npm tarballs installed in clean directories; the complete Expert QA browser suite passed.");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
