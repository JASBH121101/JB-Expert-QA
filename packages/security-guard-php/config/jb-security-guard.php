<?php

declare(strict_types=1);

return [
    'endpoint' => env('JB_SECURITY_GUARD_ENDPOINT', ''),
    'client_id' => env('JB_SECURITY_GUARD_CLIENT_ID', ''),
    'client_secret' => env('JB_SECURITY_GUARD_CLIENT_SECRET', ''),
    'failure_mode' => env('JB_SECURITY_GUARD_FAILURE_MODE', 'closed'),
    'timeout_ms' => (int) env('JB_SECURITY_GUARD_TIMEOUT_MS', 2500),
    'uploads' => [
        'max_bytes' => (int) env('JB_SECURITY_GUARD_UPLOAD_MAX_BYTES', 5 * 1024 * 1024),
    ],

    // Resolve a stable, server-trusted identity. Do not read identity from
    // request bodies, query strings, cookies, or untrusted forwarding headers.
    'identity_resolver' => static function ($request): string {
        $user = $request->user();
        if ($user !== null && method_exists($user, 'getAuthIdentifier')) {
            return (string) $user->getAuthIdentifier();
        }
        $ip = $request->ip();
        if (!is_string($ip) || $ip === '') {
            throw new RuntimeException('Trusted client identity could not be resolved');
        }
        return $ip;
    },
];
