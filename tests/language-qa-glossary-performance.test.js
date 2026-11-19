import test from "node:test";
import assert from "node:assert/strict";
import { LanguageLibrary } from "../src/language/glossary.js";

test("curated glossary covers common ERP and administration terminology", () => {
  const library = new LanguageLibrary();
  const result = library.suggestTranslation("Update customer order in the warehouse", {
    sourceLocale: "en-US", targetLocale: "es-NI"
  });
  const ids = result.suggestions.map(item => item.termId);
  for (const id of ["update", "customer", "order", "warehouse"]) {
    assert.ok(ids.includes(id), "expected glossary term: " + id);
  }
  assert.equal(result.requiresHumanReview, true);
  assert.equal(result.autoApproved, false);
});

test("glossary matching uses Unicode-aware word boundaries and preserves regional pairing", () => {
  const library = new LanguageLibrary();
  const exact = library.suggestTranslation("Update the order", {
    sourceLocale: "en-GB", targetLocale: "es-MX"
  });
  assert.ok(exact.suggestions.some(item => item.termId === "order"));
  const falsePositive = library.suggestTranslation("Disorder is not an order", {
    sourceLocale: "en", targetLocale: "es-419"
  });
  assert.equal(falsePositive.suggestions.filter(item => item.termId === "order").length, 1);
});

test("compiled glossary is a stable snapshot and rejects malformed custom entries", () => {
  const terms = ["save"];
  const glossary = [{ id: "save", en: terms, es419: ["guardar"] }];
  const library = new LanguageLibrary({ glossary });
  terms[0] = "delete";
  assert.ok(library.suggestTranslation("save", { sourceLocale: "en", targetLocale: "es" })
    .suggestions.some(item => item.termId === "save"));
  assert.throws(() => new LanguageLibrary({ glossary: "invalid" }), /array/);
  assert.throws(() => new LanguageLibrary({ glossary: [{ id: "bad", en: [""], es419: [] }] }), /non-empty strings/);
});

test("glossary suggestion and consistency checks remain deterministic after cache warm-up", () => {
  const library = new LanguageLibrary();
  const options = { sourceLocale: "en-US", targetLocale: "es-NI" };
  const first = library.suggestTranslation("Save the invoice and apply a discount", options);
  const second = library.suggestTranslation("Save the invoice and apply a discount", options);
  assert.deepEqual(second, first);
  const findings = library.validateTermConsistency("Save invoice", "Guardar factura", options);
  assert.deepEqual(findings, []);
});
