#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { reverifyProject, reverifySecurityProject } from "./adapters/filesystem/reverify-project.js";

const [projectPath = ".", ...args] = process.argv.slice(2);

try {
  const options = new Map();
  for (const arg of args) {
    const separator = arg.indexOf("=");
    if (!arg.startsWith("--") || separator < 3) {
      throw new TypeError("Usage: npm run reverify -- PROJECT --previous=REPORT.json [--profile=project|security] [--output=RESULT.json]");
    }
    const name = arg.slice(2, separator);
    const value = arg.slice(separator + 1);
    if (!value.trim()) throw new TypeError("--" + name + " requires a non-empty value");
    if (options.has(name)) throw new TypeError("--" + name + " may only be supplied once");
    if (!["previous", "profile", "output"].includes(name)) {
      throw new TypeError("Unknown re-verification option: --" + name);
    }
    options.set(name, value);
  }

  const previousPath = options.get("previous");
  if (!previousPath) throw new TypeError("Required option missing: --previous=REPORT.json");
  const profile = options.get("profile") || "project";
  if (!["project", "security"].includes(profile)) {
    throw new TypeError("--profile must be project or security");
  }

  const absolutePreviousPath = resolve(previousPath);
  let previousReport;
  try {
    previousReport = JSON.parse(await readFile(absolutePreviousPath, "utf8"));
  } catch (error) {
    throw new Error("Unable to read a valid previous JSON report: " +
      (error instanceof Error ? error.message : String(error)));
  }

  const run = profile === "security" ? reverifySecurityProject : reverifyProject;
  const result = await run(projectPath, { previousReport });
  const rendered = JSON.stringify(result, null, 2);
  const outputPath = options.get("output");

  if (outputPath) {
    const absoluteOutputPath = resolve(outputPath);
    await mkdir(dirname(absoluteOutputPath), { recursive: true });
    await writeFile(absoluteOutputPath, rendered + "\n", "utf8");
    console.log("Targeted re-verification report saved to " + absoluteOutputPath);
  } else {
    console.log(rendered);
  }

  if (result.status === "review-required") process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
