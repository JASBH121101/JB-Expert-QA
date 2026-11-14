# Comparison Engine — evidence-aware milestone

## Contract

Compare 2–4 products from exactly one domain. Each product supplies a stable ID, display name, domain, and normalized attributes. Criteria explicitly declare field, positive weight, and direction: higher, lower, target, or match. If category metadata is provided, all candidates must share the same technology device type or fragrance product type.

## Evidence-linked mode

Pass an `EvidenceStore` as `evidenceStore`. Each product may then provide `evidenceIds`, an object mapping attribute fields to arrays of evidence record IDs. Every referenced record must exist and match the product domain, subject ID, field, and exact value. Invalid references fail fast rather than being silently ignored.

In evidence-linked mode:

- Only `verified` and `cross_checked` claims contribute to ranking by default.
- `reported` claims are excluded unless the caller explicitly sets `evidencePolicy: { allowReported: true }`.
- `unconfirmed`, missing evidence, and unresolved conflicting claims are excluded from scoring.
- Conflicts are detected across all stored evidence for the same domain, subject, and field, even when the product points to only one of the conflicting claims.
- A conflict is not automatically resolved by confidence, timestamp, or source type.

Without an EvidenceStore, the engine preserves the earlier attribute-only behavior and explicitly returns `evidenceMode: "not_assessed"`. Such scores must not be described as fact-checked.

## Scoring and coverage

Numeric criteria are normalized relative to the products in the current comparison. Match criteria compare values to an explicit target. Weighted scores are calculated only from fields eligible for scoring.

- `coverage`: weighted share of criteria with a supplied attribute value.
- `scoredCoverage`: weighted share of criteria that actually contributed to the score.
- `evidenceCoverage`: weighted share backed by evidence accepted under the selected policy.
- `verifiedCoverage`: weighted share backed specifically by `verified` or `cross_checked` evidence.
- `evidenceConfidence`: weighted mean of the accepted records' stored confidence values. This is not a calibrated probability and is not part of the product-performance score.

Coverage values are percentages. Evidence confidence is in the 0–1 range.

## Safety and interpretation

- No missing value is imputed.
- No cross-domain comparisons are allowed.
- A product with excluded evidence may retain a partial score; its lower scored coverage must be visible.
- The engine returns no winner when every product lacks eligible comparable data.
- Equal top scores return a tie rather than an invented winner.
- Scores are relative rankings, not absolute quality or truth.
- Numeric attributes must already use common units and comparable measurement methods.
- Evidence links are validated for identity and value consistency. The engine does not independently authenticate the source or prove that a source's claim is true.

## Implemented domain adapters

The Technology and Fragrance adapters are implemented and exported through the public engine entry point. They normalize their own product types, explicit units and evidence-ID containers. They remain separate: technology metrics cannot be ranked with fragrance metrics, and category guards prevent unlike device/product types from being compared when category metadata is supplied. Domain profiles are defined in the Recommendation Engine; callers remain responsible for selecting criteria appropriate to the product use case.
