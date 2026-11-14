# Fragrance customer intent

## Purpose

The deterministic intent parser converts explicit customer wording into structured fragrance preferences before catalog matching. It is deliberately conservative and does not call an AI provider or invent missing preferences.

## Supported signals

- Occasion: daily/day, office/work, evening/night. Evening takes precedence; an explicit daily-use signal takes precedence over work when both are present.
- Climate: hot/humid/tropical and cold/winter.
- Intensity and projection: soft/subtle/discreet wording sets soft intensity and close projection. Strong/intense wording sets strong intensity and projection. Contradictory soft/strong wording does not cause the parser to guess.
- Non-intrusive limits: wording such as “no hostigoso”, “no invasivo” or “not overpowering” sets hard maximums of moderate intensity, projection and sillage. These are constraints, not an inferred claim about the product.
- Character: fresh/clean.
- Families: citrus (including cítrico/cítrica/cítricos/cítricas), floral, woody, gourmand, aromatic, aquatic and amber.
- Selected notes: common Spanish/English notes such as bergamot, lemon, lavender, jasmine, rose, vanilla, amber, musk, cinnamon, coconut, leather, patchouli and oud.
- Performance priority: explicit requests for long wear select the `long_lasting` recommendation profile.

Spanish accents are normalized. Explicit structured preferences supplied by the caller override inferred preferences. Unknown messages return `needsClarification: true` when no supported signal is found; when one dimension is contradictory, the parser leaves that dimension unresolved rather than selecting one side.

## Integration

Pass `customerMessage` to `AdvisorCore.advise({ domain: "fragrance", products, customerMessage })`. The response includes `customerIntent` (recognized preferences and signal trace), an explainable `preferenceMatch`, and `customerExplanation` with customer-facing Spanish copy. The explanation only names matched preference criteria and only displays duration/projection intervals that have already passed the evidence policy. A tie, no-eligible-match result or unclear intent does not produce an arbitrary winner.

Explicit structured values in `preferences` take precedence over values inferred from the message. The host application should present follow-up questions when a requested dimension remains ambiguous or required product attributes are missing.

A long-lasting request selects the existing conservative `long_lasting` profile. It does not create duration values. The profile can only score candidate attributes supplied to the engine; evidence-backed performance ranges remain governed by the performance evidence policy.

## Safety and limitations

- Phrase matching is deterministic and bounded; it is not a substitute for a follow-up question when wording is ambiguous.
- A parsed preference is a customer request, not a product fact.
- Non-intrusive ceilings require recorded `intensityLevel`, `projectionLevel` and `sillageLevel`; unknown values do not pass the constraints.
- The parser does not infer allergy, skin chemistry, gender, age, budget or product performance.
- Avoided-note checks remain hard exclusions and require complete note coverage; missing note data cannot be interpreted as absence.
- The engine ranks only the candidates supplied to the advisor.
- Reported observations are not independently verified unless an evidence policy explicitly allows them for a particular operation; they are never silently promoted to verified status.
