import test from "node:test";
import assert from "node:assert/strict";
import {
  createLocalization,
  canonicalizeLocale,
  getTextDirection,
  auditCatalogs,
  resolveLocale
} from "../src/index.js";
import { flattenCatalog } from "../src/catalog.js";

const catalogs = {
  "es-419": {
    common: { greeting: "Hola, {name}", items: { one: "{count} artículo", other: "{count} artículos" } },
    status: { ready: "Listo" }
  },
  "en-US": {
    common: { greeting: "Hello, {name}", items: { one: "{count} item", other: "{count} items" } },
    status: { ready: "Ready" }
  },
  ar: {
    common: { items: { zero: "لا عناصر", one: "عنصر واحد", two: "عنصران", few: "{count} عناصر", many: "{count} عنصرًا", other: "{count} عنصر" } }
  }
};

test("canonicalizes BCP 47 locales and uses explicit deterministic fallback", () => {
  assert.equal(canonicalizeLocale("es_ni"), "es-NI");
  assert.equal(resolveLocale("es-MX", { supportedLocales: ["es-419", "en-US"], fallback: "es-419" }), "es-419");
  assert.equal(resolveLocale("fr-FR", { supportedLocales: ["es-419", "en-US"], fallback: "es-419" }), "es-419");
  assert.equal(canonicalizeLocale("not a locale"), null);
});

test("resolves catalog entries and interpolates scalar parameters", () => {
  const i18n = createLocalization({ catalogs, defaultLocale: "es-419" });
  assert.equal(i18n.t("common.greeting", { locale: "en-US", params: { name: "JB" } }), "Hello, JB");
  assert.equal(i18n.t("status.ready", { locale: "fr-FR" }), "Listo");
  assert.throws(() => i18n.t("common.greeting", { params: {} }), /missing translation parameter/);
  assert.throws(() => i18n.t("common.greeting", { params: { name: { html: true } } }), /must be a scalar/);
});

test("uses ICU plural categories exposed by the runtime for each locale", () => {
  const i18n = createLocalization({ catalogs, defaultLocale: "es-419" });
  assert.equal(i18n.t("common.items", { count: 1, params: { count: 1 } }), "1 artículo");
  assert.equal(i18n.t("common.items", { count: 3, params: { count: 3 } }), "3 artículos");
  assert.equal(i18n.t("common.items", { locale: "ar", count: 0, params: { count: 0 } }), "لا عناصر");
  assert.equal(i18n.t("common.items", { locale: "ar", count: 7, params: { count: 7 } }), "7 عناصر");
});

test("returns RTL metadata and formats locale-sensitive numbers and dates", () => {
  const i18n = createLocalization({ catalogs, defaultLocale: "es-419" });
  assert.equal(i18n.direction("ar"), "rtl");
  assert.equal(i18n.direction("en-US"), "ltr");
  assert.match(i18n.formatNumber(1234.5, { locale: "de-DE" }), /1\.234,5/);
  assert.doesNotThrow(() => i18n.formatDate("2026-11-18T12:00:00Z", { locale: "es-419", timeZone: "UTC" }));
});

test("audit detects missing catalogs, missing keys, obsolete keys and placeholder mismatch", () => {
  const result = auditCatalogs({
    "es-419": { greeting: "Hola, {name}", onlySource: "A" },
    "en-US": { greeting: "Hello, {user}", extra: "Extra" }
  }, { sourceLocale: "es-419", requiredLocales: ["en-US", "fr-FR"] });
  assert.equal(result.status, "review-required");
  assert.ok(result.findings.some((item) => item.code === "placeholder-mismatch"));
  assert.ok(result.findings.some((item) => item.code === "translation-missing"));
  assert.ok(result.findings.some((item) => item.code === "obsolete-translation"));
  assert.ok(result.findings.some((item) => item.code === "catalog-missing"));
});

test("rejects invalid catalogs and plural objects without other", () => {
  assert.throws(() => createLocalization({
    catalogs: { "en-US": { greeting: 4 } },
    defaultLocale: "en-US"
  }));
  assert.throws(() => createLocalization({
    catalogs: { "en-US": { items: { one: "one" } } },
    defaultLocale: "en-US"
  }));
});

test("missing keys do not silently become empty strings", () => {
  const i18n = createLocalization({ catalogs: { "en-US": { ok: "OK" } }, defaultLocale: "en-US" });
  assert.throws(() => i18n.t("missing.key"), /translation key is missing/);
});

test("plural placeholder audit respects locale-specific grammatical forms", () => {
  const result = auditCatalogs({
    "es-419": { items: { one: "{count} artículo", other: "{count} artículos" } },
    ar: { items: { zero: "لا عناصر", one: "عنصر واحد", two: "عنصران", few: "{count} عناصر", many: "{count} عنصرًا", other: "{count} عنصر" } }
  }, { sourceLocale: "es-419", requiredLocales: ["ar"] });
  assert.equal(result.findings.some((item) => item.code === "placeholder-mismatch"), false);
});

test("runtime catalog snapshots are immutable after construction", () => {
  const mutable = { "en-US": { plural: { one: "{count} item", other: "{count} items" } } };
  const i18n = createLocalization({ catalogs: mutable, defaultLocale: "en-US" });
  mutable["en-US"].plural.one = "mutated";
  mutable["en-US"].plural.other = "mutated";
  assert.equal(i18n.t("plural", { count: 1, params: { count: 1 } }), "1 item");
});


test("plural audit flags missing CLDR categories required by the target locale", () => {
  const result = auditCatalogs({
    "es-419": { items: { one: "{count} artículo", other: "{count} artículos" } },
    ar: { items: { one: "عنصر واحد", other: "{count} عنصر" } }
  }, { sourceLocale: "es-419", requiredLocales: ["ar"] });
  const missing = result.findings
    .filter((item) => item.code === "plural-category-missing")
    .map((item) => item.category)
    .sort();
  assert.deepEqual(missing, ["few", "many", "two", "zero"]);
  assert.equal(result.status, "review-required");
});


test("catalog flattening rejects prototype-sensitive keys without mutating object prototypes", () => {
  const malicious = JSON.parse('{"__proto__":{"polluted":"yes"}}');
  assert.throws(() => flattenCatalog(malicious), /unsafe key/);
  assert.equal({}.polluted, undefined);

  const flattened = flattenCatalog({ common: { ready: "Ready" } });
  assert.equal(Object.getPrototypeOf(flattened), null);
  assert.equal(flattened["common.ready"], "Ready");
});

test("catalog audit reports leaf-versus-object structural mismatches", () => {
  const result = auditCatalogs({
    "es-419": { settings: { title: "Configuración" } },
    "en-US": { settings: "Settings" }
  }, { sourceLocale: "es-419", requiredLocales: ["en-US"] });
  assert.ok(result.findings.some((item) => item.code === "message-shape-mismatch" && item.key === "settings"));
  assert.equal(result.findings.some((item) => item.code === "translation-missing"), false);
  assert.equal(result.findings.some((item) => item.code === "obsolete-translation"), false);
});
