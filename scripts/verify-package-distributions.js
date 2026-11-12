import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  // JB Expert QA Core: install the actual tarball into an isolated project.
  const expertTarball = await pack("packages/expert-qa");
  const expertInstall = await install(expertTarball, "install-expert-qa");
  const fixture = path.join(tempRoot, "vite-like-project");
  await mkdir(path.join(fixture, "src"), { recursive: true });
  await mkdir(path.join(fixture, "tests"), { recursive: true });
  await writeFile(path.join(fixture, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(
    path.join(fixture, "src", "app.js"),
    "export function add(a, b) { return a + b; }\n"
  );
  await writeFile(
    path.join(fixture, "tests", "app.test.js"),
    'import { add } from "../src/app.js";\nif (add(1, 2) !== 3) throw new Error("failed");\n'
  );
  run(binPath(expertInstall, "jb-qa"), ["init"], { cwd: fixture });
  const expertReportPath = path.join(
    fixture,
    ".jb-expert-qa",
    "reports",
    "package-check.json"
  );
  run(binPath(expertInstall, "jb-qa"), [
    "audit",
    ".",
    "--format=json",
    "--output=" + expertReportPath
  ], { cwd: fixture });
  const expertReport = JSON.parse(await readFile(expertReportPath, "utf8"));
  assert.equal(expertReport.analysisScope.dependencyAdvisoryLookup, false);
  assert.equal(expertReport.analysisScope.networkRequests, 0);
  run(node, [
    "--input-type=module",
    "-e",
    'import { auditProject } from "@jb/expert-qa"; if (typeof auditProject !== "function") process.exit(1);'
  ], { cwd: expertInstall });

  // JB Security Guard: verify package entry point and middleware factory.
  const guardTarball = await pack("packages/security-guard");
  const guardInstall = await install(guardTarball, "install-security-guard");
  run(node, [
    "--input-type=module",
    "-e",
    'import { createSecurityGuard } from "@jb/security-guard"; const guard = createSecurityGuard({ mode: "monitor" }); if (typeof guard.middleware !== "function") process.exit(1);'
  ], { cwd: guardInstall });
  run(node, [
    "--input-type=module",
    "-e",
    'import { createCloudflareWorkerRateLimit } from "@jb/security-guard/cloudflare-worker-rate-limit"; if (typeof createCloudflareWorkerRateLimit !== "function") process.exit(1); const limiter = createCloudflareWorkerRateLimit({ binding: { async limit() { return { success: true }; } } }); const decision = await limiter.check({ identity: "package-smoke-test", scope: "distribution" }); if (!decision.allowed || decision.unavailable) process.exit(1);'
  ], { cwd: guardInstall });

  // JB Malware Engine: verify package import and scan a harmless text fixture.
  const malwareTarball = await pack("packages/malware-engine");
  const malwareInstall = await install(malwareTarball, "install-malware-engine");
  const sample = path.join(tempRoot, "benign-sample.txt");
  await writeFile(sample, "A harmless package distribution smoke-test fixture.\n");
  const malwareOutput = run(binPath(malwareInstall, "jb-malware-scan"), [
    sample,
    "--json"
  ], { cwd: tempRoot });
  const malwareReport = JSON.parse(malwareOutput);
  assert.equal(malwareReport.status, "no_match");
  run(node, [
    "--input-type=module",
    "-e",
    'import { createMalwareEngine } from "@jb/malware-engine"; if (typeof createMalwareEngine !== "function") process.exit(1);'
  ], { cwd: malwareInstall });

  console.log("PASS: all three npm tarballs installed into clean directories and passed import/CLI smoke tests.");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
