import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createScentoFragranceLibrary, SCENTO_DATASET } from "../src/index.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = resolve(packageRoot, "data/fragrance/sources/scento-2026-10-29");

test("bundled Scento snapshot builds an offline fragrance library with attribution", async () => {
  const [perfumesCsv, housesCsv, materialsCsv] = await Promise.all([
    readFile(resolve(sourceDirectory, "perfumes.csv"), "utf8"),
    readFile(resolve(sourceDirectory, "houses.csv"), "utf8"),
    readFile(resolve(sourceDirectory, "materials.csv"), "utf8"),
  ]);
  const library = createScentoFragranceLibrary({ perfumesCsv, housesCsv, materialsCsv });
  assert.ok(library.perfumes.length >= 1000);
  assert.ok(library.houses.length >= 100);
  assert.ok(library.materials.length >= 300);
  assert.equal(library.metadata.license, "CC BY 4.0");
  assert.equal(library.metadata.attribution, SCENTO_DATASET.attribution);
  assert.ok(library.coverageReport);
});
