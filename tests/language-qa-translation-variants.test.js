import test from "node:test";
import assert from "node:assert/strict";
import {
  recordTranslationVariant,
  compareTranslationVariants,
  recordNativeAcceptanceFeedback
} from "../src/language/index.js";

const base = {
  source: "Save changes",
  sourceLocale: "en-US",
  targetLocale: "es-NI",
  context: "button",
  intendedRegister: "informal"
};

function candidate(id, text, extra = {}) {
  return recordTranslationVariant({ ...base, variantId: id, text, ...extra });
}

function reviews(text, ratings) {
  return ratings.map(rating => recordNativeAcceptanceFeedback({
    source: base.source,
    target: text,
    sourceLocale: base.sourceLocale,
    targetLocale: base.targetLocale,
    context: base.context,
    rating,
    reviewer: "native-reviewer"
  }));
}

test("variant records validate and bind source, locale, context and register", () => {
  const v = candidate("v1", "Guardá los cambios");
  assert.equal(v.targetLocale, "es-NI");
  assert.equal(v.context, "button");
  assert.equal(v.intendedRegister, "informal");
  assert.ok(v.createdAt);
  assert.ok(Object.isFrozen(v));
  assert.throws(() => candidate("", "texto"), /variantId/);
  assert.throws(() => candidate("v2", ""), /text/);
  assert.throws(() => candidate("v3", "texto", { intendedRegister: "casual" }), /intendedRegister/);
});

test("comparison requires at least two candidates and rejects scope mismatch or duplicate IDs", () => {
  const one = [candidate("v1", "Guardá los cambios")];
  assert.throws(() => compareTranslationVariants({ ...base, variants: one }), /between 2 and 50/);
  assert.throws(() => compareTranslationVariants({ ...base, variants: [
    one[0], recordTranslationVariant({ ...base, context: "general", variantId: "v2", text: "Guardar" })
  ] }), /does not match/);
  assert.throws(() => compareTranslationVariants({ ...base, variants: [
    one[0], candidate("v1", "Guardar")
  ] }), /unique/);
});

test("comparison reports terminology coverage and no false naturalness score without sufficient feedback", () => {
  const variants = [
    candidate("v1", "Guardá los cambios"),
    candidate("v2", "Guardá los cambios y continuá")
  ];
  const result = compareTranslationVariants({
    ...base,
    variants,
    requiredTerms: ["cambios", "continuá"]
  });
  assert.equal(result.status, "insufficient-human-feedback");
  assert.equal(result.autoApproved, false);
  assert.equal(result.recommendation, null);
  assert.equal(result.evaluations[0].comparativeScore, null);
  assert.equal(result.evaluations.find(v => v.variantId === "v2").terminology.coverage, 1);
  assert.ok(result.evaluations.every(v => v.advisory));
});

test("human acceptance feedback is scoped to exact variant and supports advisory comparative ranking", () => {
  const firstText = "Guardá los cambios";
  const secondText = "Guardá los cambios y continuá";
  const variants = [candidate("v1", firstText), candidate("v2", secondText)];
  const feedbackRecords = [
    ...reviews(firstText, [3, 3, 3, 3, 3]),
    ...reviews(secondText, [5, 5, 5, 5, 5])
  ];
  const result = compareTranslationVariants({
    ...base,
    variants,
    requiredTerms: ["cambios", "continuá"],
    feedbackRecords
  });
  assert.equal(result.status, "comparative-review-available");
  assert.equal(result.evaluations[0].variantId, "v2");
  assert.equal(result.evaluations[0].nativeAcceptance.count, 5);
  assert.equal(result.evaluations[1].nativeAcceptance.count, 5);
  assert.equal(result.autoApproved, false);
  assert.equal(result.autoRewritten, false);
  assert.equal(result.recommendation, null);
});

test("comparison rejects unsafe objects and invalid term lists", () => {
  const unsafe = candidate("v1", "Guardar");
  const unsafe2 = candidate("v2", "Guardá");
  const getter = {};
  Object.defineProperty(getter, "text", { enumerable: true, get() { throw new Error("getter invoked"); } });
  assert.throws(() => compareTranslationVariants({ ...base, variants: [unsafe, getter] }), /accessor/);
  assert.throws(() => compareTranslationVariants({ ...base, variants: [unsafe, unsafe2], requiredTerms: "not-array" }), /array/);
});
