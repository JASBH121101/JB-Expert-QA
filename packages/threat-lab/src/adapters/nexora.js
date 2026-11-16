import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

const PROCESS_LIMITS = Object.freeze({
  timeoutMs: 120_000,
  maxBufferBytes: 2 * 1024 * 1024,
  outputSnippetChars: 700
});

const CATALOG_ALL_TESTS = Object.freeze([
  "demo/tests/catalog-data.test.js",
  "demo/tests/store.test.js",
  "demo/tests/admin-responsive.test.js",
  "demo/tests/setup-contract.test.js"
]);

const CATALOG_SCENARIOS = Object.freeze({
  "nexora.catalog.sample-data": "demo/tests/catalog-data.test.js",
  "nexora.catalog.local-store-and-escaping": "demo/tests/store.test.js",
  "nexora.catalog.setup-contract": "demo/tests/setup-contract.test.js",
  "nexora.catalog.mobile-layout": "demo/tests/admin-responsive.test.js",
  "nexora.catalog.extreme.full-demo-regression": {
    testFiles: CATALOG_ALL_TESTS,
    combined: true
  },
  "nexora.catalog.superextreme.prototype-boundaries": {
    testFiles: CATALOG_ALL_TESTS,
    combined: true,
    prototypeBoundary: true
  }
});

