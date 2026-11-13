<?php

namespace Tests\Unit\Library;

use App\Core\Library\Money\CurrencyCatalog;
use PHPUnit\Framework\TestCase;

final class CurrencyCatalogTest extends TestCase
{
    public function test_every_supported_currency_has_valid_metadata(): void
    {
        foreach (CurrencyCatalog::codes() as $code) {
            $metadata = CurrencyCatalog::metadata($code);

            $this->assertNotNull($metadata, 'Missing currency metadata for '.$code);
            $this->assertSame($code, $metadata['code']);
            $this->assertNotSame('', $metadata['symbol']);
            $this->assertContains($metadata['minor_units'], [0, 2, 3]);
            $this->assertNotNull($metadata['step']);
        }
    }

    public function test_iso_minor_unit_exceptions_are_respected(): void
    {
        $this->assertSame(0, CurrencyCatalog::minorUnits('JPY'));
        $this->assertSame(0, CurrencyCatalog::minorUnits('CLP'));
        $this->assertSame(2, CurrencyCatalog::minorUnits('USD'));
        $this->assertSame(2, CurrencyCatalog::minorUnits('NIO'));
        $this->assertSame(3, CurrencyCatalog::minorUnits('KWD'));
        $this->assertSame(3, CurrencyCatalog::minorUnits('BHD'));
        $this->assertNull(CurrencyCatalog::minorUnits('XXX'));
    }

    public function test_currency_symbols_are_display_hints_with_iso_code_fallback(): void
    {
        $this->assertSame('C$', CurrencyCatalog::symbol('NIO'));
        $this->assertSame('€', CurrencyCatalog::symbol('EUR'));
        $this->assertSame('¥', CurrencyCatalog::symbol('JPY'));
        $this->assertSame('XCG', CurrencyCatalog::symbol('XCG'));
        $this->assertNull(CurrencyCatalog::symbol('XXX'));
    }

    public function test_amount_validation_uses_currency_specific_precision_without_floats(): void
    {
        $this->assertTrue(CurrencyCatalog::isValidAmount('1250.75', 'USD'));
        $this->assertFalse(CurrencyCatalog::isValidAmount('1250.755', 'USD'));
        $this->assertTrue(CurrencyCatalog::isValidAmount('1250', 'JPY'));
        $this->assertFalse(CurrencyCatalog::isValidAmount('1250.0', 'JPY'));
        $this->assertTrue(CurrencyCatalog::isValidAmount('1250.750', 'KWD'));
        $this->assertFalse(CurrencyCatalog::isValidAmount('1250.7501', 'KWD'));
        $this->assertFalse(CurrencyCatalog::isValidAmount('1e3', 'USD'));
        $this->assertFalse(CurrencyCatalog::isValidAmount('1000000000000', 'USD'));
    }

    public function test_amount_formatting_preserves_decimal_precision_and_locale(): void
    {
        $this->assertSame('$ 1,234.50', CurrencyCatalog::formatAmount('1234.5000', 'USD', 'en'));
        $this->assertSame('C$ 1.234,50', CurrencyCatalog::formatAmount('1234.5000', 'NIO', 'es'));
        $this->assertSame('¥ 1,234', CurrencyCatalog::formatAmount('1234.0000', 'JPY', 'en'));
        $this->assertSame('د.ك 1.250,750', CurrencyCatalog::formatAmount('1250.7500', 'KWD', 'es'));
        $this->assertNull(CurrencyCatalog::formatAmount('10.0050', 'USD', 'en'));
    }

    public function test_currency_step_and_placeholder_match_minor_units(): void
    {
        $this->assertSame('1', CurrencyCatalog::step('JPY'));
        $this->assertSame('0.01', CurrencyCatalog::step('USD'));
        $this->assertSame('0.001', CurrencyCatalog::step('KWD'));
        $this->assertSame('0', CurrencyCatalog::placeholder('JPY'));
        $this->assertSame('0.00', CurrencyCatalog::placeholder('USD'));
        $this->assertSame('0.000', CurrencyCatalog::placeholder('KWD'));
    }
}
