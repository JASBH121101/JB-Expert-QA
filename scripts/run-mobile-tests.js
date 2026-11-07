import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const excludedFiles = new Set([
  "tests/browser-environment.test.js",
  "tests/playwright-context.test.js",
  "tests/security-url.browser.test.js"
]);
const excludedDirectories = new Set(["integration"]);

async function collectTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const results = [];

  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    const relativePath = relative(root, absolute).split(sep).join("/");

    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) {
        results.push(...await collectTests(absolute));
      }
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith(".test.js")) continue;
    if (excludedFiles.has(relativePath)) continue;
    results.push(relativePath);
  }

  return results;
}

const testRoots = ["tests", "packages/malware-engine/tests"];
const testFiles = [];
for (const directory of testRoots) {
  testFiles.push(...await collectTests(join(root, directory)));
}
testFiles.sort();

if (testFiles.length === 0) {
  console.error("No mobile-compatible test files were discovered.");
  process.exit(1);
}

console.log("JB Expert QA mobile validation");
console.log("Selected test files: " + testFiles.length);
console.log("Excluded browser-dependent suites: browser-environment, Playwright context, URL browser, and integration tests.");
console.log("Playwright browser coverage remains pending for a desktop/browser runner.");

const result = spawnSync(process.execPath, ["--test", ...testFiles], {
  cwd: root,
  stdio: "inherit",
  env: process.env
});

if (result.error) {
  console.error("Could not start the Node.js test runner: " + result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
