import test from "node:test";
import assert from "node:assert/strict";
import {
  recordNativeAcceptanceFeedback,
  summarizeNativeAcceptanceFeedback,
  auditNativeAcceptanceSignals,
  auditTranslationMaps
} from "../src/language/index.js";

test("native acceptance feedback binds ratings to exact translation, locale and context", () => {
  const review = recordNativeAcceptanceFeedback({
    source: "Save changes",
    target: "Guardar cambios",
    sourceLocale: "en-US",
    targetLocale: "es-NI",
    context: "button.save",
    rating: 5,
    reviewer: "native-reviewer-1"
  });
  assert.equal(review.targetLocale, "es-NI");
  assert.equal(review.accepted, true);
  assert.ok(review.sourceHash);
  assert.ok(review.targetHash);
  assert.throws(() => recordNativeAcceptanceFeedback({ source: "Save", target: "Guardar", sourceLocale: "en", targetLocale: "es", rating: 6 }), /rating/);
});

test("acceptance summary with low sample does not overstate quality", () => {
  assert.equal(summarizeNativeAcceptanceFeedback([]).status, "insufficient-feedback");
  const five = [5, 4, 4, 5, 4].map(rating => ({ rating }));
  const summary = summarizeNativeAcceptanceFeedback(five);
  assert.equal(summary.count, 5);
  assert.equal(summary.acceptanceRate, 100);
  assert.equal(summary.status, "high-acceptance");
  const low = summarizeNativeAcceptanceFeedback([1, 2, 2, 3, 2].map(rating => ({ rating })));
  assert.equal(low.status, "needs-revision");
});

test("native acceptance signals remain advisory and locale-aware", () => {
  const findings = auditNativeAcceptanceSignals({
    login: "Por favor loguearse en el sistema",
    punctuation: "Hola  , mundo"
  }, { targetLocale: "es-NI" });
  assert.ok(findings.some(item => item.id === "copy-acceptance-terminology"));
  assert.ok(findings.some(item => item.id === "copy-format-naturalness"));
  assert.ok(findings.every(item => item.severity === "low"));
  assert.throws(() => auditNativeAcceptanceSignals({ label: "Hello" }, { targetLocale: "zh-CN" }), /supported target locale/);
});

test("native acceptance signals are included in translation map audits", () => {
  const audit = auditTranslationMaps({ login: "Login" }, { login: "Por favor loguearse" }, { sourceLocale: "en-US", targetLocale: "es-NI" });
  assert.equal(audit.counts.nativeAcceptanceSignals, 1);
  assert.ok(audit.findings.some(item => item.id === "copy-acceptance-terminology"));
  assert.equal(audit.reviewStatus, "review-required");
});
