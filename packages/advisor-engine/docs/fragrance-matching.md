# Fragrance preference matching

## Purpose

`matchFragrances({ products, preferences, minimumMatchCoverage })` performs deterministic preference matching over supplied fragrance candidates. It is a fit-to-preferences function, not a universal perfume-quality score and not a discovery or live-research operation.

## Supported preferences

- `preferredFamilies`: overlap against `attributes.scentFamilies`.
- `preferredNotes`: overlap against top, middle, base and/or all-note attributes.
- `avoidNotes`: hard exclusion when an avoided note is found. A candidate is also excluded when its note data is not sufficiently complete to verify the exclusion; an incomplete note pyramid is never treated as proof that an unwanted note is absent.
- `preferredCharacters`: overlap against `attributes.characterTraits`.
- `occasion`: exact normalized match against `timesOfDay` or `occasionTags`.
- `climate`: exact normalized match against `climateTags`.
- `intensity`: proximity to the requested ordinal level (soft, moderate, strong, very_strong).
- `projection`: proximity to the requested level (close, moderate, strong, very_strong).
- `productTypes`: optional allowlist of explicit product formats.

Text matching is case- and diacritic-insensitive. Missing data is not scored as a match. Coverage is calculated only across preference dimensions the customer actually supplied, so a customer who specifies one preference is not penalized for omitting the others.

## Result interpretation

Each candidate returns a weighted score, match coverage, eligibility, exclusions, matched criteria and a criterion-level breakdown. A candidate is eligible only if it is not excluded, has a calculable score and meets the minimum coverage threshold (60% by default). If no candidate qualifies, the engine returns `no_eligible_match` rather than forcing a winner.

The returned evidence note is intentional: matching uses catalog attributes and does not independently verify their truth. Reported Scento fields remain reported. Performance claims such as longevity and projection duration must continue to use `buildFragrancePerformanceProfile()` and its strict evidence gate; this matcher does not infer hours from notes, families, concentration or product type.

## Example

```js
import { matchFragrances } from "./src/index.js";

const result = matchFragrances({
  products: candidates,
  preferences: {
    preferredFamilies: ["citrus", "aromatic"],
    preferredNotes: ["bergamot", "lavender"],
    avoidNotes: ["vanilla"],
    occasion: "day",
    climate: "hot_humid",
    intensity: "soft",
    projection: "close",
  },
});

if (result.decision === "matched") {
  const bestFit = result.ranking.find(item => item.eligibility === "eligible");
  // Explain bestFit.breakdown and its evidenceNote to the customer.
}
```

The module is deterministic, offline-capable and read-only. It does not write to the catalog, change evidence status, call an AI provider or fetch new products.
