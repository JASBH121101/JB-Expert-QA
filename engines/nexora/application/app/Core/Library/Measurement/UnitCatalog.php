<?php

namespace App\Core\Library\Measurement;

final class UnitCatalog
{
    /**
     * Factors convert each unit to the base unit for its physical dimension.
     * All factors are rational. Digital storage units use decimal SI multiples.
     */
    private const UNITS = [
        'ml' => [
            'dimension' => 'volume', 'symbol' => 'ml', 'numerator' => 1, 'denominator' => 1,
            'labels' => ['es' => 'ml', 'en' => 'ml'],
        ],
        'cl' => [
            'dimension' => 'volume', 'symbol' => 'cl', 'numerator' => 10, 'denominator' => 1,
            'labels' => ['es' => 'cl', 'en' => 'cl'],
        ],
        'l' => [
            'dimension' => 'volume', 'symbol' => 'L', 'numerator' => 1000, 'denominator' => 1,
            'labels' => ['es' => 'L', 'en' => 'L'],
        ],
        'cc' => [
            'dimension' => 'volume', 'symbol' => 'cc', 'numerator' => 1, 'denominator' => 1,
            'labels' => ['es' => 'cc', 'en' => 'cc'],
        ],
        'piece' => [
            'dimension' => 'count', 'symbol' => 'pza.', 'numerator' => 1, 'denominator' => 1,
            'labels' => ['es' => 'piezas', 'en' => 'pieces'],
        ],
        'MB' => [
            'dimension' => 'digital', 'symbol' => 'MB', 'numerator' => 1000000, 'denominator' => 1,
            'labels' => ['es' => 'MB', 'en' => 'MB'],
        ],
        'GB' => [
            'dimension' => 'digital', 'symbol' => 'GB', 'numerator' => 1000000000, 'denominator' => 1,
            'labels' => ['es' => 'GB', 'en' => 'GB'],
        ],
        'TB' => [
            'dimension' => 'digital', 'symbol' => 'TB', 'numerator' => 1000000000000, 'denominator' => 1,
            'labels' => ['es' => 'TB', 'en' => 'TB'],
        ],
        'mm' => [
            'dimension' => 'length', 'symbol' => 'mm', 'numerator' => 1, 'denominator' => 1,
            'labels' => ['es' => 'mm', 'en' => 'mm'],
        ],
        'cm' => [
            'dimension' => 'length', 'symbol' => 'cm', 'numerator' => 10, 'denominator' => 1,
            'labels' => ['es' => 'cm', 'en' => 'cm'],
        ],
        'm' => [
            'dimension' => 'length', 'symbol' => 'm', 'numerator' => 1000, 'denominator' => 1,
            'labels' => ['es' => 'm', 'en' => 'm'],
        ],
        'in' => [
            'dimension' => 'length', 'symbol' => 'in', 'numerator' => 254, 'denominator' => 10,
            'labels' => ['es' => 'pulgadas', 'en' => 'inches'],
        ],
        'ft' => [
            'dimension' => 'length', 'symbol' => 'ft', 'numerator' => 3048, 'denominator' => 10,
            'labels' => ['es' => 'pies', 'en' => 'feet'],
        ],
        'mg' => [
            'dimension' => 'weight', 'symbol' => 'mg', 'numerator' => 1, 'denominator' => 1,
            'labels' => ['es' => 'mg', 'en' => 'mg'],
        ],
        'g' => [
            'dimension' => 'weight', 'symbol' => 'g', 'numerator' => 1000, 'denominator' => 1,
            'labels' => ['es' => 'g', 'en' => 'g'],
        ],
        'kg' => [
            'dimension' => 'weight', 'symbol' => 'kg', 'numerator' => 1000000, 'denominator' => 1,
            'labels' => ['es' => 'kg', 'en' => 'kg'],
        ],
        'lb' => [
            'dimension' => 'weight', 'symbol' => 'lb', 'numerator' => 45359237, 'denominator' => 100,
            'labels' => ['es' => 'lb', 'en' => 'lb'],
        ],
    ];

