# NEXORA Library Engine

## Contract

The shared library lives under app/Core/Library and is organized by domain:

- Geo: country, country-to-currency, and country calling-code catalogues.
- Money: currency code catalogue.
- Localization: languages enabled by the installer.
- Contact: phone normalization with an explicitly selected calling code.
- LibraryCatalog: version and cross-catalogue integrity report.

The initial version is 0.1.0. These are PHP application services, not yet independently installable Composer packages.

## Compatibility

The original classes under App\Modules\Setup\Services remain as small compatibility facades. New code should depend on App\Core\Library.

## Phone normalization contract

PhoneNumberNormalizer::toE164($callingCode, $nationalNumber) returns a normalized E.164-shaped string or null. It requires an explicit calling code from the supported catalogue and accepts only digits plus common presentation characters. It checks the minimum national digit count and 15-digit E.164 maximum. It does not validate national numbering plans, assignment, or reachability.

Do not use prefix guessing to determine a country. Shared calling plans make that ambiguous.

## Integrity report

LibraryCatalog::integrityReport() checks unique and syntactically valid country and currency codes, valid country keys in the currency map, complete calling-code coverage, supported currency references, calling code shapes, and locale keys. A territory without a defined currency (such as AQ in this dataset) may return null.

This is an internal consistency check, not a claim that bundled data is the latest authoritative ISO publication.

## Deferred work

Measurement/unit metadata remains embedded in TemplateCatalog. Before moving it, introduce stable unit identifiers and migration rules so localized labels are not persisted as identifiers. Currency symbols, minor-unit precision, official data provenance, and update policy are also deferred to a separate review.
