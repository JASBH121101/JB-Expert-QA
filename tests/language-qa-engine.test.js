import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_LOCALE, SUPPORTED_LOCALES, normalizeLocale, resolveLocale,
  comparePlaceholders, parsePhpTranslationArray, LanguageLibrary,
  TranslationMemory, recordTranslationReview, resolveTranslationState,
  auditTranslationMaps
} from "../src/language/index.js";
import { auditLanguageFiles } from "../src/adapters/filesystem/audit-language.js";
import { languageRules } from "../src/specialists/language/index.js";

test("normalizes legacy Spanish and regional English to the approved locale set", () => {
  assert.equal(DEFAULT_LOCALE, "es-419");
  assert.deepEqual(SUPPORTED_LOCALES, ["es-419", "en"]);
  assert.equal(normalizeLocale("es"), "es-419");
  assert.equal(normalizeLocale("es_MX"), "es-419");
  assert.equal(normalizeLocale("en-GB"), "en");
  assert.equal(normalizeLocale("fr"), null);
  assert.equal(resolveLocale("fr"), "es-419");
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

test("translation memory requires human review metadata for approved entries", () => {
  const memory = new TranslationMemory();
  const pending = memory.add({ source: "Sign in", target: "Iniciar sesión", sourceLocale: "en", targetLocale: "es" });
  assert.equal(pending.status, "pending");
  assert.equal(memory.findExact({ source: "Sign in", sourceLocale: "en", targetLocale: "es" }).status, "pending");
  assert.throws(() => memory.add({
    source: "Save", target: "Guardar", sourceLocale: "en", targetLocale: "es", approved: true
  }), /reviewer and reviewedAt/);
  const approved = memory.add({
    source: "Save", target: "Guardar", sourceLocale: "en", targetLocale: "es",
    approved: true, reviewer: "human-reviewer", reviewedAt: "2026-11-14T10:00:00Z"
  });
  assert.equal(approved.status, "approved");
  assert.equal(memory.markStale({ source: "Sign in", sourceLocale: "en", targetLocale: "es" }), true);
  assert.equal(memory.findExact({ source: "Sign in", sourceLocale: "en", targetLocale: "es" }).status, "stale");
});

test("approval state requires a named reviewer and structural checks never auto-approve", () => {
  assert.throws(() => recordTranslationReview({ state: "approved", reviewer: " " }), /reviewer identity/);
  assert.equal(resolveTranslationState({}), "review-required");
  assert.equal(resolveTranslationState({ missingKeys: 1 }), "partial");
  assert.equal(resolveTranslationState({ humanApproval: { state: "approved", reviewer: "Steven", reviewedAt: "2026-11-14" } }), "approved");
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


test("locale aliases are canonical and reject unsupported or malformed regional tags", () => {
  assert.equal(normalizeLocale("es-NI"), "es-419");
  assert.equal(normalizeLocale("es-MX"), "es-419");
  assert.equal(normalizeLocale("es_419"), "es-419");
  assert.equal(normalizeLocale("es-ES"), null);
  assert.equal(normalizeLocale("es-XY"), null);
  assert.equal(normalizeLocale("es-MX-u-ca-gregory"), null);
  assert.equal(normalizeLocale("en-US"), "en");
  assert.equal(normalizeLocale("en-GB"), "en");
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
