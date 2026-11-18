# JB Localization Engine and Currency Engine — SCCM component certification

## Source snapshot and test evidence

- Repository: `JASBH121101/JB-Expert-QA`
- Source branch: `certify/currency-qa-engine-v1`
- Exact tested source commit: `7a2720ec176cde5a8fb607a9033819bcd871234d`
- Workflow: https://github.com/JASBH121101/JB-Expert-QA/actions/runs/44410116281
- Matrix: Ubuntu 24.04 and Windows 2022, each on Node.js 22 and 24; all 4 jobs passed.
- Every job ran both complete test files: `packages/localization-engine/tests/localization-engine.test.js` and `packages/currency-engine/tests/currency-engine.test.js`.

## Localization Engine

- `jb.localization-engine.runtime.canonicalization`: BCP 47 canonicalization, malformed locale handling and canonical output.
- `jb.localization-engine.runtime.fallback`: deterministic configured fallback, including catalog-order independence.
- `jb.localization-engine.runtime.dates-numbers`: Intl.NumberFormat and Intl.DateTimeFormat behavior.
- `jb.localization-engine.runtime.plurals`: separately certified by PR #167, preserving its original CLDR/Localization source snapshot.
- Existing module PASS assessment retained on its original source snapshot. The new branch/subbranch and three new components are bound to the exact current source snapshot above.

The package has no runtime translation-provider dependency. It does not download translations or auto-translate text. Product catalogs require human linguistic review. The tested contract supports simple scalar interpolation and cardinal plurals, not the complete ICU MessageFormat feature set.

## Currency Engine

- `jb.currency-engine.money.iso4217`: curated currency code/name/minor-unit metadata.
- `jb.currency-engine.money.minor-units`: strict decimal parsing, exact BigInt arithmetic and canonical serialization.
- `jb.currency-engine.money.fx`: validation of an explicitly injected FX rate contract, pair/provenance/timestamps, validity, rounding and timeout/cancellation.
- `jb.currency-engine.money.formatting`: locale-aware Intl formatting without changing stored minor units.
- Existing Currency Engine module PASS assessment retained on its original source snapshot. New branch/subbranch/components use the source snapshot above.

The registry is an operational subset, not a complete or automatically refreshed ISO 4217 list. No FX provider is bundled or contacted. No market-rate accuracy, tax, accounting, payment settlement or jurisdiction-specific compliance is certified.

## Explicit boundaries

- No new third-party runtime dependency.
- No paid translation or FX service.
- No external translation API and no automatic linguistic approval.
- No live FX provider or real transaction processing.
- PASS applies to the documented contracts and test matrix only; human review remains required where stated.
