const FAMILY_TERMS = Object.freeze([
  { terms: ["citrico", "citrica", "citricos", "citricas", "citrus"], value: "citrus" },
  { terms: ["floral", "flores", "florales"], value: "floral" },
  { terms: ["amaderado", "amaderada", "madera", "woodsy", "woody"], value: "woody" },
  { terms: ["dulce", "gourmand"], value: "gourmand" },
  { terms: ["aromatico", "aromatica", "herbal", "hierbas"], value: "aromatic" },
  { terms: ["acuatico", "acuatica", "marino", "fresh aquatic"], value: "aquatic" },
  { terms: ["ambarado", "ambar", "oriental"], value: "amber" },
]);
const NOTE_TERMS = Object.freeze([
  ["vainilla", "vanilla"], ["vanilla", "vanilla"], ["bergamota", "bergamot"],
  ["bergamot", "bergamot"], ["limon", "lemon"], ["lemon", "lemon"],
  ["lavanda", "lavender"], ["lavender", "lavender"], ["jazmin", "jasmine"],
  ["jasmine", "jasmine"], ["rosa", "rose"], ["rose", "rose"],
  ["ambar", "amber"], ["amber", "amber"], ["almizcle", "musk"],
  ["musk", "musk"], ["canela", "cinnamon"], ["cinnamon", "cinnamon"],
  ["coco", "coconut"], ["coconut", "coconut"], ["cuero", "leather"],
  ["leather", "leather"], ["pachuli", "patchouli"], ["patchouli", "patchouli"],
  ["oud", "oud"],
]);

function normalizeText(value) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase().replace(/[^a-z0-9]+/gu, " ").trim().replace(/\s+/gu, " ");
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
function includesAny(text, terms) {
  return terms.some(term => new RegExp("\\b" + escapeRegExp(normalizeText(term)) + "\\b", "u").test(text));
}
function hasNegatedTerm(text, term) {
  return new RegExp(
    "\\b(?:no quiero|no me gusta|no me gustan|no soporto|sin|evita|evitar)\\s+(?:(?:el|la|los|las)\\s+)?(?:(?:aroma|aromas|nota|notas|fragancia|fragancias)\\s+de?\\s+)?"+escapeRegExp(term)+"\\b",
    "u",
  ).test(text);
}
function extractNotes(text) {
  const preferredNotes = [], avoidNotes = [];
  for (const [term, canonical] of NOTE_TERMS) {
    if (!new RegExp("\\b" + escapeRegExp(term) + "\\b", "u").test(text)) continue;
    if (hasNegatedTerm(text, term)) {
      avoidNotes.push(canonical);
      continue;
    }
    const positive = new RegExp(
      "\\b(?:me gusta|me gustan|prefiero|con|que tenga|notas de)\\s+(?:(?:el|la|los|las)\\s+)?(?:(?:nota|notas)\\s+de\\s+)?"+escapeRegExp(term)+"\\b",
      "u",
    );
    if (positive.test(text)) preferredNotes.push(canonical);
  }
  return { preferredNotes: [...new Set(preferredNotes)], avoidNotes: [...new Set(avoidNotes)] };
}

/**
 * Conservative phrase-based extraction for Spanish/English fragrance requests.
 * This is an intent helper, not a generative model: only explicit signals are emitted.
 */
