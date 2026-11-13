<?php

namespace App\Modules\Setup\Services;

/** @deprecated Use App\Core\Library\Money\CurrencyCatalog. */
final class CurrencyCatalog
{
    public static function codes(): array
    {
        return \App\Core\Library\Money\CurrencyCatalog::codes();
    }

    public static function contains(string $currencyCode): bool
    {
        return \App\Core\Library\Money\CurrencyCatalog::contains($currencyCode);
    }
}
