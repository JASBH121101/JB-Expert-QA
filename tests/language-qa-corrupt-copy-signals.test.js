import test from "node:test";
import assert from "node:assert/strict";
import { auditTranslationSemantics, auditTranslationMaps } from "../src/language/index.js";

test("semantic QA flags replacement characters only when newly introduced in target text", () => {
  const findings = auditTranslationSemantics(
    { clean: "Guardar cambios", already: "Replacement character: �" },
    { clean: "Guardar cambios", already: "Replacement character: �", damaged: "Guard�ar cambios" },
    { sourceLocale: "es-419", targetLocale: "en-US" }
  );
  assert.equal(findings.filter(item => item.id === "corrupted-replacement-character").length, 1);
  assert.equal(findings[0].key, "damaged");
  assert.equal(findings[0].severity, "high");
});

test("semantic QA detects newly introduced control characters without treating whitespace as corruption", () => {
  const findings = auditTranslationSemantics(
    { clean: "Save\tchanges", damaged: "Guardar" },
    { clean: "Guardar\tcambios", damaged: "Guar\u0007dar" },
    { sourceLocale: "en-US", targetLocale: "es-419" }
  );
  assert.ok(findings.some(item => item.id === "corrupted-control-character" && item.key === "damaged"));
  assert.equal(findings.some(item => item.key === "clean" && item.id === "corrupted-control-character"), false);
});

test("semantic QA flags common mojibake patterns but not ordinary accented text or emoji", () => {
  const findings = auditTranslationSemantics(
    { normal: "Configuración y año nuevo 😀", damaged: "Description" },
    { normal: "Configuración y año nuevo 😀", damaged: "ConfiguraciÃ³n" },
    { sourceLocale: "en-US", targetLocale: "es-419" }
  );
  assert.deepEqual(findings.map(item => item.id), ["suspicious-encoding-sequence"]);
  assert.equal(findings[0].confidence, "heuristic-signal");
});

test("translation-map results count corruption findings and keep review status non-approved", () => {
  const result = auditTranslationMaps(
    { title: "Settings" },
    { title: "ConfiguraciÃ³n" },
    { sourceLocale: "en-US", targetLocale: "es-419" }
  );
  assert.equal(result.counts.corruptedText, 1);
  assert.equal(result.reviewStatus, "review-required");
});
