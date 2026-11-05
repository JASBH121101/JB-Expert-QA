#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { auditSecurityProject } from "./adapters/filesystem/audit-security-project.js";
import { formatReport } from "./reporters/index.js";

const [projectPath = ".", ...args] = process.argv.slice(2);

try {
  const options = new Map();
  const supportedOptions = ["--config=", "--format=", "--output="];
  let onlineAdvisories = false;

  for (const arg of args) {
    if (arg === "--online-advisories") {
      if (onlineAdvisories) throw new TypeError("--online-advisories may only be supplied once");
      onlineAdvisories = true;
      continue;
    }
    const prefix = supportedOptions.find((item) => arg.startsWith(item));
    if (!prefix) throw new TypeError("Unknown security audit option: " + arg);
    const name = prefix.slice(0, -1);
    if (options.has(name)) throw new TypeError("Security audit option may only be supplied once: " + name);
    const value = arg.slice(prefix.length);
    if (!value.trim()) throw new TypeError(name + " requires a non-empty value");
    options.set(name, value);
  }

  const format = options.get("--format") || "json";
  const outputPath = options.get("--output") || null;
  const configPath = options.get("--config") || null;
  let config;

  if (configPath !== null) {
    const absoluteConfigPath = resolve(configPath);
    let rawConfig;
    try {
      rawConfig = await readFile(absoluteConfigPath, "utf8");
    } catch (error) {
      throw new Error("Unable to read security config " + absoluteConfigPath + ": " +
        (error instanceof Error ? error.message : String(error)));
    }
    try {
      config = JSON.parse(rawConfig);
    } catch (error) {
      throw new Error("Security config is not valid JSON: " +
        (error instanceof Error ? error.message : String(error)));
    }
  }

  const report = await auditSecurityProject(projectPath, {
    ...(config === undefined ? {} : { config }),
    onlineAdvisories
  });
  const rendered = formatReport(report, format);

  if (outputPath) {
    const absoluteOutputPath = resolve(outputPath);
    await mkdir(dirname(absoluteOutputPath), { recursive: true });
    await writeFile(absoluteOutputPath, rendered + "\n", "utf8");
    console.log("Security report saved to " + absoluteOutputPath);
  } else {
    console.log(rendered);
  }

  if (!report.scoring.passed) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
