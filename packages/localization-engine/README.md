# JB Localization Engine

**Status:** v0.1.0 laboratory package.

## Responsibilities

- Canonicalize and resolve BCP 47 locale tags.
- Resolve explicit locale catalogs with deterministic fallback.
- Translate catalog keys with safe scalar interpolation.
- Support locale-specific cardinal plurals through Intl.PluralRules.
- Format numbers and dates through Intl.NumberFormat and Intl.DateTimeFormat.
- Expose text direction metadata for RTL languages.
- Audit missing catalogs, missing or obsolete keys, message-shape changes and placeholder parity.

The initial locale set is es-NI, es-419, es-MX, es-ES, en-US, en-GB, pt-BR, pt-PT, fr-FR, de-DE, it-IT and ar. A product must ship reviewed catalog content for each locale it claims to support. Registering a locale is not the same as translating the product.

## Runtime

The package has no runtime dependencies. It uses the Node runtime's ECMA-402 Intl implementation, which uses ICU/CLDR locale data. The package does not download translations and does not auto-translate content.

Catalogs are nested plain objects, with string entries or plural objects containing an other form. Placeholders use {name} syntax and accept scalar values only. Translation output is plain text; do not treat it as trusted HTML.

This v0.1 contract implements cardinal plurals and simple interpolation, not full ICU MessageFormat. Select FormatJS / MessageFormat as a later adapter only if named-argument, select, ordinal or rich-message requirements justify it.

## QA

auditCatalogs compares target catalogs with a designated source locale. Missing or extra placeholders are review-required. It never generates or auto-approves a translation. Human linguistic review remains required before release.

## Integration boundary

Applications should persist the tenant's locale preference independently of country, currency and time zone. A tenant may use es-NI with USD or en-US with NIO. Currency selection and conversion belong to JB Currency Engine, not to this package.