    private const DIMENSION_ALIASES = [
        'displacement' => 'volume',
    ];

    private const ALIASES = [
        'milliliter' => 'ml', 'milliliters' => 'ml', 'mililitro' => 'ml', 'mililitros' => 'ml',
        'centiliter' => 'cl', 'centiliters' => 'cl', 'centilitro' => 'cl', 'centilitros' => 'cl',
        'liter' => 'l', 'liters' => 'l', 'litre' => 'l', 'litres' => 'l', 'litro' => 'l', 'litros' => 'l',
        'pieza' => 'piece', 'piezas' => 'piece', 'pieces' => 'piece', 'pza' => 'piece', 'pcs' => 'piece',
        'mb' => 'MB', 'gb' => 'GB', 'tb' => 'TB',
        'inch' => 'in', 'inches' => 'in', 'pulgada' => 'in', 'pulgadas' => 'in',
        'foot' => 'ft', 'feet' => 'ft', 'pie' => 'ft', 'pies' => 'ft',
        'cm3' => 'cc',
    ];

    public static function dimensions(): array
    {
        return array_values(array_unique([
            ...array_column(self::UNITS, 'dimension'),
            ...array_keys(self::DIMENSION_ALIASES),
        ]));
    }

    public static function codes(?string $dimension = null): array
    {
        $normalizedDimension = self::canonicalDimension($dimension);

        return array_values(array_keys(array_filter(
            self::UNITS,
            static fn (array $unit): bool => $normalizedDimension === null
                || $unit['dimension'] === $normalizedDimension,
        )));
    }

    public static function canonicalCode(?string $code, ?string $dimension = null): ?string
    {
        if ($code === null || trim($code) === '') {
            return null;
        }

        $normalized = strtolower(trim($code));
        $canonical = self::ALIASES[$normalized] ?? null;

        if ($canonical === null) {
            foreach (self::UNITS as $knownCode => $_definition) {
                if (strtolower($knownCode) === $normalized) {
                    $canonical = $knownCode;
                    break;
                }
            }
        }

        if ($canonical === null || ! isset(self::UNITS[$canonical])) {
            return null;
        }

        $normalizedDimension = self::canonicalDimension($dimension);

        if ($normalizedDimension !== null
            && self::UNITS[$canonical]['dimension'] !== $normalizedDimension) {
            return null;
        }

        return $canonical;
    }

    public static function get(?string $code, ?string $dimension = null): ?array
    {
        $canonical = self::canonicalCode($code, $dimension);

        return $canonical === null ? null : ['code' => $canonical] + self::UNITS[$canonical];
    }

    public static function label(?string $code, string $locale = 'es', ?string $dimension = null): ?string
    {
        $unit = self::get($code, $dimension);

        if ($unit === null) {
            return null;
        }

        $language = strtolower(substr(str_replace('_', '-', $locale), 0, 2));

        return $unit['labels'][$language] ?? $unit['labels']['es'];
    }

    public static function symbol(?string $code, ?string $dimension = null): ?string
    {
        return self::get($code, $dimension)['symbol'] ?? null;
    }

    public static function forDimension(string $dimension, string $locale = 'es'): array
    {
        $normalizedDimension = self::canonicalDimension($dimension);

        if ($normalizedDimension === null) {
            return [];
        }

        $units = [];

        foreach (self::UNITS as $code => $definition) {
            if ($definition['dimension'] !== $normalizedDimension) {
                continue;
            }

            $language = strtolower(substr(str_replace('_', '-', $locale), 0, 2));
            $units[$code] = [
                'code' => $code,
                'dimension' => $normalizedDimension,
                'symbol' => $definition['symbol'],
                'label' => $definition['labels'][$language] ?? $definition['labels']['es'],
            ];
        }

        return $units;
    }

    private static function canonicalDimension(?string $dimension): ?string
    {
        if ($dimension === null || trim($dimension) === '') {
            return null;
        }

        $dimension = trim($dimension);

        return self::DIMENSION_ALIASES[$dimension] ?? $dimension;
    }
}
