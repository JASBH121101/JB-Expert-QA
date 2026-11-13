<?php

namespace App\Core\Library\Money;

final class CurrencyCatalog
{
    private const CODES = 'AED AFN ALL AMD AOA ARS AUD AWG AZN BAM BBD BDT BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XCG XOF XPF YER ZAR ZMW ZWG';

    /**
     * ISO 4217 minor-unit exceptions for the supported currency set.
     * All supported codes not listed here use two minor units.
     */
    private const MINOR_UNITS = [
        'BIF' => 0,
        'CLP' => 0,
        'DJF' => 0,
        'GNF' => 0,
        'ISK' => 0,
        'JPY' => 0,
        'KMF' => 0,
        'KRW' => 0,
        'PYG' => 0,
        'RWF' => 0,
        'UGX' => 0,
        'VND' => 0,
        'VUV' => 0,
        'XAF' => 0,
        'XOF' => 0,
        'XPF' => 0,
        'BHD' => 3,
        'IQD' => 3,
        'JOD' => 3,
        'KWD' => 3,
        'LYD' => 3,
        'OMR' => 3,
        'TND' => 3,
    ];

    /**
     * Symbols are display hints, not globally unique currency identifiers.
     * The ISO code must remain visible wherever an amount is shown.
     */
    private const SYMBOLS = [
        'AED' => 'د.إ', 'AFN' => '؋', 'ALL' => 'L', 'AMD' => '֏',
        'AOA' => 'Kz', 'ARS' => '$', 'AUD' => 'A$', 'AWG' => 'ƒ',
        'AZN' => '₼', 'BAM' => 'KM', 'BBD' => 'Bds$', 'BDT' => '৳',
        'BHD' => 'د.ب', 'BIF' => 'FBu', 'BMD' => 'Bds$', 'BND' => 'B$',
        'BOB' => 'Bs.', 'BRL' => 'R$', 'BSD' => 'B$', 'BTN' => 'Nu.',
        'BWP' => 'P', 'BYN' => 'Br', 'BZD' => 'BZ$', 'CAD' => 'C$',
        'CDF' => 'FC', 'CHF' => 'CHF', 'CLP' => '$', 'CNY' => '¥',
        'COP' => '$', 'CRC' => '₡', 'CUP' => '$', 'CVE' => '$',
        'CZK' => 'Kč', 'DJF' => 'Fdj', 'DKK' => 'kr', 'DOP' => 'RD$',
        'DZD' => 'دج', 'EGP' => 'E£', 'ERN' => 'Nfk', 'ETB' => 'Br',
        'EUR' => '€', 'FJD' => 'FJ$', 'FKP' => '£', 'GBP' => '£',
        'GEL' => '₾', 'GHS' => '₵', 'GIP' => '£', 'GMD' => 'D',
        'GNF' => 'FG', 'GTQ' => 'Q', 'GYD' => 'G$', 'HKD' => 'HK$',
        'HNL' => 'L', 'HTG' => 'G', 'HUF' => 'Ft', 'IDR' => 'Rp',
        'ILS' => '₪', 'INR' => '₹', 'IQD' => 'ع.د', 'IRR' => '﷼',
        'ISK' => 'kr', 'JMD' => 'J$', 'JOD' => 'د.ا', 'JPY' => '¥',
        'KES' => 'KSh', 'KGS' => 'сом', 'KHR' => '៛', 'KMF' => 'CF',
        'KPW' => '₩', 'KRW' => '₩', 'KWD' => 'د.ك', 'KYD' => 'CI$',
        'KZT' => '₸', 'LAK' => '₭', 'LBP' => 'ل.ل', 'LKR' => 'Rs',
        'LRD' => 'L$', 'LSL' => 'L', 'LYD' => 'ل.د', 'MAD' => 'د.م.',
        'MDL' => 'L', 'MGA' => 'Ar', 'MKD' => 'ден', 'MMK' => 'K',
        'MNT' => '₮', 'MOP' => 'MOP$', 'MRU' => 'UM', 'MUR' => '₨',
        'MVR' => 'ރ', 'MWK' => 'MK', 'MXN' => 'MX$', 'MYR' => 'RM',
        'MZN' => 'MT', 'NAD' => 'N$', 'NGN' => '₦', 'NIO' => 'C$',
        'NOK' => 'kr', 'NPR' => 'रू', 'NZD' => 'NZ$', 'OMR' => 'ر.ع.',
        'PAB' => 'B/.', 'PEN' => 'S/', 'PGK' => 'K', 'PHP' => '₱',
        'PKR' => '₨', 'PLN' => 'zł', 'PYG' => '₲', 'QAR' => 'ر.ق',
        'RON' => 'lei', 'RSD' => 'дин.', 'RUB' => '₽', 'RWF' => 'FRw',
        'SAR' => 'ر.س', 'SBD' => 'SI$', 'SCR' => '₨', 'SDG' => 'ج.س.',
        'SEK' => 'kr', 'SGD' => 'S$', 'SHP' => '£', 'SLE' => 'Le',
        'SOS' => 'Sh', 'SRD' => 'SR$', 'SSP' => '£', 'STN' => 'Db',
        'SYP' => '£', 'SZL' => 'E', 'THB' => '฿', 'TJS' => 'ЅМ',
        'TMT' => 'm', 'TND' => 'د.ت', 'TOP' => 'T$', 'TRY' => '₺',
        'TTD' => 'TT$', 'TWD' => 'NT$', 'TZS' => 'TSh', 'UAH' => '₴',
        'UGX' => 'USh', 'USD' => '$', 'UYU' => '$U', 'UZS' => 'soʻm',
        'VES' => 'Bs.', 'VND' => '₫', 'VUV' => 'VT', 'WST' => 'WS$',
        'XAF' => 'FCFA', 'XCD' => 'EC$', 'XOF' => 'CFA', 'XPF' => 'CFP',
        'YER' => '﷼', 'ZAR' => 'R', 'ZMW' => 'ZK', 'ZWG' => 'ZiG',
    ];

