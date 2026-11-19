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


test("glossary snapshots reject accessor-backed entries and term arrays without invoking getters", () => {
  let entryInvoked = false;
  const accessorEntry = { es419: ["guardar"] };
  Object.defineProperty(accessorEntry, "en", {
    enumerable: true,
    get() { entryInvoked = true; return ["save"]; }
  });
  assert.throws(() => new LanguageLibrary({ glossary: [{ id: "safe", en: ["save"], es419: ["guardar"] }, accessorEntry] }),
    /data-property id|accessor properties/);
  assert.equal(entryInvoked, false);

  let termInvoked = false;
  const accessorTerms = [];
  Object.defineProperty(accessorTerms, "0", {
    enumerable: true,
    configurable: true,
    get() { termInvoked = true; return "save"; }
  });
  accessorTerms.length = 1;
  assert.throws(() => new LanguageLibrary({ glossary: [{ id: "safe", en: accessorTerms, es419: ["guardar"] }] }),
    /holes or accessor properties/);
  assert.equal(termInvoked, false);
});

test("glossary locale matching is independent of host default locale and ids are unique", () => {
  assert.throws(() => new LanguageLibrary({ glossary: [
    { id: "duplicate", en: ["save"], es419: ["guardar"] },
    { id: "duplicate", en: ["update"], es419: ["actualizar"] }
  ] }), /ids must be unique/);
  const library = new LanguageLibrary();
  assert.ok(library.suggestTranslation("UPDATE customer order", {
    sourceLocale: "en-US", targetLocale: "es-NI"
  }).suggestions.some(item => item.termId === "update"));
});


test("glossary snapshots reject accessor-backed glossary arrays without invoking getters", () => {
  let invoked = false;
  const entries = [];
  Object.defineProperty(entries, "0", {
    enumerable: true,
    configurable: true,
    get() {
      invoked = true;
      return { id: "unsafe", en: ["save"], es419: ["guardar"] };
    }
  });
  entries.length = 1;
  assert.throws(() => new LanguageLibrary({ glossary: entries }), /holes or accessor properties/);
  assert.equal(invoked, false);
});
