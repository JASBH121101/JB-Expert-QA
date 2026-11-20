import test from "node:test";
import assert from "node:assert/strict";
import {
  recordTranslationVariant, recordTranslationVariantAcceptanceFeedback, compareTranslationVariants
} from "../src/language/index.js";

const base = { source: "Save changes", sourceLocale: "en-US", targetLocale: "es-NI", context: "button", intendedRegister: "informal" };
function candidate(id, text, extra = {}) { return recordTranslationVariant({ ...base, variantId: id, text, ...extra }); }
function reviews(variantId, text, ratings) { return ratings.map(rating => recordTranslationVariantAcceptanceFeedback({ variantId, source:base.source, target:text, sourceLocale:base.sourceLocale, targetLocale:base.targetLocale, context:base.context, intendedRegister:base.intendedRegister, rating, reviewer:"native-reviewer" })); }
function dimensions(variantId, text, ratings) { return ratings.map((rating,index) => ({ variantId, source:base.source, target:text, sourceLocale:base.sourceLocale, targetLocale:base.targetLocale, context:base.context, intendedRegister:base.intendedRegister, reviewer:"human-reviewer-"+index, naturalness:rating, contextualAdequacy:rating, terminologyConsistency:rating })); }

test("variant records validate and bind source, locale, context and register", () => {
  const v = candidate("v1", "Guardá los cambios");
  assert.equal(v.targetLocale, "es-NI"); assert.equal(v.context, "button"); assert.equal(v.intendedRegister, "informal");
  assert.ok(v.createdAt); assert.ok(Object.isFrozen(v));
  assert.throws(() => candidate("", "texto"), /variantId/); assert.throws(() => candidate("v2", ""), /text/);
  assert.throws(() => candidate("v3", "texto", { intendedRegister:"casual" }), /intendedRegister/);
});

test("comparison requires two variants and rejects mismatched scope or duplicate IDs", () => {
  const one = [candidate("v1", "Guardá los cambios")];
  assert.throws(() => compareTranslationVariants({ ...base, variants:one }), /between 2 and 50/);
  assert.throws(() => compareTranslationVariants({ ...base, variants:[one[0], recordTranslationVariant({ ...base, context:"general", variantId:"v2", text:"Guardar" })] }), /does not match/);
  assert.throws(() => compareTranslationVariants({ ...base, variants:[one[0], candidate("v1", "Guardar")] }), /unique/);
});

test("terminology coverage is mechanical and scores stay withheld without sufficient human feedback", () => {
  const variants = [candidate("v1", "Guardá los cambios"), candidate("v2", "Guardá los cambios y continuá")];
  const result = compareTranslationVariants({ ...base, variants, requiredTerms:["cambios", "continuá"] });
  assert.equal(result.status, "insufficient-human-feedback"); assert.equal(result.autoApproved, false);
  assert.equal(result.recommendation, null); assert.equal(result.evaluations[0].comparativeScore, null);
  assert.equal(result.evaluations.find(v => v.variantId === "v2").terminology.coverage, 1);
  assert.ok(result.evaluations.every(v => v.advisory));
});

test("five native-acceptance and dimension reviews enable advisory ranking scoped per variant", () => {
  const a="Guardá los cambios", b="Guardá los cambios y continuá";
  const variants=[candidate("v1",a),candidate("v2",b)];
  const dimensionFeedback=[...dimensions("v1",a,[3,3,3,3,3]),...dimensions("v2",b,[5,5,5,5,5])];
  const feedbackRecords=[...reviews("v1",a,[3,3,3,3,3]),...reviews("v2",b,[5,5,5,5,5])];
  const result=compareTranslationVariants({ ...base, variants, requiredTerms:["cambios","continuá"], feedbackRecords, dimensionFeedback });
  assert.equal(result.status,"comparative-review-available"); assert.equal(result.evaluations[0].variantId,"v2");
  assert.equal(result.evaluations[0].nativeAcceptance.count,5); assert.equal(result.evaluations[1].nativeAcceptance.count,5);
  assert.equal(result.evaluations[0].humanDimensions.naturalness.count,5); assert.equal(result.evaluations[0].humanDimensions.contextualAdequacy.count,5);
  assert.equal(result.autoApproved,false); assert.equal(result.autoRewritten,false); assert.equal(result.recommendation,null);
});

test("dimension feedback requires valid scope, reviewer ratings and sample threshold", () => {
  const variants=[candidate("v1","Guardar"),candidate("v2","Guardá")];
  const result=compareTranslationVariants({ ...base, variants, dimensionFeedback:dimensions("v1","Guardar",[5,5,5,5,5]) });
  assert.equal(result.evaluations.find(v=>v.variantId==="v1").humanDimensions.naturalness.score,1);
  assert.equal(result.evaluations.find(v=>v.variantId==="v2").humanDimensions.naturalness.status,"insufficient-feedback");
  assert.throws(() => compareTranslationVariants({ ...base, variants, dimensionFeedback:[{variantId:"missing",source:base.source,target:"?",sourceLocale:base.sourceLocale,targetLocale:base.targetLocale,context:base.context,intendedRegister:base.intendedRegister,reviewer:"x",naturalness:5,contextualAdequacy:5,terminologyConsistency:5}] }),/unknown variantId/);
  assert.throws(() => compareTranslationVariants({ ...base, variants, dimensionFeedback:[{variantId:"v1",source:base.source,target:"Guardar",sourceLocale:base.sourceLocale,targetLocale:base.targetLocale,context:base.context,intendedRegister:base.intendedRegister,reviewer:"x",naturalness:6,contextualAdequacy:5,terminologyConsistency:5}] }),/integer from 1 to 5/);
  const duplicateReview = {variantId:"v1",source:base.source,target:"Guardar",sourceLocale:base.sourceLocale,targetLocale:base.targetLocale,context:base.context,intendedRegister:base.intendedRegister,reviewer:"same",naturalness:5,contextualAdequacy:5,terminologyConsistency:5};
  assert.throws(() => compareTranslationVariants({ ...base, variants, dimensionFeedback:[duplicateReview,{...duplicateReview}] }),/only one dimension review/);
});

test("native acceptance reviews reject duplicate reviewer votes and unsafe records", () => {
  const text="Guardá los cambios", variants=[candidate("v1",text),candidate("v2","Guardá y seguí")];
  const duplicate=reviews("v1",text,[5,5]);
  assert.throws(() => compareTranslationVariants({ ...base, variants, feedbackRecords:duplicate }),/only one Native Acceptance rating/);
  const unsafe={...duplicate[0]};
  Object.defineProperty(unsafe,"rating",{enumerable:true,get(){throw new Error("getter invoked");}});
  assert.throws(() => compareTranslationVariants({ ...base, variants, feedbackRecords:[unsafe] }),/accessor/);
});

test("comparison rejects accessor objects and invalid term lists", () => {
  const one=candidate("v1","Guardar"), two=candidate("v2","Guardá"), getter={};
  Object.defineProperty(getter,"text",{enumerable:true,get(){throw new Error("getter invoked");}});
  assert.throws(()=>compareTranslationVariants({ ...base, variants:[one,getter] }),/accessor/);
  assert.throws(()=>compareTranslationVariants({ ...base, variants:[one,two], requiredTerms:"not-array" }),/array/);
});
