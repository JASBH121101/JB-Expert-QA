<?php

declare(strict_types=1);

return [
    'endpoint' => env('JB_SECURITY_GUARD_ENDPOINT', ''),
    'client_id' => env('JB_SECURITY_GUARD_CLIENT_ID', ''),
    'client_secret' => env('JB_SECURITY_GUARD_CLIENT_SECRET', ''),
    'failure_mode' => env('JB_SECURITY_GUARD_FAILURE_MODE', 'closed'),
    'timeout_ms' => (int) env('JB_SECURITY_GUARD_TIMEOUT_MS', 2500),

    // Upload inspection is fail-closed. If clamscan is missing or unavailable,
    // the inspector retains the file in private quarantine instead of approving it.
    'uploads' => [
        'storage_root' => env('JB_SECURITY_GUARD_UPLOAD_STORAGE_ROOT', storage_path('app/private/jb-security-guard')),
        'clamav_binary' => env('JB_SECURITY_GUARD_CLAMAV_BINARY', 'clamscan'),
        'scanner_timeout_ms' => (int) env('JB_SECURITY_GUARD_UPLOAD_SCAN_TIMEOUT_MS', 15000),
        'max_bytes' => (int) env('JB_SECURITY_GUARD_UPLOAD_MAX_BYTES', 5242880),
        'max_width' => (int) env('JB_SECURITY_GUARD_UPLOAD_MAX_WIDTH', 4000),
        'max_height' => (int) env('JB_SECURITY_GUARD_UPLOAD_MAX_HEIGHT', 4000),
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
