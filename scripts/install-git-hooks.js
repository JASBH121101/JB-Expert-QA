import { chmodSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const hookPath = resolve(root, ".githooks", "pre-push");

if (!existsSync(hookPath)) {
  console.error("Missing .githooks/pre-push. Run this command from the repository root.");
  process.exit(1);
}

try {
  execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: root,
    stdio: "ignore"
  });
  chmodSync(hookPath, 0o755);
  execFileSync("git", ["config", "core.hooksPath", ".githooks"], {
    cwd: root,
    stdio: "inherit"
  });
  console.log("Installed JB Expert QA pre-push hook.");
  console.log("Every git push will run: npm run test:all-engines");
} catch (error) {
  console.error("Could not install the Git hook. Ensure Git is installed and run this inside the repository.");
  console.error(error.message);
  process.exit(1);
}
