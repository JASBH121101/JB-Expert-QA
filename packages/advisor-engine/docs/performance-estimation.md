# Fragrance performance estimates

## Customer-facing contract

JBAE may show an estimated interval only when a product contains both positive endpoints and both endpoints have field-matched evidence. Examples:

- Longevity: `longevityMinHours` and `longevityMaxHours`.
- Projection duration: `projectionDurationMinHours` and `projectionDurationMaxHours`.

The normalized input convenience fields are `longevityRange: { min, max }` and `projectionDurationRange: { min, max }`. Each endpoint still needs its own evidence record and evidence ID. An exact scalar such as `longevityHours: 6` is not converted to `5–7`, nor is any artificial tolerance added.

The `buildFragrancePerformanceProfile()` API returns a range only when both endpoints are supported. In strict mode, each must be `verified` or `cross_checked` and come from an `independent_test` source. Conflicts, missing links, unconfirmed values, and reported-only claims are not displayed. `allowReported: true` permits `reported` observations from community or independent-test sources, but the result is labelled as a reported observation with limited evidence strength.

## Keep dimensions separate

- **Longevity:** how long the fragrance remains perceptible on skin.
- **Projection duration:** how long it projects beyond the immediate skin area.
- **Projection level:** how far or strongly it radiates, represented here with an ordinal category.
- **Intensity:** perceived strength of the scent.
- **Sillage:** the trail left behind.

Projection distance is not projection duration. Intensity is not longevity. Sillage is not projection. None is inferred from notes, concentration, perfume type, or marketing copy.

## Evidence expectations

An independent wear-test record should identify the exact product/version, measured field, value, source, date and test context. Where available, record application amount, application locations, skin/climate conditions, tester count and observation method in the source note or supplemental test record. The evidence source must describe the test rather than merely repeat promotional claims.

Each field endpoint uses a separate evidence record. For a 5–7 hour longevity interval, one record supports 5 hours and a second supports 7 hours. Both records must reference the same canonical product ID and their matching field names. The engine does not average incompatible or conflicting sources into a range. Supporting URLs listed under one evidence record are references, not additional independent sources; the profile counts primary evidence-source URLs separately from supporting references when describing evidence strength.

## Interpretation and customer disclaimer

A range is an estimate of observed performance conditions, not a warranty or promise. The UI/customer explanation should include a concise qualification: results vary by skin, application, temperature, humidity and individual perception. Stored evidence confidence is not a calibrated probability.

## Audit

The library build generates:

- `fragrance-quality-audit.json`: machine-readable provenance and readiness metrics.
- `fragrance-quality-audit.md`: readable audit summary.

The audit separates catalog completeness, evidence links, reported claims and independently tested performance. Field presence or linked provenance alone is not proof that a claim is true.
