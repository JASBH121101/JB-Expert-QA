import { normalizeLocale } from "./locale.js";

const INFORMAL_MARKERS = Object.freeze([
  /\b(?:tú|te|contigo|puedes|tienes|quieres|eres|haz|ven|dime)\b/iu
]);
const FORMAL_MARKERS = Object.freeze([
  /\b(?:usted|ustedes|puede|tiene|quiere|haga|venga|dígame)\b/iu
]);

function inspectRegister(text) {
  return {
    informal: INFORMAL_MARKERS.some(pattern => pattern.test(text)),
    formal: FORMAL_MARKERS.some(pattern => pattern.test(text))
  };
}

/**
 * Context/register checks are conservative advisory heuristics.
 * They flag mixed signals or conflicts with an explicitly declared register;
 * they do not infer audience or certify tone.
 */
export function auditTranslationRegisterSignals(targetMap, {
  targetLocale = "es-419",
  intendedRegister = "neutral"
} = {}) {
  const locale = normalizeLocale(targetLocale);
  if (!locale) throw new TypeError("A supported target locale is required");
  if (!["neutral", "formal", "informal"].includes(intendedRegister)) {
    throw new TypeError("intendedRegister must be neutral, formal, or informal");
  }
  if (locale.split("-")[0] !== "es") return Object.freeze([]);

  if (targetMap === null || typeof targetMap !== "object" || Array.isArray(targetMap)) {
    throw new TypeError("targetMap must be a plain flattened translation map");
  }
  const prototype = Object.getPrototypeOf(targetMap);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("targetMap must be a plain flattened translation map");
  }
  if (Object.getOwnPropertySymbols(targetMap).length > 0) {
    throw new TypeError("targetMap must not contain symbol keys");
  }

  const descriptors = Object.getOwnPropertyDescriptors(targetMap);
  const findings = [];
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable) continue;
    if (!Object.hasOwn(descriptor, "value")) {
      throw new TypeError("targetMap must not contain accessor properties");
    }
    if (typeof descriptor.value !== "string") continue;
    const markers = inspectRegister(descriptor.value);
    const mixed = markers.informal && markers.formal;
    const conflict = intendedRegister !== "neutral" &&
      ((intendedRegister === "formal" && markers.informal) ||
       (intendedRegister === "informal" && markers.formal));
    if (!mixed && !conflict) continue;
    findings.push(Object.freeze({
      id: mixed ? "mixed-register-signals" : "register-context-mismatch",
      key,
      severity: "low",
      confidence: "review-signal",
      message: mixed
        ? "The message contains both formal and informal Spanish register signals; review consistency and audience."
        : "The message contains register signals that may conflict with the declared intended register; review in context.",
      details: Object.freeze({
        targetLocale: locale,
        intendedRegister,
        detected: Object.freeze(markers),
        index: null
      })
    }));
  }
  return Object.freeze(findings);
}
