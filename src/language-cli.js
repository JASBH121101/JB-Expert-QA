#!/usr/bin/env node
import { resolve } from "node:path";
import { auditLanguageFiles } from "./adapters/filesystem/audit-language.js";

const [projectPath, ...args] = process.argv.slice(2);
if (!projectPath) {
  console.error("Usage: npm run audit:language -- /path/to/project [--source=es-419] [--target=en]");
  process.exitCode = 2;
} else {
  try {
    const sourceArg = args.find((item) => item.startsWith("--source="));
    const targetArg = args.find((item) => item.startsWith("--target="));
    const result = await auditLanguageFiles(resolve(projectPath), {
      ...(sourceArg ? { sourceLocale: sourceArg.slice(9) } : {}),
      ...(targetArg ? { targetLocale: targetArg.slice(9) } : {})
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.status === "checked" && result.findings.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
