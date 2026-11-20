import { normalizeLocale } from "./locale.js";

export const LINGUISTIC_CONTEXTS = Object.freeze([
  "general",
  "button",
  "navigation",
  "field-label",
  "validation",
  "error",
  "success",
  "notification",
  "help",
  "onboarding",
  "marketing",
  "legal",
  "transactional"
]);

const CONTEXT_GUIDANCE = Object.freeze({
  general: Object.freeze([
    "Use consistent terminology and phrasing natural to the declared locale and audience."
  ]),
  button: Object.freeze([
    "Prefer a concise, action-oriented label that describes the result of the action."
  ]),
  navigation: Object.freeze([
    "Prefer short, recognizable labels and keep terminology consistent across the navigation."
  ]),
  "field-label": Object.freeze([
    "Name the information requested; do not rely on placeholder text as the only label."
  ]),
  validation: Object.freeze([
    "Explain what needs attention and how to correct it without blaming the user."
  ]),
  error: Object.freeze([
    "State what happened and give the clearest safe next action; avoid blame or unexplained technical jargon."
  ]),
  success: Object.freeze([
    "Lead with the completed outcome and mention a next step only when one exists."
  ]),
  notification: Object.freeze([
    "Put the important status first and keep secondary detail brief."
  ]),
  help: Object.freeze([
    "Use supportive, stepwise wording and explain specialized terms when first introduced."
  ]),
  onboarding: Object.freeze([
    "Introduce concepts in the order users need them and make each next step explicit."
  ]),
  marketing: Object.freeze([
    "Preserve the declared brand voice and use region-appropriate wording without forcing slang."
  ]),
  legal: Object.freeze([
    "Preserve legal meaning, defined terms, conditions and obligations; prefer a formal register."
  ]),
  transactional: Object.freeze([
    "Keep amounts, statuses, conditions and next steps explicit; prefer a formal, unambiguous register."
  ])
});

const LOCALE_PROFILES = Object.freeze({
  "es-NI": Object.freeze({
    label: "Spanish (Nicaragua)",
    informalAddress: "voseo (vos)",
    formalAddress: "usted",
    neutralAddress: "impersonal phrasing or omitted pronouns",
    regionalNotes: "Nicaraguan voseo is available for informal product voice; formal address remains appropriate for formal or institutional contexts."
  }),
  "es-MX": Object.freeze({
    label: "Spanish (Mexico)",
    informalAddress: "tuteo (tú)",
    formalAddress: "usted",
    neutralAddress: "impersonal phrasing or omitted pronouns",
    regionalNotes: "Prefer Mexican vocabulary where relevant; select address form according to audience and brand voice."
  }),
  "es-419": Object.freeze({
    label: "Spanish (Latin America)",
    informalAddress: "market-selected informal address (often tú or vos)",
    formalAddress: "usted",
    neutralAddress: "impersonal phrasing or omitted pronouns",
    regionalNotes: "Latin American Spanish is not a single uniform variety; select a country or market profile before enforcing regional vocabulary."
  }),
  "es-ES": Object.freeze({
    label: "Spanish (Spain)",
    informalAddress: "tuteo (tú)",
    formalAddress: "usted",
    neutralAddress: "impersonal phrasing or omitted pronouns",
    regionalNotes: "Use Spain-specific vocabulary where appropriate and keep the selected address form consistent."
  }),
  "en-US": Object.freeze({
    label: "English (United States)",
    regionalNotes: "Use US spelling and conventions consistently."
  }),
  "en-GB": Object.freeze({
    label: "English (United Kingdom)",
    regionalNotes: "Use UK spelling and conventions consistently."
  }),
  "pt-BR": Object.freeze({
    label: "Portuguese (Brazil)",
    informalAddress: "você (usage varies by region and brand voice)",
    formalAddress: "formal wording selected for the audience",
    neutralAddress: "omit the subject pronoun where natural",
    regionalNotes: "Prefer Brazilian Portuguese vocabulary and conventions."
  }),
  "pt-PT": Object.freeze({
    label: "Portuguese (Portugal)",
    informalAddress: "tu (when appropriate for the audience)",
    formalAddress: "formal or impersonal address selected for the audience",
    neutralAddress: "omit the subject pronoun where natural",
    regionalNotes: "Prefer European Portuguese vocabulary and conventions."
  }),
  "fr-FR": Object.freeze({
    label: "French (France)",
    informalAddress: "tu",
    formalAddress: "vous",
    neutralAddress: "avoid unnecessary direct address",
    regionalNotes: "Keep tu/vous consistent with the audience and product relationship."
  }),
  "de-DE": Object.freeze({
    label: "German (Germany)",
    informalAddress: "du",
    formalAddress: "Sie",
    neutralAddress: "avoid unnecessary direct address",
    regionalNotes: "Keep du/Sie capitalization and address consistent."
  }),
  "it-IT": Object.freeze({
    label: "Italian (Italy)",
    informalAddress: "tu",
    formalAddress: "Lei",
    neutralAddress: "avoid unnecessary direct address",
    regionalNotes: "Keep the selected form of address consistent."
  }),
  "ar": Object.freeze({
    label: "Arabic",
    regionalNotes: "Arabic wording varies substantially by region; select a target-market reviewer for dialect-sensitive copy."
  })
});

