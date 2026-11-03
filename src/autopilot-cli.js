#!/usr/bin/env node
import { runAutopilot } from "./agent/autopilot.js";

const args = process.argv.slice(2);
const projectPath = args.find((arg) => !arg.startsWith("--")) || ".";
const aiDeepAnalysis = args.includes("--ai-deep-analysis");
const applyLowRisk = args.includes("--apply-low-risk");
const allowSourceUpload = args.includes("--allow-source-upload");
const runTests = args.includes("--run-tests");
const maxTasksArg = args.find((arg) => arg.startsWith("--max-tasks="));
const minFilesArg = args.find((arg) => arg.startsWith("--min-ai-files="));
const minBytesArg = args.find((arg) => arg.startsWith("--min-ai-bytes="));
const maxTasks = maxTasksArg ? Number(maxTasksArg.slice("--max-tasks=".length)) : 5;
const minProjectFiles = minFilesArg ? Number(minFilesArg.slice("--min-ai-files=".length)) : undefined;
const minProjectBytes = minBytesArg ? Number(minBytesArg.slice("--min-ai-bytes=".length)) : undefined;

try {
  if (applyLowRisk && !aiDeepAnalysis) {
    throw new Error("Auto-repair requires --ai-deep-analysis as an explicit AI opt-in");
  }
  if (applyLowRisk && (!allowSourceUpload || !runTests)) {
    throw new Error("Auto-repair requires all four flags: --ai-deep-analysis --apply-low-risk --allow-source-upload --run-tests");
  }
  if (!Number.isInteger(maxTasks) || maxTasks < 1 || maxTasks > 20) {
    throw new Error("--max-tasks must be an integer between 1 and 20");
  }
  const result = await runAutopilot(projectPath, {
    aiEnabled: aiDeepAnalysis,
    applyLowRisk,
    allowSourceUpload,
    runTests,
    maxTasks,
    ...(minProjectFiles === undefined ? {} : { minProjectFiles }),
    ...(minProjectBytes === undefined ? {} : { minProjectBytes })
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.status === "repair-failed" || result.status === "blocked-by-policy") {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
