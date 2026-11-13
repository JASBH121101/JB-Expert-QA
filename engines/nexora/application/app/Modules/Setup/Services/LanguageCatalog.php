<?php

namespace App\Modules\Setup\Services;

/** @deprecated Use App\Core\Library\Localization\LanguageCatalog. */
final class LanguageCatalog
{
    public static function all(string $locale = 'es'): array
    {
        return \App\Core\Library\Localization\LanguageCatalog::all($locale);
    }

    public static function codes(): array
    {
        return \App\Core\Library\Localization\LanguageCatalog::codes();
    }
}
