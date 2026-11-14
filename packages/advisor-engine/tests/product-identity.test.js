import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTechnologyProduct } from "../src/domains/technology/adapter.js";
import { normalizeFragranceProduct } from "../src/domains/fragrance/adapter.js";
import { matchProducts, findProductMatches } from "../src/core/product-matching.js";

const phone = (id, overrides = {}) => normalizeTechnologyProduct({
  id, name: "Samsung Galaxy S25 Ultra", brand: "Samsung", model: "Galaxy S25 Ultra",
  deviceType: "smartphone", attributes: { ramGB: 12, storageGB: 256 },
  ...overrides,
});

test("identity normalization preserves validated identifiers and variant metadata", () => {
  const product = phone("a", {
    identifiers: { gtin: "4006381333931", mpn: "SM-S938BZKGEUB" },
    variant: { ramGB: 12, storageGB: 512, color: "Titanium Gray", region: "Global" },
    market: "Global",
    condition: "new",
  });
  assert.equal(product.identifiers.gtin, "4006381333931");
  assert.equal(product.variant.storageGB, 512);
  assert.equal(product.market, "Global");
  assert.equal(product.condition, "new");
  assert.throws(() => phone("bad", { identifiers: { imei: "123" } }), /Unsupported identifiers/);
  assert.throws(() => phone("bad", { variant: { unknown: "x" } }), /Unsupported variant/);
});

test("matches exact universal identifiers even when display names differ", () => {
  const left = phone("a", { identifiers: { gtin: "4006381333931" } });
  const right = phone("b", {
    name: "S25 Ultra 12GB/256GB", model: "Galaxy S25 Ultra",
    identifiers: { gtin: "4006381333931" },
  });
  const result = matchProducts(left, right);
  assert.equal(result.matchType, "exact_variant");
  assert.equal(result.score, 100);
  assert.equal(result.matchedIdentifier, "gtin");
});

test("recognizes same model family but does not collapse different storage variants", () => {
  const left = phone("a", {
    variant: { ramGB: 12, storageGB: 256, color: "Black" },
    attributes: { ramGB: 12, storageGB: 256 },
  });
  const right = phone("b", {
    variant: { ramGB: 12, storageGB: 512, color: "Black" },
    attributes: { ramGB: 12, storageGB: 512 },
  });
  const result = matchProducts(left, right);
  assert.equal(result.matchType, "same_product_family");
  assert.equal(result.sameVariant, false);
  assert.ok(result.variantConflicts.includes("storageGB"));
});

test("brand, category and conflicting identifiers prevent false-positive matching", () => {
  const base = phone("a");
  assert.equal(matchProducts(base, phone("b", { brand: "Apple" })).matchType, "no_match");
  assert.equal(matchProducts(base, phone("c", { deviceType: "tablet" })).matchType, "no_match");
  assert.equal(matchProducts(
    phone("d", { identifiers: { mpn: "SM-A" } }),
    phone("e", { identifiers: { mpn: "SM-B" } }),
  ).matchType, "no_match");
});

test("fragrance matching keeps perfume concentration and size variants distinct", () => {
  const left = normalizeFragranceProduct({
    id: "p1", name: "Dior Sauvage", brand: "Dior", model: "Sauvage",
    productType: "perfume", variant: { concentration: "edp", volumeMl: 100 },
    attributes: { concentration: "edp", volumeMl: 100 },
  });
  const right = normalizeFragranceProduct({
    id: "p2", name: "Dior Sauvage", brand: "Dior", model: "Sauvage",
    productType: "perfume", variant: { concentration: "edt", volumeMl: 100 },
    attributes: { concentration: "edt", volumeMl: 100 },
  });
  const result = matchProducts(left, right);
  assert.equal(result.matchType, "same_product_family");
  assert.ok(result.variantConflicts.includes("concentration"));
});

test("findProductMatches returns ranked candidates and excludes unrelated products", () => {
  const target = phone("target");
  const candidates = [
    phone("same", { name: "Samsung Galaxy Tab S10", model: "Galaxy Tab S10", deviceType: "tablet" }),
    phone("other", { name: "Samsung S25 Ultra 12GB/256GB", model: "Galaxy S25 Ultra" }),
    phone("unrelated", { name: "Apple iPhone 16 Pro", brand: "Apple", model: "iPhone 16 Pro" }),
  ];
  const result = findProductMatches({ product: target, candidates, minScore: 45, limit: 10 });
  assert.equal(result[0].rightId, "other");
  assert.ok(result.every(item => item.rightId !== "unrelated"));
});


test("flags internal variant contradictions and regional differences for manual review", () => {
  const internallyInconsistent = phone("inconsistent", {
    variant: { ramGB: 8, storageGB: 256 },
    attributes: { ramGB: 12, storageGB: 256 },
  });
  const normal = phone("normal", {
    variant: { ramGB: 12, storageGB: 256 },
    market: "Global",
  });
  assert.equal(matchProducts(internallyInconsistent, normal).matchType, "no_match");

  const global = phone("global", {
    variant: { ramGB: 12, storageGB: 256 },
    market: "Global",
  });
  const india = phone("india", {
    variant: { ramGB: 12, storageGB: 256 },
    market: "India",
  });
  const regional = matchProducts(global, india);
  assert.equal(regional.matchType, "same_product_family");
  assert.equal(regional.sameVariant, false);
  assert.ok(regional.conflicts.includes("market"));
});


test("accepts UPC-A and equivalent zero-prefixed EAN-13 as the same barcode", () => {
  const upc = phone("upc", { identifiers: { upc: "123456789012" } });
  const ean = phone("ean", { identifiers: { ean: "0123456789012" } });
  const result = matchProducts(upc, ean);
  assert.equal(result.matchType, "exact_variant");
  assert.equal(result.matchedIdentifier, "upc/ean");
  assert.equal(result.score, 100);
});

