import { DOMAINS } from "../core/domains.js";
import { SOURCE_TYPES } from "../core/evidence.js";

const sourceWeights = Object.freeze({
  [SOURCE_TYPES.OFFICIAL]: 1,
  [SOURCE_TYPES.INDEPENDENT_TEST]: 0.9,
  [SOURCE_TYPES.DATABASE]: 0.82,
  [SOURCE_TYPES.DISTRIBUTOR]: 0.72,
  [SOURCE_TYPES.COMMUNITY]: 0.55,
  [SOURCE_TYPES.OTHER]: 0.4,
});

const defaultFreshnessDays = Object.freeze({
  identity: 3650,
  manufacturer: 3650,
  device_type: 3650,
  operating_system: 730,
  release_date: 3650,
  launch_date: 3650,
  notes: 3650,
  concentration: 3650,
  dimensions: 3650,
  display_size: 3650,
  ram: 3650,
  ram_capacity: 3650,
  storage: 3650,
  storage_capacity: 3650,
  cpu: 3650,
  processor: 3650,
  gpu: 3650,
  chipset: 3650,
  software_support: 365,
  price: 30,
  availability: 7,
  warranty: 180,
  performance: 365,
  battery: 365,
  camera: 365,
  default: 180,
});

const domainFieldRules = Object.freeze({
  [DOMAINS.FRAGRANCE]: Object.freeze({
    perfumer: Object.freeze([SOURCE_TYPES.OFFICIAL, SOURCE_TYPES.DATABASE]),
    notes: Object.freeze([SOURCE_TYPES.OFFICIAL, SOURCE_TYPES.DATABASE, SOURCE_TYPES.INDEPENDENT_TEST]),
    longevity: Object.freeze([SOURCE_TYPES.INDEPENDENT_TEST, SOURCE_TYPES.COMMUNITY]),
    projection: Object.freeze([SOURCE_TYPES.INDEPENDENT_TEST, SOURCE_TYPES.COMMUNITY]),
    reformulation: Object.freeze([SOURCE_TYPES.OFFICIAL, SOURCE_TYPES.INDEPENDENT_TEST, SOURCE_TYPES.COMMUNITY]),
  }),
  [DOMAINS.TECHNOLOGY]: Object.freeze({
    manufacturer: Object.freeze([SOURCE_TYPES.OFFICIAL, SOURCE_TYPES.DATABASE]),
    device_type: Object.freeze([SOURCE_TYPES.OFFICIAL, SOURCE_TYPES.DATABASE]),
    operating_system: Object.freeze([SOURCE_TYPES.OFFICIAL, SOURCE_TYPES.DATABASE]),
    release_date: Object.freeze([SOURCE_TYPES.OFFICIAL, SOURCE_TYPES.DATABASE]),
    launch_date: Object.freeze([SOURCE_TYPES.OFFICIAL, SOURCE_TYPES.DATABASE]),
    display_size: Object.freeze([SOURCE_TYPES.OFFICIAL, SOURCE_TYPES.INDEPENDENT_TEST, SOURCE_TYPES.DATABASE]),
    ram: Object.freeze([SOURCE_TYPES.OFFICIAL, SOURCE_TYPES.DATABASE]),
    ram_capacity: Object.freeze([SOURCE_TYPES.OFFICIAL, SOURCE_TYPES.DATABASE]),
    storage: Object.freeze([SOURCE_TYPES.OFFICIAL, SOURCE_TYPES.DATABASE]),
    storage_capacity: Object.freeze([SOURCE_TYPES.OFFICIAL, SOURCE_TYPES.DATABASE]),
    cpu: Object.freeze([SOURCE_TYPES.OFFICIAL, SOURCE_TYPES.INDEPENDENT_TEST, SOURCE_TYPES.DATABASE]),
    processor: Object.freeze([SOURCE_TYPES.OFFICIAL, SOURCE_TYPES.INDEPENDENT_TEST, SOURCE_TYPES.DATABASE]),
    gpu: Object.freeze([SOURCE_TYPES.OFFICIAL, SOURCE_TYPES.INDEPENDENT_TEST, SOURCE_TYPES.DATABASE]),
    chipset: Object.freeze([SOURCE_TYPES.OFFICIAL, SOURCE_TYPES.INDEPENDENT_TEST, SOURCE_TYPES.DATABASE]),
    camera: Object.freeze([SOURCE_TYPES.INDEPENDENT_TEST, SOURCE_TYPES.OFFICIAL]),
    battery: Object.freeze([SOURCE_TYPES.INDEPENDENT_TEST, SOURCE_TYPES.OFFICIAL]),
    performance: Object.freeze([SOURCE_TYPES.INDEPENDENT_TEST, SOURCE_TYPES.OFFICIAL]),
    price: Object.freeze([SOURCE_TYPES.DISTRIBUTOR, SOURCE_TYPES.OFFICIAL]),
    availability: Object.freeze([SOURCE_TYPES.DISTRIBUTOR, SOURCE_TYPES.OFFICIAL]),
    warranty: Object.freeze([SOURCE_TYPES.OFFICIAL, SOURCE_TYPES.DISTRIBUTOR]),
  }),
});

function validateDomain(domain) {
  if (!Object.values(DOMAINS).includes(domain)) throw new TypeError("Unsupported research domain");
}

export function getSourcePolicy({ domain, field }) {
  validateDomain(domain);
  if (typeof field !== "string" || !field.trim()) throw new TypeError("field is required");
  const normalizedField = field.trim().toLowerCase();
  const preferredTypes = domainFieldRules[domain][normalizedField] ?? Object.values(SOURCE_TYPES);
  return Object.freeze({
    domain,
    field: normalizedField,
    preferredTypes: Object.freeze([...preferredTypes]),
    sourceWeights,
    freshnessDays: defaultFreshnessDays[normalizedField] ?? defaultFreshnessDays.default,
  });
}

export function assessSource({ domain, field, sourceType, observedAt, now = new Date().toISOString() }) {
  const policy = getSourcePolicy({ domain, field });
  if (!Object.hasOwn(sourceWeights, sourceType)) throw new TypeError("Unsupported source type");
  const observed = Date.parse(observedAt);
  const current = Date.parse(now);
  if (!Number.isFinite(observed) || !Number.isFinite(current)) throw new TypeError("observedAt and now must be valid dates");
  const ageDays = Math.max(0, (current - observed) / 86_400_000);
  const freshness = Math.max(0, 1 - ageDays / policy.freshnessDays);
  const preferred = policy.preferredTypes.includes(sourceType);
  const reliability = sourceWeights[sourceType] * (preferred ? 1 : 0.75) * freshness;
  return Object.freeze({
    domain,
    field: policy.field,
    sourceType,
    preferred,
    ageDays: Number(ageDays.toFixed(2)),
    freshness: Number(freshness.toFixed(4)),
    sourceWeight: sourceWeights[sourceType],
    reliability: Number(reliability.toFixed(4)),
    freshnessLimitDays: policy.freshnessDays,
    explanation: preferred
      ? "Source type is preferred for this field; score is adjusted for age."
      : "Source type is not preferred for this field; reliability is discounted and age-adjusted.",
  });
}
