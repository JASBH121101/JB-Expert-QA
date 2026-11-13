<?php

namespace Tests\Unit\Library;

use App\Core\Library\Contact\PhoneNumberNormalizer;
use App\Core\Library\Geo\CountryCatalog;
use App\Core\Library\Geo\CountryCurrencyCatalog;
use App\Core\Library\Geo\CountryDialingCodeCatalog;
use App\Core\Library\LibraryCatalog;
use App\Core\Library\Localization\LanguageCatalog;
use App\Core\Library\Money\CurrencyCatalog;
use PHPUnit\Framework\TestCase;

final class LibraryCatalogTest extends TestCase
{
    public function test_reference_catalogues_pass_internal_integrity_checks(): void
    {
        $report = LibraryCatalog::integrityReport();

        $this->assertTrue($report['passed'], json_encode($report, JSON_PRETTY_PRINT));
        $this->assertSame(LibraryCatalog::VERSION, $report['version']);
    }

    public function test_country_currency_and_calling_code_catalogues_cover_the_same_country_set(): void
    {
        $countries = CountryCatalog::codes();

        $this->assertSame([], array_values(array_diff(array_keys(CountryCurrencyCatalog::all()), $countries)));
        $this->assertSame([], array_values(array_diff($countries, array_keys(CountryDialingCodeCatalog::all()))));
        $this->assertSame('+505', CountryDialingCodeCatalog::forCountry(' ni '));
        $this->assertSame('+44', CountryDialingCodeCatalog::forCountry('GB'));
        $this->assertSame('NIO', CountryCurrencyCatalog::forCountry(' ni '));
        $this->assertNull(CountryCurrencyCatalog::forCountry('AQ'));
    }

    public function test_currency_and_locale_catalogues_expose_stable_codes(): void
    {
        $this->assertContains('NIO', CurrencyCatalog::codes());
        $this->assertContains('USD', CurrencyCatalog::codes());
        $this->assertTrue(CurrencyCatalog::contains(' usd '));
        $this->assertSame(['es', 'en'], LanguageCatalog::codes());
    }

    public function test_phone_normalization_uses_the_explicit_calling_code(): void
    {
        $this->assertSame('+50588881234', PhoneNumberNormalizer::toE164('+505', '8888-1234'));
        $this->assertSame('+12025550123', PhoneNumberNormalizer::toE164('+1', '(202) 555 0123'));
    }

    public function test_phone_normalization_rejects_unknown_codes_and_invalid_shapes(): void
    {
        $this->assertNull(PhoneNumberNormalizer::toE164('+999', '88881234'));
        $this->assertNull(PhoneNumberNormalizer::toE164('+505', '12345'));
        $this->assertNull(PhoneNumberNormalizer::toE164('+505', '8888-ABCD'));
        $this->assertNull(PhoneNumberNormalizer::toE164('+505', '123456789012345'));
    }
}
