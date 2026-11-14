import { DOMAINS } from "../../core/domains.js";
import { normalizeCatalogIdentity } from "../../core/catalog-identity.js";
import { cloneAndFreeze, normalizeEvidenceIds } from "../../core/immutable.js";

const DEVICE_TYPES = new Set([
  "smartphone", "tablet", "laptop", "desktop", "workstation",
  "console", "handheld_console", "television", "monitor", "projector",
  "smartwatch", "fitness_tracker", "headphones", "earbuds", "speaker",
  "camera", "router", "network_device", "printer", "accessory", "other",
]);
const SCORE_FIELDS = new Set([
  "performanceScore", "cameraScore", "videoScore", "displayScore",
  "gamingScore", "productivityScore", "portabilityScore", "thermalStabilityScore",
  "efficiencyScore", "buildQualityScore", "audioScore", "connectivityScore",
  "repairabilityScore", "valueScore",
]);
const POSITIVE_FIELDS = new Set([
  "ramGB", "storageGB", "batteryCapacityMah", "batteryCapacityWh",
  "batteryLifeHours", "displaySizeInches", "refreshRateHz", "displayBrightnessNits",
  "chargingPowerW", "weightGrams", "softwareSupportYears", "priceUSD", "priceNIO",
  "cpuCores", "gpuComputeUnits", "cameraMegapixels", "videoResolutionMP",
  "maxVideoFPS", "speakerPowerW", "wirelessRangeMeters", "portsCount",
  "fanCount", "memoryBandwidthGBs", "ssdReadMBps", "ssdWriteMBps",
]);
const STRING_FIELDS = new Set([
  "processor", "chipset", "cpuModel", "gpu", "gpuModel", "operatingSystem",
  "displayTechnology", "displayResolution", "aspectRatio", "panelType",
  "cameraSystem", "frontCamera", "rearCamera", "audioCodec", "bluetoothVersion",
  "wifiStandard", "networkGeneration", "waterResistance", "buildMaterial",
  "keyboardType", "stylusType", "storageType", "memoryType", "powerSupply",
  "portsDescription", "manufacturerModel", "modelNumber",
]);
const STRING_ARRAY_FIELDS = new Set([
  "networkBands", "connectivity", "ports", "hdrFormats", "audioCodecs",
  "supportedPlatforms", "compatibleDevices", "cameraFeatures", "simTypes",
  "wirelessStandards", "supportedResolutions", "colors",
]);
const BOOLEAN_FIELDS = new Set([
  "has5G", "expandableStorage", "stylusSupport", "keyboardSupport",
  "touchscreen", "removableBattery", "rayTracing", "variableRefreshRate",
  "hasWebcam", "hasMicrophone", "hasNoiseCancellation", "waterResistant",
  "supportsWirelessCharging", "supportsExternalGPU",
]);

function quantity(value, field, units, factor) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return value;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof value.value !== "number" || !Number.isFinite(value.value) ||
      typeof value.unit !== "string") {
    throw new TypeError(`${field} must be a finite number or { value, unit }`);
  }
  const unit = value.unit.trim().toLowerCase();
  if (!Object.hasOwn(factor, unit) || !units.includes(unit)) {
    throw new TypeError(`${field} unit must be one of: ${units.join(", ")}`);
  }
  return value.value * factor[unit];
}

function assertAliasChoice(attributes, canonical, aliases) {
  const present = aliases.filter(alias => attributes[alias] !== undefined && attributes[alias] !== null);
  if (attributes[canonical] !== undefined && present.length > 0) {
    throw new TypeError(`Provide either ${canonical} or its unit-aware alias, not both`);
  }
  if (present.length > 1) throw new TypeError(`Provide only one alias for ${canonical}`);
}

