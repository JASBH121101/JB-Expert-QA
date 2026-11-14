const LEVELS = Object.freeze({ soft: 1, suave: 1, moderate: 2, moderada: 2, strong: 3, intensa: 3, very_strong: 4 });
const PROJECTION = Object.freeze({ close: 1, moderate: 2, moderada: 2, strong: 3, alta: 3, very_strong: 4 });
const SILLAGE = Object.freeze({ low: 1, baja: 1, moderate: 2, moderada: 2, strong: 3, alta: 3, very_strong: 4 });
const STRICT_STATUSES = new Set(["verified", "cross_checked"]);

function normalizeText(value) {
  return String(value).normalize("NFD").replace(/[\u0300-\u036f]/gu, "")
    .trim().toLocaleLowerCase().replace(/[_-]+/gu, " ").replace(/\s+/gu, " ");
}
function alias(value, map) {
  const key = normalizeText(value);
  return map[key] ?? key;
}
const FAMILY_ALIASES = Object.freeze({
  citrica: "citrus", citrico: "citrus", amaderado: "woody",
  amaderada: "woody", madera: "woody", aromatica: "aromatic",
  aromatico: "aromatic", acuatico: "aquatic", acuatica: "aquatic",
});
const NOTE_ALIASES = Object.freeze({
  vainilla: "vanilla", bergamota: "bergamot", limon: "lemon", lavanda: "lavender",
  jazmin: "jasmine", rosa: "rose", ambar: "amber", almizcle: "musk",
  canela: "cinnamon", coco: "coconut", cuero: "leather", pachuli: "patchouli",
});
const CHARACTER_ALIASES = Object.freeze({
  fresco: "fresh", fresca: "fresh", limpio: "clean", limpia: "clean",
  dulce: "sweet", goloso: "gourmand", golosa: "gourmand",
});
const OCCASION_ALIASES = Object.freeze({
  office: ["office", "work", "day", "daytime"],
  work: ["office", "work", "day", "daytime"],
  day: ["day", "daytime", "daily", "everyday"],
  evening: ["evening", "night", "date"],
  night: ["evening", "night", "date"],
});
const CLIMATE_ALIASES = Object.freeze({
  hot_humid: ["hot_humid", "tropical", "hot", "humid"],
  tropical: ["hot_humid", "tropical", "hot", "humid"],
  cold: ["cold", "cool", "winter"],
});
function normalizeList(value, field, mapper = normalizeText) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim())) {
    throw new TypeError(field + " must be an array of non-empty strings");
  }
  return [...new Set(value.map(mapper))];
}
function asList(value, field = "attribute", mapper = normalizeText) {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : [value];
  if (items.some(item => typeof item !== "string" || !item.trim())) {
    throw new TypeError(field + " must contain only non-empty strings");
  }
  return items.map(mapper);
}
function overlapScore(preferred, actual, aliases = null) {
  if (!preferred.length || !actual.length) return null;
  const expanded = actual.flatMap(item => aliases?.[item] ?? [item]);
  const available = new Set(expanded);
  const matched = preferred.filter(item => (aliases?.[item] ?? [item]).some(value => available.has(value)));
  return matched.length / preferred.length * 100;
}
function levelScore(value, target, field, levels) {
  if (value === undefined || value === null || target === undefined || target === null) return null;
  const actual = levels[normalizeText(value)];
  const desired = levels[normalizeText(target)];
  if (!actual || !desired) throw new TypeError(field + " and its preference must use a supported ordinal level");
  return Math.max(0, 100 - Math.abs(actual - desired) / 3 * 100);
}
function validateProduct(product) {
  if (!product || typeof product !== "object" || Array.isArray(product) ||
      typeof product.id !== "string" || !product.id.trim() ||
      typeof product.name !== "string" || !product.name.trim() ||
      product.domain !== "fragrance" || typeof product.productType !== "string" ||
      !product.productType.trim() || !product.attributes ||
      typeof product.attributes !== "object" || Array.isArray(product.attributes)) {
    throw new TypeError("Each candidate must be a fragrance product with id, name, productType and attributes");
  }
}
function noteFields(attributes) {
  if (asList(attributes.allNotes, "allNotes", value => alias(value, NOTE_ALIASES)).length) return ["allNotes"];
  return ["topNotes", "middleNotes", "baseNotes"].filter(field =>
    asList(attributes[field], field, value => alias(value, NOTE_ALIASES)).length > 0);
}
function completeNoteCoverage(attributes) {
  return asList(attributes.allNotes, "allNotes", value => alias(value, NOTE_ALIASES)).length > 0 ||
    ["topNotes", "middleNotes", "baseNotes"].every(field =>
      asList(attributes[field], field, value => alias(value, NOTE_ALIASES)).length > 0);
}
function canonicalValue(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalValue).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ":" + canonicalValue(value[key])).join(",") + "}";
  return JSON.stringify(value);
}
function resolveEvidence(product, fields, evidenceStore, allowReported) {
  if (!evidenceStore) return { eligible: true, status: "not_assessed", ids: [] };
  const accepted = [];
  for (const field of [...new Set(fields)]) {
    const ids = product.evidenceIds?.[field] ?? [];
    if (!Array.isArray(ids)) throw new TypeError("product.evidenceIds." + field + " must be an array");
    if (!ids.length) return { eligible: false, status: "missing_evidence", ids: [] };
    if (new Set(ids).size !== ids.length) throw new TypeError("Duplicate evidence IDs for field: " + field);
    const records = ids.map(id => {
      if (typeof id !== "string" || !id.trim()) throw new TypeError("Evidence IDs must be non-empty strings");
      const record = evidenceStore.getById(id.trim());
      if (!record) throw new Error("Evidence record not found: " + id);
      if (record.domain !== "fragrance" || record.subjectId !== product.id || record.field !== field ||
          canonicalValue(record.value) !== canonicalValue(product.attributes[field])) {
        throw new Error("Evidence record " + id + " does not match the product attribute " + field);
      }
      return record;
    });
    if (evidenceStore.conflicts({ domain: "fragrance", subjectId: product.id, field }).length > 1) {
      return { eligible: false, status: "conflict", ids };
    }
    const verified = records.filter(record => STRICT_STATUSES.has(record.status));
    const reported = records.filter(record => record.status === "reported");
    const usable = verified.length ? verified : allowReported ? reported : [];
    if (!usable.length) return { eligible: false, status: reported.length ? "reported_only" : "unconfirmed", ids };
    accepted.push(...usable);
  }
  return {
    eligible: true,
    status: accepted.every(record => record.status === "reported")
      ? "reported" : accepted.some(record => record.status === "cross_checked") ? "cross_checked" : "verified",
    ids: [...new Set(accepted.map(record => record.id))],
  };
}
function scoreCriterion({ key, weight, score, product, fields, evidenceStore, allowReported, matched = [] }) {
  if (score === null || !fields.length) return { key, weight, score: null, status: "missing_data", matched: [] };
  const evidence = resolveEvidence(product, fields, evidenceStore, allowReported);
  if (!evidence.eligible) return { key, weight, score: null, status: evidence.status, evidenceIds: evidence.ids, matched: [] };
  return {
    key, weight, score: Number(score.toFixed(1)), status: "scored",
    evidenceStatus: evidence.status, evidenceIds: evidence.ids, matched: [...matched],
  };
}
function applyCeiling({ product, key, field, target, levels, weight, evidenceStore, allowReported, exclusions, constraints, values }) {
  const raw = product.attributes[field];
  if (raw === undefined || raw === null) {
    exclusions.push(key + "_not_verifiable");
    constraints.push({ key, status: "not_verifiable", value: null, maximum: target });
    values.push({ key, weight, score: null, status: "not_verifiable", matched: [] });
    return;
  }
  const actual = levels[normalizeText(raw)];
  const maximum = levels[normalizeText(target)];
  if (!actual || !maximum) throw new TypeError(key + " must use a supported ordinal level");
  const evidence = resolveEvidence(product, [field], evidenceStore, allowReported);
  if (!evidence.eligible) {
    exclusions.push(key + "_evidence_not_eligible");
    constraints.push({ key, status: evidence.status, value: raw, maximum: target });
    values.push({ key, weight, score: null, status: evidence.status, matched: [] });
    return;
  }
  const satisfied = actual <= maximum;
  constraints.push({ key, status: satisfied ? "satisfied" : "exceeded", value: raw, maximum: target });
  if (!satisfied) exclusions.push(key + "_above_limit");
  values.push({ key, weight, score: satisfied ? 100 : 0, status: satisfied ? "scored" : "constraint_failed",
    evidenceStatus: evidence.status, evidenceIds: evidence.ids, matched: satisfied ? ["within_limit"] : [] });
}
function explain(values) {
  const reasons = [];
  for (const item of values) {
    if (item.score === null || item.score < 60) continue;
    const descriptions = {
      scentFamilies: "Coincide con las familias olfativas que buscas.",
      notes: "Incluye notas que mencionaste.",
      characterTraits: "Su carácter coincide con tus preferencias.",
      occasion: "Su ficha lo relaciona con la ocasión indicada.",
      climate: "Su perfil tiene etiquetas compatibles con el clima indicado.",
      intensity: "La intensidad registrada se aproxima a la que prefieres.",
      projection: "La proyección registrada se aproxima a la que buscas.",
      maxIntensity: "La intensidad registrada está dentro del límite solicitado.",
      maxProjection: "La proyección registrada está dentro del límite solicitado.",
      maxSillage: "La estela registrada está dentro del límite solicitado.",
    };
    if (descriptions[item.key]) reasons.push(descriptions[item.key]);
  }
  return Object.freeze({
    headline: reasons.length ? "Esta opción coincide con varias preferencias expresadas." : "No hay suficientes coincidencias positivas para justificar esta opción.",
    reasons: Object.freeze(reasons),
    tradeoffs: Object.freeze(values.filter(item => item.score !== null && item.score < 40)
      .map(item => Object.freeze({ criterion: item.key, note: "Este criterio no coincide bien con la preferencia indicada.", score: item.score }))),
  });
}

