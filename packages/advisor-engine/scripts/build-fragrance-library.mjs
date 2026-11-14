import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildScentoFragranceBundle,
  renderScentoCoverageMarkdown,
} from "../src/domains/fragrance/library.js";
import { EvidenceStore } from "../src/core/evidence-store.js";
import {
  auditFragranceLibrary,
  renderFragranceQualityAuditMarkdown,
} from "../src/domains/fragrance/quality-audit.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = resolve(packageRoot, "data/fragrance/sources/scento-2026-10-29");
const outputDirectory = resolve(packageRoot, "dist/fragrance-library");
const [perfumesCsv, housesCsv, materialsCsv] = await Promise.all([
  readFile(resolve(sourceDirectory, "perfumes.csv"), "utf8"),
  readFile(resolve(sourceDirectory, "houses.csv"), "utf8"),
  readFile(resolve(sourceDirectory, "materials.csv"), "utf8"),
]);

const bundle = buildScentoFragranceBundle({ perfumesCsv, housesCsv, materialsCsv });
await mkdir(outputDirectory, { recursive: true });
const qualityAudit = auditFragranceLibrary({
  products: bundle.library.perfumes,
  evidenceStore: EvidenceStore.fromExport(bundle.snapshot.evidence),
});
const outputs = [
  ["scento-knowledge-snapshot.json", JSON.stringify(bundle.snapshot)],
  ["scento-supporting-reference.json", JSON.stringify({
    metadata: bundle.library.metadata,
    houses: bundle.library.houses,
    materials: bundle.library.materials,
  })],
  ["scento-library-coverage.json", JSON.stringify(bundle.library.coverageReport, null, 2)],
  ["scento-library-coverage.md", renderScentoCoverageMarkdown(bundle.library.coverageReport)],
  ["fragrance-quality-audit.json", JSON.stringify(qualityAudit, null, 2)],
  ["fragrance-quality-audit.md", renderFragranceQualityAuditMarkdown(qualityAudit)],
];
await Promise.all(outputs.map(([name, content]) =>
  writeFile(resolve(outputDirectory, name), content, "utf8")
));
process.stdout.write(
  `Built ${bundle.library.metadata.perfumeCount} perfumes, ${bundle.library.metadata.houseCount} houses, ${bundle.library.metadata.materialCount} materials; ${bundle.evidenceCount} imported claims remain reported.\n`
);
