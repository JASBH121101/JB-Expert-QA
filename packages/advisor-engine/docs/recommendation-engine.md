# Recommendation Engine

## Inputs

Provide 2–4 normalized products from one domain and either an ordered `priorities` array or a named domain profile. Every priority has a field and positive weight. Priority order is preserved for explanations, while weights control the score. Price fields use lower-is-better; quality, suitability and endurance fields use higher-is-better.

## Fragrance profiles

- `hot_humid_daily`: climate suitability, versatility and balanced projection, with softer-intensity and closer-projection preferences as secondary criteria.
- `office`: versatility, discreet projection, freshness, lower intensity/projection/sillage and conservative longevity.
- `evening`: conservative longevity bound, projection balance, complexity and occasion fit.
- `fresh_light`: freshness, climate suitability, discretion, lower intensity and closer projection.
- `soft_daily`: explicitly favors softer intensity, closer projection, lower sillage, freshness and versatility.
- `long_lasting`: ranks by the **minimum** documented longevity bound, with minimum projection-duration as a secondary consideration.
- `budget`: price and versatility, with the minimum documented longevity bound as a secondary criterion.

Technology profiles remain photography/video, gaming, productivity, premium, autonomy and balanced.

Profiles are starting points, not universal truths. Caller-supplied priorities override profile priorities. Ordinal fragrance fields use explicit documented scales: intensity (soft to very strong), projection (close to very strong) and sillage (low to very strong). They are not inferred from notes or concentration.

## Decision policy

The engine uses the Evidence-aware Comparison Engine. When an EvidenceStore is supplied, the strict evidence policy is applied: verified/cross-checked claims count by default; reported claims require explicit opt-in; unconfirmed and conflicting facts are excluded.

A winner is recommended only when it has non-null score and meets `minimumScoredCoverage` (default 60%). Ties remain ties. When coverage is insufficient, no winner is returned.

## Explainability

Each candidate includes position, score, data and evidence coverage, evidence confidence, scored attribute breakdown, strengths, compromises and caveats. Evidence confidence is not the product-quality score and is not a calibrated probability.

## Performance interval policy

A fragrance duration interval requires both lower and upper bounds, and both bounds must have matching evidence. The built-in profiles optimize the conservative lower bound (for example, 5 hours in a 5–7 hour estimate); the upper bound is retained for customer-facing context but is not used to inflate the ranking. A single `longevityHours` value is not treated as an interval and is no longer a built-in recommendation criterion.

Intensity, projection, projection duration and sillage are separate dimensions. Projection distance is not the same thing as projection duration. A soft-intensity classification does not establish short longevity, and a long-lasting fragrance does not necessarily project strongly.

## Limitations

The engine does not infer longevity, projection or sillage from concentration, note pyramids, marketing language or product type. Performance intervals require field-matched, independent-test evidence for both endpoints. Reported community observations may be surfaced only through an explicit `allowReported` opt-in and remain labelled as reported. Ranges are estimates, not guarantees; skin, application, temperature and humidity can change real-world results.

Numeric values must use consistent units and comparable measurement methods. Scores are relative to supplied candidates, not universal ratings.

## Category safety and result ordering

Product types remain distinct: fine fragrance, body mist, body spray, traditional attar, concentrated perfume oil, attar-labelled perfume oil, body oil, lotion/cream, decant, manufacturer sample and travel spray. Legacy `attar_oil` and `body_lotion` values remain readable for compatibility, but new records should use explicit types. Decants require a `parentFragranceId` and a positive package volume; they are package units linked to a canonical fragrance identity, not new scent identities.

The displayed recommendation ranking puts candidates meeting the scored-coverage threshold first, then sorts by relative score. Products below the threshold remain visible with an explicit ineligible status; they cannot displace a sufficiently documented recommendation.
