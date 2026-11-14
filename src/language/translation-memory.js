import { normalizeLocale } from "./locale.js";

export class TranslationMemory {
  #entries = new Map();

  add({ source, target, sourceLocale, targetLocale, context = "", approved = false, reviewer = null, reviewedAt = null }) {
    if (typeof source !== "string" || !source.trim() || typeof target !== "string" || !target.trim()) {
      throw new TypeError("Translation memory source and target must be non-empty strings");
    }
    const from = normalizeLocale(sourceLocale);
    const to = normalizeLocale(targetLocale);
    if (!from || !to || from === to) throw new TypeError("Translation memory locales must be supported and different");
    if (approved && (!String(reviewer ?? "").trim() || !reviewedAt)) {
      throw new TypeError("An approved memory entry requires reviewer and reviewedAt metadata");
    }
    const entry = Object.freeze({
      source, target, sourceLocale: from, targetLocale: to, context: String(context),
      status: approved ? "approved" : "pending",
      reviewer: approved ? String(reviewer) : null,
      reviewedAt: approved ? String(reviewedAt) : null
    });
    this.#entries.set(this.#key(entry), entry);
    return entry;
  }

  findExact({ source, sourceLocale, targetLocale, context = "" }) {
    const from = normalizeLocale(sourceLocale);
    const to = normalizeLocale(targetLocale);
    if (!from || !to) return null;
    return this.#entries.get(this.#key({ source, sourceLocale: from, targetLocale: to, context: String(context) })) ?? null;
  }

  markStale({ source, sourceLocale, targetLocale, context = "" }) {
    const from = normalizeLocale(sourceLocale);
    const to = normalizeLocale(targetLocale);
    if (!from || !to) return false;
    const key = this.#key({ source, sourceLocale: from, targetLocale: to, context: String(context) });
    const current = this.#entries.get(key);
    if (!current) return false;
    this.#entries.set(key, Object.freeze({ ...current, status: "stale" }));
    return true;
  }

  list() {
    return [...this.#entries.values()];
  }

  #key(entry) {
    return JSON.stringify([entry.sourceLocale, entry.targetLocale, entry.context, entry.source]);
  }
}
