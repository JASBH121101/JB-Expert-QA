# JB Expert QA — Language QA Engine

## Purpose

Language QA is a deterministic, free-first development tool for checking translation resources during NEXORA development. Its library is not shipped as a dependency in customer installations.

The initial supported locales are:

- **es-419** — Latin American Spanish (default and fallback).
- **en** — English.

The legacy locale label **es** and an explicit allowlist of Latin-American aliases (including **es-NI**, **es-MX** and **es-419**) normalize to **es-419**. English regional aliases such as **en-US** and **en-GB** normalize to **en**. Unsupported or malformed tags are rejected instead of being silently collapsed. **es-ES is deliberately not mapped to es-419**, because European Spanish is not the same locale commitment as Latin-American Spanish.

## What is included

- Static comparison of Laravel PHP translation arrays and JSON translation objects.
- Nested key flattening and missing/obsolete/empty key detection.
- Exact placeholder parity checks for Laravel :name, {name}, {{ name }} and positional printf placeholders.
- A curated bilingual glossary for consistent core product terminology.
- Deterministic glossary suggestions with no network call, no provider selection and no automatic approval.
- Semantic-integrity signals for suspicious unchanged copy and protected URLs, email addresses, HTML tag structure and numeric literals.
- Translation memory API with exact source/locale/context lookup and explicit stale state.
- Human review states: pending, partial, review-required, approved and stale.
- Project-audit integration and a dedicated language-audit CLI.

## Run

From the JB Expert QA repository:

~~~sh
npm run audit:language -- /path/to/project
~~~

Optional locale arguments:

~~~sh
npm run audit:language -- /path/to/project --source=es-419 --target=en
~~~

The full project auditor also runs the language resource check when a supported lang/ directory exists.

## Safety and review policy

The PHP parser accepts only a static returned associative array made of literal strings, scalar values and nested arrays. It does not execute PHP, include files, evaluate expressions or interpolate variables. Unsupported PHP is reported as a parse finding so a developer can review it manually.

The tool does not translate arbitrary text with an AI provider. Glossary suggestions are terminology hints, not complete translations. Glossary mismatch findings are low-confidence advisory findings and require review.

Structural and semantic-integrity checks never certify meaning, tone, legal wording or cultural suitability. The new semantic checks are deterministic signals: identical source/target copy can be intentional (for example, a brand name), and numeric formatting may legitimately vary. Findings therefore require human review and are not proof of a mistranslation. A translation is only marked **approved** when a named human reviewer explicitly records approval against the exact SHA-256 fingerprints of both the flattened source and target maps. The fingerprints are canonicalized by key order, so equivalent maps produce the same digest regardless of insertion order. Approval without both fingerprints, an approval for different content, missing keys, empty values, placeholder mismatches, obsolete keys or message-shape mismatches cannot produce an approved result. Any source or target content change invalidates the prior approval and requires a new review.

TranslationMemory remains an in-memory API. An entry is pending by default. The legacy `approved: true`, `reviewer` and `reviewedAt` flags are rejected because they are not bound to the reviewed text. To approve an entry, call `fingerprintTranslationMemoryEntry` with its source, target, locale pair and context, create a review with `recordTranslationReview` using both returned hashes, then pass that review record to `memory.add({ ...entry, review })`. Changing either string, locale or context invalidates the review. Entry and review inputs are inspected through own data descriptors; accessors and symbol keys are rejected without invoking getters.

Durable storage, collaborative review UI, TM import/export and per-key persisted approvals are follow-up work; no database schema is silently added in this phase.

## Current limits

- Supported resource files: .php static Laravel arrays and .json objects.
- Unsupported: executable PHP, arbitrary PHP expressions, YAML, PO/POT, XLIFF, ICU message syntax validation and framework-specific dynamic translation functions.
- Maximum: 500 files per locale and 2 MB per individual resource.
- The glossary is an initial curated set and can produce false positives; its findings are advisory.
- Semantic checks protect measurable content and flag likely untranslated copy, but do not infer meaning or assess fluency; identical words and numeric representations may be valid in context.
- No AI provider is called by the deterministic Language QA audit. The optional AI router remains disabled by default.
- Gemini requires an explicit `GEMINI_FREE_TIER_CONFIRMED=true` for the allowlisted `gemini-3.1-flash-lite` model, or `GEMINI_BILLING_APPROVED=true` for any other model. A key alone is insufficient. Do not set either flag without checking the Google AI Studio project's actual billing tier.
- Google's published Gemini API pricing distinguishes Free and Paid tiers; its Free tier states that submitted content may be used to improve products. Do not send sensitive or confidential catalogs under that tier unless the data-use terms have been approved. See [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing).
- Cloudflare Workers AI likewise requires an explicit free-tier confirmation and is limited to its allowlisted free-tier models and local per-run request budget; the service documents a daily free allocation and charges on Workers Paid above that allocation. See [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/).
- The auditor checks structure and a limited glossary. It does not claim native-speaker quality assurance.

## Ownership

**JB Expert QA / Language QA Engine** owns this library. NEXORA consumes only language resources reviewed and approved for use. The tool is not a NEXORA customer-runtime dependency.


## Structural audit hardening

