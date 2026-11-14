<?php

namespace Tests\Feature;

use App\Core\Security\TrustedProxyList;
use App\Http\Middleware\TrustConfiguredProxies;
use Illuminate\Http\Request;
use InvalidArgumentException;
use Symfony\Component\HttpFoundation\Response;
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

    public function test_proxy_middleware_uses_only_the_configured_proxy_list_and_header_set(): void
    {
        config(['nexora.trusted_proxies' => ['192.0.2.10', '2001:db8:abcd::/48']]);

        $request = Request::create('https://nexora.example.test/');

        (new TrustConfiguredProxies())->handle(
            $request,
            static fn (Request $request): Response => new Response('ok'),
        );

        $this->assertSame(
            ['192.0.2.10', '2001:db8:abcd::/48'],
            Request::getTrustedProxies(),
        );
        $this->assertSame(
            Request::HEADER_X_FORWARDED_FOR
                | Request::HEADER_X_FORWARDED_PORT
                | Request::HEADER_X_FORWARDED_PROTO,
            Request::getTrustedHeaderSet(),
        );

        Request::setTrustedProxies([], 0);
    }

    public function test_proxy_middleware_does_not_trust_any_proxy_when_configuration_is_empty(): void
    {
        config(['nexora.trusted_proxies' => []]);
        Request::setTrustedProxies(['198.51.100.10'], Request::HEADER_X_FORWARDED_FOR);

        $request = Request::create('http://nexora.example.test/');

        (new TrustConfiguredProxies())->handle(
            $request,
            static fn (Request $request): Response => new Response('ok'),
        );

        $this->assertSame([], Request::getTrustedProxies());

        Request::setTrustedProxies([], 0);
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
