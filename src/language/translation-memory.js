import { normalizeLocale } from "./locale.js";
import { stableTranslationHash } from "./audit.js";
import { resolveTranslationState } from "./review.js";

function snapshotPlainRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(label + " must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(label + " must be a plain object");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(label + " must not contain symbol keys");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const output = Object.create(null);
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable) continue;
    if (!Object.hasOwn(descriptor, "value")) {
      throw new TypeError(label + " must not contain accessor properties");
    }
    Object.defineProperty(output, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: false,
      writable: false
    });
  }
  return output;
}

function validateMemoryInput({ source, target, sourceLocale, targetLocale, context }) {
  if (typeof source !== "string" || !source.trim() ||
      typeof target !== "string" || !target.trim()) {
    throw new TypeError("Translation memory source and target must be non-empty strings");
  }
  const from = normalizeLocale(sourceLocale);
  const to = normalizeLocale(targetLocale);
  if (!from || !to || from === to) {
    throw new TypeError("Translation memory locales must be supported and different");
  }
  if (typeof context !== "string") {
    throw new TypeError("Translation memory context must be a string");
  }
  return { from, to, context };
}

/**
 * Produces content bindings for one Translation Memory entry. Locale and
 * context are included so an approval cannot be reused for a different
 * language pair or use case even when the visible strings are unchanged.
 */
export function fingerprintTranslationMemoryEntry({
  source,
  target,
  sourceLocale,
  targetLocale,
  context = ""
} = {}) {
  const normalized = validateMemoryInput({ source, target, sourceLocale, targetLocale, context });
  const shared = {
    context: normalized.context,
    sourceLocale: normalized.from,
    targetLocale: normalized.to
  };
  const sourceMap = Object.assign(Object.create(null), shared, { text: source });
  const targetMap = Object.assign(Object.create(null), shared, { text: target });
  return Object.freeze({
    sourceHash: stableTranslationHash(sourceMap),
    targetHash: stableTranslationHash(targetMap)
  });
}

export class TranslationMemory {
  #entries = new Map();

  add(input = {}) {
    const options = snapshotPlainRecord(input, "Translation memory entry");
    const source = options.source;
    const target = options.target;
    const sourceLocale = options.sourceLocale;
    const targetLocale = options.targetLocale;
    const context = options.context ?? "";
    const review = options.review ?? null;

    // Legacy reviewer/date flags were not linked to the actual content and
    // therefore must not create an approved memory entry.
    if (options.approved === true || options.reviewer !== undefined || options.reviewedAt !== undefined) {
      throw new TypeError("Translation memory approval requires a content-bound review record");
    }

    const normalized = validateMemoryInput({ source, target, sourceLocale, targetLocale, context });
    const { sourceHash, targetHash } = fingerprintTranslationMemoryEntry({
      source,
      target,
      sourceLocale: normalized.from,
      targetLocale: normalized.to,
      context: normalized.context
    });

    let status = "pending";
    let reviewer = null;
    let reviewedAt = null;
    if (review !== null) {
      const reviewSnapshot = snapshotPlainRecord(review, "Translation memory review");
      const resolved = resolveTranslationState({
        humanApproval: reviewSnapshot,
        sourceHash,
        targetHash
      });
      if (resolved !== "approved") {
        throw new TypeError("Translation memory review does not approve the exact source, target, locale pair and context");
      }
      status = "approved";
      reviewer = reviewSnapshot.reviewer;
      reviewedAt = reviewSnapshot.reviewedAt;
    }

    const entry = Object.freeze({
      source,
      target,
      sourceLocale: normalized.from,
      targetLocale: normalized.to,
      context: normalized.context,
      status,
      reviewer,
      reviewedAt,
      sourceHash,
      targetHash
    });
    this.#entries.set(this.#key(entry), entry);
    return entry;
  }

  findExact({ source, sourceLocale, targetLocale, context = "" } = {}) {
    if (typeof context !== "string") return null;
    const from = normalizeLocale(sourceLocale);
    const to = normalizeLocale(targetLocale);
    if (!from || !to) return null;
    return this.#entries.get(this.#key({
      source, sourceLocale: from, targetLocale: to, context
    })) ?? null;
  }

  markStale({ source, sourceLocale, targetLocale, context = "" } = {}) {
    if (typeof context !== "string") return false;
    const from = normalizeLocale(sourceLocale);
    const to = normalizeLocale(targetLocale);
    if (!from || !to) return false;
    const key = this.#key({ source, sourceLocale: from, targetLocale: to, context });
    const current = this.#entries.get(key);
    if (!current) return false;
    this.#entries.set(key, Object.freeze({ ...current, status: "stale" }));
    return true;
  }

  suggestSimilar({
    source,
    sourceLocale,
    targetLocale,
    context = "",
    threshold = 0.5,
    limit = 5
  } = {}) {
    if (typeof source !== "string" || !source.trim() || typeof context !== "string") return [];
    const from = normalizeLocale(sourceLocale);
    const to = normalizeLocale(targetLocale);
    if (!from || !to || from === to) return [];
    if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      throw new RangeError("Translation Memory similarity threshold must be between 0 and 1");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new RangeError("Translation Memory suggestion limit must be an integer from 1 to 50");
    }

    const tokenize = (value) => new Set(
      value.normalize("NFKC").toLocaleLowerCase("en").match(/[\\p{L}\\p{N}]+/gu) ?? []
    );
    const queryTokens = tokenize(source);
    if (queryTokens.size === 0) return [];
    const candidates = [];
    for (const entry of this.#entries.values()) {
      if (entry.sourceLocale !== from || entry.targetLocale !== to || entry.context !== context) continue;
      const candidateTokens = tokenize(entry.source);
      if (candidateTokens.size === 0) continue;
      let intersection = 0;
      for (const token of queryTokens) if (candidateTokens.has(token)) intersection += 1;
      const union = queryTokens.size + candidateTokens.size - intersection;
      const similarity = union ? intersection / union : 0;
      if (similarity >= threshold && similarity < 1) {
        candidates.push({
          entry,
          similarity: Number(similarity.toFixed(4)),
          requiresHumanReview: true,
          autoApproved: false
        });
      }
    }
    candidates.sort((left, right) => right.similarity - left.similarity ||
      left.entry.source.localeCompare(right.entry.source));
    return candidates.slice(0, limit);
  }

  list() {
    return [...this.#entries.values()];
  }

  #key(entry) {
    return JSON.stringify([entry.sourceLocale, entry.targetLocale, entry.context, entry.source]);
  }
}
