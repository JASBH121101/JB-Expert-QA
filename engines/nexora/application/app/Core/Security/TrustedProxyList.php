<?php

namespace App\Core\Security;

use InvalidArgumentException;

final class TrustedProxyList
{
    /**
     * Parse a comma-separated list of literal proxy IP addresses or CIDR ranges.
     *
     * Wildcards and hostnames are deliberately rejected: trusting every proxy
     * would allow arbitrary clients to spoof forwarded request headers.
     *
     * @return array<int, string>
     */
    public static function parse(?string $value): array
    {
        if ($value === null || trim($value) === '') {
            return [];
        }

        $entries = preg_split('/\\s*,\\s*/', trim($value), -1, PREG_SPLIT_NO_EMPTY);

        if ($entries === false || $entries === []) {
            return [];
        }

        $proxies = [];

        foreach ($entries as $entry) {
            $range = explode('/', $entry);

            if (
                count($range) > 2
                || filter_var($range[0], FILTER_VALIDATE_IP) === false
            ) {
                throw new InvalidArgumentException(
                    'TRUSTED_PROXIES entries must be valid IP addresses or CIDR ranges.',
                );
            }

            if (isset($range[1])) {
                $maximumPrefix = str_contains($range[0], ':') ? 128 : 32;

                if (
                    ! ctype_digit($range[1])
                    || (int) $range[1] > $maximumPrefix
                ) {
                    throw new InvalidArgumentException(
                        'TRUSTED_PROXIES contains an invalid CIDR prefix.',
                    );
                }
            }

            $proxies[] = $entry;
        }

        return array_values(array_unique($proxies));
    }
}
