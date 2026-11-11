#!/usr/bin/env node
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditProject } from "./adapters/filesystem/audit-project.js";
import { formatReport } from "./reporters/index.js";
import { EXPERT_QA_PACKAGE_VERSION } from "./version.js";

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const bundledConfigPath = resolve(packageDirectory, "../config/project-audit.config.json");

function printHelp() {
  console.log([
    "JB Expert QA",
    "",
    "Usage:",
    "  jb-qa init [--force]",
    "  jb-qa audit [project-path] [--format html|json|markdown] [--output file] [--config file]",
    "",
    "Commands:",
    "  init       Create jb-expert-qa.config.json without overwriting an existing file.",
    "  audit      Audit source files locally and save a report.",
    "",
    "Options:",
    "  --format   Report format (default: html).",
    "  --output   Report destination. Defaults to .jb-expert-qa/reports/.",
    "  --config   Use an explicit JSON configuration file.",
    "  --force    Replace the configuration during init."
  ].join("\n"));
}

function parseOptions(tokens, allowed) {
  const options = new Map();
  const positional = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    const key = equals >= 0 ? token.slice(0, equals) : token;
    if (!allowed.has(key)) throw new TypeError("Unknown option: " + key);
    if (options.has(key)) throw new TypeError("Option supplied more than once: " + key);
    const value = equals >= 0 ? token.slice(equals + 1) : tokens[++index];
    if (typeof value !== "string" || !value.trim() || value.startsWith("--")) {
      throw new TypeError(key + " requires a non-empty value");
    }
    options.set(key, value);
  }
  return { options, positional };
}

async function readJsonConfig(configPath) {
  let raw;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    throw new Error("Unable to read configuration " + configPath + ": " +
      (error instanceof Error ? error.message : String(error)));
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error("Configuration is not valid JSON: " +
      (error instanceof Error ? error.message : String(error)));
  }
}

async function initialize(tokens) {
  const { options, positional } = parseOptions(tokens, new Set(["--force"]));
  if (positional.length) throw new TypeError("init does not accept positional arguments");
  const target = resolve("jb-expert-qa.config.json");
  const force = options.has("--force");

  if (!force) {
    try {
      await access(target);
      console.log("Configuration already exists; it was not changed.");
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const defaults = await readJsonConfig(bundledConfigPath);
  defaults.advisories = { enabled: false, required: false };
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(defaults, null, 2) + "\n", {
    encoding: "utf8",
    flag: force ? "w" : "wx"
  });
  console.log("Created " + target);
  console.log("Online dependency advisory lookups are disabled by default.");
}

async function runAudit(tokens) {
  const { options, positional } = parseOptions(tokens, new Set(["--format", "--output", "--config"]));
  if (positional.length > 1) throw new TypeError("audit accepts only one project path");
  const projectPath = positional[0] ?? ".";
  const format = options.get("--format") ?? "html";
  if (!["html", "json", "markdown"].includes(format)) {
    throw new TypeError("--format must be html, json, or markdown");
  }

  const localConfig = resolve("jb-expert-qa.config.json");
  let config;
  if (options.has("--config")) {
    config = await readJsonConfig(resolve(options.get("--config")));
  } else {
    try {
      await access(localConfig);
      config = await readJsonConfig(localConfig);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      config = await readJsonConfig(bundledConfigPath);
    }
  }

  const report = await auditProject(projectPath, { config });
  const extension = format === "markdown" ? "md" : format;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destination = resolve(options.get("--output") ??
    ".jb-expert-qa/reports/audit-" + stamp + "." + extension);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, formatReport(report, format) + "\n", "utf8");

  console.log("Report: " + destination);
  console.log("Score: " + report.scoring.score + "/100");
  console.log("Files analyzed: " + report.analysisScope.filesAnalyzed);
  console.log("Scan complete: " + report.analysisScope.complete);
  console.log("Advisory network requests: " + report.analysisScope.networkRequests);
  console.log("Result: " + (report.scoring.passed ? "PASS" : "REVIEW REQUIRED"));
  if (!report.scoring.passed) process.exitCode = 1;
}

const args = process.argv.slice(2);
const first = args[0];
if (!first || ["--help", "-h"].includes(first)) {
  printHelp();
} else if (["--version", "-v"].includes(first)) {
  console.log("JB Expert QA " + EXPERT_QA_PACKAGE_VERSION);
} else if (first === "init") {
  await initialize(args.slice(1)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
} else if (first === "audit") {
  await runAudit(args.slice(1)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
} else {
  console.error("Unknown command: " + first);
  printHelp();
  process.exitCode = 2;
}
