import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_LOCALE, SUPPORTED_LOCALES, normalizeLocale, resolveLocale,
  comparePlaceholders, parsePhpTranslationArray, LanguageLibrary,
  TranslationMemory, recordTranslationReview, resolveTranslationState,
  auditTranslationMaps, flattenTranslationMap, auditTranslationSemantics, stableTranslationHash,
  fingerprintTranslationMemoryEntry
} from "../src/language/index.js";
import { auditLanguageFiles } from "../src/adapters/filesystem/audit-language.js";
import { languageRules } from "../src/specialists/language/index.js";

test("normalizes aliases to the 12 locales supported by Localization Engine", () => {
  assert.equal(DEFAULT_LOCALE, "es-419");
  assert.deepEqual(SUPPORTED_LOCALES, [
    "es-NI", "es-419", "es-MX", "es-ES",
    "en-US", "en-GB", "pt-BR", "pt-PT",
    "fr-FR", "de-DE", "it-IT", "ar"
  ]);
  assert.equal(normalizeLocale("es"), "es-419");
  assert.equal(normalizeLocale("es_NI"), "es-NI");
  assert.equal(normalizeLocale("es_MX"), "es-MX");
  assert.equal(normalizeLocale("es-CO"), "es-419");
  assert.equal(normalizeLocale("es-ES"), "es-ES");
  assert.equal(normalizeLocale("en"), "en-US");
  assert.equal(normalizeLocale("en-GB"), "en-GB");
  assert.equal(normalizeLocale("pt"), "pt-BR");
  assert.equal(normalizeLocale("fr"), "fr-FR");
  assert.equal(normalizeLocale("de-DE"), "de-DE");
  assert.equal(normalizeLocale("it"), "it-IT");
  assert.equal(normalizeLocale("ar"), "ar");
  assert.equal(normalizeLocale("fr-CA"), "fr-FR");
  assert.equal(normalizeLocale("zh-CN"), null);
  assert.equal(resolveLocale("zh-CN"), "es-419");
});

test("compares named, brace and positional placeholders without losing duplicates", () => {
  assert.equal(comparePlaceholders("Hello :name {count}", "Hola :name {count}").matches, true);
  const mismatch = comparePlaceholders(":name :name %2$s", ":name %s");
  assert.equal(mismatch.matches, false);
  assert.deepEqual(mismatch.missing, ["%2$s", ":name"]);
  assert.deepEqual(mismatch.unexpected, ["%s"]);
});

test("parses static nested Laravel translation arrays without executing PHP", () => {
  const parsed = parsePhpTranslationArray(`<?php
return [
  'heading' => 'Hello :name',
  'nested' => [
    'count' => 'There are :count items',
  ],
];
`);
  assert.equal(parsed.heading, "Hello :name");
  assert.equal(parsed.nested.count, "There are :count items");
  assert.throws(() => parsePhpTranslationArray("<?php return include 'evil.php';"), /Only literal strings/);
  assert.throws(() => parsePhpTranslationArray('<?php return ["x" => $secret];'), /Only literal strings/);
});

test("glossary suggestions are deterministic, provider-free and never auto-approved", () => {
  const library = new LanguageLibrary();
  const suggestion = library.suggestTranslation("Update the product price", { sourceLocale: "en", targetLocale: "es-419" });
  assert.ok(suggestion.suggestions.some((item) => item.termId === "product"));
  assert.ok(suggestion.suggestions.some((item) => item.termId === "price"));
  assert.equal(suggestion.requiresHumanReview, true);
  assert.equal(suggestion.autoApproved, false);
  assert.equal(suggestion.providerUsed, null);
});

