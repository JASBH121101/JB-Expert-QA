<?php

namespace Tests\Feature;

use App\Core\Security\TrustedProxyList;
use InvalidArgumentException;
use Tests\TestCase;

final class SecurityConfigurationTest extends TestCase
{
    public function test_proxy_trust_is_empty_when_no_reverse_proxy_is_configured(): void
    {
        $this->assertSame([], TrustedProxyList::parse(null));
        $this->assertSame([], TrustedProxyList::parse(''));
        $this->assertSame([], TrustedProxyList::parse('   '));
    }

    public function test_proxy_parser_accepts_ipv4_ipv6_and_cidr_ranges_and_removes_duplicates(): void
    {
        $this->assertSame(
            [
                '192.0.2.10',
                '198.51.100.0/24',
                '2001:db8::10',
                '2001:db8:abcd::/48',
            ],
            TrustedProxyList::parse(
                '192.0.2.10, 198.51.100.0/24, 2001:db8::10, 2001:db8:abcd::/48, 192.0.2.10',
            ),
        );
    }

    public function test_proxy_parser_rejects_wildcard_trust(): void
    {
        $this->expectException(InvalidArgumentException::class);

        TrustedProxyList::parse('*');
    }

    public function test_proxy_parser_rejects_invalid_cidr_prefixes(): void
    {
        $this->expectException(InvalidArgumentException::class);

        TrustedProxyList::parse('192.0.2.10/33');
    }

    public function test_proxy_parser_rejects_hostnames_and_urls(): void
    {
        $this->expectException(InvalidArgumentException::class);

        TrustedProxyList::parse('proxy.example.com, https://proxy.example.com');
    }
}
