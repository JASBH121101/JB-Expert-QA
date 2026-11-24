import test from "node:test";
import assert from "node:assert/strict";
import {
  recordNativeAcceptanceFeedback,
  summarizeNativeAcceptanceFeedback,
  auditNativeAcceptanceSignals,
  auditTranslationMaps
} from "../src/language/index.js";

const identity = {
  source: "Save changes",
  target: "Guardar cambios",
  sourceLocale: "en-US",
  targetLocale: "es-NI",
  context: "button.save"
};

function feedback(rating, overrides = {}) {
  return recordNativeAcceptanceFeedback({
    ...identity,
    rating,
    reviewer: "native-reviewer",
    ...overrides
  });
}

test("native acceptance feedback binds ratings to exact translation, locale and context", () => {
  const review = feedback(5);
  assert.equal(review.targetLocale, "es-NI");
  assert.equal(review.accepted, true);
  assert.ok(review.sourceHash);
  assert.ok(review.targetHash);
  assert.equal(Object.isFrozen(review), true);
  assert.throws(() => feedback(6), /rating/);
  assert.throws(() => recordNativeAcceptanceFeedback({
    source: "Save",
    target: "Guardar",
    sourceLocale: "en",
    targetLocale: "en",
    rating: 5
  }), /different locales/);
});

test("acceptance summary counts only matching content, locale and context fingerprints", () => {
  const matching = [5, 4, 4, 5, 4].map(rating => feedback(rating));
  const unrelated = [
    feedback(1, { target: "Guarda cambios" }),
    feedback(1, { context: "toast.saved" }),
    feedback(1, { targetLocale: "es-MX" }),
    feedback(1, { source: "Save" })
  ];
  const summary = summarizeNativeAcceptanceFeedback([...matching, ...unrelated], identity);
  assert.equal(summary.count, 5);
  assert.equal(summary.ignoredCount, 4);
  assert.equal(summary.acceptanceRate, 100);
  assert.equal(summary.status, "high-acceptance");
});

test("acceptance summary refuses unscoped non-empty feedback", () => {
  assert.throws(
    () => summarizeNativeAcceptanceFeedback([feedback(5)]),
    /identity is required/
  );
});

test("acceptance summary gates small samples and distinguishes mixed or low acceptance", () => {
  assert.equal(summarizeNativeAcceptanceFeedback([]).status, "insufficient-feedback");
  const small = summarizeNativeAcceptanceFeedback([feedback(5), feedback(4)], identity);
  assert.equal(small.count, 2);
  assert.equal(small.status, "insufficient-feedback");
  const mixed = summarizeNativeAcceptanceFeedback(
    [5, 4, 3, 3, 2].map(rating => feedback(rating)),
    identity
  );
  assert.equal(mixed.acceptanceRate, 40);
  assert.equal(mixed.status, "needs-revision");
  const balanced = summarizeNativeAcceptanceFeedback(
    [5, 4, 4, 3, 2].map(rating => feedback(rating)),
    identity
  );
  assert.equal(balanced.acceptanceRate, 60);
  assert.equal(balanced.status, "mixed-acceptance");
});

test("native acceptance signals remain advisory and locale-aware", () => {
  const findings = auditNativeAcceptanceSignals({
    login: "Por favor loguearse en el sistema",
    punctuation: "Hola  , mundo"
  }, { targetLocale: "es-NI" });
  assert.ok(findings.some(item => item.id === "copy-acceptance-terminology"));
  assert.ok(findings.some(item => item.id === "copy-format-naturalness"));
  assert.ok(findings.every(item => item.severity === "low"));
  assert.equal(Object.isFrozen(findings), true);
  assert.throws(
    () => auditNativeAcceptanceSignals({ label: "Hello" }, { targetLocale: "zh-CN" }),
    /supported target locale/
  );
});

test("native acceptance signals are included in translation map audits", () => {
  const audit = auditTranslationMaps(
    { login: "Login" },
    { login: "Por favor loguearse" },
    { sourceLocale: "en-US", targetLocale: "es-NI" }
  );
  assert.equal(audit.counts.nativeAcceptanceSignals, 1);
  assert.ok(audit.findings.some(item => item.id === "copy-acceptance-terminology"));
  assert.equal(audit.reviewStatus, "review-required");
});
