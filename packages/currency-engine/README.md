# JB Currency Engine

**Status:** v0.1.0 laboratory package. It is not a tax, accounting, payment-settlement or FX dealing system.

## Responsibilities

- Store money as an integer BigInt number of currency minor units.
- Parse strict decimal strings; never parse monetary amounts through binary floating point.
- Format values with the runtime's Intl.NumberFormat and its ICU/CLDR data.
- Provide checked add, subtract, compare and integer multiplication.
- Convert currencies only through an explicitly injected rate provider.
- Validate source/target pair, positive decimal rate, source label, asOf, validUntil and maximum rate age.
- Record rate provenance and the selected rounding mode with each conversion result.

Currency registries accept only plain records with own currency-code entries and validated code/name/minor-unit metadata; inherited prototype entries are never treated as registered currencies.

The curated initial registry includes NIO, USD, MXN, CRC, HNL, GTQ, PAB, COP, BRL, EUR, GBP, JPY, KWD, AUD, CAD, CHF, CNY, INR, AED, SAR, SGD, SEK, NOK, DKK, NZD, ZAR, PLN, CZK, THB, KRW, CLP, PEN, DOP, ARS, PHP, MYR, HKD, ISK, EGP, MAD, NGN, KES, UAH and the four-decimal units of account CLF and UYW. This is a broader operational subset, not a complete or automatically refreshed ISO 4217 registry. Verify active status and minor-unit metadata against the current official ISO list before production use.

## Exact amount model

createMoney("125.40", "NIO") stores 12540n minor units. The decimal input must be a string without grouping separators or exponent notation and cannot contain more fractional digits than the configured currency precision.

Use serializeMoney for JSON boundaries; it converts BigInt to a canonical integer string. Never store formatted display text as the financial amount.

## FX boundary

convertMoney requires an injected object with getRate({ from, to, at, signal }). It does not fetch rates, embed an API key, or contact a provider. Responses must contain exactly:

- from, to: exact requested currency pair
- rate: positive decimal string, up to 18 fractional digits
- source: non-empty provenance label
- asOf, validUntil: timezone-qualified ISO timestamps

Stale, future-dated, expired, malformed or mismatched rates are rejected. No inverse or triangulated rate is inferred. A caller must select an appropriate provider and rate policy for its accounting jurisdiction.

The core supports explicit half-up, half-even and down rounding. Financial products may require other rules (cash rounding, tax rules, payment processor precision); those belong in a versioned business policy, not silent defaults.

## Standards

The registry uses three-letter currency identifiers consistent with ISO 4217. Unicode CLDR/ICU-derived formatting is provided by the Node runtime's Intl implementation; no external runtime dependency is required. Confirm the official current code and minor-unit list before extending the registry. ISO explains its codes and minor-unit relationships at https://www.iso.org/iso-4217-currency-codes.html.

## Security and product boundary

- Currency formatting is not FX conversion.
- A rate is not trusted just because a caller supplied a number; source, timestamp, pair and validity are checked, but the adapter/operator must still establish source authenticity.
- The core does not sign rates. Production adapters should verify transport/signatures and preserve the signed provider payload.
- Historical transaction amounts keep their original currency and rate snapshot; changing a tenant's display preference must not rewrite ledger entries.


## Certification coverage and limits

The package test suite covers the curated registry entries and minor-unit metadata, exact decimal-to-minor-unit conversion, BigInt money arithmetic, canonical serialization, locale formatting, explicit rounding modes, FX input validation, provenance, freshness and timeout behavior.

This certification scope is intentionally bounded:
- The built-in currency list is a curated operational subset, not a complete, automatically refreshed ISO 4217 registry.
- FX conversion is only a validated contract around an explicitly injected rate provider. No provider is bundled, contacted or trusted automatically; no market-rate accuracy is implied.
- Locale formatting is delegated to the runtime's Intl/ICU implementation. It does not change stored monetary values.
- The tests do not certify tax, accounting, payment settlement, cash-rounding rules or jurisdiction-specific compliance.
