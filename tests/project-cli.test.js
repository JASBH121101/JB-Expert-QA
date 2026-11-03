import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../src/project-cli.js", import.meta.url));

test("project CLI loads a custom policy and applies project-specific scan limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "jbqa-cli-profile-"));
  const project = join(root, "project");
  const configPath = join(root, "jb-expert-qa.config.json");
  const reportPath = join(root, "reports", "report.json");
  try {
    await mkdir(join(project, "src"), { recursive: true });
    await mkdir(join(project, "tests"), { recursive: true });
    await writeFile(join(project, "package.json"), JSON.stringify({
      name: "profile-fixture", version: "1.0.0"
    }));
    await writeFile(join(project, "package-lock.json"), "{}");
    await writeFile(join(project, "src", "app.js"), "export const ready = true;\n");
    await writeFile(join(project, "tests", "app.test.js"), "import test from 'node:test';\n");
    const policy = {
      version: 1,
      profile: "fixture-web-app",
      weights: { "code-quality": 25, security: 45, dependencies: 20, database: 10 },
      thresholds: { minimumScore: 90, failOnCritical: true, maxFileLines: 500 },
      scan: { maxFiles: 100, maxFileBytes: 100_000, maxTotalBytes: 500_000, maxDepth: 10 }
    };
    await writeFile(configPath, JSON.stringify(policy));

    const first = spawnSync(process.execPath, [
      cliPath, project, "--config=" + configPath, "--format=json", "--output=" + reportPath
    ], { encoding: "utf8", timeout: 30_000 });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.profile, "fixture-web-app");
    assert.equal(report.analysisScope.complete, true);
    assert.equal(report.projectScan.filesRead, 4);
    assert.equal(report.scoring.minimumScore, 90);

    policy.scan.maxFiles = 1;
    await writeFile(configPath, JSON.stringify(policy));
    const second = spawnSync(process.execPath, [
      cliPath, project, "--config=" + configPath, "--format=json", "--output=" + reportPath
    ], { encoding: "utf8", timeout: 30_000 });
    assert.equal(second.status, 1);
    const limitedReport = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(limitedReport.analysisScope.complete, false);
    assert.equal(limitedReport.analysisScope.coverage.truncated, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project CLI rejects malformed and missing policy files", async () => {
  const root = await mkdtemp(join(tmpdir(), "jbqa-cli-invalid-"));
  try {
    const malformed = join(root, "malformed.json");
    await writeFile(malformed, "{ not json");
    const invalid = spawnSync(process.execPath, [cliPath, root, "--config=" + malformed], {
      encoding: "utf8", timeout: 30_000
    });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /not valid JSON/);

    const missing = spawnSync(process.execPath, [cliPath, root, "--config=" + join(root, "missing.json")], {
      encoding: "utf8", timeout: 30_000
    });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Unable to read project config/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
