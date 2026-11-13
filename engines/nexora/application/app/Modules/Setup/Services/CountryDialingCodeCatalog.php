<?php

namespace App\Modules\Setup\Services;

/** @deprecated Use App\Core\Library\Geo\CountryDialingCodeCatalog. */
final class CountryDialingCodeCatalog
{
    public static function all(): array
    {
        return \App\Core\Library\Geo\CountryDialingCodeCatalog::all();
    }

    public static function forCountry(string $countryCode): ?string
    {
        return \App\Core\Library\Geo\CountryDialingCodeCatalog::forCountry($countryCode);
    }

    /**
     * @deprecated Prefix guessing is ambiguous for shared calling plans.
     * Use PhoneNumberNormalizer with an explicitly selected calling code.
     */
    public static function formatInternational(string $phone): string
    {
        return \App\Core\Library\Geo\CountryDialingCodeCatalog::formatInternational($phone);
    }

    public static function formatNational(string $number): string
    {
        return \App\Core\Library\Geo\CountryDialingCodeCatalog::formatNational($number);
    }
}
