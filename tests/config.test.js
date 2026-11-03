import test from "node:test";
import assert from "node:assert/strict";
import { validateEngineConfig } from "../src/index.js";

test("engine config supplies safe defaults and preserves custom profile settings", () => {
  const config = validateEngineConfig({
    profile: "erp",
    weights: { "erp-inventory": 10 },
    thresholds: { minimumScore: 90, failOnCritical: false, customLimit: 25 }
  });
  assert.equal(config.profile, "erp");
  assert.equal(config.thresholds.minimumScore, 90);
  assert.equal(config.thresholds.failOnCritical, false);
  assert.equal(config.thresholds.customLimit, 25);
  assert.equal(config.severityPenalties.critical, 25);
  assert.equal(config.severityPenalties.info, 0);
});

test("engine config rejects invalid specialist weights", () => {
  assert.throws(() => validateEngineConfig({
    weights: { "erp-inventory": -1 }
  }), /non-negative finite number/);
  assert.throws(() => validateEngineConfig({
    weights: { "ERP Inventory": 10 }
  }), /Invalid specialist id/);
});

test("engine config rejects invalid severity penalties and thresholds", () => {
  assert.throws(() => validateEngineConfig({
    severityPenalties: { urgent: 10 }
  }), /Unknown severity penalty/);
  assert.throws(() => validateEngineConfig({
    severityPenalties: { high: Number.NaN }
  }), /non-negative finite number/);
  assert.throws(() => validateEngineConfig({
    thresholds: { minimumScore: 101 }
  }), /between 0 and 100/);
  assert.throws(() => validateEngineConfig({
    thresholds: { failOnCritical: "yes" }
  }), /must be a boolean/);
});

test("engine config validates project-specific scanner limits and applies defaults", () => {
  const defaults = validateEngineConfig({});
  assert.equal(defaults.scan.maxFiles, 2500);
  assert.equal(defaults.scan.maxFileBytes, 1_000_000);
  assert.equal(defaults.scan.maxTotalBytes, 20_000_000);
  assert.equal(defaults.scan.maxDepth, 20);

  const custom = validateEngineConfig({
    profile: "erp-project",
    scan: { maxFiles: 120, maxFileBytes: 500_000, maxDepth: 12 }
  });
  assert.equal(custom.scan.maxFiles, 120);
  assert.equal(custom.scan.maxFileBytes, 500_000);
  assert.equal(custom.scan.maxTotalBytes, 20_000_000);
  assert.equal(custom.scan.maxDepth, 12);
  assert.throws(() => validateEngineConfig({ scan: { maxFiles: 0 } }), /positive integer/);
  assert.throws(() => validateEngineConfig({ scan: { unknown: 10 } }), /Unknown project scan option/);
});

test("engine config keeps online advisories opt-in and validates safety limits", () => {
  const defaults = validateEngineConfig({});
  assert.deepEqual(defaults.advisories, {
    enabled: false,
    required: false,
    provider: "osv",
    maxPackages: 1000,
    batchSize: 100,
    maxVulnerabilities: 200,
    timeoutMs: 8000
  });

  const enabled = validateEngineConfig({
    advisories: { enabled: true, required: true, maxPackages: 250, batchSize: 50 }
  });
  assert.equal(enabled.advisories.enabled, true);
  assert.equal(enabled.advisories.required, true);
  assert.equal(enabled.advisories.maxPackages, 250);
  assert.equal(enabled.advisories.batchSize, 50);

  assert.throws(() => validateEngineConfig({ advisories: { enabled: "yes" } }), /must be a boolean/);
  assert.throws(() => validateEngineConfig({ advisories: { provider: "other" } }), /provider must be/);
  assert.throws(() => validateEngineConfig({ advisories: { batchSize: 101 } }), /safety limit/);
  assert.throws(() => validateEngineConfig({ advisories: { unknown: true } }), /Unknown advisory option/);
});
