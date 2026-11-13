<?php

namespace App\Core\Library\Contact;

use App\Core\Library\Geo\CountryDialingCodeCatalog;

/**
 * Normalizes a phone number only when the user has explicitly selected its
 * international calling code. This validates E.164 shape, not national
 * numbering-plan assignment or reachability.
 */
final class PhoneNumberNormalizer
{
    public static function toE164(string $callingCode, string $nationalNumber): ?string
    {
        $callingCode = trim($callingCode);

        if (! preg_match('/^\+[1-9][0-9]{0,2}$/D', $callingCode)) {
            return null;
        }

        if (! in_array($callingCode, CountryDialingCodeCatalog::uniqueCodes(), true)) {
            return null;
        }

        if (! preg_match('/^[0-9().\-\s]+$/D', $nationalNumber)) {
            return null;
        }

        $nationalDigits = preg_replace('/\D+/', '', $nationalNumber) ?? '';
        $callingDigits = substr($callingCode, 1);
        $totalLength = strlen($callingDigits) + strlen($nationalDigits);

        if (strlen($nationalDigits) < 6 || $totalLength > 15) {
            return null;
        }

        return '+'.$callingDigits.$nationalDigits;
    }
}
