<?php

namespace App\Modules\Setup\Services;

/** @deprecated Use App\Core\Library\Geo\CountryCatalog. */
final class CountryCatalog
{
    public static function codes(): array
    {
        return \App\Core\Library\Geo\CountryCatalog::codes();
    }

    public static function contains(string $countryCode): bool
    {
        return \App\Core\Library\Geo\CountryCatalog::contains($countryCode);
    }
}
