# Fragrance Library — Scento reference seed

## Included snapshot

JBAE now includes the Scento Perfume Database snapshot dated **2026-10-29**:

- 1,479 perfume records.
- 160 perfume houses.
- 420 materials, accords and note-reference records.
- 1,388 perfumes have a complete top/heart/base note pyramid in this snapshot.
- 91 perfumes do not have all three pyramid tiers recorded.
- The validated Knowledge Store seed contains 20,280 field-scoped evidence records for the available source attributes.
- 251 perfume records have no concentration label.
- The generated coverage report measures 1,388 complete note pyramids (93.8%), concentration labels on 1,228 records (83.0%), release years on 80 records (5.4%) and perfumer credits on 69 records (4.7%). A separate provenance/quality audit counts field-linked evidence, evidence statuses and the number of records that could support customer-facing performance estimates.

The source files are preserved under `data/fragrance/sources/scento-2026-10-29/`. Empty source fields remain empty. JBAE does not infer missing notes, concentration, year or perfumer.

## License and attribution

The source repository explicitly marks this snapshot **Creative Commons Attribution 4.0 International (CC BY 4.0)**.

Attribution:

> Scento. Scento Perfume Database (2026-10-29). https://www.scento.com/perfume-database  
> Licensed under CC BY 4.0: https://creativecommons.org/licenses/by/4.0/

The JBAE import is an adaptation: CSV fields are normalized into the JBAE Fragrance domain, and provenance/evidence records are generated. Scento does not endorse JBAE or JB Parfums. The original attribution and license are included alongside the preserved source data.

The separate FragDB sample found during research is CC BY-NC 4.0 and is not included in this commercial-capable seed library.

## Regional coverage and catalog boundaries

The current snapshot contains **331 perfume records across 11 selected Middle Eastern / Arabic-fragrance houses**: Afnan (53), Ajmal (21), Al Haramain (3), Amouage (25), Arabian Oud (1), Armaf (189), Khadlaj (1), Lattafa (23), Nabeel (8), Rasasi (4) and Swiss Arabian (3). The country field is preserved exactly as supplied by Scento; for example, this snapshot lists Ajmal as India. These are observed source counts, not a claim that the regional market is fully covered.

The seed is a perfume catalog, not a complete fragrance-commerce catalog. It does **not** currently include a verified bulk collection of body mists, body sprays, attars/oils, lotions, decants, bottle sizes, local stock or prices. The domain adapter can represent those product types, but the seed does not fabricate entries for them. They require separate traceable sources and review.

The 14 source families are Scento's own taxonomy: Amber & Resin, Green Leaf, Orchard Fruit, Oud Court, Petal Garden, Powder Veil, Salt & Mineral, Skin Musk, Smoke & Leather, Spice Route, Sunlit Citrus, Velvet Sweet, White Bloom, and Wood & Root. JBAE retains the taxonomy label rather than pretending it is a universal industry standard.

The offline library also exposes a deterministic similarity search based on weighted Jaccard overlap: notes (65%), families (20%), character traits (10%) and seasons (5%). It reports shared attributes and a similarity index. This is a discovery heuristic only; it does not establish a clone, exact equivalence, identical smell or equal longevity/performance.

Supplemental intake decisions and licensing boundaries for future body products, additional perfume sources and wear-test evidence are tracked in [Supplemental source assessment](fragrance-supplemental-sources.md).

The free 10ML Fragrance Index is also registered as a bounded research provider for additional perfume discovery and profile enrichment. Its current API terms allow free commercial use and caching of fetched responses, provided the visible credit **“Data: 10ML Fragrance Index”** links to [10ml.com/perfume-api](https://10ml.com/perfume-api). Search results enter JBAE as unconfirmed evidence candidates; the provider does not copy the full index into the local catalog. The index covers perfumes and fine fragrances, not an established body-mist/body-spray catalog. The source and usage conditions are documented in [Supplemental source assessment](fragrance-supplemental-sources.md).

Open Beauty Facts is integrated separately as a **barcode-only cosmetics lookup** against its API v3 product endpoint. It returns source-provided product name, brand, categories and ingredient fields when present, but leaves categories unnormalized for human review. It does not search or mirror the catalog, infer that a product is a perfume/body mist, or retrieve product images. Its database is ODbL 1.0; individual contents and images have separate rights. Any later derivative database must preserve the applicable ODbL share-alike conditions. No Open Beauty Facts product records have been imported into the local seed yet.

## Evidence policy

Each imported factual attribute is linked to its Scento perfume page and a dated dataset record. JBAE assigns these claims status `reported`, not `verified` or `cross_checked`, because JBAE has not independently revalidated each perfume page. The source's own curation claim is not treated as an independent JBAE verification.

The evidence records include the source URL, publisher, snapshot date, license, attribution and a review note. Strict comparisons therefore exclude seed-only claims by default; a caller must consciously permit reported evidence or add independent corroboration.

The source's `character` terms are kept as `characterTraits`; they are not relabeled as standardized accords. The source's 14-family classification is retained with its Scento system label rather than represented as a universal taxonomy.

## Fields and omissions

Where supplied, the library retains house, release year, perfumers, concentration label, Scento family, secondary family, character traits, season, time of day, note pyramid, all-notes list, short description and source rank.

This snapshot does not provide reliable per-product prices, local availability, bottle sizes, images, measured longevity, measured sillage or projection. Those fields must come from additional authorized and traceable sources; no values are fabricated. `sourcePopularityRank` is a source catalog rank and is not a JBAE quality score.

## Build and import

Build a validated Knowledge Store snapshot and supporting house/material reference file:

```bash
npm run build:fragrance-library
```

The generated files are written to ignored `dist/fragrance-library/`:

- `scento-knowledge-snapshot.json`: schema-v2 products plus field-scoped evidence.
- `scento-supporting-reference.json`: houses and materials reference catalogs.\n- `scento-library-coverage.json` and `scento-library-coverage.md`: generated source-field coverage and distribution reports.
- `fragrance-quality-audit.json` and `fragrance-quality-audit.md`: evidence-link integrity, source/status distribution and performance-estimate readiness.

The exported `importScentoFragranceLibrary()` function merges the snapshot into an already-open KnowledgeStore. Its merge is non-destructive and idempotent for identical IDs. With a `CapacitorSQLiteKnowledgeAdapter`, the same import path can seed the app's local SQLite store once the Android shell and native plugin exist.

## Generated coverage report

The build also emits an auditable coverage report from the normalized source records:

- `scento-library-coverage.json`: machine-readable totals, field-presence counts, note-pyramid completeness and distributions.
- `scento-library-coverage.md`: human-readable coverage tables and frequency summaries.

The report includes release-year, perfumer, concentration-label, family, character, season, time-of-day, note-tier, all-notes and description coverage. It also summarizes concentration labels, Scento primary/secondary families, houses and the most common pyramid notes. A note is counted at most once per perfume in the frequency summary.

Coverage is a measure of whether the snapshot contains a source value. It is **not** a measure of factual accuracy, fragrance quality, similarity quality, longevity, sillage or independent verification. Missing values remain missing; no enrichment is inferred by the report. The CI workflow publishes the JSON and Markdown reports as a 30-day artifact named `fragrance-library-coverage`.


## Source records

- Dataset repository: https://github.com/Scento-com/perfume-dataset
- Database: https://www.scento.com/perfume-database
- API documentation: https://www.scento.com/developers/perfume-api