function normalizeUnits(input) {
  const attributes = { ...input };
  const aliases = [
    ["ramGB", "ram"], ["storageGB", "storage"],
    ["batteryCapacityMah", "batteryCapacity"], ["batteryCapacityWh", "batteryCapacity"],
    ["displaySizeInches", "displaySize"], ["weightGrams", "weight"],
    ["refreshRateHz", "refreshRate"], ["displayBrightnessNits", "brightness"],
    ["chargingPowerW", "chargingPower"],
  ];
  for (const [canonical, alias] of aliases) assertAliasChoice(attributes, canonical, [alias]);

  if (attributes.ram !== undefined) attributes.ramGB = quantity(attributes.ram, "ram", ["gb"], { gb: 1 });
  if (attributes.storage !== undefined) attributes.storageGB = quantity(attributes.storage, "storage", ["gb", "tb"], { gb: 1, tb: 1024 });
  if (attributes.batteryCapacity !== undefined) {
    const raw = attributes.batteryCapacity;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new TypeError("batteryCapacity must include a value and an explicit unit");
    }
    const unit = String(raw.unit).trim().toLowerCase();
    if (unit === "mah") attributes.batteryCapacityMah = quantity(raw, "batteryCapacity", ["mah"], { mah: 1 });
    else if (unit === "wh") attributes.batteryCapacityWh = quantity(raw, "batteryCapacity", ["wh"], { wh: 1 });
    else throw new TypeError("batteryCapacity unit must be mAh or Wh");
  }
  if (attributes.displaySize !== undefined) attributes.displaySizeInches = quantity(attributes.displaySize, "displaySize", ["in", "inch", "inches", "cm"], { in: 1, inch: 1, inches: 1, cm: 1 / 2.54 });
  if (attributes.weight !== undefined) attributes.weightGrams = quantity(attributes.weight, "weight", ["g", "kg"], { g: 1, kg: 1000 });
  if (attributes.refreshRate !== undefined) attributes.refreshRateHz = quantity(attributes.refreshRate, "refreshRate", ["hz"], { hz: 1 });
  if (attributes.brightness !== undefined) attributes.displayBrightnessNits = quantity(attributes.brightness, "brightness", ["nit", "nits"], { nit: 1, nits: 1 });
  if (attributes.chargingPower !== undefined) attributes.chargingPowerW = quantity(attributes.chargingPower, "chargingPower", ["w"], { w: 1 });

  for (const alias of ["ram", "storage", "batteryCapacity", "displaySize", "weight", "refreshRate", "brightness", "chargingPower"]) delete attributes[alias];
  return attributes;
}

function validateAttributeTypes(attributes) {
  for (const field of STRING_FIELDS) {
    const value = attributes[field];
    if (value !== undefined && value !== null && (typeof value !== "string" || !value.trim())) {
      throw new TypeError(`${field} must be a non-empty string`);
    }
  }
  for (const field of STRING_ARRAY_FIELDS) {
    const value = attributes[field];
    if (value !== undefined && (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim()))) {
      throw new TypeError(`${field} must be an array of non-empty strings`);
    }
  }
  for (const field of BOOLEAN_FIELDS) {
    const value = attributes[field];
    if (value !== undefined && typeof value !== "boolean") throw new TypeError(`${field} must be a boolean`);
  }
}

export function normalizeTechnologyProduct(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Technology product must be an object");
  const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : null;
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : null;
  if (!id || !name) throw new TypeError("Technology product requires id and name");
  const deviceType = String(input.deviceType ?? "").trim().toLowerCase();
  if (!DEVICE_TYPES.has(deviceType)) throw new TypeError("deviceType is not supported");
  if (input.domain !== undefined && input.domain !== DOMAINS.TECHNOLOGY) throw new TypeError("Technology adapter cannot normalize another domain");
  if (!input.attributes || typeof input.attributes !== "object" || Array.isArray(input.attributes)) throw new TypeError("Technology product attributes must be an object");

  const attributes = normalizeUnits(input.attributes);
  validateAttributeTypes(attributes);
  for (const field of POSITIVE_FIELDS) {
    const value = attributes[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new TypeError(`${field} must be a positive finite number`);
  }
  for (const field of SCORE_FIELDS) {
    const value = attributes[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) throw new TypeError(`${field} must be between 0 and 100`);
  }

  return Object.freeze({
    id, name, domain: DOMAINS.TECHNOLOGY, deviceType,
    ...normalizeCatalogIdentity(input),
    attributes: cloneAndFreeze(attributes),
    evidenceIds: normalizeEvidenceIds(input.evidenceIds, "Technology evidenceIds"),
  });
}

export const TECHNOLOGY_DEVICE_TYPES = Object.freeze([...DEVICE_TYPES]);
