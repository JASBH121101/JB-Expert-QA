import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { scanProject } from "../src/adapters/filesystem/scan-project.js";

test("Expert QA generated report directory is excluded from subsequent project scans", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "jb-qa-output-ignore-"));
  try {
    await mkdir(resolve(root, "src"), { recursive: true });
    await mkdir(resolve(root, ".jb-expert-qa/reports"), { recursive: true });
    await writeFile(resolve(root, "src/index.js"), "export const value = 1;\n");
    await writeFile(resolve(root, ".jb-expert-qa/reports/old-report.html"), "<h1>old report</h1>\n");
    const scan = await scanProject(root);
    assert.equal(scan.files.some((file) => file.path.startsWith(".jb-expert-qa/")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