test("Translation Memory pending and approved entries carry exact content fingerprints", () => {
  const memory = new TranslationMemory();
  const pendingInput = {
    source: "Sign in",
    target: "Iniciar sesión",
    sourceLocale: "en",
    targetLocale: "es"
  };
  const pending = memory.add(pendingInput);
  assert.equal(pending.status, "pending");
  assert.match(pending.sourceHash, /^[a-f0-9]{64}$/u);
  assert.match(pending.targetHash, /^[a-f0-9]{64}$/u);
  assert.equal(memory.findExact({ source: "Sign in", sourceLocale: "en", targetLocale: "es" }).status, "pending");

  assert.throws(() => memory.add({
    source: "Save", target: "Guardar", sourceLocale: "en", targetLocale: "es", approved: true
  }), /content-bound review record/);
  assert.throws(() => memory.add({
    source: "Save", target: "Guardar", sourceLocale: "en", targetLocale: "es",
    reviewer: "human-reviewer", reviewedAt: "2026-11-14T10:00:00Z"
  }), /content-bound review record/);

  const reviewedInput = {
    source: "Save",
    target: "Guardar",
    sourceLocale: "en",
    targetLocale: "es",
    context: "button.label"
  };
  const fingerprints = fingerprintTranslationMemoryEntry(reviewedInput);
  const review = recordTranslationReview({
    state: "approved",
    reviewer: "human-reviewer",
    reviewedAt: "2026-11-14T10:00:00Z",
    ...fingerprints
  });
  const approved = memory.add({ ...reviewedInput, review });
  assert.equal(approved.status, "approved");
  assert.equal(approved.reviewer, "human-reviewer");
  assert.equal(approved.sourceHash, fingerprints.sourceHash);
  assert.equal(approved.targetHash, fingerprints.targetHash);

  assert.equal(memory.markStale({ source: "Sign in", sourceLocale: "en", targetLocale: "es" }), true);
  assert.equal(memory.findExact({ source: "Sign in", sourceLocale: "en", targetLocale: "es" }).status, "stale");
});

test("Translation Memory rejects stale or context-mismatched approvals", () => {
  const input = {
    source: "Delete account",
    target: "Eliminar cuenta",
    sourceLocale: "en",
    targetLocale: "es-419",
    context: "destructive.confirmation"
  };
  const hashes = fingerprintTranslationMemoryEntry(input);
  const review = recordTranslationReview({
    state: "approved",
    reviewer: "human-reviewer",
    reviewedAt: "2026-11-19T02:50:00Z",
    ...hashes
  });
  const memory = new TranslationMemory();
  assert.throws(() => memory.add({
    ...input,
    target: "Eliminar perfil",
    review
  }), /does not approve the exact source/);
  assert.throws(() => memory.add({
    ...input,
    context: "neutral.label",
    review
  }), /does not approve the exact source/);
});

test("Translation Memory rejects accessor-backed entries and review records without executing getters", () => {
  const memory = new TranslationMemory();
  let inputGetterCalled = false;
  const unsafeInput = {
    source: "Save",
    target: "Guardar",
    sourceLocale: "en",
    targetLocale: "es"
  };
  Object.defineProperty(unsafeInput, "context", {
    enumerable: true,
    get() {
      inputGetterCalled = true;
      return "unsafe";
    }
  });
  assert.throws(() => memory.add(unsafeInput), /accessor properties/);
  assert.equal(inputGetterCalled, false);

  const valid = {
    source: "Save",
    target: "Guardar",
    sourceLocale: "en",
    targetLocale: "es"
  };
  const hashes = fingerprintTranslationMemoryEntry(valid);
  let reviewGetterCalled = false;
  const unsafeReview = {
    reviewer: "human-reviewer",
    reviewedAt: "2026-11-19T02:50:00Z",
    sourceHash: hashes.sourceHash,
    targetHash: hashes.targetHash
  };
  Object.defineProperty(unsafeReview, "state", {
    enumerable: true,
    get() {
      reviewGetterCalled = true;
      return "approved";
    }
  });
  assert.throws(() => memory.add({ ...valid, review: unsafeReview }), /accessor properties/);
  assert.equal(reviewGetterCalled, false);
});

