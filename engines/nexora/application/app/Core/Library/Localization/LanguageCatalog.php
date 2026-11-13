<?php

namespace App\Core\Library\Localization;

final class LanguageCatalog
{
    /**
     * Languages currently offered as NEXORA installation defaults.
     * Additional languages must be enabled after their interface translations exist.
     */
    public static function codes(): array
    {
        return array_keys(self::all());
    }

    public static function all(string $locale = 'es'): array
    {
        return [
            'es' => $locale === 'en' ? 'Spanish' : 'Español',
            'en' => 'English',
        ];
    }
}