const CONTEXT_DEFAULT_REGISTER = Object.freeze({
  legal: "formal",
  transactional: "formal"
});

const TUTEO_MARKERS = /\b(?:tú|contigo|puedes|tienes|quieres|eres|haz|dime|ven|mira|usa|selecciona|ingresa|elige)\b/iu;
const VOSEO_MARKERS = /\b(?:vos|podés|tenés|querés|sos|hacé|decime|vení|mirá|usá|seleccioná|ingresá|elegí)\b/iu;

function isPlainRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || value === Object.prototype) {
    throw new TypeError(label + " must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(label + " must be a plain object");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(label + " must not contain symbol keys");
  }
  return Object.getOwnPropertyDescriptors(value);
}

function readStringEntries(value, label) {
  const descriptors = isPlainRecord(value, label);
  const entries = [];
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable) continue;
    if (!key || key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new TypeError(label + " contains a prototype-sensitive key");
    }
    if (!Object.hasOwn(descriptor, "value")) {
      throw new TypeError(label + " must not contain accessor properties");
    }
    if (typeof descriptor.value === "string") entries.push([key, descriptor.value]);
  }
  return entries;
}

function normalizeContext(value) {
  if (typeof value !== "string" || !LINGUISTIC_CONTEXTS.includes(value)) {
    throw new TypeError("context must be one of the supported linguistic contexts");
  }
  return value;
}

function normalizeRegister(value, context) {
  const resolved = value ?? CONTEXT_DEFAULT_REGISTER[context] ?? "neutral";
  if (!["neutral", "formal", "informal"].includes(resolved)) {
    throw new TypeError("intendedRegister must be neutral, formal, or informal");
  }
  return resolved;
}

export function inferTranslationContext(key) {
  if (typeof key !== "string" || !key.trim()) {
    throw new TypeError("translation key must be a non-empty string");
  }
  const parts = key.toLowerCase().split(/[._/:-]+/u);
  const has = (...tokens) => parts.some(part => tokens.includes(part));

  if (has("legal", "privacy", "terms", "consent", "policy", "compliance")) return "legal";
  if (has("error", "errors")) return "error";
  if (has("payment", "invoice", "order", "receipt", "checkout", "billing")) return "transactional";
  if (has("validation", "invalid", "required", "warning")) return "validation";
  if (has("success", "saved", "completed", "complete", "done")) return "success";
  if (has("notification", "notifications", "toast", "alert", "banner")) return "notification";
  if (has("navigation", "nav", "menu", "breadcrumb", "tab")) return "navigation";
  if (has("button", "buttons", "action", "actions", "cta", "submit")) return "button";
  if (has("label", "labels", "placeholder", "field", "input")) return "field-label";
  if (has("help", "tooltip", "faq", "support")) return "help";
  if (has("onboarding", "welcome", "tour", "setup")) return "onboarding";
  if (has("marketing", "campaign", "promo", "promotion", "hero", "headline")) return "marketing";
  if (has("error", "errors")) return "error";
  return "general";
}

/**
 * Resolve conservative style guidance for a locale, message context and
 * declared register. Profiles provide review guidance, not automatic copy.
 */
export function resolveLinguisticProfile({
  targetLocale = "es-419",
  context = "general",
  intendedRegister
} = {}) {
  const locale = normalizeLocale(targetLocale);
  if (!locale) throw new TypeError("A supported target locale is required");
  const resolvedContext = normalizeContext(context);
  const register = normalizeRegister(intendedRegister, resolvedContext);
  const localeProfile = LOCALE_PROFILES[locale] ?? Object.freeze({
    label: locale,
    regionalNotes: "Use terminology validated by reviewers familiar with the target locale."
  });
  const language = locale.split("-")[0];

  let preferredAddress = null;
  if (register === "informal") preferredAddress = localeProfile.informalAddress ?? null;
  else if (register === "formal") preferredAddress = localeProfile.formalAddress ?? null;
  else preferredAddress = localeProfile.neutralAddress ?? null;

  return Object.freeze({
    id: locale + ":" + resolvedContext + ":" + register,
    targetLocale: locale,
    language,
    region: locale.includes("-") ? locale.split("-")[1] : null,
    localeLabel: localeProfile.label,
    context: resolvedContext,
    intendedRegister: register,
    preferredAddress,
    regionalNotes: localeProfile.regionalNotes ?? "Use terminology validated for the target locale.",
    guidance: Object.freeze([...CONTEXT_GUIDANCE[resolvedContext]])
  });
}

