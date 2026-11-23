import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageRoot = resolve(repositoryRoot, "packages/expert-qa");
const sourceRoot = resolve(repositoryRoot, "src");
const configRoot = resolve(repositoryRoot, "config");
const localizationSourceRoot = resolve(repositoryRoot, "packages/localization-engine/src");
const apiTestingSourceRoot = resolve(repositoryRoot, "packages/api-testing-engine/src");
const packageLocalizationRoot = resolve(packageRoot, "packages/localization-engine/src");
const packageApiTestingRoot = resolve(packageRoot, "packages/api-testing-engine/src");
const packageSourceRoot = resolve(packageRoot, "src");
const packageConfigRoot = resolve(packageRoot, "config");

const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));

await rm(packageSourceRoot, { recursive: true, force: true });
await rm(packageConfigRoot, { recursive: true, force: true });
await rm(resolve(packageRoot, "packages/localization-engine"), { recursive: true, force: true });
await rm(resolve(packageRoot, "packages/api-testing-engine"), { recursive: true, force: true });
await mkdir(packageRoot, { recursive: true });

await cp(sourceRoot, packageSourceRoot, { recursive: true, force: true });
await cp(configRoot, packageConfigRoot, { recursive: true, force: true });
// Language QA shares the canonical CLDR catalog auditor with Localization Engine.
// Copy its source into the standalone package so relative imports remain valid after npm pack.
await mkdir(packageLocalizationRoot, { recursive: true });
await cp(localizationSourceRoot, packageLocalizationRoot, { recursive: true, force: true });
// Bundle the canonical API Testing Engine source required by the standalone adapter.
await mkdir(packageApiTestingRoot, { recursive: true });
await cp(apiTestingSourceRoot, packageApiTestingRoot, { recursive: true, force: true });

await writeFile(
  resolve(packageRoot, "package-version.js"),
  "export const EXPERT_QA_PACKAGE_VERSION = " + JSON.stringify(manifest.version) + ";\n",
  "utf8"
);

const requiredFiles = [
  "src/index.js",
  "src/audit-engines/index.js",
  "src/engine-registry/index.js",
  "src/engine-registry/adapters/api-testing.js",
  "src/engine-registry/adapters/static-qa.js",
  "src/engine-registry/adapters/static-security-qa.js",
  "src/engine-registry/adapters/runtime-security-qa.js",
  "src/engine-registry/adapters/accessibility-qa.js",
  "src/engine-registry/adapters/performance-qa.js",
  "src/engine-registry/adapters/visual-qa.js",
  "src/engine-registry/adapters/report-certification.js",
  "src/engine-registry/orchestrator.js",
  "packages/api-testing-engine/src/index.js",
  "src/dashboard/analytics.js",
  "src/dashboard/phase4-catalog.js",
  "src/dashboard/server.js",
  "src/dashboard/phase4-execution.js",
  "src/dashboard-cli.js",
  "src/dashboard/public/index.html",
  "src/dashboard/public/app.css",
  "src/dashboard/public/app.js",
  "src/cli.js",
  "src/project-cli.js",
  "src/database-cli.js",
  "src/update-manager/cli.js",
  "src/update-manager/manager.js",
  "src/update-manager/policy.js",
  "src/adapters/filesystem/audit-database.js",
  "src/specialists/database/index.js",
  "src/specialists/database/operational-rules.js",
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
  "src/agent/autonomous-execution.js",
  "src/agent/execution-runtime.js",
  "src/agent/execution-job-queue.js",
  "src/agent/execution-job-persistence.js",
  "src/agent/execution-worker.js",
  "src/agent/execution-ledger.js",
  "src/security-bridge/index.js",
  "packages/localization-engine/src/catalog.js",
  "packages/localization-engine/src/locale.js",
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
  requiredFiles.length + " required entry files verified, including the secure updater)."
);
