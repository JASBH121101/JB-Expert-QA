#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { auditProject } from "./adapters/filesystem/audit-project.js";
import { formatReport } from "./reporters/index.js";

const [projectPath = ".", ...args] = process.argv.slice(2);
try {
  const option = (name) => args.find((arg) => arg.startsWith(name + "="))?.slice(name.length + 1);
  const format = option("--format") || "json";
  const outputPath = option("--output") || null;
  const configPath = option("--config") || null;
  let config;

  if (configPath !== null) {
    if (!configPath.trim()) throw new TypeError("--config requires a JSON file path");
    const absoluteConfigPath = resolve(configPath);
    let rawConfig;
    try {
      rawConfig = await readFile(absoluteConfigPath, "utf8");
    } catch (error) {
      throw new Error("Unable to read project config " + absoluteConfigPath + ": " +
        (error instanceof Error ? error.message : String(error)));
    }
    try {
      config = JSON.parse(rawConfig);
    } catch (error) {
      throw new Error("Project config is not valid JSON: " +
        (error instanceof Error ? error.message : String(error)));
    }
  }

  const report = await auditProject(projectPath, config === undefined ? {} : { config });
  const rendered = formatReport(report, format);
  if (outputPath) {
    const absoluteOutputPath = resolve(outputPath);
    await mkdir(dirname(absoluteOutputPath), { recursive: true });
    await writeFile(absoluteOutputPath, rendered + "\n", "utf8");
    console.log("Project audit report saved to " + absoluteOutputPath);
  } else {
    console.log(rendered);
  }
  if (!report.scoring.passed) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
