import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildScentoFragranceBundle,
  createScentoFragranceLibrary,
  importScentoFragranceLibrary,
  parseCsvRecords,
  renderScentoCoverageMarkdown,
} from "../src/domains/fragrance/library.js";
import {
  KnowledgeStore,
  MemoryKnowledgeAdapter,
} from "../src/knowledge/knowledge-store.js";

const DATA = resolve("data/fragrance/sources/scento-2026-10-29");
async function readSource(name) {
  return readFile(resolve(DATA, name), "utf8");
}

const sampleHeader = "id,name,house_id,house,year,perfumers,concentration,family,secondary_family,character,seasons,times_of_day,top_notes,heart_notes,base_notes,notes,description,popularity_rank,url";
function sampleCsv({
  id = "sample-one",
  name = "Sample One",
  house = "Sample House",
  concentration = "eau-de-parfum",
  top = "Bergamot",
  heart = "Jasmine",
  base = "Vanilla",
  notes = "Bergamot; Jasmine; Vanilla",
} = {}) {
  return [
    sampleHeader,
    [
      id, name, "sample-house", house, "2020", "Perfumer One",
      concentration, "White Bloom", "Amber & Resin", "floral; creamy",
      "spring; summer", "day; evening", top, heart, base, notes,
      "A sample description, with a comma.", "1",
      "https://www.scento.com/perfumes/sample-one",
    ].map((value) => {
      const text = String(value);
      return /[",\r\n]/u.test(text) ? '"' + text.replace(/"/gu, '""') + '"' : text;
    }).join(","),
  ].join("\n");
}
const sampleHouses = "id,name,country,founded,type,portrait,perfume_count,url\nsample-house,Sample House,France,2000,designer,House portrait,1,https://example.com/house";
const sampleMaterials = "id,name,aliases,material_family,origin,smell,url\nbergamot,Bergamot,Bergamot orange,Citrus,natural,Bright citrus,https://example.com/bergamot";

test("CSV parser preserves quoted commas, escaped quotes and embedded newlines", () => {
  const rows = parseCsvRecords('id,description\r\none,"A phrase, with ""quotes"".\nSecond line."\r\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].description, 'A phrase, with "quotes".\nSecond line.');
});

test("creates domain-safe perfume products with provenance-linked reported claims", () => {
  const library = createScentoFragranceLibrary({
    perfumesCsv: sampleCsv(),
    housesCsv: sampleHouses,
    materialsCsv: sampleMaterials,
  });
  assert.equal(library.perfumes.length, 1);
  const product = library.findPerfume("sample-one");
  assert.equal(product.id, "scento:sample-one");
  assert.equal(product.brand, "Sample House");
  assert.equal(product.productType, "perfume");
  assert.equal(product.attributes.concentration, "edp");
  assert.deepEqual(product.attributes.topNotes, ["Bergamot"]);
  assert.deepEqual(product.attributes.middleNotes, ["Jasmine"]);
  assert.deepEqual(product.attributes.baseNotes, ["Vanilla"]);
  assert.equal(product.attributes.sourceLicense, "CC BY 4.0");
  assert.equal(library.searchPerfumes({note:"Jasmine"}).length, 1);
  assert.equal(library.searchHouses({query:"sample"}).length, 1);
  assert.equal(library.searchMaterials({query:"citrus"}).length, 1);
});

test("does not invent standardized concentration or missing note-pyramid fields", () => {
  const library = createScentoFragranceLibrary({
    perfumesCsv: sampleCsv({
      id:"sample-unknown",
      name:"Unknown Concentration",
      concentration:"elixir",
      top:"",
      heart:"",
      base:"",
      notes:"",
    }),
    housesCsv: sampleHouses,
    materialsCsv: sampleMaterials,
  });
  const product = library.findPerfume("sample-unknown");
  assert.equal(product.attributes.concentration, undefined);
  assert.equal(product.attributes.concentrationLabel, "elixir");
  assert.equal(product.attributes.topNotes, undefined);
  assert.equal(product.attributes.middleNotes, undefined);
  assert.equal(product.attributes.baseNotes, undefined);
});

test("builds a schema-valid knowledge snapshot with stable reported evidence", () => {
  const bundle = buildScentoFragranceBundle({
    perfumesCsv: sampleCsv(),
    housesCsv: sampleHouses,
    materialsCsv: sampleMaterials,
    importedAt:"2026-10-29T00:00:00.000Z",
  });
  assert.equal(bundle.snapshot.schemaVersion, 2);
  assert.equal(bundle.snapshot.catalog.products.length, 1);
  assert.ok(bundle.evidenceCount >= 10);
  const product = bundle.snapshot.catalog.products[0];
  const evidence = bundle.snapshot.evidence.records;
  const referenced = Object.values(product.evidenceIds).flat();
  assert.ok(referenced.length >= 10);
  assert.ok(referenced.every((id) => evidence.some((record) =>
    record.id === id && record.status === "reported"
  )));
});

test("imports the library non-destructively and is idempotent", async () => {
  const knowledgeStore = await KnowledgeStore.open({
    adapter: new MemoryKnowledgeAdapter(),
    clock: () => new Date("2026-10-29T00:00:00.000Z"),
  });
  const data = {
    perfumesCsv:sampleCsv(),
    housesCsv:sampleHouses,
    materialsCsv:sampleMaterials,
    importedAt:"2026-10-29T00:00:00.000Z",
  };
  const first = await importScentoFragranceLibrary({knowledgeStore,...data});
  const second = await importScentoFragranceLibrary({knowledgeStore,...data});
  assert.equal(first.perfumeCount, 1);
  assert.equal(first.importResult.newProductCount, 1);
  assert.equal(second.importResult.newProductCount, 0);
  assert.ok(second.importResult.duplicateProductCount >= 1);
  assert.equal(knowledgeStore.getProducts({domain:"fragrance"}).length, 1);
});

test("ships the complete 2026-10-29 open perfume reference snapshot", async () => {
  const [perfumesCsv, housesCsv, materialsCsv] = await Promise.all([
    readSource("perfumes.csv"),
    readSource("houses.csv"),
    readSource("materials.csv"),
  ]);
  const bundle = buildScentoFragranceBundle({
    perfumesCsv,
    housesCsv,
    materialsCsv,
    importedAt:"2026-10-29T00:00:00.000Z",
  });
  assert.equal(bundle.library.metadata.perfumeCount, 1479);
  assert.equal(bundle.library.metadata.houseCount, 160);
  assert.equal(bundle.library.metadata.materialCount, 420);
  assert.equal(bundle.library.metadata.perfumesWithCompleteNotePyramid, 1388);
  assert.equal(bundle.library.metadata.perfumesWithoutCompleteNotePyramid, 91);
  assert.equal(bundle.snapshot.catalog.products.length, 1479);
  assert.ok(bundle.evidenceCount > 12000);
  assert.equal(bundle.library.searchPerfumes({query:"Libre"}).length > 0, true);
  const perfumeIds = bundle.snapshot.catalog.products.map((item) => item.id);
  assert.equal(new Set(perfumeIds).size, perfumeIds.length);
});

test("finds offline similarity candidates from shared notes and family without claiming equivalence", () => {
  const first = sampleCsv();
  const second = sampleCsv({
    id: "sample-two",
    name: "Sample Two",
    top: "Bergamot; Mandarin",
    heart: "Jasmine; Rose",
    base: "Musk",
    notes: "Bergamot; Mandarin; Jasmine; Rose; Musk",
  }).split("\n").slice(1).join("\n");
  const library = createScentoFragranceLibrary({
    perfumesCsv: first + "\n" + second,
    housesCsv: sampleHouses,
    materialsCsv: sampleMaterials,
  });
  const similar = library.findSimilarPerfumes("sample-one");
  assert.equal(similar.length, 1);
  assert.equal(similar[0].product.id, "scento:sample-two");
  assert.ok(similar[0].similarityScore > 0);
  assert.ok(similar[0].sharedNotes.includes("Bergamot"));
  assert.ok(similar[0].sharedFamilies.includes("White Bloom"));
  assert.deepEqual(similar[0].matchReasons, ["notes", "families", "character", "seasons"]);
  assert.match(similar[0].caveat, /not proof of smell equivalence/u);
});

test("imports all 1,479 source perfumes and 20,280 evidence records into KnowledgeStore idempotently", async () => {
  const [perfumesCsv, housesCsv, materialsCsv] = await Promise.all([
    readSource("perfumes.csv"),
    readSource("houses.csv"),
    readSource("materials.csv"),
  ]);
  const knowledgeStore = await KnowledgeStore.open({
    adapter: new MemoryKnowledgeAdapter(),
    clock: () => new Date("2026-10-29T00:00:00.000Z"),
  });
  const data = {
    knowledgeStore,
    perfumesCsv,
    housesCsv,
    materialsCsv,
    importedAt: "2026-10-29T00:00:00.000Z",
  };
  const first = await importScentoFragranceLibrary(data);
  assert.equal(first.perfumeCount, 1479);
  assert.equal(first.houseCount, 160);
  assert.equal(first.materialCount, 420);
  assert.equal(first.evidenceCount, 20280);
  assert.equal(first.importResult.newProductCount, 1479);
  assert.equal(first.importResult.newRecordCount, 20280);
  assert.equal(knowledgeStore.getProducts({ domain: "fragrance" }).length, 1479);
  assert.equal(knowledgeStore.queryEvidence({ domain: "fragrance" }).length, 20280);

  const second = await importScentoFragranceLibrary(data);
  assert.equal(second.importResult.newProductCount, 0);
  assert.equal(second.importResult.newRecordCount, 0);
  assert.equal(second.importResult.duplicateProductCount, 1479);
  assert.equal(second.importResult.duplicateRecordCount, 20280);
});


test("reports field coverage without converting missing source data into inferred values", () => {
  const library = createScentoFragranceLibrary({
    perfumesCsv: sampleCsv({
      id: "coverage-sample",
      name: "Coverage Sample",
      concentration: "elixir",
      top: "Bergamot",
      heart: "",
      base: "Vanilla",
      notes: "Bergamot; Vanilla",
    }),
    housesCsv: sampleHouses,
    materialsCsv: sampleMaterials,
  });
  const report = library.coverageReport;
  assert.equal(report.schemaVersion, 1);
  assert.deepEqual(report.totals, { perfumes: 1, houses: 1, materials: 1 });
  assert.deepEqual(report.notePyramid, {
    complete: 0,
    incompleteOrMissing: 1,
    coveragePercent: 0,
  });
  const coverage = Object.fromEntries(report.fieldCoverage.map((item) => [item.field, item]));
  assert.deepEqual(
    { present: coverage.topNotes.present, missing: coverage.topNotes.missing },
    { present: 1, missing: 0 },
  );
  assert.deepEqual(
    { present: coverage.middleNotes.present, missing: coverage.middleNotes.missing },
    { present: 0, missing: 1 },
  );
  assert.deepEqual(
    { present: coverage.concentrationLabel.present, missing: coverage.concentrationLabel.missing },
    { present: 1, missing: 0 },
  );
  assert.equal(report.distributions.concentrations[0].value, "elixir");
  assert.equal(report.distributions.primaryFamilies[0].value, "White Bloom");
  assert.equal(
    report.distributions.mostCommonNotes.find((item) => item.value === "Bergamot").count,
    1,
  );
  assert.match(report.interpretation, /does not measure factual accuracy/u);
  const markdown = renderScentoCoverageMarkdown(report);
  assert.match(markdown, /Field coverage/u);
  assert.match(markdown, /Heart notes \| 0 \| 1 \| 0%/u);
  assert.throws(() => renderScentoCoverageMarkdown({}), /schema-v1/u);
});

test("full snapshot coverage report reconciles with the source catalog totals", async () => {
  const [perfumesCsv, housesCsv, materialsCsv] = await Promise.all([
    readSource("perfumes.csv"),
    readSource("houses.csv"),
    readSource("materials.csv"),
  ]);
  const library = createScentoFragranceLibrary({
    perfumesCsv,
    housesCsv,
    materialsCsv,
  });
  const report = library.coverageReport;
  assert.deepEqual(report.totals, {
    perfumes: 1479,
    houses: 160,
    materials: 420,
  });
  assert.equal(report.notePyramid.complete, 1388);
  assert.equal(report.notePyramid.incompleteOrMissing, 91);
  assert.equal(report.notePyramid.coveragePercent, 93.8);
  const concentration = report.fieldCoverage.find((item) => item.field === "concentrationLabel");
  assert.equal(concentration.present, 1228);
  assert.equal(concentration.missing, 251);
  assert.equal(report.distributions.primaryFamilies.length > 0, true);
  assert.equal(report.distributions.houses.length, 30);
  assert.equal(
    JSON.stringify(report),
    JSON.stringify(createScentoFragranceLibrary({
      perfumesCsv,
      housesCsv,
      materialsCsv,
    }).coverageReport),
  );
});
