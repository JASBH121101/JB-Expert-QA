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

Structural validation never certifies semantic accuracy, tone, legal wording or cultural suitability. A translation is only marked **approved** when a named human reviewer explicitly records approval. A later source/target change must be reviewed again.

The initial TranslationMemory implementation is an in-memory API. Durable storage, collaborative review UI, TM import/export and per-key persisted approvals are follow-up work; no database schema is silently added in this phase.

## Current limits

- Supported resource files: .php static Laravel arrays and .json objects.
- Unsupported: executable PHP, arbitrary PHP expressions, YAML, PO/POT, XLIFF, ICU message syntax validation and framework-specific dynamic translation functions.
- Maximum: 500 files per locale and 2 MB per individual resource.
- The glossary is an initial curated set and can produce false positives; its findings are advisory.
- No AI, online translation API, paid key, network transmission or external provider is used.
- The auditor checks structure and a limited glossary. It does not claim native-speaker quality assurance.

## Ownership

**JB Expert QA / Language QA Engine** owns this library. NEXORA consumes only language resources reviewed and approved for use. The tool is not a NEXORA customer-runtime dependency.


## Structural audit hardening

Nested leaf-versus-object changes are reported as `message-shape-mismatch` rather than a confusing pair of missing and obsolete keys. The test suite covers malformed locale tags, unsupported regional aliases and nested structural mismatches. The audit remains deterministic and dependency-free.