Nested leaf-versus-object changes are reported as `message-shape-mismatch` rather than a confusing pair of missing and obsolete keys. The test suite covers malformed locale tags, unsupported regional aliases and nested structural mismatches. The audit remains deterministic and dependency-free.


## Semantic integrity validation

`auditTranslationSemantics` operates on flattened string maps and reports review-only findings for identical source/target text and differences in URLs, email addresses, HTML tag order/structure or numeric literals. `auditTranslationMaps` includes these findings in its result counts and the Language QA specialist exposes them to the project auditor. Use `allowUntranslatedKeys` for approved brand names or other intentionally shared labels. No finding is auto-approved, and no semantic model or network provider is required.


## CLDR plural-catalog bridge (Language QA 2.0)

`auditTranslationCatalogs` validates complete locale catalogs through the shared Localization Engine while enforcing Language QA's supported locale policy (`es-419` and `en`). It detects missing CLDR plural categories, message-shape changes and plural placeholder inconsistencies. Locale aliases are normalized before validation and duplicate aliases are rejected.

This bridge is an audit integration, not a translation provider. Findings remain review-required and are never auto-approved. The runtime relies on Node's built-in `Intl`/ICU data; it adds no third-party dependency or network call.

The bridge snapshots input catalogs using own-property descriptors before delegation. Accessors, symbol keys, prototype-sensitive keys, unsupported object types, excessive nesting and catalogs above 10,000 entries are rejected without executing getters. This protects the shared Localization Engine from unsafe caller-supplied objects.


## Content-bound translation approval

`recordTranslationReview({ state: "approved", reviewer, reviewedAt, sourceHash, targetHash })` requires the two SHA-256 fingerprints returned by `auditTranslationMaps`. `resolveTranslationState` gives structural integrity findings precedence over human approval and returns `review-required` when fingerprints do not match the current maps. Semantic findings may still be accepted only by a named reviewer against that exact content snapshot. These hashes are integrity bindings, not cryptographic reviewer signatures or an identity provider.


## Current regional locale policy

The initial two-locale policy above is historical. The current supported set is aligned with the shared Localization Engine and contains these 12 canonical locales:

- Spanish: `es-NI`, `es-419`, `es-MX`, `es-ES`.
- English: `en-US`, `en-GB`.
- Portuguese: `pt-BR`, `pt-PT`.
- French: `fr-FR`.
- German: `de-DE`.
- Italian: `it-IT`.
- Arabic: `ar`.

The default and safe fallback remain `es-419`. Canonical tags and underscore-separated aliases are normalized. Exact supported regional variants are preserved; approved Latin-American Spanish regions not individually represented in the set normalize to `es-419`. Base language aliases map deterministically to `en-US`, `pt-BR`, `fr-FR`, `de-DE`, `it-IT` or `ar`. `es-ES` remains distinct from Latin-American Spanish. Unsupported languages, unsupported Spanish regions, malformed tags, script subtags and Unicode extensions are rejected.

The curated bilingual glossary currently covers English and the Spanish glossary family (`es-419`, `es-NI`, `es-MX`). It does not claim to provide translated glossary dictionaries for Portuguese, French, German, Italian or Arabic. For locale pairs without a dictionary, it returns no suggestion, sets `requiresHumanReview` and never auto-approves. CLDR catalog validation uses the shared Localization Engine for the supported locale set; passing structural validation does not certify translation meaning, fluency or cultural suitability.


## Deterministic performance baseline

Run the Language QA microbenchmark locally with:

~~~sh
npm run benchmark:language-qa
~~~

Optional controls:

~~~sh
JB_LANGUAGE_QA_BENCH_ITERATIONS=100 JB_LANGUAGE_QA_BENCHMARK_OUTPUT_DIR=/tmp/jb-language-qa-benchmark npm run benchmark:language-qa
~~~

The benchmark measures locale normalization, nested translation-map flattening, source/target audits at two sizes, CLDR catalog auditing across the 12 supported locales, and exact Translation Memory lookup. It records mean, median, p95, p99, throughput, CPU time, RSS and heap deltas. Synthetic local data is used; no AI provider, network request, paid service or third-party benchmark dependency is involved.

The benchmark uses 100 measured samples per scenario by default (minimum 20), after two warmups, so its p95/p99 estimates are more useful than a handful of runs. The engine certification workflow executes it on Ubuntu and Windows with Node.js 22 and 24 and uploads JSON/Markdown evidence per matrix job. Results are informational rather than machine-dependent pass/fail thresholds. Compare only equivalent runner images, Node versions and workloads; a successful benchmark validates its functional invariants but does not by itself certify translation fluency or cultural quality.


## Regional style review signals

The regional-style auditor adds advisory findings for a curated set of visible regional variants: US/UK English spelling, selected Peninsular-Spanish vocabulary in Latin-American targets, and selected Latin-American vocabulary in the `es-ES` target. Findings include the term, target locale and a suggested alternative. They are low-severity review signals only: they do not rewrite copy, prove that a phrase is incorrect, or block a human approval. Product names, quotations, audience, and context may make a variant intentional.

The rules are intentionally conservative and incomplete. A clean result does not certify regional fluency. Regional terminology outside the curated list, register, tone, intent and cultural suitability still require a reviewer familiar with the target audience. This check is deterministic, network-free and has no provider or paid-service dependency.
