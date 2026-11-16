<?php

declare(strict_types=1);

namespace JB\SecurityGuard\Laravel;

use Closure;
use JB\SecurityGuard\UniversalRateLimitClient;
use Throwable;

final class RateLimitMiddleware
{
    public function __construct(
        private readonly UniversalRateLimitClient $client,
        private readonly Closure $identityResolver
    ) {
    }

    public function handle(mixed $request, Closure $next, string $policy, string $scope): mixed
    {
        try {
            $identity = ($this->identityResolver)($request);
            if (!is_string($identity)) throw new \RuntimeException('identity resolver must return a string');
            $decision = $this->client->check($identity, $scope, $policy);
        } catch (Throwable) {
            return response()->json([
                'error' => 'security_rate_limit_unavailable',
                'message' => 'Request temporarily unavailable due to a security control.',
            ], 503, ['Retry-After' => '5', 'Cache-Control' => 'no-store']);
        }

        if (!$decision['allowed']) {
            $status = $decision['status'] ?? 503;
            $headers = ['Cache-Control' => 'no-store'];
            if ($decision['retryAfterSeconds'] !== null) {
                $headers['Retry-After'] = (string) $decision['retryAfterSeconds'];
            }
            return response()->json([
                'error' => $status === 429 ? 'rate_limit_exceeded' : 'security_rate_limit_unavailable',
                'message' => $status === 429
                    ? 'Too many requests. Try again later.'
                    : 'Request temporarily unavailable due to a security control.',
            ], $status, $headers);
        }

        return $next($request);
    }
}
