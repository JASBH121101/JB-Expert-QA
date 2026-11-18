import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { persistThreatLabReport } from "./helpers/persist-report.js";

test("report persistence is a no-op when CI has not requested an output directory", async () => {
  const previous = process.env.JB_THREAT_LAB_REPORT_DIR;
  delete process.env.JB_THREAT_LAB_REPORT_DIR;
  try {
    const result = await persistThreatLabReport({
      schema: "jb.threat-lab.report/v2",
      results: []
    }, "local-no-op");
    assert.equal(result, null);
  } finally {
    if (previous === undefined) delete process.env.JB_THREAT_LAB_REPORT_DIR;
    else process.env.JB_THREAT_LAB_REPORT_DIR = previous;
  }
});

test("report persistence atomically writes one bounded source report", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jb-threat-lab-report-"));
  const previous = process.env.JB_THREAT_LAB_REPORT_DIR;
  process.env.JB_THREAT_LAB_REPORT_DIR = directory;
  try {
    const report = {
      schema: "jb.threat-lab.report/v2",
      metadata: { suite: "safe-fixture" },
      results: [{ status: "pass", target: { id: "jb-engine" }, scenario: { id: "scenario-1" } }]
    };
    const output = await persistThreatLabReport(report, "safe-fixture");
    assert.equal(output, path.join(directory, "safe-fixture.json"));
    const persisted = JSON.parse(await readFile(output, "utf8"));
    assert.equal(persisted.reportId, "safe-fixture");
    assert.deepEqual(persisted.report, report);
    assert.deepEqual(await readdir(directory), ["safe-fixture.json"]);
  } finally {
    if (previous === undefined) delete process.env.JB_THREAT_LAB_REPORT_DIR;
    else process.env.JB_THREAT_LAB_REPORT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("report persistence rejects invalid filenames instead of accepting path traversal", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jb-threat-lab-report-invalid-"));
  const previous = process.env.JB_THREAT_LAB_REPORT_DIR;
  process.env.JB_THREAT_LAB_REPORT_DIR = directory;
  try {
    await assert.rejects(
      persistThreatLabReport({
        schema: "jb.threat-lab.report/v2",
        results: []
      }, "../escape"),
      /stable 2-80 character identifier/
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    if (previous === undefined) delete process.env.JB_THREAT_LAB_REPORT_DIR;
    else process.env.JB_THREAT_LAB_REPORT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
