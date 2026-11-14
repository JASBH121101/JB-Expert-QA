# Fragrance recommendation quality audit — baseline

## Audited snapshot

The current seed is the Scento Perfume Database snapshot dated 2026-10-29 (CC BY 4.0), with 1,479 perfume identities, 160 houses, 420 note/material references and 20,280 field-scoped evidence records.

The source fields are imported with status `reported`, not `verified` or `cross_checked`. The evidence records retain the product page, snapshot, license and attribution. This is traceable provenance, but it is not independent validation of the product claims.

## What the seed can support

The seed provides attributed perfume identity, house, release year where present, perfumer credits where present, source family/character tags, season/time-of-day tags and note pyramids. Its 1,388 complete pyramids (93.8%) measure note-field presence only.

The seed does not provide measured per-product longevity, projection duration, projection level, intensity level or sillage measurements. It therefore cannot, by itself, support customer-facing performance ranges such as “5–7 hours”. These values must remain unavailable until separately sourced and reviewed.

## Recommendation safeguards

1. Do not infer longevity or projection from concentration, notes, family, marketing descriptions or product type.
2. Require a lower and upper endpoint for each interval.
3. Require a field-matched evidence record for each endpoint.
4. In strict mode, require verified/cross-checked independent-test evidence for both bounds.
5. Keep reported community observations separately labelled and opt-in only.
6. Block unresolved conflicts, mixed evidence classes and incomplete intervals.
7. Optimize long-lasting profiles using the conservative lower bound; keep the upper bound for explanation only.
8. Keep intensity, projection, projection duration and sillage as different data dimensions.
9. Keep decants and official samples/travel sprays as package units linked to a canonical fragrance identity, not new scent identities.
10. Keep traditional attar, concentrated perfume oil and attar-labelled perfume oil as distinct product formats.

## Current code changes

The fragrance adapter now accepts explicit formats for traditional attars, concentrated perfume oils, attar-labelled perfume oils, body oils, lotion/cream, decants, manufacturer samples and travel sprays. Legacy `attar_oil` and `body_lotion` remain readable for compatibility. A decant requires a canonical `parentFragranceId` and positive package volume.

The performance profile API refuses to fabricate ranges and returns explicit unavailable reasons. The recommendation engine supports ordinal intensity/projection/sillage scales and a `soft_daily` profile. The long-lasting profile ranks by the minimum longevity bound, never by a made-up midpoint or the best-case endpoint.

## Reproducible artifacts

Run `npm run build:fragrance-library` to generate the normal field-coverage reports and the separate quality audit:

- `dist/fragrance-library/fragrance-quality-audit.json`
- `dist/fragrance-library/fragrance-quality-audit.md`

The quality report is a structural/provenance audit. It does not certify fragrance truth, universal customer experience or commercial product quality.
