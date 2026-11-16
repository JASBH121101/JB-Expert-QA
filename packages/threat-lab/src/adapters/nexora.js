import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

const PROCESS_LIMITS = Object.freeze({
  timeoutMs: 120_000,
  maxBufferBytes: 2 * 1024 * 1024,
  outputSnippetChars: 700
});

const CATALOG_SCENARIOS = Object.freeze({
  "nexora.catalog.sample-data": "demo/tests/catalog-data.test.js",
  "nexora.catalog.local-store-and-escaping": "demo/tests/store.test.js",
  "nexora.catalog.setup-contract": "demo/tests/setup-contract.test.js",
  "nexora.catalog.mobile-layout": "demo/tests/admin-responsive.test.js"
});

const SITE_ENGINE_SCENARIOS = Object.freeze({
  "nexora.site.installation-and-template-seeding": "tests/Feature/SetupHealthTest.php",
  "nexora.site.public-data-boundaries": "tests/Feature/PublicSiteEngineTest.php",
  "nexora.site.inventory-assistant-field-isolation": "tests/Feature/InventoryAssistantTest.php",
  "nexora.site.export-permission-and-formula-safety": "tests/Feature/ExportEngineTest.php",
  "nexora.site.role-and-field-authorization": "tests/Feature/PermissionEngineTest.php"
});

const SAFE_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "WINDIR"];
const SITE_TEST_ENV = Object.freeze({
  APP_ENV: "testing",
  APP_KEY: "base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  DB_CONNECTION: "sqlite",
  DB_DATABASE: ":memory:",
  DB_URL: "",
  CACHE_STORE: "array",
  MAIL_MAILER: "array",
  QUEUE_CONNECTION: "sync",
  SESSION_DRIVER: "array",
  SESSION_ENCRYPT: "false"
});

function resolveTargetRoot(rootPath, label) {
  if (typeof rootPath !== "string" || !rootPath.trim()) {
    throw new Error(label + "_ROOT is not configured; the product checkout is required for real adapter execution");
  }

  const root = realpathSync(rootPath);
  const info = statSync(root);
  if (!info.isDirectory()) throw new Error(label + "_ROOT must point to a directory");
  return root;
}

function createMinimalEnvironment(overrides = {}) {
  const env = {};
  for (const key of SAFE_ENV_KEYS) {
    if (typeof process.env[key] === "string") env[key] = process.env[key];
  }
  return { ...env, ...overrides };
}

function runBoundedProcess({ binary, args, cwd, env, timeoutMs = PROCESS_LIMITS.timeoutMs }) {
  const startedAt = Date.now();
  const result = spawnSync(binary, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: PROCESS_LIMITS.maxBufferBytes,
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const durationMs = Math.max(0, Date.now() - startedAt);
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  const output = (stdout + (stderr ? "\n" + stderr : "")).trim();
  const outputSnippet = output.slice(-PROCESS_LIMITS.outputSnippetChars);

  if (result.error) {
    return {
      passed: false,
      durationMs,
      exitCode: Number.isInteger(result.status) ? result.status : null,
      timedOut: result.error.code === "ETIMEDOUT",
      outputBytes: Buffer.byteLength(output),
      outputSnippet,
      errorCode: result.error.code ?? "PROCESS_ERROR",
      errorMessage: String(result.error.message).slice(0, 300)
    };
  }

  return {
    passed: result.status === 0 && !result.signal,
    durationMs,
    exitCode: Number.isInteger(result.status) ? result.status : null,
    timedOut: false,
    outputBytes: Buffer.byteLength(output),
    outputSnippet,
    errorCode: null,
    errorMessage: null
  };
}

function buildOutcome(result, productLabel, testFile, environmentMetrics = {}) {
  const status = result.passed ? "pass" : "fail";
  const findings = result.passed ? [] : [{
    code: result.timedOut ? "NEXORA_TEST_TIMEOUT" : "NEXORA_PRODUCT_TEST_FAILED",
    product: productLabel,
    testFile,
    exitCode: result.exitCode,
    processError: result.errorCode,
    message: result.errorMessage || result.outputSnippet || "The product test process did not exit successfully."
  }];

  return {
    status,
    summary: result.passed
      ? productLabel + " product test passed: " + testFile
      : productLabel + " product test failed: " + testFile,
    findings,
    metrics: {
      testFile,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      outputBytes: result.outputBytes,
      timedOut: result.timedOut,
      ...environmentMetrics
    }
  };
}

function resolveAllowedTest(root, relativeTestFile) {
  if (typeof relativeTestFile !== "string" || relativeTestFile.startsWith("/") || relativeTestFile.includes("\\")) {
    throw new Error("Adapter test path is not a permitted relative path");
  }
  const segments = relativeTestFile.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Adapter test path contains an invalid segment");
  }
  const fullPath = path.resolve(root, ...segments);
  const relative = path.relative(root, fullPath);
  if (!relative || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new Error("Adapter test path escaped its product checkout");
  }
  const info = statSync(fullPath);
  if (!info.isFile()) throw new Error("Adapter test target is not a regular file");

  // Resolve symlinks before execution so an allow-listed name cannot escape
  // the pinned product checkout through a link to an external path.
  const canonicalPath = realpathSync(fullPath);
  const canonicalRelative = path.relative(root, canonicalPath);
  if (!canonicalRelative || canonicalRelative === ".." ||
      canonicalRelative.startsWith(".." + path.sep) || path.isAbsolute(canonicalRelative)) {
    throw new Error("Adapter test symlink resolves outside its product checkout");
  }
  if (!statSync(canonicalPath).isFile()) {
    throw new Error("Resolved adapter test target is not a regular file");
  }
  return canonicalPath;
}

