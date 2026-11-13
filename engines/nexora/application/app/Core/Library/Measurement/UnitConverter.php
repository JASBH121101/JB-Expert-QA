<?php

namespace App\Core\Library\Measurement;

use InvalidArgumentException;
use OverflowException;

final class UnitConverter
{
    /**
     * Convert a numeric value between two units of the same physical dimension.
     * This conversion utility is not intended for monetary calculations.
     */
    public static function convert(
        float $value,
        string $fromCode,
        string $toCode,
        int $precision = 6,
    ): float {
        if (! is_finite($value)) {
            throw new InvalidArgumentException('The value must be finite.');
        }

        if ($precision < 0 || $precision > 12) {
            throw new InvalidArgumentException('Precision must be between 0 and 12.');
        }

        $from = UnitCatalog::get($fromCode);
        $to = UnitCatalog::get($toCode);

        if ($from === null || $to === null) {
            throw new InvalidArgumentException('Both unit codes must exist in the NEXORA catalogue.');
        }

        if ($from['dimension'] !== $to['dimension']) {
            throw new InvalidArgumentException('Units from different dimensions cannot be converted.');
        }

        $baseValue = $value * $from['numerator'] / $from['denominator'];
        $converted = $baseValue * $to['denominator'] / $to['numerator'];

        if (! is_finite($converted)) {
            throw new OverflowException('The converted value is outside the supported numeric range.');
        }

        return round($converted, $precision, PHP_ROUND_HALF_UP);
    }
}
