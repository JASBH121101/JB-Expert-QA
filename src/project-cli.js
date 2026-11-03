#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { auditProject } from "./adapters/filesystem/audit-project.js";
import { formatReport } from "./reporters/index.js";

const [projectPath = ".", ...args] = process.argv.slice(2);
try {
  const formatArg = args.find((arg) => arg.startsWith("--format="));
  const outputArg = args.find((arg) => arg.startsWith("--output="));
  const format = formatArg ? formatArg.slice("--format=".length) : "json";
  const outputPath = outputArg ? outputArg.slice("--output=".length) : null;
  const report = await auditProject(projectPath);
  const rendered = formatReport(report, format);
  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, rendered + "\n", "utf8");
    console.log("Project audit report saved to " + outputPath);
  } else {
    console.log(rendered);
  }
  if (!report.scoring.passed) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
