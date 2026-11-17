<?php

declare(strict_types=1);

require_once __DIR__ . '/../src/CoreV1.php';
require_once __DIR__ . '/../src/UniversalRateLimitClient.php';

use JB\SecurityGuard\CoreV1;
use JB\SecurityGuard\UniversalRateLimitClient;

function expect(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}

$fixturePath = dirname(__DIR__, 2) . '/security-guard-core/tests/fixtures/identity-key-derivation.v1.json';
$fixture = json_decode((string) file_get_contents($fixturePath), true, 8, JSON_THROW_ON_ERROR);
$secret = hex2bin($fixture['secretHex']);
$key = CoreV1::deriveIdentityKey(
    $secret,
    $fixture['keyId'],
    $fixture['tenantId'],
    $fixture['applicationId'],
    $fixture['identityType'],
    $fixture['canonicalIdentity']
);
expect($key === $fixture['expectedKey'], 'PHP HMAC must match the shared Core v1 known-answer vector');

$check = CoreV1::normalizeRateLimitCheck([
    'schema' => 'jb.security.rate-limit.check/v1',
    'requestId' => 'b37a5d9e-40c4-4d3b-bf9c-62d79ecf9f3a',
    'tenantId' => 'tenant-demo',
    'applicationId' => 'catalog-api',
    'policyId' => 'public-api',
    'scope' => 'catalog:list',
    'identity' => ['type' => 'anonymous', 'key' => str_repeat('a', 64), 'keyId' => 'k2026-01'],
]);
expect($check['identity']['type'] === 'anonymous', 'Core check validator must normalize a valid opaque identity');

$failOpen = CoreV1::normalizeRateLimitDecision([
    'schema' => 'jb.security.rate-limit.decision/v1',
    'requestId' => 'b37a5d9e-40c4-4d3b-bf9c-62d79ecf9f3a',
    'tenantId' => 'tenant-demo',
    'applicationId' => 'catalog-api',
    'policyId' => 'public-api',
    'scope' => 'catalog:list',
    'allowed' => true,
    'exceeded' => false,
    'enforced' => false,
    'unavailable' => true,
    'status' => null,
    'retryAfterSeconds' => null,
]);
expect($failOpen['allowed'] && $failOpen['unavailable'], 'Fail-open unavailable decisions must be valid');
expect(
    CoreV1::createRateLimitCounterKey([
        'tenantId' => 'tenant-demo',
        'applicationId' => 'catalog-api',
        'policyId' => 'public-api',
        'scope' => 'catalog:list',
        'identityType' => 'account',
        'keyId' => 'k2026-01',
        'identityKey' => $key,
    ]) === '15:jbsg-counter-v1' . '11:tenant-demo' . '11:catalog-api' . '10:public-api' . '12:catalog:list' . '7:account' . '8:k2026-01' . '64:' . $key,
    'Counter key must match the length-prefixed Core v1 format'
);

$captured = null;
$client = new UniversalRateLimitClient(
    'https://guard.example/__jb/security-guard/v1/check',
    'catalog-api',
    'php-client-secret-at-least-32-bytes',
    'closed',
    1000,
    static function ($url, $headers, $body, $timeout) use (&$captured): array {
        $captured = compact('url', 'headers', 'body', 'timeout');
        return [
            'status' => 200,
            'headers' => [],
            'body' => json_encode(['allowed' => true, 'policy' => 'public', 'scope' => 'catalog-read']),
        ];
    }
);
$decision = $client->check('user-123', 'catalog-read', 'public');
expect($decision['allowed'] && !$decision['unavailable'], 'PHP universal client must map an allowed response');
expect(str_starts_with($captured['headers']['Authorization'], 'Bearer '), 'PHP client must use server-side Bearer authentication');
expect(!str_contains($captured['body'], 'php-client-secret'), 'PHP client must not put credentials in JSON body');

$unicodeDecision = $client->check(str_repeat('€', 512), 'catalog-read', 'public');
expect($unicodeDecision['allowed'], 'PHP client must accept the shared 512 UTF-16-unit / 2048-byte identity boundary');
$oversizedIdentityRejected = false;
try {
    $client->check(str_repeat('€', 513), 'catalog-read', 'public');
} catch (RuntimeException) {
    $oversizedIdentityRejected = true;
}
expect($oversizedIdentityRejected, 'PHP client must reject identities beyond 512 UTF-16 code units');

$oversizedResponseClient = new UniversalRateLimitClient(
    'https://guard.example/check', 'catalog-api',
    'php-client-secret-at-least-32-bytes', 'open', 1000,
    static fn() => ['status' => 200, 'headers' => [], 'body' => str_repeat('x', 16385)]
);
expect(!$oversizedResponseClient->check('user-123', 'catalog-read', 'public')['allowed'],
    'PHP client must reject oversized upstream response bodies');

$embeddedCredentialsRejected = false;
try {
    new UniversalRateLimitClient(
        'https://user:password@guard.example/check', 'catalog-api',
        'php-client-secret-at-least-32-bytes'
    );
} catch (RuntimeException) {
    $embeddedCredentialsRejected = true;
}
expect($embeddedCredentialsRejected, 'PHP client must reject endpoint userinfo');

$failClosedClient = new UniversalRateLimitClient(
    'https://guard.example/check', 'catalog-api',
    'php-client-secret-at-least-32-bytes', 'closed', 1000,
    static fn() => throw new RuntimeException('transport private detail')
);
$denied = $failClosedClient->check('user-123', 'catalog-read', 'public');
expect(!$denied['allowed'] && $denied['status'] === 503, 'Transport outages must fail closed by default');

$failOpenClient = new UniversalRateLimitClient(
    'https://guard.example/check', 'catalog-api',
    'php-client-secret-at-least-32-bytes', 'open', 1000,
    static fn() => throw new RuntimeException('transport private detail')
);
$observed = $failOpenClient->check('user-123', 'catalog-read', 'public');
expect($observed['allowed'] && !$observed['enforced'] && $observed['unavailable'], 'Fail-open is explicit and remains observable');

$authFailureClient = new UniversalRateLimitClient(
    'https://guard.example/check', 'catalog-api',
    'php-client-secret-at-least-32-bytes', 'open', 1000,
    static fn() => ['status' => 401, 'headers' => [], 'body' => '{"error":"unauthorized"}']
);
expect(!$authFailureClient->check('user-123', 'catalog-read', 'public')['allowed'], 'Authentication errors must never fail open');

require_once __DIR__ . '/upload-inspection.php';
runUploadInspectionTests();

echo "PASS: PHP Core v1 HMAC vector, normalizers, universal API client and upload inspection.\n";