test("rejects malformed or invalid-check-digit universal barcodes during normalization", () => {
  assert.throws(
    () => phone("bad-length", { identifiers: { gtin: "123456" } }),
    /8, 12, 13 or 14 digits/u,
  );
  assert.throws(
    () => phone("bad-check", { identifiers: { ean: "4006381333932" } }),
    /invalid barcode check digit/u,
  );
  assert.throws(
    () => phone("numeric-barcode", { identifiers: { upc: 123456789012 } }),
    /barcode string/u,
  );
});

test("different valid universal barcodes restrict an otherwise identical model to family-level matching", () => {
  const left = phone("barcode-a", { identifiers: { upc: "123456789012" } });
  const right = phone("barcode-b", { identifiers: { ean: "4006381333931" } });
  const result = matchProducts(left, right);
  assert.equal(result.matchType, "same_product_family");
  assert.equal(result.sameVariant, false);
  assert.ok(result.conflicts.includes("universal_identifier"));
  assert.equal(result.reviewRequired, true);
});

test("normalizes capacity units and common fragrance aliases before comparing variants", () => {
  const oneTb = phone("one-tb", {
    variant: { ramGB: 12, storageGB: "1 TB", color: "Space Grey" },
    attributes: { ramGB: 12, storageGB: 1024 },
  });
  const thousandTwentyFourGb = phone("1024-gb", {
    variant: { ramGB: 12, storageGB: 1024, color: "Space Gray" },
    attributes: { ramGB: 12, storageGB: 1024 },
  });
  const result = matchProducts(oneTb, thousandTwentyFourGb);
  assert.equal(result.matchType, "same_variant");
  assert.deepEqual(result.variantConflicts, []);
  assert.ok(result.comparableVariantFields.includes("storageGB"));

  const perfumeA = normalizeFragranceProduct({
    id: "edp-a", name: "Dior Sauvage", brand: "Dior", model: "Sauvage",
    productType: "perfume", variant: { concentration: "EDP", volumeMl: 100 },
    attributes: { concentration: "edp", volumeMl: 100 },
  });
  const perfumeB = normalizeFragranceProduct({
    id: "edp-b", name: "Dior Sauvage", brand: "Dior", model: "Sauvage",
    productType: "perfume", variant: { concentration: "eau de parfum", volumeMl: "0.1 L" },
    attributes: { concentration: "edp", volumeMl: 100 },
  });
  assert.equal(matchProducts(perfumeA, perfumeB).matchType, "same_variant");
});

test("validates matcher input shapes and bounds candidate search", () => {
  const target = phone("target");
  assert.throws(() => matchProducts(target, { ...phone("bad"), aliases: "not-an-array" }), /aliases must be an array/u);
  assert.throws(() => matchProducts(target, { ...phone("bad"), identifiers: "bad" }), /identifiers must be an object/u);
  assert.throws(() => findProductMatches({ product: target, candidates: [], minScore: 101 }), /minScore/u);
  assert.throws(() => findProductMatches({ product: target, candidates: [], limit: 51 }), /limit/u);
});


test("rejects object-valued variant fields instead of coercing them into text", () => {
  const left = phone("left");
  const right = {
    ...phone("right"),
    attributes: { ramGB: 12, storageGB: { value: 1, unit: "TB" } },
  };
  assert.throws(
    () => matchProducts(left, right),
    /variant field storageGB must be a non-empty string or finite number/u,
  );
});


test("does not mistake a base model for its Ultra or Pro sibling", () => {
  const samsungBase = phone("s25", {
    name: "Samsung Galaxy S25", model: "Galaxy S25",
    variant: { ramGB: 12, storageGB: 256 },
    attributes: { ramGB: 12, storageGB: 256 },
  });
  const samsungUltra = phone("s25-ultra", {
    variant: { ramGB: 12, storageGB: 256 },
    attributes: { ramGB: 12, storageGB: 256 },
  });
  const samsung = matchProducts(samsungBase, samsungUltra);
  assert.equal(samsung.matchType, "same_product_family");
  assert.equal(samsung.sameVariant, false);

  const iphoneBase = phone("iphone-15", {
    name: "Apple iPhone 15", brand: "Apple", model: "iPhone 15",
    variant: { storageGB: 128 }, attributes: { storageGB: 128 },
  });
  const iphonePro = phone("iphone-15-pro", {
    name: "Apple iPhone 15 Pro", brand: "Apple", model: "iPhone 15 Pro",
    variant: { storageGB: 128 }, attributes: { storageGB: 128 },
  });
  const iphone = matchProducts(iphoneBase, iphonePro);
  assert.equal(iphone.matchType, "same_product_family");
  assert.equal(iphone.sameVariant, false);
});

test("allows formatting differences but requires a full model-token match for variant identity", () => {
  const left = phone("formatted-a", {
    name: "Samsung Galaxy S25 Ultra", model: "Galaxy S25 Ultra",
    variant: { ramGB: 12, storageGB: 256 }, attributes: { ramGB: 12, storageGB: 256 },
  });
  const right = phone("formatted-b", {
    name: "SAMSUNG Galaxy-S25 Ultra", model: "GALAXY S25 ULTRA",
    variant: { ramGB: 12, storageGB: 256 }, attributes: { ramGB: 12, storageGB: 256 },
  });
  const result = matchProducts(left, right);
  assert.equal(result.matchType, "same_variant");
  assert.equal(result.sameVariant, true);
});
