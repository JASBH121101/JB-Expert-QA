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