export function parseFragranceCustomerMessage(message) {
  if (typeof message !== "string" || !message.trim()) {
    throw new TypeError("customer message must be a non-empty string");
  }
  if (message.length > 2000) throw new TypeError("customer message must not exceed 2000 characters");
  const text = normalizeText(message);
  const preferences = {};
  const signals = [];

  const evening = includesAny(text, ["noche", "nocturno", "nocturna", "cita nocturna", "evening", "night"]);
  const office = includesAny(text, ["oficina", "trabajo", "trabajar", "laboral", "work", "office"]);
  const daily = includesAny(text, ["diario", "dia a dia", "todos los dias", "uso diario", "everyday", "daily"]);
  if (evening) {
    preferences.occasion = "evening";
    signals.push("occasion:evening");
  } else if (daily) {
    // An explicit daily-use request remains the primary occasion when work is also mentioned.
    preferences.occasion = "day";
    signals.push("occasion:day");
  } else if (office) {
    preferences.occasion = "office";
    signals.push("occasion:office");
  }

  if (includesAny(text, ["calor", "caluroso", "calurosa", "humedo", "humeda", "tropical", "clima caliente", "hot weather"])) {
    preferences.climate = "hot_humid";
    signals.push("climate:hot_humid");
  } else if (includesAny(text, ["frio", "fria", "invierno", "cold weather"])) {
    preferences.climate = "cold";
    signals.push("climate:cold");
  }

  const softWords = ["suave", "ligero", "ligera", "discreto", "discreta", "soft", "subtle"];
  const nonIntrusivePhrases = [
    "no hostigoso", "no hostigosa", "no invasivo", "no invasiva",
    "no empalagoso", "no empalagosa", "no muy fuerte", "no demasiado fuerte",
    "que no sea fuerte", "que no resulte fuerte", "not overpowering", "not too strong",
  ];
  const asksSoft = includesAny(text, softWords) || includesAny(text, nonIntrusivePhrases);
  const negatedStrong = includesAny(text, [
    "no fuerte", "no quiero fuerte", "no me gusta fuerte", "no quiero que sea fuerte",
    "que no sea fuerte", "not strong", "not too strong",
  ]);
  const asksStrong = !negatedStrong && includesAny(text, [
    "intenso", "intensa", "fuerte", "potente", "marcado", "strong", "powerful",
  ]);
  if (asksSoft && !asksStrong) {
    if (includesAny(text, softWords)) {
      preferences.intensity = "soft";
      preferences.projection = "close";
      signals.push("intensity:soft", "projection:close");
    }
    // Non-intrusive is a hard ceiling, not merely a soft ranking preference.
    preferences.maxIntensity = "moderate";
    preferences.maxProjection = "moderate";
    preferences.maxSillage = "moderate";
    signals.push("constraint:non_intrusive");
  } else if (asksStrong && !asksSoft) {
    preferences.intensity = "strong";
    preferences.projection = "strong";
    signals.push("intensity:strong", "projection:strong");
  }

  if (includesAny(text, ["fresco", "fresca", "refrescante", "fresh", "clean", "limpio", "limpia"])) {
    preferences.preferredCharacters = ["fresh", "clean"];
    signals.push("character:fresh_clean");
  }

  const families = FAMILY_TERMS
    .filter(item => item.terms.some(term => includesAny(text, [term]) && !hasNegatedTerm(text, term)))
    .map(item => item.value);
  if (families.length && !includesAny(text, [
    "no dulce", "no tan dulce", "poco dulce", "no quiero dulce", "not sweet", "not too sweet",
  ])) {
    preferences.preferredFamilies = [...new Set(families)];
    signals.push("families:" + preferences.preferredFamilies.join(","));
  }

  const notes = extractNotes(text);
  if (notes.preferredNotes.length) {
    preferences.preferredNotes = notes.preferredNotes;
    signals.push("notes:" + notes.preferredNotes.join(","));
  }
  if (notes.avoidNotes.length) {
    preferences.avoidNotes = notes.avoidNotes;
    signals.push("avoid_notes:" + notes.avoidNotes.join(","));
  }

  if (includesAny(text, ["no dulce", "no tan dulce", "poco dulce", "no quiero dulce", "not sweet", "not too sweet"])) {
    preferences.avoidCharacters = ["sweet", "gourmand"];
    signals.push("avoid_character:sweet_gourmand");
  }
  if (includesAny(text, ["que dure", "larga duracion", "bastante tiempo", "dure bastante", "long lasting", "long lasting", "que me dure"])) {
    preferences.performancePriority = "long_lasting";
    signals.push("performance:long_lasting");
  }

  return Object.freeze({
    preferences: Object.freeze(preferences),
    signals: Object.freeze(signals),
    needsClarification: Object.keys(preferences).length === 0,
    note: "Only explicit, recognized customer signals are extracted. Unrecognized or ambiguous wording must be clarified rather than guessed.",
  });
}