const SITE_ENGINE_SCENARIOS = Object.freeze({
  "nexora.site.installation-and-template-seeding": "tests/Feature/SetupHealthTest.php",
  "nexora.site.public-data-boundaries": "tests/Feature/PublicSiteEngineTest.php",
  "nexora.site.inventory-assistant-field-isolation": "tests/Feature/InventoryAssistantTest.php",
  "nexora.site.export-permission-and-formula-safety": "tests/Feature/ExportEngineTest.php",
  "nexora.site.export-and-inventory-authorization": {
    testFiles: [
      "tests/Feature/ExportEngineTest.php",
      "tests/Feature/InventoryAssistantTest.php"
    ]
  },
  "nexora.site.role-and-field-authorization": "tests/Feature/PermissionEngineTest.php",
  "nexora.site.extreme.domain-and-tls-boundaries": {
    testFiles: [
      "tests/Feature/SiteDomainControllerTest.php",
      "tests/Feature/PublishedDomainMiddlewareTest.php"
    ]
  },
  "nexora.site.superextreme.full-feature-and-unit-suite": {
    fullSuite: true,
    timeoutMs: 300_000
  }
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

function normalizePlan(value) {
  if (typeof value === "string") return { testFiles: [value] };
  if (Array.isArray(value)) return { testFiles: value };
  if (!value || typeof value !== "object") throw new Error("The adapter scenario plan is invalid");
  return {
    testFiles: Array.isArray(value.testFiles) ? value.testFiles : [],
    combined: value.combined === true,
    fullSuite: value.fullSuite === true,
    prototypeBoundary: value.prototypeBoundary === true,
    timeoutMs: value.timeoutMs
  };
}

function executePlan({ root, binary, productLabel, scenarioId, planValue, env, database = null }) {
  const plan = normalizePlan(planValue);
  const commandResults = [];
  const testFiles = [];
  const startedAt = Date.now();

  if (plan.fullSuite) {
    const args = ["vendor/bin/phpunit", "--configuration", "phpunit.xml", "--colors=never", "--stop-on-failure"];
    const result = runBoundedProcess({
      binary,
      args,
      cwd: root,
      env,
      timeoutMs: plan.timeoutMs ?? 300_000
    });
    commandResults.push({
      testFile: "complete-feature-and-unit-suite",
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      outputBytes: result.outputBytes,
      timedOut: result.timedOut
    });
    testFiles.push("complete-feature-and-unit-suite");

    if (!result.passed) {
      return {
        status: "fail",
        summary: productLabel + " full regression suite failed.",
        findings: [{
          code: result.timedOut ? "NEXORA_TEST_TIMEOUT" : "NEXORA_PRODUCT_TEST_FAILED",
          scenarioId,
          testFile: "complete-feature-and-unit-suite",
          exitCode: result.exitCode,
          processError: result.errorCode,
          message: result.errorMessage || result.outputSnippet || "The Laravel full-suite process did not exit successfully."
        }],
        metrics: {
          exitCode: result.exitCode,
          testFiles,
          commandResults,
          durationMs: Date.now() - startedAt,
          database,
          networkRequests: 0
        }
      };
    }
  } else {
    const fullPaths = plan.testFiles.map((file) => resolveAllowedTest(root, file));
    if (fullPaths.length === 0) throw new Error("The adapter scenario has no allow-listed test file");

    const batches = plan.combined ? [{ files: fullPaths, labels: plan.testFiles }] :
      fullPaths.map((file, index) => ({ files: [file], labels: [plan.testFiles[index]] }));

    for (const batch of batches) {
      const args = binary === process.execPath
        ? ["--test", ...batch.files]
        : ["vendor/bin/phpunit", "--configuration", "phpunit.xml", "--colors=never", "--stop-on-failure", ...batch.files];

      const result = runBoundedProcess({
        binary,
        args,
        cwd: root,
        env,
        timeoutMs: plan.timeoutMs ?? PROCESS_LIMITS.timeoutMs
      });
      commandResults.push({
        testFiles: batch.labels,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        outputBytes: result.outputBytes,
        timedOut: result.timedOut
      });
      testFiles.push(...batch.labels);

      if (!result.passed) {
        return {
          status: "fail",
          summary: productLabel + " product test command failed.",
          findings: [{
            code: result.timedOut ? "NEXORA_TEST_TIMEOUT" : "NEXORA_PRODUCT_TEST_FAILED",
            scenarioId,
            testFiles: batch.labels,
            exitCode: result.exitCode,
            processError: result.errorCode,
            message: result.errorMessage || result.outputSnippet || "The product test process did not exit successfully."
          }],
          metrics: {
            exitCode: result.exitCode,
            testFiles,
            commandResults,
            durationMs: Date.now() - startedAt,
            database,
            networkRequests: 0
          }
        };
      }
    }
  }

  let safetyChecks = null;
  if (plan.prototypeBoundary) {
    const setupHtml = readFileSync(resolveAllowedTest(root, "demo/setup.html"), "utf8");
    const setupJs = readFileSync(resolveAllowedTest(root, "demo/assets/js/setup.js"), "utf8");
    safetyChecks = {
      noRealPasswordField: !setupHtml.toLowerCase().includes('type="password"') &&
        !setupHtml.toLowerCase().includes("type='password'"),
      explicitlyDemoOnly: setupJs.includes('mode:"demo-local-only"'),
      browserLocalStorageOnly: setupJs.includes("localStorage.setItem(STORE_KEY")
    };
    if (!Object.values(safetyChecks).every(Boolean)) {
      return {
        status: "fail",
        summary: "NEXORA Configurable Catalog prototype boundary checks failed.",
        findings: [{ code: "NEXORA_CATALOG_PROTOTYPE_BOUNDARY_MISMATCH", safetyChecks }],
        metrics: {
          exitCode: 1,
          testFiles,
          commandResults,
          safetyChecks,
          durationMs: Date.now() - startedAt,
          networkRequests: 0
        }
      };
    }
  }

  return {
    status: "pass",
    summary: productLabel + " passed " + commandResults.length + " bounded test command(s).",
    findings: [],
    metrics: {
      exitCode: 0,
      testFiles,
      commandResults,
      safetyChecks,
      durationMs: Date.now() - startedAt,
      database,
      networkRequests: 0
    }
  };
}

export function createNexoraCatalogAdapter({
  rootPath = process.env.NEXORA_CATALOG_ROOT,
  nodeBinary = process.execPath
} = {}) {
  return Object.freeze({
    async runScenario({ scenario }) {
      const plan = CATALOG_SCENARIOS[scenario?.id];
      if (!plan) {
        return {
          status: "fail",
          summary: "NEXORA Configurable Catalog adapter received an unregistered scenario.",
          findings: [{ code: "NEXORA_UNKNOWN_CATALOG_SCENARIO", scenarioId: scenario?.id ?? null }],
          metrics: {}
        };
      }

      try {
        const root = resolveTargetRoot(rootPath, "NEXORA_CATALOG");
        return executePlan({
          root,
          binary: nodeBinary,
          productLabel: "NEXORA Configurable Catalog prototype",
          scenarioId: scenario.id,
          planValue: plan,
          env: createMinimalEnvironment(),
          database: "browser-localStorage-demo"
        });
      } catch (error) {
        return {
          status: "fail",
          summary: "NEXORA Configurable Catalog product test could not be started.",
          findings: [{
            code: "NEXORA_CATALOG_ADAPTER_SETUP_FAILED",
            message: String(error?.message ?? error).slice(0, 500)
          }],
          metrics: { scenarioId: scenario?.id ?? null }
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
      const plan = SITE_ENGINE_SCENARIOS[scenario?.id];
      if (!plan) {
        return {
          status: "fail",
          summary: "NEXORA Site Engine adapter received an unregistered scenario.",
          findings: [{ code: "NEXORA_UNKNOWN_SITE_SCENARIO", scenarioId: scenario?.id ?? null }],
          metrics: {}
        };
      }

      try {
        const root = resolveTargetRoot(rootPath, "NEXORA_SITE_ENGINE");
        if (!existsSync(path.join(root, "vendor", "autoload.php"))) {
          throw new Error("Composer dependencies are missing; the isolated Laravel checkout must run composer install first");
        }
        if (!existsSync(path.join(root, "phpunit.xml"))) {
          throw new Error("phpunit.xml is missing from the Site Engine checkout");
        }

        return executePlan({
          root,
          binary: phpBinary,
          productLabel: "NEXORA Site Engine Laravel application",
          scenarioId: scenario.id,
          planValue: plan,
          env: createMinimalEnvironment(SITE_TEST_ENV),
          database: "sqlite-memory"
        });
      } catch (error) {
        return {
          status: "fail",
          summary: "NEXORA Site Engine product test could not be started.",
          findings: [{
            code: "NEXORA_SITE_ENGINE_ADAPTER_SETUP_FAILED",
            message: String(error?.message ?? error).slice(0, 500)
          }],
          metrics: { scenarioId: scenario?.id ?? null, database: "sqlite-memory" }
        };
      }
    }
  });
}
