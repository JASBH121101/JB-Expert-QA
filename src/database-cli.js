#!/usr/bin/env node
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { auditDatabaseProject } from "./adapters/filesystem/audit-database.js";
import { formatReport } from "./reporters/index.js";

function parse(tokens) {
  const options = new Map();
  const positional = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const equal = token.indexOf("=");
    const key = equal >= 0 ? token.slice(0, equal) : token;
    if (!["--format", "--output", "--config"].includes(key)) {
      throw new TypeError("Unknown database audit option: " + key);
    }
    if (options.has(key)) throw new TypeError("Option supplied more than once: " + key);
    const value = equal >= 0 ? token.slice(equal + 1) : tokens[++index];
    if (typeof value !== "string" || !value.trim() || value.startsWith("--")) {
      throw new TypeError(key + " requires a non-empty value");
    }
    options.set(key, value);
  }
  if (positional.length > 1) throw new TypeError("Database audit accepts only one project path");
  return { options, projectPath: positional[0] ?? "." };
}

async function readConfig(path) {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw);
}

try {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    console.log([
      "JB Expert QA — Database Auditor",
      "",
      "Usage:",
      "  jb-qa-db [project-path] [--format html|json|markdown] [--output file] [--config file]",
      "",
      "This command performs a local static audit and never connects to or modifies a database."
    ].join("\n"));
  } else {
    const { options, projectPath } = parse(args);
    const format = options.get("--format") ?? "html";
    if (!["html", "json", "markdown"].includes(format)) {
      throw new TypeError("--format must be html, json, or markdown");
    }

    let config;
    if (options.has("--config")) {
      config = await readConfig(resolve(options.get("--config")));
    } else {
      const local = resolve("jb-expert-qa.config.json");
      try {
        await access(local);
        config = await readConfig(local);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }

    const report = await auditDatabaseProject(projectPath, config === undefined ? {} : { config });
    const extension = format === "markdown" ? "md" : format;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = resolve(options.get("--output") ??
      ".jb-expert-qa/reports/database-audit-" + stamp + "." + extension);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, formatReport(report, format) + "\n", "utf8");

    console.log("Report: " + destination);
    console.log("Database evidence files: " + report.databaseScope.databaseEvidenceFiles);
    console.log("Schema files: " + report.databaseScope.schemaFiles);
    console.log("Database connections: " + report.databaseScope.databaseConnections);
    console.log("Network requests: " + report.databaseScope.networkRequests);
    console.log("Assessment: " + report.databaseScope.assessmentStatus);
    console.log("Result: " + (report.scoring.passed ? "PASS" : "REVIEW REQUIRED"));
    if (!report.scoring.passed) process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
