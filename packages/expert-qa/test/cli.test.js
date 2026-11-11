import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(packageRoot, "cli/package-cli.js");
let tempRoot;

before(async () => {
  tempRoot = await mkdtemp(resolve(tmpdir(), "jb-expert-qa-test-"));
});

after(async () => {
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

test("init creates an offline config and never overwrites an existing config by default", async () => {
  const project = resolve(tempRoot, "init-project");
  await mkdir(project, { recursive: true });
  const first = execFileSync(process.execPath, [cliPath, "init"], { cwd: project, encoding: "utf8" });
  const configPath = resolve(project, "jb-expert-qa.config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(config.advisories.enabled, false);
  assert.match(first, /Created/);

  const second = execFileSync(process.execPath, [cliPath, "init"], { cwd: project, encoding: "utf8" });
  assert.match(second, /already exists/);
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).advisories.enabled, false);
});

test("audit produces a local report, skips environment files and makes no advisory requests", async () => {
  const project = resolve(tempRoot, "audit-project");
  await mkdir(resolve(project, "src"), { recursive: true });
  await mkdir(resolve(project, "tests"), { recursive: true });
  await writeFile(resolve(project, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(resolve(project, "src/app.js"), "export function add(a, b) { return a + b; }\n");
  await writeFile(resolve(project, "tests/app.test.js"),
    'import { add } from "../src/app.js";\nif (add(2, 3) !== 5) throw new Error("addition failed");\n');
  await writeFile(resolve(project, ".env"), "VERY_SECRET_VALUE_MUST_NOT_APPEAR=hidden\n");

  execFileSync(process.execPath, [cliPath, "init"], { cwd: project, stdio: "pipe" });
  const output = resolve(project, ".jb-expert-qa/reports/test-report.json");
  execFileSync(process.execPath, [
    cliPath, "audit", ".", "--format=json", "--output=" + output
  ], { cwd: project, stdio: "pipe" });

  const serialized = await readFile(output, "utf8");
  const report = JSON.parse(serialized);
  assert.equal(report.analysisScope.dependencyAdvisoryLookup, false);
  assert.equal(report.analysisScope.networkRequests, 0);
  assert.equal(report.projectScan.environmentFiles, 1);
  assert.equal(serialized.includes("VERY_SECRET_VALUE_MUST_NOT_APPEAR"), false);
  assert.equal(typeof report.scoring.score, "number");
});

test("the package CLI advertises browser setup and the complete command set", () => {
  const help = execFileSync(process.execPath, [cliPath, "--help"], { encoding: "utf8" });
  assert.match(help, /jb-qa setup --browser chromium/);
  assert.match(help, /jb-qa-url/);
  assert.match(help, /jb-qa-security/);
  assert.match(help, /jb-qa-autopilot/);
  const version = execFileSync(process.execPath, [cliPath, "--version"], { encoding: "utf8" });
  assert.match(version, /0\.2\.0/);
});
