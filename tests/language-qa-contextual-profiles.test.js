import test from "node:test";
import assert from "node:assert/strict";
import {
  LINGUISTIC_CONTEXTS,
  inferTranslationContext,
  resolveLinguisticProfile,
  auditTranslationContextualProfiles,
  auditTranslationMaps
} from "../src/language/index.js";

test("context inference maps translation keys to deterministic UI contexts", () => {
  assert.equal(inferTranslationContext("button.save"), "button");
  assert.equal(inferTranslationContext("navigation.primary.home"), "navigation");
  assert.equal(inferTranslationContext("validation.email.required"), "validation");
  assert.equal(inferTranslationContext("errors.payment.failed"), "error");
  assert.equal(inferTranslationContext("legal.privacy.notice"), "legal");
  assert.equal(inferTranslationContext("checkout.payment.status"), "transactional");
  assert.equal(inferTranslationContext("profile.title"), "general");
  assert.ok(LINGUISTIC_CONTEXTS.includes("marketing"));
});

test("profiles distinguish Nicaraguan, Mexican, Latin-American and Iberian Spanish", () => {
  const nicaragua = resolveLinguisticProfile({
    targetLocale: "es-NI",
    context: "button",
    intendedRegister: "informal"
  });
  const mexico = resolveLinguisticProfile({
    targetLocale: "es-MX",
    context: "button",
    intendedRegister: "informal"
  });
  const latam = resolveLinguisticProfile({
    targetLocale: "es-419",
    context: "general",
    intendedRegister: "informal"
  });
  const spain = resolveLinguisticProfile({
    targetLocale: "es-ES",
    context: "general",
    intendedRegister: "informal"
  });

  assert.equal(nicaragua.preferredAddress, "voseo (vos)");
  assert.equal(mexico.preferredAddress, "tuteo (tú)");
  assert.match(latam.preferredAddress, /market-selected/);
  assert.equal(spain.preferredAddress, "tuteo (tú)");
  assert.notEqual(nicaragua.id, mexico.id);
});

test("legal and transactional contexts default to formal register", () => {
  assert.equal(resolveLinguisticProfile({
    targetLocale: "es-NI",
    context: "legal"
  }).intendedRegister, "formal");
  assert.equal(resolveLinguisticProfile({
    targetLocale: "en-GB",
    context: "transactional"
  }).intendedRegister, "formal");
  assert.equal(resolveLinguisticProfile({
    targetLocale: "es-NI",
    context: "help"
  }).intendedRegister, "neutral");
});

test("profiles reject unsupported locales, contexts and register values", () => {
  assert.throws(() => resolveLinguisticProfile({ targetLocale: "zh-CN" }), /supported target locale/);
  assert.throws(() => resolveLinguisticProfile({ targetLocale: "es-NI", context: "chat" }), /supported linguistic contexts/);
  assert.throws(() => resolveLinguisticProfile({ targetLocale: "es-NI", intendedRegister: "casual" }), /intendedRegister/);
});

test("contextual audit detects long labels and regional address-form review signals", () => {
  const findings = auditTranslationContextualProfiles({
    "navigation.primary": "Administración completa de las configuraciones principales de tu cuenta",
    "button.save": "Puedes guardar todos los cambios de configuración de tu cuenta"
  }, {
    targetLocale: "es-NI",
    contextMap: {
      "button.save": { context: "button", intendedRegister: "informal" }
    }
  });

  assert.ok(findings.some(item =>
    item.id === "context-copy-too-long" && item.key === "navigation.primary"
  ));
  assert.ok(findings.some(item =>
    item.id === "regional-address-form-review" &&
    item.key === "button.save" &&
    item.details.preferredAddress === "voseo (vos)"
  ));
  assert.ok(findings.every(item => item.severity === "low"));
  assert.ok(findings.every(item => item.confidence === "review-signal"));
});

test("explicit context profile applies formal-register review to legal copy", () => {
  const findings = auditTranslationContextualProfiles({
    "privacy.notice": "Read this carefully"
  }, {
    targetLocale: "en-US",
    contextMap: {
      "privacy.notice": { context: "legal", intendedRegister: "informal" }
    }
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, "context-register-review");
  assert.equal(findings[0].details.context, "legal");
});

test("contextual profile signals are included in translation map audit counts", () => {
  const audit = auditTranslationMaps(
    { "button.save": "Save" },
    { "button.save": "Guarda absolutamente todos los cambios de configuración disponibles de tu cuenta" },
    {
      sourceLocale: "en-US",
      targetLocale: "es-NI",
      contextMap: {
        "button.save": { context: "button", intendedRegister: "informal" }
      }
    }
  );
  assert.equal(audit.counts.contextualProfileSignals, 1);
  assert.ok(audit.findings.some(item => item.id === "context-copy-too-long"));
});

test("contextual audits reject symbol keys and accessors without executing getters", () => {
  const symbolMap = { title: "Hello" };
  symbolMap[Symbol("hidden")] = "unsafe";
  assert.throws(() => auditTranslationContextualProfiles(symbolMap), /symbol keys/);

  let invoked = false;
  const unsafeMap = {};
  Object.defineProperty(unsafeMap, "button.save", {
    enumerable: true,
    get() {
      invoked = true;
      return "Guardar";
    }
  });
  assert.throws(() => auditTranslationContextualProfiles(unsafeMap), /accessor properties/);
  assert.equal(invoked, false);

  const unsafeContextMap = {};
  Object.defineProperty(unsafeContextMap, "button.save", {
    enumerable: true,
    get() {
      invoked = true;
      return "button";
    }
  });
  assert.throws(() => auditTranslationContextualProfiles(
    { "button.save": "Guardar" },
    { contextMap: unsafeContextMap }
  ), /accessor properties/);
  assert.equal(invoked, false);
});


test("context map lookup does not inherit object prototype properties", () => {
  const findings = auditTranslationContextualProfiles({
    toString: "A simple label"
  }, {
    targetLocale: "en-US",
    contextMap: Object.create(null)
  });
  assert.deepEqual(findings, []);
});

test("contextual profile records reject prototype-sensitive keys", () => {
  const unsafeMap = JSON.parse('{"__proto__":"unexpected"}');
  assert.throws(() => auditTranslationContextualProfiles(unsafeMap), /prototype-sensitive key/);
});
