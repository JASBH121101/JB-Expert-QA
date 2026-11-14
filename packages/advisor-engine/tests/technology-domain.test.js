import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTechnologyProduct, TECHNOLOGY_DEVICE_TYPES } from "../src/domains/technology/adapter.js";

const base = { id: "phone-1", name: "Phone", deviceType: "smartphone", attributes: {} };

test("technology catalogue accepts the expanded device taxonomy", () => {
  for (const deviceType of ["smartphone", "tablet", "laptop", "desktop", "console", "television", "monitor", "headphones", "earbuds", "speaker", "smartwatch", "camera", "router", "printer", "accessory"]) {
    assert.equal(normalizeTechnologyProduct({ ...base, deviceType }).deviceType, deviceType);
  }
  assert.ok(TECHNOLOGY_DEVICE_TYPES.includes("handheld_console"));
});

test("normalizes explicit technology units without mixing battery units", () => {
  const result = normalizeTechnologyProduct({
    ...base,
    attributes: {
      ram: { value: 12, unit: "GB" },
      storage: { value: 1, unit: "TB" },
      batteryCapacity: { value: 5000, unit: "mAh" },
      displaySize: { value: 16, unit: "cm" },
      weight: { value: 1.8, unit: "kg" },
    },
  });
  assert.equal(result.attributes.ramGB, 12);
  assert.equal(result.attributes.storageGB, 1024);
  assert.equal(result.attributes.batteryCapacityMah, 5000);
  assert.equal(result.attributes.batteryCapacityWh, undefined);
  assert.ok(Math.abs(result.attributes.displaySizeInches - 6.2992) < 0.001);
  assert.equal(result.attributes.weightGrams, 1800);
});

test("supports structured specification fields for different technology categories", () => {
  const result = normalizeTechnologyProduct({
    ...base, deviceType: "laptop",
    attributes: {
      processor: "Intel Core Ultra 7",
      gpu: "Intel Arc",
      displayTechnology: "OLED",
      displayResolution: "2880x1800",
      ports: ["USB-C", "HDMI"],
      hdrFormats: ["HDR10"],
      keyboardSupport: true,
      rayTracing: false,
      cpuCores: 16,
      memoryBandwidthGBs: 120,
    },
  });
  assert.deepEqual(result.attributes.ports, ["USB-C", "HDMI"]);
  assert.equal(result.attributes.processor, "Intel Core Ultra 7");
  assert.equal(result.attributes.cpuCores, 16);
  assert.equal(result.attributes.rayTracing, false);
  assert.ok(Object.isFrozen(result.attributes.ports));
});

test("rejects ambiguous units, invalid scores, invalid typed specs and unknown device types", () => {
  assert.throws(() => normalizeTechnologyProduct({ ...base, attributes: { batteryCapacity: 5000 } }), /explicit unit/);
  assert.throws(() => normalizeTechnologyProduct({ ...base, attributes: { storage: { value: 1, unit: "PB" } } }), /unit/);
  assert.throws(() => normalizeTechnologyProduct({ ...base, attributes: { cameraScore: 101 } }), /between 0 and 100/);
  assert.throws(() => normalizeTechnologyProduct({ ...base, deviceType: "spaceship" }), /deviceType/);
  assert.throws(() => normalizeTechnologyProduct({ ...base, attributes: { ports: "USB-C" } }), /array/);
  assert.throws(() => normalizeTechnologyProduct({ ...base, attributes: { rayTracing: "yes" } }), /boolean/);
  assert.throws(() => normalizeTechnologyProduct({ ...base, attributes: { processor: 123 } }), /string/);
});

test("deep-freezes copied attributes and validates evidence ID lists", () => {
  const source = { networkBands: ["n1", "n78"] };
  const result = normalizeTechnologyProduct({ ...base, attributes: source });
  source.networkBands.push("n79");
  assert.deepEqual(result.attributes.networkBands, ["n1", "n78"]);
  assert.ok(Object.isFrozen(result.attributes.networkBands));
  assert.throws(() => normalizeTechnologyProduct({ ...base, attributes: {}, evidenceIds: { cameraScore: ["x", "x"] } }), /duplicate/);
  assert.throws(() => normalizeTechnologyProduct({ ...base, attributes: {}, evidenceIds: { cameraScore: "x" } }), /array/);
});