test("approval state requires a named reviewer and exact source/target fingerprints", () => {
  const sourceHash = "a".repeat(64);
  const targetHash = "b".repeat(64);
  assert.throws(() => recordTranslationReview({ state: "approved", reviewer: " " }), /reviewer identity/);
  assert.throws(() => recordTranslationReview({
    state: "approved", reviewer: "Steven", reviewedAt: "2026-11-14T10:00:00Z"
  }), /sourceHash\/targetHash/);
  assert.equal(resolveTranslationState({}), "review-required");
  assert.equal(resolveTranslationState({ missingKeys: 1 }), "partial");

  const approval = recordTranslationReview({
    state: "approved",
    reviewer: "Steven",
    reviewedAt: "2026-11-14T10:00:00Z",
    sourceHash,
    targetHash
  });
  assert.equal(resolveTranslationState({ humanApproval: approval }), "review-required");
  assert.equal(resolveTranslationState({ humanApproval: approval, sourceHash, targetHash }), "approved");
  assert.equal(resolveTranslationState({
    missingKeys: 1, humanApproval: approval, sourceHash, targetHash
  }), "partial");
  assert.equal(resolveTranslationState({
    placeholderMismatches: 1, humanApproval: approval, sourceHash, targetHash
  }), "review-required");
  assert.equal(resolveTranslationState({
    humanApproval: approval,
    sourceHash,
    targetHash: "c".repeat(64)
  }), "review-required");

  let getterCalled = false;
  const unsafeApproval = {};
  Object.defineProperty(unsafeApproval, "state", {
    enumerable: true,
    get() {
      getterCalled = true;
      return "approved";
    }
  });
  assert.equal(resolveTranslationState({
    humanApproval: unsafeApproval,
    sourceHash,
    targetHash
  }), "review-required");
  assert.equal(getterCalled, false);
});

test("translation maps identify missing, obsolete and placeholder-mismatched keys", () => {
  const result = auditTranslationMaps(
    { setup: { greeting: "Hello :name", count: "Total :count" }, old: "Old" },
    { setup: { greeting: "Hola :name", count: "Total" }, obsolete: "Antiguo" },
    { sourceLocale: "en", targetLocale: "es-419" }
  );
  assert.equal(result.counts.missingKeys, 1);
  assert.equal(result.counts.obsoleteKeys, 1);
  assert.equal(result.counts.placeholderMismatches, 1);
  assert.equal(result.reviewStatus, "stale");
});

