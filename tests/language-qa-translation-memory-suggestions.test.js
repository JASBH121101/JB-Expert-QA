import test from "node:test";
import assert from "node:assert/strict";
import { TranslationMemory } from "../src/language/translation-memory.js";

test("Translation Memory similar suggestions are locale/context scoped and review-only", () => {
  const memory = new TranslationMemory();
  memory.add({ source: "Save product changes", target: "Guardar cambios del producto", sourceLocale: "en-US", targetLocale: "es-419", context: "button" });
  memory.add({ source: "Save changes", target: "Guardar cambios", sourceLocale: "en-US", targetLocale: "es-419", context: "button" });
  memory.add({ source: "Save product changes", target: "Salvar alterações", sourceLocale: "en-US", targetLocale: "pt-BR", context: "button" });
  memory.add({ source: "Save product changes", target: "Guardar cambios", sourceLocale: "en-US", targetLocale: "es-419", context: "dialog" });

  const results = memory.suggestSimilar({
    source: "Save product changes now",
    sourceLocale: "en",
    targetLocale: "es",
    context: "button",
    threshold: 0.5
  });
  assert.equal(results.length, 2);
  assert.equal(results[0].entry.source, "Save product changes");
  assert.equal(results[0].similarity, 0.75);
  assert.equal(results[1].entry.source, "Save changes");
  assert.equal(results[1].similarity, 0.5);
  assert.ok(results.every((item) => item.requiresHumanReview && item.autoApproved === false));
  assert.ok(results.every((item) => item.entry.status === "pending"));
});

test("Translation Memory suggestions exclude exact matches, bound output and validate options", () => {
  const memory = new TranslationMemory();
  memory.add({ source: "Update profile", target: "Actualizar perfil", sourceLocale: "en", targetLocale: "es-419" });
  memory.add({ source: "Update account", target: "Actualizar cuenta", sourceLocale: "en", targetLocale: "es-419" });
  assert.deepEqual(memory.suggestSimilar({ source: "Update profile", sourceLocale: "en", targetLocale: "es-419" }), [
    {
      entry: memory.findExact({ source: "Update account", sourceLocale: "en", targetLocale: "es-419" }),
      similarity: 0.5,
      requiresHumanReview: true,
      autoApproved: false
    }
  ]);
  assert.deepEqual(memory.suggestSimilar({ source: "", sourceLocale: "en", targetLocale: "es" }), []);
  assert.throws(() => memory.suggestSimilar({ source: "Update", sourceLocale: "en", targetLocale: "es", threshold: 1.1 }), /threshold/);
  assert.throws(() => memory.suggestSimilar({ source: "Update", sourceLocale: "en", targetLocale: "es", limit: 0 }), /limit/);
});
