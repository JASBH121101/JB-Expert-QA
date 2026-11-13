<?php

namespace App\Modules\Setup\Services;

/** @deprecated Use App\Core\Library\Geo\CountryCurrencyCatalog. */
final class CountryCurrencyCatalog
{
    public static function all(): array
    {
        return \App\Core\Library\Geo\CountryCurrencyCatalog::all();
    }

    public static function forCountry(string $countryCode): ?string
    {
        return \App\Core\Library\Geo\CountryCurrencyCatalog::forCountry($countryCode);
    }
}
