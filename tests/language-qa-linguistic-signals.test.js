import test from "node:test";
import assert from "node:assert/strict";
import {
  auditTranslationLinguisticSignals,
  auditTranslationRegionalStyle,
  auditTranslationMaps
} from "../src/language/index.js";
import { languageRules } from "../src/specialists/language/index.js";

test("linguistic review signals flag duplicated common words, unfinished markers and mojibake", () => {
  const findings = auditTranslationLinguisticSignals({
    greeting: "de de configuración",
    pending: "TODO: translate this",
    corrupted: "ConfiguraciÃ³n inválida"
  }, { targetLocale: "es-NI" });
  assert.deepEqual(findings.map(item => item.id), [
    "repeated-function-word", "untranslated-marker", "mojibake"
  ]);
  assert.ok(findings.every(item => item.confidence === "review-signal" || item.confidence === "mechanical-signal"));
  assert.equal(findings[0].details.word, "de");
});

test("linguistic signals use target-locale function-word lists and avoid non-function repetition", () => {
  const english = auditTranslationLinguisticSignals({
    repeated: "the the settings are ready",
    emphasis: "very very good"
  }, { targetLocale: "en-GB" });
  assert.equal(english.length, 1);
  assert.equal(english[0].key, "repeated");
  const french = auditTranslationLinguisticSignals({
    repeated: "de de paramètres",
    other: "très très bien"
  }, { targetLocale: "fr-FR" });
  assert.equal(french.length, 1);
  assert.equal(french[0].id, "repeated-function-word");
});

test("Language QA map audit includes linguistic signals but never turns them into automatic approval", () => {
  const audit = auditTranslationMaps(
    { title: "Settings", label: "Save" },
    { title: "de de configuración", label: "Guardar" },
    { sourceLocale: "en-US", targetLocale: "es-419" }
  );
  assert.equal(audit.counts.linguisticSignals, 1);
  assert.equal(audit.reviewStatus, "review-required");
  assert.ok(audit.findings.some(item => item.id === "repeated-function-word"));
  const diagnostics = languageRules[0].evaluate({ languageAudit: {
    status: "checked",
    sourceLocale: "en-US",
    targetLocale: "es-419",
    findings: audit.findings
  } });
  assert.ok(diagnostics.some(item => item.title === "Repeated function word may be a typo" && item.severity === "low"));
});

test("linguistic auditor rejects unsupported locales, symbols and accessor-backed maps", () => {
  assert.throws(() => auditTranslationLinguisticSignals({ title: "Hello" }, { targetLocale: "zh-CN" }), /supported target locale/);
  const symbolMap = { title: "safe" };
  symbolMap[Symbol("hidden")] = "unsafe";
  assert.throws(() => auditTranslationLinguisticSignals(symbolMap), /symbol keys/);
  let invoked = false;
  const accessorMap = {};
  Object.defineProperty(accessorMap, "message", {
    enumerable: true,
    get() { invoked = true; return "TODO"; }
  });
  assert.throws(() => auditTranslationLinguisticSignals(accessorMap), /accessor properties/);
  assert.equal(invoked, false);
});


test("Arabic repeated function words are recognized with Unicode-aware matching", () => {
  const findings = auditTranslationLinguisticSignals({
    message: "في في السوق"
  }, { targetLocale: "ar" });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].details.word, "في");
});


test("regional style signals compare English US/UK spelling without automatic correction", () => {
  const us = auditTranslationRegionalStyle({
    first: "Check the colour at the centre and organise the list"
  }, { targetLocale: "en-US" });
  assert.deepEqual(us.map(item => item.details.term), ["colour", "centre", "organise"]);
  assert.ok(us.every(item => item.id === "regional-style-variant" && item.severity === "low"));
  assert.ok(us.every(item => item.confidence === "review-signal"));
  assert.equal(us[0].details.suggestedAlternative, "color");

  const gb = auditTranslationRegionalStyle({
    first: "Check the color at the center and organize the list"
  }, { targetLocale: "en-GB" });
  assert.deepEqual(gb.map(item => item.details.term), ["color", "center", "organize"]);
  assert.deepEqual(auditTranslationRegionalStyle({ first: "Color and center" }, { targetLocale: "en-US" }), []);
});

test("regional style signals distinguish Latin-American, Mexican and Iberian Spanish", () => {
  const latam = auditTranslationRegionalStyle({
    first: "El ordenador y el móvil que vosotros utilizáis"
  }, { targetLocale: "es-NI" });
  assert.deepEqual(latam.map(item => item.details.term), ["ordenador", "móvil", "vosotros"]);

  const mexico = auditTranslationRegionalStyle({
    first: "El ordenador y el móvil que vosotros utilizáis"
  }, { targetLocale: "es-MX" });
  assert.equal(mexico.length, 3);

  const spain = auditTranslationRegionalStyle({
    first: "La computadora y el celular para platicar"
  }, { targetLocale: "es-ES" });
  assert.deepEqual(spain.map(item => item.details.term), ["computadora", "celular", "platicar"]);
});

test("regional style signals are included in Language QA counts and safely inspect maps", () => {
  const audit = auditTranslationMaps(
    { title: "Computer and phone" },
    { title: "El ordenador y el móvil" },
    { sourceLocale: "en-US", targetLocale: "es-NI" }
  );
  assert.equal(audit.counts.regionalStyleSignals, 2);
  assert.ok(audit.findings.some(item => item.id === "regional-style-variant"));

  let invoked = false;
  const unsafe = {};
  Object.defineProperty(unsafe, "title", {
    enumerable: true,
    get() { invoked = true; return "ordenador"; }
  });
  assert.throws(() => auditTranslationRegionalStyle(unsafe, { targetLocale: "es-NI" }), /accessor properties/);
  assert.equal(invoked, false);
  assert.throws(() => auditTranslationRegionalStyle({ title: "color" }, { targetLocale: "zh-CN" }), /supported target locale/);
});
