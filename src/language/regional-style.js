import { normalizeLocale } from "./locale.js";

const REGIONAL_TERMS = Object.freeze({
  "en-US": Object.freeze([
    ["colour", "color"], ["favourite", "favorite"], ["honour", "honor"],
    ["centre", "center"], ["theatre", "theater"], ["metre", "meter"],
    ["organise", "organize"], ["recognise", "recognize"], ["travelling", "traveling"]
  ]),
  "en-GB": Object.freeze([
    ["color", "colour"], ["favorite", "favourite"], ["honor", "honour"],
    ["center", "centre"], ["theater", "theatre"], ["meter", "metre"],
    ["organize", "organise"], ["recognize", "recognise"], ["traveling", "travelling"]
  ]),
  "es-419": Object.freeze([
    ["ordenador", "computadora / equipo"], ["móvil", "celular"],
    ["vosotros", "ustedes"], ["vosotras", "ustedes"], ["vuestro", "su / de ustedes"]
  ]),
  "es-NI": Object.freeze([
    ["ordenador", "computadora / equipo"], ["móvil", "celular"],
    ["vosotros", "ustedes"], ["vosotras", "ustedes"], ["vuestro", "su / de ustedes"]
  ]),
  "es-MX": Object.freeze([
    ["ordenador", "computadora / equipo"], ["móvil", "celular"],
    ["vosotros", "ustedes"], ["vosotras", "ustedes"], ["vuestro", "su / de ustedes"]
  ]),
  "es-ES": Object.freeze([
    ["computadora", "ordenador / equipo"], ["celular", "móvil"], ["platicar", "charlar / conversar"]
  ])
});

/**
 * Finds possible regional-style mismatches without asserting that a term is
 * wrong. Regional usage is contextual, so every result is advisory and must
 * be reviewed by a person familiar with the target locale.
 */
export function auditTranslationRegionalStyle(targetMap, { targetLocale = "es-419" } = {}) {
  const locale = normalizeLocale(targetLocale);
  if (!locale) throw new TypeError("A supported target locale is required");
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
  const rules = REGIONAL_TERMS[locale] ?? [];
  const findings = [];
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable) continue;
    if (!Object.hasOwn(descriptor, "value")) {
      throw new TypeError("targetMap must not contain accessor properties");
    }
    if (typeof descriptor.value !== "string") continue;
    for (const [term, alternative] of rules) {
      const pattern = new RegExp("(?<![\\p{L}\\p{N}])" + term + "(?![\\p{L}\\p{N}])", "giu");
      for (const match of descriptor.value.matchAll(pattern)) {
        findings.push(Object.freeze({
          id: "regional-style-variant",
          key,
          severity: "low",
          confidence: "review-signal",
          message: "This wording may belong to a different regional variant than the selected target locale; verify it in context.",
          details: Object.freeze({
            term: match[0],
            suggestedAlternative: alternative,
            targetLocale: locale,
            index: match.index
          })
        }));
      }
    }
  }
  return Object.freeze(findings);
}
