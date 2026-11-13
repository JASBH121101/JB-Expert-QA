<?php

namespace Tests\Unit\Library;

use App\Core\Library\Measurement\UnitCatalog;
use App\Core\Library\Measurement\UnitConverter;
use InvalidArgumentException;
use PHPUnit\Framework\TestCase;

final class UnitCatalogTest extends TestCase
{
    public function test_catalog_exposes_stable_codes_and_dimensions(): void
    {
        $this->assertContains('volume', UnitCatalog::dimensions());
        $this->assertContains('displacement', UnitCatalog::dimensions());
        $this->assertContains('ml', UnitCatalog::codes('volume'));
        $this->assertContains('l', UnitCatalog::codes('volume'));
        $this->assertContains('GB', UnitCatalog::codes('digital'));
        $this->assertContains('piece', UnitCatalog::codes('count'));
    }

    public function test_legacy_localized_unit_names_resolve_to_stable_codes(): void
    {
        $this->assertSame('in', UnitCatalog::canonicalCode('pulgadas', 'length'));
        $this->assertSame('in', UnitCatalog::canonicalCode('inches', 'length'));
        $this->assertSame('piece', UnitCatalog::canonicalCode('piezas', 'count'));
        $this->assertSame('piece', UnitCatalog::canonicalCode('pieces', 'count'));
        $this->assertSame('GB', UnitCatalog::canonicalCode('gb', 'digital'));
        $this->assertSame('cc', UnitCatalog::canonicalCode('cc', 'displacement'));
        $this->assertNull(UnitCatalog::canonicalCode('pulgadas', 'volume'));
        $this->assertNull(UnitCatalog::canonicalCode('unknown-unit', 'length'));
    }

    public function test_unit_labels_are_localized_without_changing_stable_codes(): void
    {
        $this->assertSame('pulgadas', UnitCatalog::label('in', 'es'));
        $this->assertSame('inches', UnitCatalog::label('in', 'en'));
        $this->assertSame('piezas', UnitCatalog::label('piece', 'es'));
        $this->assertSame('pieces', UnitCatalog::label('piece', 'en'));
    }

    public function test_converter_uses_rational_factors_for_supported_dimensions(): void
    {
        $this->assertSame(1000.0, UnitConverter::convert(1.0, 'l', 'ml'));
        $this->assertSame(1000.0, UnitConverter::convert(1.0, 'kg', 'g'));
        $this->assertSame(2.54, UnitConverter::convert(1.0, 'in', 'cm', 2));
        $this->assertSame(1000.0, UnitConverter::convert(1.0, 'GB', 'MB'));
        $this->assertSame(1.0, UnitConverter::convert(1.0, 'cc', 'ml'));
    }

    public function test_converter_rejects_unknown_and_cross_dimension_units(): void
    {
        $this->expectException(InvalidArgumentException::class);
        UnitConverter::convert(1.0, 'kg', 'ml');
    }

    public function test_converter_rejects_non_finite_values_and_invalid_precision(): void
    {
        try {
            UnitConverter::convert(INF, 'kg', 'g');
            $this->fail('Expected non-finite values to be rejected.');
        } catch (InvalidArgumentException) {
            $this->assertTrue(true);
        }

        $this->expectException(InvalidArgumentException::class);
        UnitConverter::convert(1.0, 'kg', 'g', 13);
    }
}