/**
 * Context-aware, region-sensitive review signals. Context can be inferred from
 * translation keys or supplied explicitly as a string or {context, intendedRegister}.
 * Every finding is advisory and must be reviewed by a human.
 */
export function auditTranslationContextualProfiles(targetMap, {
  targetLocale = "es-419",
  intendedRegister,
  contextMap = Object.create(null)
} = {}) {
  const entries = readStringEntries(targetMap, "targetMap");
  const contextDescriptors = isPlainRecord(contextMap, "contextMap");
  const findings = [];

  for (const [key, text] of entries) {
    const contextDescriptor = Object.hasOwn(contextDescriptors, key) ? contextDescriptors[key] : undefined;
    if (contextDescriptor && !Object.hasOwn(contextDescriptor, "value")) {
      throw new TypeError("contextMap must not contain accessor properties");
    }
    const override = contextDescriptor?.value;
    let context = inferTranslationContext(key);
    let register = intendedRegister;

    if (typeof override === "string") {
      context = normalizeContext(override);
    } else if (override !== undefined) {
      const profileDescriptors = isPlainRecord(override, "contextMap entry");
      const contextValue = profileDescriptors.context?.value;
      const registerValue = profileDescriptors.intendedRegister?.value;
      for (const descriptor of Object.values(profileDescriptors)) {
        if (descriptor.enumerable && !Object.hasOwn(descriptor, "value")) {
          throw new TypeError("contextMap entry must not contain accessor properties");
        }
      }
      if (contextValue !== undefined) context = normalizeContext(contextValue);
      if (registerValue !== undefined) register = registerValue;
    }

    const profile = resolveLinguisticProfile({ targetLocale, context, intendedRegister: register });
    const wordCount = (text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? []).length;

    if (profile.context === "button" && wordCount > 8) {
      findings.push(Object.freeze({
        id: "context-copy-too-long",
        key,
        severity: "low",
        confidence: "review-signal",
        message: "This action label is unusually long; review whether it can be made more concise without losing meaning.",
        details: Object.freeze({ context: profile.context, wordCount, suggestedMaximum: 8, targetLocale: profile.targetLocale })
      }));
    } else if (profile.context === "navigation" && wordCount > 5) {
      findings.push(Object.freeze({
        id: "context-copy-too-long",
        key,
        severity: "low",
        confidence: "review-signal",
        message: "This navigation label is unusually long; review whether a shorter, recognizable label would work.",
        details: Object.freeze({ context: profile.context, wordCount, suggestedMaximum: 5, targetLocale: profile.targetLocale })
      }));
    }

    if (["legal", "transactional"].includes(profile.context) && profile.intendedRegister !== "formal") {
      findings.push(Object.freeze({
        id: "context-register-review",
        key,
        severity: "low",
        confidence: "review-signal",
        message: "This legal or transactional message uses a non-formal profile; confirm that the tone is suitable for the audience and obligations.",
        details: Object.freeze({ context: profile.context, intendedRegister: profile.intendedRegister, targetLocale: profile.targetLocale })
      }));
    }

    if (profile.language === "es" && profile.intendedRegister === "informal") {
      const tuteo = TUTEO_MARKERS.test(text);
      const voseo = VOSEO_MARKERS.test(text);
      if (profile.targetLocale === "es-NI" && tuteo && !voseo) {
        findings.push(Object.freeze({
          id: "regional-address-form-review",
          key,
          severity: "low",
          confidence: "review-signal",
          message: "This informal copy uses tuteo markers; consider whether Nicaraguan voseo better matches the selected locale and brand voice.",
          details: Object.freeze({ targetLocale: profile.targetLocale, detectedAddress: "tuteo", preferredAddress: "voseo (vos)", context: profile.context })
        }));
      } else if (["es-MX", "es-ES"].includes(profile.targetLocale) && voseo && !tuteo) {
        findings.push(Object.freeze({
          id: "regional-address-form-review",
          key,
          severity: "low",
          confidence: "review-signal",
          message: "This informal copy uses voseo markers; review whether tuteo better matches the selected locale and brand voice.",
          details: Object.freeze({ targetLocale: profile.targetLocale, detectedAddress: "voseo", preferredAddress: "tuteo (tú)", context: profile.context })
        }));
      }
    }
  }

  return Object.freeze(findings);
}