export function matchFragrances({
  products, preferences = {}, minimumMatchCoverage = 60, evidenceStore = null, evidencePolicy = {},
} = {}) {
  if (!Array.isArray(products) || products.length === 0) throw new TypeError("products must contain at least one fragrance candidate");
  if (!Number.isFinite(minimumMatchCoverage) || minimumMatchCoverage < 0 || minimumMatchCoverage > 100) throw new TypeError("minimumMatchCoverage must be between 0 and 100");
  if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) throw new TypeError("preferences must be an object");
  if (!evidencePolicy || typeof evidencePolicy !== "object" || Array.isArray(evidencePolicy) ||
      (evidencePolicy.allowReported !== undefined && typeof evidencePolicy.allowReported !== "boolean")) throw new TypeError("evidencePolicy.allowReported must be a boolean");
  if (evidenceStore !== null && (typeof evidenceStore.getById !== "function" || typeof evidenceStore.conflicts !== "function")) throw new TypeError("evidenceStore must implement getById() and conflicts()");
  const allowReported = evidencePolicy.allowReported === true;
  products.forEach(validateProduct);
  if (new Set(products.map(product => product.id)).size !== products.length) throw new TypeError("candidate IDs must be unique");

  const preferredFamilies = normalizeList(preferences.preferredFamilies, "preferredFamilies", value => alias(value, FAMILY_ALIASES));
  const preferredNotes = normalizeList(preferences.preferredNotes, "preferredNotes", value => alias(value, NOTE_ALIASES));
  const avoidedNotes = normalizeList(preferences.avoidNotes, "avoidNotes", value => alias(value, NOTE_ALIASES));
  const preferredCharacters = normalizeList(preferences.preferredCharacters, "preferredCharacters", value => alias(value, CHARACTER_ALIASES));
  const avoidedCharacters = normalizeList(preferences.avoidCharacters, "avoidCharacters", value => alias(value, CHARACTER_ALIASES));
  const occasion = preferences.occasion === undefined ? null : normalizeText(preferences.occasion);
  const climate = preferences.climate === undefined ? null : normalizeText(preferences.climate);
  const intensity = preferences.intensity === undefined ? null : normalizeText(preferences.intensity);
  const projection = preferences.projection === undefined ? null : normalizeText(preferences.projection);
  const maxIntensity = preferences.maxIntensity === undefined ? null : normalizeText(preferences.maxIntensity);
  const maxProjection = preferences.maxProjection === undefined ? null : normalizeText(preferences.maxProjection);
  const maxSillage = preferences.maxSillage === undefined ? null : normalizeText(preferences.maxSillage);
  const productTypes = normalizeList(preferences.productTypes, "productTypes");

  const requested = [];
  if (preferredFamilies.length) requested.push({ key: "scentFamilies", weight: 25 });
  if (preferredNotes.length) requested.push({ key: "notes", weight: 30 });
  if (avoidedNotes.length) requested.push({ key: "avoidNotes", weight: 25 });
  if (preferredCharacters.length) requested.push({ key: "characterTraits", weight: 15 });
  if (avoidedCharacters.length) requested.push({ key: "avoidCharacters", weight: 15 });
  if (occasion) requested.push({ key: "occasion", weight: 10 });
  if (climate) requested.push({ key: "climate", weight: 10 });
  if (intensity) requested.push({ key: "intensity", weight: 6 });
  if (projection) requested.push({ key: "projection", weight: 4 });
  if (maxIntensity) requested.push({ key: "maxIntensity", weight: 8 });
  if (maxProjection) requested.push({ key: "maxProjection", weight: 8 });
  if (maxSillage) requested.push({ key: "maxSillage", weight: 6 });
  const requestedWeight = requested.reduce((sum, item) => sum + item.weight, 0);
  if (!requestedWeight && !productTypes.length) throw new TypeError("At least one fragrance preference must be supplied");

  const results = products.map(product => {
    const attributes = product.attributes;
    const sourceNoteFields = asList(attributes.allNotes, "allNotes").length ? ["allNotes"]
      : ["topNotes", "middleNotes", "baseNotes"].filter(field => asList(attributes[field], field).length);
    const notes = [...new Set(sourceNoteFields.flatMap(field => asList(attributes[field], field, value => alias(value, NOTE_ALIASES))))];
    const allNotesComplete = sourceNoteFields.includes("allNotes") ||
      ["topNotes", "middleNotes", "baseNotes"].every(field => asList(attributes[field], field).length > 0);
    const exclusions = [];
    const constraints = [];
    const values = [];
    if (productTypes.length && !productTypes.includes(normalizeText(product.productType))) exclusions.push("product_type_not_allowed");
    const add = (key, weight, score, fields, matched = []) => values.push(scoreCriterion({
      key, weight, score, product, fields, evidenceStore, allowReported, matched,
    }));

    if (preferredFamilies.length) {
      const actual = asList(attributes.scentFamilies, "scentFamilies", value => alias(value, FAMILY_ALIASES));
      const score = overlapScore(preferredFamilies, actual);
      add("scentFamilies", 25, score, ["scentFamilies"], score === null ? [] : actual);
    }
    if (preferredNotes.length) {
      const score = overlapScore(preferredNotes, notes);
      add("notes", 30, score, sourceNoteFields, notes);
    }
    if (avoidedNotes.length) {
      const matches = avoidedNotes.filter(note => notes.includes(note));
      if (matches.length) {
        const evidence = sourceNoteFields.length ? resolveEvidence(product, sourceNoteFields, evidenceStore, allowReported)
          : { eligible: !evidenceStore, status: "missing_evidence", ids: [] };
        exclusions.push(evidence.eligible ? "contains_avoided_notes" : "avoidance_evidence_not_eligible");
        values.push({ key: "avoidNotes", weight: 25, score: evidence.eligible ? 0 : null,
          status: evidence.eligible ? "constraint_failed" : evidence.status, matched: [] });
      } else if (!allNotesComplete) {
        exclusions.push("avoidance_not_verifiable");
        values.push({ key: "avoidNotes", weight: 25, score: null, status: "incomplete_note_coverage", matched: [] });
      } else add("avoidNotes", 25, 100, sourceNoteFields);
    }
    if (preferredCharacters.length) {
      const actual = asList(attributes.characterTraits, "characterTraits", value => alias(value, CHARACTER_ALIASES));
      const score = overlapScore(preferredCharacters, actual);
      add("characterTraits", 15, score, ["characterTraits"], actual);
    }
    if (avoidedCharacters.length) {
      const actual = asList(attributes.characterTraits, "characterTraits", value => alias(value, CHARACTER_ALIASES));
      if (!actual.length) {
        exclusions.push("character_avoidance_not_verifiable");
        values.push({ key: "avoidCharacters", weight: 15, score: null, status: "not_verifiable", matched: [] });
      } else if (avoidedCharacters.some(item => actual.includes(item))) {
        const evidence = resolveEvidence(product, ["characterTraits"], evidenceStore, allowReported);
        exclusions.push(evidence.eligible ? "contains_avoided_characters" : "character_avoidance_evidence_not_eligible");
        values.push({ key: "avoidCharacters", weight: 15, score: evidence.eligible ? 0 : null,
          status: evidence.eligible ? "constraint_failed" : evidence.status, matched: [] });
      } else add("avoidCharacters", 15, 100, ["characterTraits"]);
    }
    if (occasion) {
      const actual = [...asList(attributes.timesOfDay, "timesOfDay"), ...asList(attributes.occasionTags, "occasionTags")].map(normalizeText);
      const aliases = OCCASION_ALIASES[occasion] ?? [occasion];
      const score = actual.some(value => (OCCASION_ALIASES[value] ?? [value]).some(item => aliases.includes(item))) ? 100 : 0;
      const fields = ["timesOfDay", "occasionTags"].filter(field => asList(attributes[field], field).length);
      add("occasion", 10, fields.length ? score : null, fields, actual);
    }
    if (climate) {
      const actual = asList(attributes.climateTags, "climateTags").map(normalizeText);
      const aliases = CLIMATE_ALIASES[climate] ?? [climate];
      const score = actual.some(value => (CLIMATE_ALIASES[value] ?? [value]).some(item => aliases.includes(item))) ? 100 : 0;
      add("climate", 10, actual.length ? score : null, ["climateTags"], actual);
    }
    if (intensity) add("intensity", 6, levelScore(attributes.intensityLevel, intensity, "intensity", LEVELS),
      ["intensityLevel"], [normalizeText(attributes.intensityLevel ?? "")]);
    if (projection) add("projection", 4, levelScore(attributes.projectionLevel, projection, "projection", PROJECTION),
      ["projectionLevel"], [normalizeText(attributes.projectionLevel ?? "")]);

    const ceiling = (key, field, target, levels, weight) => {
      const raw = attributes[field];
      if (raw === undefined || raw === null) {
        exclusions.push(key + "_not_verifiable");
        constraints.push({ key, status: "not_verifiable", value: null, maximum: target });
        values.push({ key, weight, score: null, status: "not_verifiable", matched: [] });
        return;
      }
      const actual = levels[normalizeText(raw)], maximum = levels[normalizeText(target)];
      if (!actual || !maximum) throw new TypeError(key + " must use a supported ordinal level");
      const evidence = resolveEvidence(product, [field], evidenceStore, allowReported);
      if (!evidence.eligible) {
        exclusions.push(key + "_evidence_not_eligible");
        constraints.push({ key, status: evidence.status, value: raw, maximum: target });
        values.push({ key, weight, score: null, status: evidence.status, matched: [] });
        return;
      }
      const passed = actual <= maximum;
      constraints.push({ key, status: passed ? "satisfied" : "exceeded", value: raw, maximum: target });
      if (!passed) exclusions.push(key + "_above_limit");
      values.push({ key, weight, score: passed ? 100 : 0, status: passed ? "scored" : "constraint_failed",
        evidenceStatus: evidence.status, evidenceIds: evidence.ids, matched: passed ? ["within_limit"] : [] });
    };
    if (maxIntensity) ceiling("maxIntensity", "intensityLevel", maxIntensity, LEVELS, 8);
    if (maxProjection) ceiling("maxProjection", "projectionLevel", maxProjection, PROJECTION, 8);
    if (maxSillage) ceiling("maxSillage", "sillageLevel", maxSillage, SILLAGE, 6);

    const scored = values.filter(item => item.score !== null);
    const scoredWeight = scored.reduce((sum, item) => sum + item.weight, 0);
    const score = scoredWeight ? scored.reduce((sum, item) => sum + item.score * item.weight, 0) / scoredWeight : null;
    const coverage = requestedWeight ? scoredWeight / requestedWeight * 100 : 0;
    const eligible = exclusions.length === 0 && score !== null && coverage >= minimumMatchCoverage;
    const reasons = scored.filter(item => item.score >= 60).map(item => ({
      scentFamilies: "Coincide con las familias olfativas que buscas.",
      notes: "Incluye notas que mencionaste.",
      characterTraits: "Su carácter coincide con tus preferencias.",
      occasion: "Su ficha lo relaciona con la ocasión indicada.",
      climate: "Su perfil tiene compatibilidad con el clima indicado.",
      intensity: "La intensidad registrada se aproxima a la que prefieres.",
      projection: "La proyección registrada se aproxima a la que buscas.",
      maxIntensity: "La intensidad registrada está dentro del límite solicitado.",
      maxProjection: "La proyección registrada está dentro del límite solicitado.",
      maxSillage: "La estela registrada está dentro del límite solicitado.",
    }[item.key])).filter(Boolean);
    const statuses = [...new Set(scored.map(item => item.evidenceStatus ?? "not_assessed"))];
    const evidenceStatus = !evidenceStore ? "not_assessed" : statuses.includes("reported") ? "reported"
      : statuses.includes("cross_checked") ? "cross_checked" : "verified";
    const caveats = [];
    if (!evidenceStore) caveats.push("Los atributos del catálogo se utilizaron sin verificación independiente.");
    if (values.some(item => item.score === null)) caveats.push("Una o más preferencias carecen de datos o evidencia elegible.");
    if (sourceNoteFields.length && !allNotesComplete) caveats.push("La pirámide de notas es parcial; no se afirma que las notas no registradas estén ausentes.");
    const explanation = Object.freeze({
      headline: reasons.length ? "Esta opción coincide con varias preferencias expresadas." : "No hay suficientes coincidencias positivas para justificar esta opción.",
      reasons: Object.freeze(reasons),
      tradeoffs: Object.freeze(scored.filter(item => item.score < 40).map(item => ({ criterion: item.key, score: item.score }))),
      evidenceNote: evidenceStore ? "La evidencia enlazada se evaluó bajo la política configurada." : "Las coincidencias utilizan atributos del catálogo no verificados independientemente; esto no certifica la calidad ni el rendimiento.",
    });
    return Object.freeze({
      id: product.id, name: product.name, productType: product.productType,
      score: score === null ? null : Number(score.toFixed(1)), coverage: Number(coverage.toFixed(1)),
      eligibility: exclusions.length ? "excluded" : eligible ? "eligible" : score === null ? "insufficient_data" : "insufficient_coverage",
      exclusions: Object.freeze(exclusions), constraints: Object.freeze(constraints),
      matchedCriteria: Object.freeze(scored.filter(item => item.score >= 60).map(item => item.key)),
      reasons: Object.freeze(reasons), explanation, breakdown: Object.freeze(values.map(item => Object.freeze(item))),
      evidenceStatus, evidenceNote: explanation.evidenceNote, caveats: Object.freeze(caveats),
    });
  });

  const ranking = results.sort((a, b) => {
    const aEligible = a.eligibility === "eligible", bEligible = b.eligibility === "eligible";
    if (aEligible !== bEligible) return aEligible ? -1 : 1;
    if (a.score === null && b.score === null) return a.name.localeCompare(b.name);
    if (a.score === null) return 1;
    if (b.score === null) return -1;
    return b.score - a.score;
  }).map((item, index) => Object.freeze({ ...item, position: index + 1 }));
  const eligible = ranking.filter(item => item.eligibility === "eligible");
  const first = eligible[0] ?? null;
  const tied = first !== null && eligible.filter(item => Math.abs(item.score - first.score) < 0.05).length > 1;
  const decision = !first ? "no_eligible_match" : tied ? "tie" : "matched";
  return Object.freeze({
    decision, winnerId: decision === "matched" ? first.id : null,
    summary: decision === "matched"
      ? "Se encontró una opción con mayor compatibilidad entre las candidatas evaluadas."
      : decision === "tie"
        ? "Hay un empate entre las opciones con mayor compatibilidad; no se fuerza un ganador."
        : "No hay una opción suficientemente respaldada por los datos y límites solicitados.",
    minimumMatchCoverage,
    evidenceMode: evidenceStore ? (allowReported ? "strict_with_reported_opt_in" : "strict") : "not_assessed",
    requestedPreferences: Object.freeze({
      preferredFamilies: Object.freeze(preferredFamilies), preferredNotes: Object.freeze(preferredNotes),
      avoidNotes: Object.freeze(avoidedNotes), preferredCharacters: Object.freeze(preferredCharacters),
      avoidCharacters: Object.freeze(avoidedCharacters), occasion, climate, intensity, projection,
      maxIntensity, maxProjection, maxSillage, productTypes: Object.freeze(productTypes),
    }),
    ranking: Object.freeze(ranking),
    limitations: Object.freeze([
      "Los datos faltantes no se consideran coincidencias.",
      "Una pirámide incompleta no demuestra la ausencia de una nota.",
      "Los límites de intensidad, proyección y estela son restricciones obligatorias; los valores desconocidos no los superan.",
      "La puntuación expresa ajuste a preferencias, no calidad universal ni rendimiento garantizado.",
      "Sin EvidenceStore, los atributos permanecen sin verificación independiente.",
    ]),
  });
}