export function createNexoraCatalogAdapter({
  rootPath = process.env.NEXORA_CATALOG_ROOT,
  nodeBinary = process.execPath
} = {}) {
  return Object.freeze({
    async runScenario({ scenario }) {
      const testFile = CATALOG_SCENARIOS[scenario?.id];
      if (!testFile) {
        return {
          status: "fail",
          summary: "NEXORA Configurable Catalog adapter received an unregistered scenario.",
          findings: [{ code: "NEXORA_UNKNOWN_CATALOG_SCENARIO", scenarioId: scenario?.id ?? null }],
          metrics: {}
        };
      }

      try {
        const root = resolveTargetRoot(rootPath, "NEXORA_CATALOG");
        const fullPath = resolveAllowedTest(root, testFile);
        const result = runBoundedProcess({
          binary: nodeBinary,
          args: ["--test", fullPath],
          cwd: root,
          env: createMinimalEnvironment()
        });
        return buildOutcome(result, "NEXORA Configurable Catalog prototype", testFile, {
          persistenceModel: "browser-localStorage-demo",
          authentication: "not-implemented-in-prototype"
        });
      } catch (error) {
        return {
          status: "fail",
          summary: "NEXORA Configurable Catalog product test could not be started.",
          findings: [{
            code: "NEXORA_CATALOG_ADAPTER_SETUP_FAILED",
            message: String(error?.message ?? error).slice(0, 500)
          }],
          metrics: { testFile }
        };
      }
    }
  });
}

export function createNexoraSiteEngineAdapter({
  rootPath = process.env.NEXORA_SITE_ENGINE_ROOT,
  phpBinary = "php"
} = {}) {
  return Object.freeze({
    async runScenario({ scenario }) {
      const testFile = SITE_ENGINE_SCENARIOS[scenario?.id];
      if (!testFile) {
        return {
          status: "fail",
          summary: "NEXORA Site Engine adapter received an unregistered scenario.",
          findings: [{ code: "NEXORA_UNKNOWN_SITE_SCENARIO", scenarioId: scenario?.id ?? null }],
          metrics: {}
        };
      }

      try {
        const root = resolveTargetRoot(rootPath, "NEXORA_SITE_ENGINE");
        const fullPath = resolveAllowedTest(root, testFile);
        if (!existsSync(path.join(root, "vendor", "autoload.php"))) {
          throw new Error("Composer dependencies are missing; the isolated Laravel checkout must run composer install first");
        }
        if (!existsSync(path.join(root, "phpunit.xml"))) {
          throw new Error("phpunit.xml is missing from the Site Engine checkout");
        }

        const result = runBoundedProcess({
          binary: phpBinary,
          args: ["vendor/bin/phpunit", "--configuration", "phpunit.xml", "--colors=never", "--stop-on-failure", fullPath],
          cwd: root,
          env: createMinimalEnvironment(SITE_TEST_ENV)
        });
        return buildOutcome(result, "NEXORA Site Engine Laravel application", testFile, {
          database: "sqlite-memory",
          phpunitConfiguration: "phpunit.xml",
          externalServicesExpected: false
        });
      } catch (error) {
        return {
          status: "fail",
          summary: "NEXORA Site Engine product test could not be started.",
          findings: [{
            code: "NEXORA_SITE_ENGINE_ADAPTER_SETUP_FAILED",
            message: String(error?.message ?? error).slice(0, 500)
          }],
          metrics: { testFile, database: "sqlite-memory" }
        };
      }
    }
  });
}
