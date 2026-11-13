import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageRoot = resolve(repositoryRoot, "packages/expert-qa");
const sourceRoot = resolve(repositoryRoot, "src");
const configRoot = resolve(repositoryRoot, "config");
const packageSourceRoot = resolve(packageRoot, "src");
const packageConfigRoot = resolve(packageRoot, "config");

const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));

await rm(packageSourceRoot, { recursive: true, force: true });
await rm(packageConfigRoot, { recursive: true, force: true });
await mkdir(packageRoot, { recursive: true });

await cp(sourceRoot, packageSourceRoot, { recursive: true, force: true });
await cp(configRoot, packageConfigRoot, { recursive: true, force: true });

await writeFile(
  resolve(packageRoot, "package-version.js"),
  "export const EXPERT_QA_PACKAGE_VERSION = " + JSON.stringify(manifest.version) + ";\n",
  "utf8"
);

const requiredFiles = [
  "src/index.js",
  "src/cli.js",
  "src/project-cli.js",
  "src/security-cli.js",
  "src/security-url-cli.js",
  "src/autopilot-cli.js",
  "src/adapters/playwright/audit-url.js",
  "src/adapters/playwright/interactions.js",
  "src/adapters/visual/png-diff.js",
  "src/specialists/responsive/index.js",
  "src/specialists/accessibility/index.js",
  "src/ai/visual-review.js",
  "src/agent/autopilot.js",
  "src/security-bridge/index.js",
  "config/default.config.json",
  "config/project-audit.config.json",
  "config/security-audit.config.json",
  "config/security-url.config.json"
];

for (const relativePath of requiredFiles) {
  const path = resolve(packageRoot, relativePath);
  if (!path.startsWith(packageRoot)) {
    throw new Error("Generated package path escaped package root");
  }
  await readFile(path);
}

console.log(
  "Prepared the complete JB Expert QA engine from canonical src/ and config/ trees (" +
  requiredFiles.length + " required entry files verified)."
);