    public const DATA_SOURCE_URL = 'https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml';

    public static function codes(): array
    {
        return explode(' ', self::CODES);
    }

    public static function contains(string $currencyCode): bool
    {
        return in_array(strtoupper(trim($currencyCode)), self::codes(), true);
    }

    public static function minorUnits(string $currencyCode): ?int
    {
        $code = strtoupper(trim($currencyCode));

        if (! self::contains($code)) {
            return null;
        }

        return self::MINOR_UNITS[$code] ?? 2;
    }

    public static function symbol(string $currencyCode): ?string
    {
        $code = strtoupper(trim($currencyCode));

        if (! self::contains($code)) {
            return null;
        }

        return self::SYMBOLS[$code] ?? $code;
    }

    public static function metadata(string $currencyCode): ?array
    {
        $code = strtoupper(trim($currencyCode));
        $minorUnits = self::minorUnits($code);

        if ($minorUnits === null) {
            return null;
        }

        return [
            'code' => $code,
            'symbol' => self::symbol($code),
            'minor_units' => $minorUnits,
            'step' => self::step($code),
        ];
    }

    public static function step(string $currencyCode): ?string
    {
        $minorUnits = self::minorUnits($currencyCode);

        if ($minorUnits === null) {
            return null;
        }

        return $minorUnits === 0
            ? '1'
            : '0.'.str_repeat('0', $minorUnits - 1).'1';
    }

    public static function placeholder(string $currencyCode): ?string
    {
        $minorUnits = self::minorUnits($currencyCode);

        return $minorUnits === null
            ? null
            : '0'.($minorUnits > 0 ? '.'.str_repeat('0', $minorUnits) : '');
    }

    /**
     * Validate non-negative decimal strings without converting them to floats.
     * The current product price limit remains 12 integer digits.
     */
    public static function isValidAmount(mixed $amount, string $currencyCode): bool
    {
        $minorUnits = self::minorUnits($currencyCode);

        if ($minorUnits === null || (! is_string($amount) && ! is_int($amount))) {
            return false;
        }

        $value = trim((string) $amount);

        if (! preg_match('/^([0-9]+)(?:\.([0-9]+))?$/D', $value, $matches)) {
            return false;
        }

        $integer = ltrim($matches[1], '0');
        $fraction = $matches[2] ?? '';

        return strlen($integer) <= 12 && strlen($fraction) <= $minorUnits;
    }

    /**
     * Format a stored decimal string without converting it to a binary float.
     * A locale's decimal/grouping separators are presentation only.
     */
    public static function formatAmount(
        string|int $amount,
        string $currencyCode,
        string $locale = 'es',
    ): ?string {
        $metadata = self::metadata($currencyCode);

        if ($metadata === null || ! preg_match('/^([0-9]+)(?:\.([0-9]+))?$/D', trim((string) $amount), $matches)) {
            return null;
        }

        $minorUnits = $metadata['minor_units'];
        $integer = ltrim($matches[1], '0');
        $integer = $integer === '' ? '0' : $integer;
        $fraction = $matches[2] ?? '';

        if (strlen($fraction) > $minorUnits) {
            $extraDigits = substr($fraction, $minorUnits);

            if (trim($extraDigits, '0') !== '') {
                return null;
            }
        }

        $fraction = str_pad(substr($fraction, 0, $minorUnits), $minorUnits, '0');
        $isSpanish = str_starts_with(strtolower(str_replace('_', '-', $locale)), 'es');
        $decimalSeparator = $isSpanish ? ',' : '.';
        $groupSeparator = $isSpanish ? '.' : ',';
        $groupedInteger = preg_replace('/\B(?=(\d{3})+(?!\d))/', $groupSeparator, $integer) ?? $integer;
        $formattedNumber = $groupedInteger.($minorUnits > 0 ? $decimalSeparator.$fraction : '');

        return self::symbol($currencyCode).' '.$formattedNumber;
    }
}
