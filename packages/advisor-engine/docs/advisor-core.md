# Advisor Core

## Responsibility

Advisor Core coordinates the deterministic flow for Fragrance Advisor and Tech Advisor. It validates the request, selects the domain adapter, normalizes candidate product data, connects the local evidence ledger when configured, and invokes the Recommendation Engine. For fragrance requests it can also parse explicit customer wording, match preferences and build a customer-facing explanation.

## Request contract

`AdvisorCore.advise()` requires:

- `domain`: `technology` or `fragrance`.
- `products`: 2–4 candidate products with unique IDs.
- Recommendation criteria: provide an ordered `priorities` array or a supported `profile`. A recognized fragrance `customerMessage` can infer a default profile; an unrecognized message does not substitute for recommendation criteria.

Optional values:

- `customerMessage`: up to 2,000 characters; conservative Spanish/English phrase extraction is enabled for fragrance only.
- `preferences`: structured fragrance preferences. Explicit structured values override values inferred from `customerMessage`.
- `minimumScoredCoverage`: request-level recommendation coverage threshold override.
- `minimumMatchCoverage`: fragrance preference-match coverage threshold override.
- `evidencePolicy.allowReported`: explicit opt-in to reported evidence. Default is false.

Technology requests pass through `normalizeTechnologyProduct()`; fragrance requests pass through `normalizeFragranceProduct()`. IDs must be unique, and the downstream comparison engine rejects mixed device or fragrance product types.

## Fragrance intent and matching

The customer-message parser emits only recognized signals and marks unsupported or empty intent for clarification. It normalizes common Spanish accents and terms, including occasion, climate, intensity, projection, scent families, selected notes and long-lasting priority. Conflicting intensity requests are not resolved by guessing.

Explicit `preferences` take precedence over extracted values. The preference matcher returns candidate-level scores, coverage, constraints, exclusions, evidence status, caveats and tie/no-match outcomes. Non-intrusive requests are enforced as hard ceilings for intensity, projection and sillage; unknown values do not pass those constraints. A candidate missing a required ceiling attribute can therefore be excluded rather than described as compliant.

The customer-facing explanation uses the matched candidate and its eligible evidence only. A tie, no-match result or unclear intent produces an explicit non-recommendation/clarification response. A long-lasting request may influence ranking priorities, but it does not create a duration interval.

## Evidence boundary

A KnowledgeStore or EvidenceStore may be injected when constructing the AdvisorCore, but not both. If no evidence store is connected, the recommendation and matching outputs mark evidence as `not_assessed`. When connected, criteria only use evidence-eligible values under the strict evidence policy, unless reported evidence is explicitly enabled.

The core does not perform web research, call external AI services, mutate verified records, or write to the KnowledgeStore during `advise()`.

## Result

The immutable result includes:

- Engine ID, domain, candidate count, normalized candidate identities/categories and evidence mode/ledger size.
- Full explainable `recommendation` result.
- Fragrance-only `customerIntent`, `preferenceMatch` and `customerExplanation` when applicable.
- Fragrance `performance` profiles with eligible longevity/projection intervals and separately evidenced intensity/projection/sillage labels.
- Fixed `limitations` describing candidate discovery, source verification, scoring and performance boundaries.

Missing, conflicting, reported-only (without opt-in), or incomplete evidence returns an explicit unavailable status instead of a fabricated estimate.

## Non-goals

Network discovery, OCR intake, live source refresh, APK/UI actions and product publishing remain separate layers. A recommendation is only as grounded as the candidate attributes and evidence provided to the core.

For package installation, SQLite initialization, host-side candidate retrieval and release gates, see [JB Manager integration contract](./jb-manager-integration.md).
