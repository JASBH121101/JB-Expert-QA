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
