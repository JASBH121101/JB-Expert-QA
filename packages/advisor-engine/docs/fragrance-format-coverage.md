# Fragrance format coverage and source review

**Reviewed:** 2026-11-08  
**Status:** research ledger only; no external product rows imported.

## 1. Body mists — bounded Open Beauty Facts expansion

Open Beauty Facts remains the only enabled structured open-data discovery source for body mists in this phase.

- Query: `category:body-mists`, using the structured API v2 `categories_tags_en` filter.
- Search window: pages 1–3, maximum 10 source products per page (30 raw source rows per smoke run).
- Provider validation rejects pages above 3 and any cosmetic categories outside body mists.
- Candidate gate: valid 8–14 digit GTIN, product name, and an explicit `body-mists` source category tag.
- Review payload: GTIN, name, brand, categories, category tags, INCI text, package quantity/unit and source last-modified timestamp. Images are excluded.
- Deduplication key: GTIN. Results remain unconfirmed research candidates and are not added to the seed automatically.

A bounded three-page result is not a total-catalogue census. Products missing a valid GTIN or exact body-mists tag are intentionally omitted. Records carrying contradictory category tags such as `suncare` are rejected even if OBF also marks them as body mists. In the 2026-11-08 smoke, the Nivea refreshing mist suncare record (GTIN 8850029003177) was rejected for this reason. An empty or small result does not prove that no other body-mist products exist.

## 2. Attars and perfumed oils — no suitable open catalogue identified

The reviewed open perfume datasets are not attar/oil catalogues. Parfica's openly licensed fragrance-to-OBF file reports 237 matched fragrance identities; its product/brand name columns are CC0 1.0 and its OBF-derived EAN/INCI/URL columns are ODbL 1.0. The checked file yielded no name/brand matches for the terms attar, mukhallat, perfume oil, fragrance oil, body mist, hair mist or decant. That is a snapshot-level search result, not proof of global absence.

No comprehensive row-level attar/perfume-oil dataset with verified commercial reuse rights has been admitted to JBAE. The 10ML and Scento fragrance datasets primarily describe alcohol-based perfume profiles, retail/decant demand and prices; they do not establish attar or oil product coverage.

### Individual official manufacturer references (manual research only)

These official product pages establish that the named manufacturers sell oil-format products. They do **not** grant a bulk catalog reuse license. Only concise factual identity/type/size/SKU observations are recorded here; descriptions, photos, prices and stock states are not copied into JBAE.

| Manufacturer reference | Source-reported format | Size / identifier | Intake status |
|---|---|---|---|
| Al Haramain Attar Al Kaaba | Concentrated perfume oil; official product page also labels it an attar | 25 ml; SKU AHP1152 | Strong manual identity/type example; not imported |
| Al Haramain Ajmer | Concentrated perfume oil; alcohol-free, presented within an attar context | 15 ml; SKU AHP1831 | Strong manual oil-format example; not classified as traditional natural attar |
| Al Haramain Zamzam | Concentrated perfume oil; alcohol-free; described as part of the house's attar range | 15 ml; SKU AHP1832 | Manual oil-format example; not imported |
| Swiss Arabian Attar Mubakhar | Concentrated perfume oil; marketed as an attar | 20 ml | Manual attar-labelled oil example; not imported |
| Arabian Oud Mukhallat Nagham | Listed in the manufacturer's Perfume Oils & Attar collection; described as a perfume-oil blend | 1/4, 1/2 and 1 tola variants; preserve source unit (no ml conversion) | Collection-page reference only; exact SKU/type not inferred |

**Taxonomy rule:** an attar-labelled modern concentrated perfume oil is not automatically equivalent to a traditional distilled attar/itr. Keep manufacturer-reported format terminology, alcohol-free claim and actual composition as separate claims. Do not infer that a perfume oil is natural, alcohol-free or traditional unless the source explicitly supports that fact.

Manufacturer references:
- https://us.alharamainperfumes.com/en/haramain-attar-al-kaaba-25ml.html
- https://shop.alharamainperfumes.com/uae/al-haramain-ajmer-pure-perfume-oil.html
- https://shop.alharamainperfumes.com/default/al-haramain-zamzam-pure-perfume-oil.html
- https://us.swissarabian.com/products/attar-mubakhar
- https://my.arabianoud.com/en/perfume-oils/c262185198 (collection page; oil sizes shown in tola, do not convert to ml)
- https://my.arabianoud.com/en/perfume-oils/c262185198

## 3. Decants — separate package units from fragrance identity

Two CC BY 4.0 public datasets provide bounded commercial-format evidence:

- **Scento Fragrance Index:** aggregate demand observations from Scento's own paid European decant orders (October 2025–September 2026). It reports decant sizes of 0.75, 2, 5, 8 and 30 ml and aggregate rankings/segments. It is not a global demand survey or a product master.
- **10ML Price-per-ml Index:** 3,343 checked rows for 3, 10 and 30 ml decants, plus full-bottle references. Prices are 10ML member prices in EUR including VAT for a curated European catalogue. They are not Nicaragua retail prices, local competitive prices or valid NIO margin inputs.

These datasets are useful for learning which package sizes exist in those sellers' operations and how they structure decant offers. They do not authorize automatic local pricing or product imports.

**JBAE modelling recommendation:** retain one canonical fragrance identity and represent each decant as a derived package/sale unit linked to that fragrance (for example, 2 ml, 5 ml, 10 ml). Track source bottle/lot, decanter, volume, packaging and provenance separately. Distinguish seller-prepared decants from manufacturer-issued samples and official travel sprays. Do not create duplicate fragrance identities just because the same scent is sold in multiple decant sizes.

## 4. Data decisions

| Format | Best evidence available in this review | Current JBAE decision |
|---|---|---|
| Body mist | Open Beauty Facts structured body-mists tags; manual manufacturer cross-checks where available | Bounded pages 1–3; candidate-only, GTIN dedupe, no automatic import |
| Traditional attar/itr | No clean open row-level product catalogue established | Keep separate; manufacturer-authorized/manual references only |
| Attar-labelled concentrated perfume oil | Individual official manufacturer product pages | Research-only until reusable source or explicit intake authorization |
| Other perfume oils | Individual official manufacturer product pages; broad cosmetics datasets are noisy | Research-only; do not merge with body oils or traditional attars |
| Decants | Scento and 10ML CC BY 4.0 aggregate datasets | Format and demand research only; model as package units linked to parent fragrance |

## 5. Non-negotiable intake checks

Before any record enters the reusable fragrance library, verify exact brand/name/variant, product type, concentration or oil format, size/unit, source record and canonical URL, source date, field-level provenance, license/reuse basis, and whether any source images or third-party text are excluded. A barcode helps distinguish a retail SKU but does not prove the formulation, notes or performance.
