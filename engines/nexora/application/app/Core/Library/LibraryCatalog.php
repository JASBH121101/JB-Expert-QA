<?php

namespace App\Core\Library;

use App\Core\Library\Geo\CountryCatalog;
use App\Core\Library\Geo\CountryCurrencyCatalog;
use App\Core\Library\Geo\CountryDialingCodeCatalog;
use App\Core\Library\Localization\LanguageCatalog;
use App\Core\Library\Money\CurrencyCatalog;

/**
 * Entry point and consistency diagnostics for NEXORA shared reference data.
 * Checks are syntactic/internal; they do not certify the latest ISO registry data.
 */
final class LibraryCatalog
{
    public const VERSION = '0.1.0';

    public static function integrityReport(): array
    {
        $countries = CountryCatalog::codes();
        $currencies = CurrencyCatalog::codes();
        $countryCurrencies = CountryCurrencyCatalog::all();
        $callingCodes = CountryDialingCodeCatalog::all();
        $locales = LanguageCatalog::codes();
        $countryCurrencyKeys = array_keys($countryCurrencies);
        $callingCountryKeys = array_keys($callingCodes);

        $checks = [
            'country_codes_unique' => count($countries) === count(array_unique($countries)),
            'country_codes_alpha2' => count(array_filter(
                $countries,
                static fn (string $code): bool => preg_match('/^[A-Z]{2}$/D', $code) !== 1,
            )) === 0,
            'currency_codes_unique' => count($currencies) === count(array_unique($currencies)),
            'currency_codes_alpha3' => count(array_filter(
                $currencies,
                static fn (string $code): bool => preg_match('/^[A-Z]{3}$/D', $code) !== 1,
            )) === 0,
            'country_currency_keys_valid' => array_diff($countryCurrencyKeys, $countries) === [],
            'country_currency_codes_supported' => count(array_filter(
                $countryCurrencies,
                static fn (string $code): bool => ! CurrencyCatalog::contains($code),
            )) === 0,
            'calling_code_coverage' => array_diff($countries, $callingCountryKeys) === []
                && array_diff($callingCountryKeys, $countries) === [],
            'calling_code_format' => count(array_filter(
                $callingCodes,
                static fn (string $code): bool => preg_match('/^\+[1-9][0-9]{0,2}$/D', $code) !== 1,
            )) === 0,
            'locale_codes_format' => count(array_filter(
                $locales,
                static fn (string $code): bool => preg_match('/^[a-z]{2}(?:-[A-Z]{2})?$/D', $code) !== 1,
            )) === 0,
        ];

        return [
            'version' => self::VERSION,
            'passed' => ! in_array(false, $checks, true),
            'checks' => $checks,
            'counts' => [
                'countries' => count($countries),
                'currencies' => count($currencies),
                'country_currency_mappings' => count($countryCurrencies),
                'country_calling_code_mappings' => count($callingCodes),
                'unique_calling_codes' => count(CountryDialingCodeCatalog::uniqueCodes()),
                'locales' => count($locales),
            ],
        ];
    }
}
