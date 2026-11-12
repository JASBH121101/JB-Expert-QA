#!/usr/bin/env node
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { auditProject } from "../src/adapters/filesystem/audit-project.js";
import { formatReport } from "../src/reporters/index.js";
import { EXPERT_QA_PACKAGE_VERSION } from "../package-version.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundledConfigPath = resolve(packageRoot, "config/project-audit.config.json");
const require = createRequire(import.meta.url);

function help() {
  console.log([
    "JB Expert QA — complete engine",
    "",
    "Usage:",
    "  jb-qa --version",
    "  jb-qa setup --browser chromium [--with-deps]",
    "  jb-qa init [--force]",
    "  jb-qa audit [project-path] [--format html|json|markdown] [--output file] [--config file]",
    "",
    "Other complete-engine commands:",
    "  jb-qa-project [path]       Static project audit",
    "  jb-qa-url <url> --matrix   Playwright, responsive, interactive and visual audit",
    "  jb-qa-security [path]      Focused static security audit",
    "  jb-qa-security-url <url>   Runtime website security audit",
    "  jb-qa-autopilot [path]     Explicitly controlled AI planning/remediation",
    "",
    "The browser binary is installed separately: jb-qa setup --browser chromium"
  ].join("\n"));
}

function parse(tokens, allowed) {
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

async function readConfig(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new Error("Unable to read configuration " + path + ": " +
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
  const { options, positional } = parse(tokens, new Set(["--force"]));
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
  const defaults = await readConfig(bundledConfigPath);
  defaults.advisories = { enabled: false, required: false };
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(defaults, null, 2) + "\n", {
    encoding: "utf8",
    flag: force ? "w" : "wx"
  });
  console.log("Created " + target + "; online advisory lookups remain disabled.");
}

async function audit(tokens) {
  const { options, positional } = parse(tokens, new Set(["--format", "--output", "--config"]));
  if (positional.length > 1) throw new TypeError("audit accepts only one project path");
  const projectPath = positional[0] ?? ".";
  const format = options.get("--format") ?? "html";
  if (!["html", "json", "markdown"].includes(format)) {
    throw new TypeError("--format must be html, json, or markdown");
  }
  let config;
  if (options.has("--config")) {
    config = await readConfig(resolve(options.get("--config")));
  } else {
    const localConfig = resolve("jb-expert-qa.config.json");
    try {
      config = await readConfig(localConfig);
    } catch (error) {
      if (!String(error?.message).includes("ENOENT")) throw error;
      config = await readConfig(bundledConfigPath);
    }
  }
  const report = await auditProject(projectPath, { config });
  const extension = format === "markdown" ? "md" : format;
  const destination = resolve(options.get("--output") ??
    ".jb-expert-qa/reports/audit-" + new Date().toISOString().replace(/[:.]/g, "-") + "." + extension);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, formatReport(report, format) + "\n", "utf8");
  console.log("Report: " + destination);
  console.log("Score: " + report.scoring.score + "/100");
  console.log("Files analyzed: " + report.analysisScope.filesAnalyzed);
  console.log("Scan complete: " + report.analysisScope.complete);
  console.log("Result: " + (report.scoring.passed ? "PASS" : "REVIEW REQUIRED"));
  if (!report.scoring.passed) process.exitCode = 1;
}

function setup(tokens) {
  const withDeps = tokens.includes("--with-deps");
  const filteredTokens = tokens.filter((token) => token !== "--with-deps");
  const { options, positional } = parse(filteredTokens, new Set(["--browser"]));
  if (positional.length) throw new TypeError("setup does not accept positional arguments");
  const browser = options.get("--browser") ?? "chromium";
  if (browser !== "chromium") {
    throw new TypeError("This engine build uses Chromium; --browser must be chromium.");
  }
  const playwrightEntry = require.resolve("playwright");
  const playwrightCli = resolve(dirname(playwrightEntry), "cli.js");
  const args = [playwrightCli, "install", ...(withDeps ? ["--with-deps"] : []), browser];
  const result = spawnSync(process.execPath, args, { stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}

const [command, ...args] = process.argv.slice(2);
try {
  if (!command || ["--help", "-h"].includes(command)) {
    help();
  } else if (["--version", "-v"].includes(command)) {
    console.log("JB Expert QA " + EXPERT_QA_PACKAGE_VERSION);
  } else if (command === "setup") {
    setup(args);
  } else if (command === "init") {
    await initialize(args);
  } else if (command === "audit") {
    await audit(args);
  } else {
    throw new TypeError("Unknown command: " + command + ". Run jb-qa --help.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