test("filesystem auditor compares legacy es and en PHP resources and exposes findings to the specialist", async () => {
  const root = await mkdtemp(join(tmpdir(), "jb-language-qa-"));
  try {
    await mkdir(join(root, "lang", "es"), { recursive: true });
    await mkdir(join(root, "lang", "en"), { recursive: true });
    await writeFile(join(root, "lang", "es", "messages.php"), `<?php
return [
  'greeting' => 'Hola :name',
  'count' => 'Total :count',
  'missing' => 'Descripción',
];
`);
    await writeFile(join(root, "lang", "en", "messages.php"), `<?php
return [
  'greeting' => 'Hello :name',
  'count' => 'Total',
  'obsolete' => 'Old message',
];
`);
    const result = await auditLanguageFiles(root);
    assert.equal(result.status, "checked");
    assert.equal(result.sourceLocale, "es-419");
    assert.ok(result.findings.some((item) => item.id === "missing-key" && item.key === "missing"));
    assert.ok(result.findings.some((item) => item.id === "placeholder-mismatch" && item.key === "count"));
    assert.ok(result.findings.some((item) => item.id === "obsolete-key" && item.key === "obsolete"));
    const diagnostics = languageRules[0].evaluate({ languageAudit: result });
    assert.ok(diagnostics.length >= 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem auditor skips safely when no locale folders exist", async () => {
  const root = await mkdtemp(join(tmpdir(), "jb-language-empty-"));
  try {
    const result = await auditLanguageFiles(root);
    assert.equal(result.status, "skipped");
    assert.equal(result.findings.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsafe or dynamic PHP translation resources become parse findings instead of being executed", async () => {
  const root = await mkdtemp(join(tmpdir(), "jb-language-unsafe-"));
  try {
    await mkdir(join(root, "lang", "es"), { recursive: true });
    await mkdir(join(root, "lang", "en"), { recursive: true });
    await writeFile(join(root, "lang", "es", "unsafe.php"), "<?php return include 'runtime.php';");
    await writeFile(join(root, "lang", "en", "unsafe.php"), "<?php return ['x' => 'x'];");
    const result = await auditLanguageFiles(root);
    assert.equal(result.parseErrors.length, 1);
    assert.equal(result.parseErrors[0].id, "resource-parse-error");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("locale normalization preserves approved variants and rejects unsupported or malformed tags", () => {
  assert.equal(normalizeLocale("es-NI"), "es-NI");
  assert.equal(normalizeLocale("es-MX"), "es-MX");
  assert.equal(normalizeLocale("es_419"), "es-419");
  assert.equal(normalizeLocale("es-ES"), "es-ES");
  assert.equal(normalizeLocale("es-XY"), null);
  assert.equal(normalizeLocale("es-MX-u-ca-gregory"), null);
  assert.equal(normalizeLocale("en-US"), "en-US");
  assert.equal(normalizeLocale("en-GB"), "en-GB");
  assert.equal(normalizeLocale("en-not-a-region"), null);
  assert.equal(normalizeLocale("en-US-u-ca-gregory"), null);
});

test("translation audit distinguishes nested message shape changes from missing keys", () => {
  const result = auditTranslationMaps(
    { setup: { heading: "Welcome", actions: { save: "Save" } } },
    { setup: "Bienvenido" },
    { sourceLocale: "en", targetLocale: "es-419" }
  );
  assert.equal(result.counts.messageShapeMismatches, 1);
  assert.equal(result.counts.missingKeys, 0);
  assert.equal(result.counts.obsoleteKeys, 0);
  assert.equal(result.reviewStatus, "review-required");
  assert.ok(result.findings.some((item) => item.id === "message-shape-mismatch" && item.key === "setup"));
});


test("translation flattening rejects prototype-sensitive keys without mutating prototypes", () => {
  const malicious = JSON.parse('{"__proto__":{"polluted":"yes"}}');
  assert.throws(() => flattenTranslationMap(malicious), /prototype-sensitive key/);
  assert.equal({}.polluted, undefined);

  const flattened = flattenTranslationMap({ setup: { title: "Welcome" } });
  assert.equal(Object.getPrototypeOf(flattened), null);
  assert.equal(flattened["setup.title"], "Welcome");
  assert.throws(() => flattenTranslationMap({ constructor: "unsafe" }), /prototype-sensitive key/);
});

test("translation flattening rejects accessors without executing them", () => {
  let invoked = false;
  const malicious = {};
  Object.defineProperty(malicious, "title", {
    enumerable: true,
    get() {
      invoked = true;
      return "unexpected";
    }
  });

  assert.throws(() => flattenTranslationMap(malicious), /accessor properties/);
  assert.equal(invoked, false);
});

test("translation flattening safely handles caller output and rejects Object.prototype", () => {
  const output = {};
  assert.equal(flattenTranslationMap({ title: "Safe" }, "", output), output);
  assert.equal(output.title, "Safe");
  assert.throws(
    () => flattenTranslationMap({ polluted: "no" }, "", Object.prototype),
    /plain record/
  );
  assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
});

test("translation flattening bounds recursion and rejects ambiguous duplicate paths", () => {
  assert.throws(
    () => flattenTranslationMap({ a: { b: "nested" }, "a.b": "flat" }),
    /duplicate flattened key/
  );
  let deep = { value: "end" };
  for (let index = 0; index < 26; index += 1) deep = { child: deep };
  assert.throws(() => flattenTranslationMap(deep), /maximum nesting depth/);
});


test("semantic audit flags unchanged copy and respects explicit untranslated-key allowlists", () => {
  const findings = auditTranslationSemantics(
    { "settings.title": "Settings", "brand.name": "JB Collections" },
    { "settings.title": "Settings", "brand.name": "JB Collections" },
    {
      sourceLocale: "en",
      targetLocale: "es-419",
      allowUntranslatedKeys: ["brand.name"]
    }
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, "unchanged-source-text");
  assert.equal(findings[0].key, "settings.title");
  assert.equal(findings[0].severity, "low");
});

test("semantic audit preserves URL, email, markup and numeric literals", () => {
  const findings = auditTranslationSemantics(
    {
      link: "Read https://example.test/terms",
      contact: "Email support@example.test",
      markup: "<strong>Save</strong>",
      quantity: "There are 12 items"
    },
    {
      link: "Leer https://example.test/conditions",
      contact: "Correo help@example.test",
      markup: "<b>Guardar</b>",
      quantity: "Hay 13 artículos"
    },
    { sourceLocale: "en", targetLocale: "es-419" }
  );
  const ids = findings.map((item) => item.id);
  assert.ok(ids.includes("protected-url-mismatch"));
  assert.ok(ids.includes("protected-email-mismatch"));
  assert.ok(ids.includes("protected-markup-mismatch"));
  assert.ok(ids.includes("protected-number-mismatch"));
  assert.ok(findings.every((item) => item.confidence === "mechanical-signal"));
});

test("semantic audit rejects accessor properties without executing them", () => {
  let invoked = false;
  const source = {};
  Object.defineProperty(source, "message", {
    enumerable: true,
    get() {
      invoked = true;
      return "Settings";
    }
  });
  assert.throws(
    () => auditTranslationSemantics(source, { message: "Ajustes" }, { sourceLocale: "en", targetLocale: "es-419" }),
    /accessor properties/
  );
  assert.equal(invoked, false);
});

test("translation map audit surfaces semantic signals to the Language QA specialist without auto-approval", () => {
  const result = auditTranslationMaps(
    { title: "Settings", link: "Read https://example.test/help" },
    { title: "Settings", link: "Abrir https://example.test/ayuda" },
    { sourceLocale: "en", targetLocale: "es-419" }
  );
  assert.equal(result.counts.unchangedSourceText, 1);
  assert.equal(result.counts.protectedTokenMismatches, 1);
  assert.equal(result.reviewStatus, "review-required");
  const diagnostics = languageRules[0].evaluate({ languageAudit: {
    status: "checked",
    sourceLocale: "en",
    targetLocale: "es-419",
    findings: result.findings
  } });
  assert.ok(diagnostics.some((item) => item.title === "Source text may be untranslated"));
  assert.ok(diagnostics.some((item) => item.title === "Translation link differs from source"));
});

import { auditTranslationCatalogs } from "../src/language/index.js";

test("Language QA delegates CLDR plural categories and placeholder parity to the localization engine", () => {
  const result = auditTranslationCatalogs({
    "es-419": {
      items: { one: "{count} artículo", other: "{count} artículos" }
    },
    en: {
      items: { other: "{count} items" }
    }
  }, { sourceLocale: "es-419", requiredLocales: ["en"] });

  assert.equal(result.engine, "jb-localization-engine");
  assert.equal(result.status, "review-required");
  assert.equal(result.autoApproved, false);
  assert.equal(result.reviewRequired, true);
  assert.ok(result.findings.some((item) =>
    item.code === "plural-category-missing" && item.locale === "en-US" && item.category === "one"
  ));
});

test("Language QA catalog bridge rejects unsupported locales and duplicate aliases", () => {
  assert.throws(() => auditTranslationCatalogs({
    "es-419": { title: "Hola" },
    "zh-CN": { title: "你好" }
  }, { sourceLocale: "es-419", requiredLocales: ["zh-CN"] }), /not supported|unsupported/);

  assert.throws(() => auditTranslationCatalogs({
    es: { title: "Hola" },
    "es-419": { title: "Qué tal" },
    en: { title: "Hello" }
  }, { sourceLocale: "es-419", requiredLocales: ["en"] }), /duplicate locale/);
});

test("Language QA catalog bridge rejects invalid required locale sets", () => {
  assert.throws(() => auditTranslationCatalogs({
    "es-419": { title: "Hola" },
    en: { title: "Hello" }
  }, { sourceLocale: "es-419", requiredLocales: ["es-NI"] }), /must not include the source locale|duplicate/);
});

test("Language QA catalog bridge rejects accessors without executing them", () => {
  let invoked = false;
  const source = { title: "Hola" };
  Object.defineProperty(source, "danger", {
    enumerable: true,
    get() {
      invoked = true;
      return "should not run";
    }
  });
  assert.throws(() => auditTranslationCatalogs({
    "es-419": source,
    en: { title: "Hello", danger: "safe" }
  }, { sourceLocale: "es-419", requiredLocales: ["en"] }), /accessor properties/);
  assert.equal(invoked, false);
});

test("Language QA catalog bridge rejects symbols, prototype keys and excessive nesting", () => {
  const symbolCatalog = { title: "Hola" };
  symbolCatalog[Symbol("unsafe")] = "hidden";
  assert.throws(() => auditTranslationCatalogs({
    "es-419": symbolCatalog,
    en: { title: "Hello" }
  }, { sourceLocale: "es-419", requiredLocales: ["en"] }), /symbol keys/);

  const polluted = JSON.parse('{"__proto__":{"polluted":"yes"},"title":"Hola"}');
  assert.throws(() => auditTranslationCatalogs({
    "es-419": polluted,
    en: { title: "Hello" }
  }, { sourceLocale: "es-419", requiredLocales: ["en"] }), /prototype-sensitive key/);
  assert.equal({}.polluted, undefined);

  let deep = { title: "Hola" };
  for (let index = 0; index < 26; index += 1) deep = { nested: deep };
  assert.throws(() => auditTranslationCatalogs({
    "es-419": deep,
    en: { nested: { title: "Hello" } }
  }, { sourceLocale: "es-419", requiredLocales: ["en"] }), /nested plain object/);
});

test("complete CLDR plural catalogs pass structural audit without becoming human-approved", () => {
  const result = auditTranslationCatalogs({
    "es-419": {
      items: { one: "{count} artículo", other: "{count} artículos" }
    },
    en: {
      items: { one: "{count} item", other: "{count} items" }
    }
  }, { sourceLocale: "es-419", requiredLocales: ["en"] });

  assert.equal(result.status, "passed");
  assert.equal(result.reviewRequired, false);
  assert.equal(result.autoApproved, false);
});


test("translation fingerprints are deterministic across object key order", () => {
  const first = Object.assign(Object.create(null), { "settings.title": "Settings", greeting: "Hello" });
  const second = Object.create(null);
  second.greeting = "Hello";
  second["settings.title"] = "Settings";
  assert.equal(stableTranslationHash(first), stableTranslationHash(second));
  assert.notEqual(
    stableTranslationHash(first),
    stableTranslationHash({ greeting: "Hello", "settings.title": "Preferences" })
  );
  assert.throws(() => stableTranslationHash({ unsafe: 42 }), /flattened string map/);
  assert.throws(() => stableTranslationHash(["not", "a", "map"]), /plain flattened string map/);

  let getterCalled = false;
  const accessorMap = {};
  Object.defineProperty(accessorMap, "label", {
    enumerable: true,
    get() {
      getterCalled = true;
      return "unsafe";
    }
  });
  assert.throws(() => stableTranslationHash(accessorMap), /accessor properties/);
  assert.equal(getterCalled, false);
});

test("human approvals are bound to exact translation content and cannot mask structural defects", () => {
  const source = { greeting: "Hello :name" };
  const target = { greeting: "Hola :name" };
  const initial = auditTranslationMaps(source, target, { sourceLocale: "en", targetLocale: "es-419" });
  const approval = recordTranslationReview({
    state: "approved",
    reviewer: "Steven",
    reviewedAt: "2026-11-19T02:30:00Z",
    sourceHash: initial.sourceHash,
    targetHash: initial.targetHash
  });

  const unchanged = auditTranslationMaps(source, target, {
    sourceLocale: "en",
    targetLocale: "es-419",
    humanApproval: approval
  });
  assert.equal(unchanged.reviewStatus, "approved");

  const changed = auditTranslationMaps(source, { greeting: "Qué tal :name" }, {
    sourceLocale: "en",
    targetLocale: "es-419",
    humanApproval: approval
  });
  assert.equal(changed.reviewStatus, "review-required");
  assert.notEqual(changed.targetHash, approval.targetHash);

  const missing = auditTranslationMaps(source, {}, {
    sourceLocale: "en",
    targetLocale: "es-419",
    humanApproval: approval
  });
  assert.equal(missing.reviewStatus, "partial");

  const brokenPlaceholder = auditTranslationMaps(source, { greeting: "Hola" }, {
    sourceLocale: "en",
    targetLocale: "es-419",
    humanApproval: approval
  });
  assert.equal(brokenPlaceholder.reviewStatus, "review-required");
});
