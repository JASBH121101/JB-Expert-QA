#!/usr/bin/env node
import { runAutopilot } from "./agent/autopilot.js";

const args = process.argv.slice(2);
const projectPath = args.find((arg) => !arg.startsWith("--")) || ".";
const applyLowRisk = args.includes("--apply-low-risk");
const allowSourceUpload = args.includes("--allow-source-upload");
const runTests = args.includes("--run-tests");
const maxTasksArg = args.find((arg) => arg.startsWith("--max-tasks="));
const maxTasks = maxTasksArg ? Number(maxTasksArg.slice("--max-tasks=".length)) : 5;

try {
  if (applyLowRisk && (!allowSourceUpload || !runTests)) {
    throw new Error("Auto-repair requires all three flags: --apply-low-risk --allow-source-upload --run-tests");
  }
  if (!Number.isInteger(maxTasks) || maxTasks < 1 || maxTasks > 20) {
    throw new Error("--max-tasks must be an integer between 1 and 20");
  }
  const result = await runAutopilot(projectPath, {
    applyLowRisk,
    allowSourceUpload,
    runTests,
    maxTasks
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.status === "repair-failed" || result.status === "blocked-by-policy") {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
