import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = resolve(root, "packages/expert-qa");
const generatedDirectories = [
  "config",
  "src/adapters",
  "src/core",
  "src/reporters",
  "src/specialists"
];
const sourceFiles = [
  "src/adapters/advisories/osv.js",
  "src/adapters/filesystem/audit-project.js",
  "src/adapters/filesystem/scan-project.js",
  "src/core/config.js",
  "src/core/diagnostic.js",
  "src/core/engine.js",
  "src/core/redaction.js",
  "src/core/rule-registry.js",
  "src/core/scoring.js",
  "src/core/severities.js",
  "src/core/version.js",
  "src/reporters/html.js",
  "src/reporters/index.js",
  "src/reporters/markdown.js",
  "src/specialists/dead-code-rules.js",
  "src/specialists/project-rules.js",
  "src/specialists/security-rules.js",
  "config/project-audit.config.json"
];

for (const relativePath of generatedDirectories) {
  await rm(resolve(packageRoot, relativePath), { recursive: true, force: true });
}
for (const relativePath of sourceFiles) {
  const source = resolve(root, relativePath);
  const destination = resolve(packageRoot, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}
for (const relativePath of [
  "src/cli.js",
  "src/index.js",
  "src/adapters/filesystem/audit-project.js",
  "src/core/engine.js",
  "src/specialists/dead-code-rules.js",
  "config/project-audit.config.json"
]) {
  const destination = resolve(packageRoot, relativePath);
  if (!destination.startsWith(packageRoot)) {
    throw new Error("Generated path escaped package root");
  }
}
console.log("Prepared JB Expert QA Core from canonical repository sources.");
