<?php

declare(strict_types=1);

namespace JB\SecurityGuard;

use InvalidArgumentException;

final class CoreV1
{
    private const IDENTIFIER = '/^[A-Za-z0-9:_-]{1,96}$/D';
    private const KEY_ID = '/^[A-Za-z0-9:_-]{1,64}$/D';
    private const SHA256_HEX = '/^[a-f0-9]{64}$/D';
    private const UUID = '/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iD';
    private const IDENTITY_TYPES = ['ip', 'account', 'account_ip', 'session', 'anonymous'];

    public static function deriveIdentityKey(
        string $secret,
        string $keyId,
        string $tenantId,
        string $applicationId,
        string $identityType,
        string $canonicalIdentity
    ): string {
        if (strlen($secret) < 32 || strlen($secret) > 4096) {
            throw new InvalidArgumentException('secret must contain 32-4096 bytes');
        }
        self::assertMatch($keyId, self::KEY_ID, 'keyId');
        self::assertMatch($tenantId, self::IDENTIFIER, 'tenantId');
        self::assertMatch($applicationId, self::IDENTIFIER, 'applicationId');
        if (!in_array($identityType, self::IDENTITY_TYPES, true)) {
            throw new InvalidArgumentException('identityType is unsupported');
        }
        self::assertCanonicalIdentity($canonicalIdentity);

        $message = "jb.security-guard.identity.v1\0"
            . $tenantId . "\0"
            . $applicationId . "\0"
            . $identityType . "\0"
            . $canonicalIdentity;

        return hash_hmac('sha256', $message, $secret, false);
    }

    public static function normalizeRateLimitCheck(array $input): array
    {
        self::assertExactKeys($input, [
            'schema', 'requestId', 'tenantId', 'applicationId', 'policyId', 'scope', 'identity'
        ], 'request');
        if (($input['schema'] ?? null) !== 'jb.security.rate-limit.check/v1') {
            throw new InvalidArgumentException('request.schema is unsupported');
        }
        self::assertMatch($input['requestId'] ?? null, self::UUID, 'requestId');
        foreach (['tenantId', 'applicationId', 'policyId', 'scope'] as $field) {
            self::assertMatch($input[$field] ?? null, self::IDENTIFIER, $field);
        }
        $identity = $input['identity'] ?? null;
        if (!is_array($identity)) {
            throw new InvalidArgumentException('identity must be an object-shaped array');
        }
        self::assertExactKeys($identity, ['type', 'key', 'keyId'], 'identity');
        if (!in_array($identity['type'] ?? null, self::IDENTITY_TYPES, true)) {
            throw new InvalidArgumentException('identity.type is unsupported');
        }
        self::assertMatch($identity['key'] ?? null, self::SHA256_HEX, 'identity.key');
        self::assertMatch($identity['keyId'] ?? null, self::KEY_ID, 'identity.keyId');

        return [
            'schema' => $input['schema'],
            'requestId' => strtolower($input['requestId']),
            'tenantId' => $input['tenantId'],
            'applicationId' => $input['applicationId'],
            'policyId' => $input['policyId'],
            'scope' => $input['scope'],
            'identity' => [
                'type' => $identity['type'],
                'key' => $identity['key'],
                'keyId' => $identity['keyId'],
            ],
        ];
    }

    public static function normalizeRateLimitDecision(array $input): array
    {
        self::assertExactKeys($input, [
            'schema', 'requestId', 'tenantId', 'applicationId', 'policyId', 'scope',
            'allowed', 'exceeded', 'enforced', 'unavailable', 'status', 'retryAfterSeconds'
        ], 'decision');
        if (($input['schema'] ?? null) !== 'jb.security.rate-limit.decision/v1') {
            throw new InvalidArgumentException('decision.schema is unsupported');
        }
        self::assertMatch($input['requestId'] ?? null, self::UUID, 'requestId');
        foreach (['tenantId', 'applicationId', 'policyId', 'scope'] as $field) {
            self::assertMatch($input[$field] ?? null, self::IDENTIFIER, $field);
        }
        foreach (['allowed', 'exceeded', 'enforced', 'unavailable'] as $field) {
            if (!is_bool($input[$field] ?? null)) {
                throw new InvalidArgumentException("decision.$field must be boolean");
            }
        }
        $status = $input['status'] ?? null;
        if (!in_array($status, [null, 429, 503], true)) {
            throw new InvalidArgumentException('decision.status must be null, 429, or 503');
        }
        $retry = $input['retryAfterSeconds'] ?? null;
        if ($retry !== null && (!is_int($retry) || $retry < 1 || $retry > 60)) {
            throw new InvalidArgumentException('decision.retryAfterSeconds must be null or 1-60');
        }
        if ($input['allowed'] && ($status !== null || $retry !== null || $input['enforced'])) {
            throw new InvalidArgumentException('allowed decisions cannot be enforced or carry a blocking response');
        }
        if ($input['allowed'] && $input['unavailable'] && $input['exceeded']) {
            throw new InvalidArgumentException('fail-open unavailable decisions cannot be quota-exceeded');
        }
        if (!$input['allowed'] && !in_array($status, [429, 503], true)) {
            throw new InvalidArgumentException('denied decisions require 429 or 503');
        }
        if ($status === 429 && (!$input['exceeded'] || !$input['enforced'] || $input['unavailable'])) {
            throw new InvalidArgumentException('429 requires exceeded=true, enforced=true and unavailable=false');
        }
        if ($status === 503 && ($input['exceeded'] || !$input['enforced'] || !$input['unavailable'])) {
            throw new InvalidArgumentException('503 requires exceeded=false, enforced=true and unavailable=true');
        }

        $input['requestId'] = strtolower($input['requestId']);
        return $input;
    }

    public static function normalizeRateLimitPolicy(array $input): array
    {
        self::assertExactKeys($input, [
            'schema', 'id', 'tenantId', 'applicationId', 'version',
            'enabled', 'mode', 'failureMode', 'limits'
        ], 'policy');
        if (($input['schema'] ?? null) !== 'jb.security.policy.rate-limit/v1') {
            throw new InvalidArgumentException('policy.schema is unsupported');
        }
        foreach (['id', 'tenantId', 'applicationId'] as $field) {
            self::assertMatch($input[$field] ?? null, self::IDENTIFIER, 'policy.' . $field);
        }
        if (!is_int($input['version'] ?? null) || $input['version'] < 1) {
            throw new InvalidArgumentException('policy.version must be a positive integer');
        }
        if (!is_bool($input['enabled'] ?? null)) {
            throw new InvalidArgumentException('policy.enabled must be boolean');
        }
        if (!in_array($input['mode'] ?? null, ['monitor', 'enforce'], true)) {
            throw new InvalidArgumentException('policy.mode is unsupported');
        }
        if (!in_array($input['failureMode'] ?? null, ['open', 'closed'], true)) {
            throw new InvalidArgumentException('policy.failureMode is unsupported');
        }
        $limits = $input['limits'] ?? null;
        if (!is_array($limits) || !array_is_list($limits) || count($limits) < 1 || count($limits) > 64) {
            throw new InvalidArgumentException('policy.limits must contain 1-64 entries');
        }
        $seen = [];
        $normalized = [];
        foreach ($limits as $index => $limit) {
            if (!is_array($limit)) {
                throw new InvalidArgumentException("policy.limits[$index] must be an object-shaped array");
            }
            self::assertExactKeys($limit, ['id', 'identityType', 'scope', 'windowSeconds', 'maxRequests'], "policy.limits[$index]");
            self::assertMatch($limit['id'] ?? null, self::IDENTIFIER, "policy.limits[$index].id");
            self::assertMatch($limit['scope'] ?? null, self::IDENTIFIER, "policy.limits[$index].scope");
            if (isset($seen[$limit['id']])) throw new InvalidArgumentException('policy limit IDs must be unique');
            $seen[$limit['id']] = true;
            if (!in_array($limit['identityType'] ?? null, self::IDENTITY_TYPES, true)) {
                throw new InvalidArgumentException("policy.limits[$index].identityType is unsupported");
            }
            if (!is_int($limit['windowSeconds'] ?? null) || $limit['windowSeconds'] < 1 || $limit['windowSeconds'] > 86400) {
                throw new InvalidArgumentException("policy.limits[$index].windowSeconds is out of bounds");
            }
            if (!is_int($limit['maxRequests'] ?? null) || $limit['maxRequests'] < 1 || $limit['maxRequests'] > 1000000) {
                throw new InvalidArgumentException("policy.limits[$index].maxRequests is out of bounds");
            }
            $normalized[] = [
                'id' => $limit['id'],
                'identityType' => $limit['identityType'],
                'scope' => $limit['scope'],
                'windowSeconds' => $limit['windowSeconds'],
                'maxRequests' => $limit['maxRequests'],
            ];
        }
        $input['limits'] = $normalized;
        return $input;
    }

    public static function createRateLimitCounterKey(array $input): string
    {
        self::assertExactKeys($input, [
            'tenantId', 'applicationId', 'policyId', 'scope', 'identityType', 'keyId', 'identityKey'
        ], 'counterKey');
        foreach (['tenantId', 'applicationId', 'policyId', 'scope'] as $field) {
            self::assertMatch($input[$field] ?? null, self::IDENTIFIER, 'counterKey.' . $field);
        }
        if (!in_array($input['identityType'] ?? null, self::IDENTITY_TYPES, true)) {
            throw new InvalidArgumentException('counterKey.identityType is unsupported');
        }
        self::assertMatch($input['keyId'] ?? null, self::KEY_ID, 'counterKey.keyId');
        self::assertMatch($input['identityKey'] ?? null, self::SHA256_HEX, 'counterKey.identityKey');
        $values = [
            'jbsg-counter-v1', $input['tenantId'], $input['applicationId'],
            $input['policyId'], $input['scope'], $input['identityType'],
            $input['keyId'], $input['identityKey'],
        ];
        return implode('', array_map(static fn(string $value): string => strlen($value) . ':' . $value, $values));
    }

    private static function assertExactKeys(array $value, array $allowed, string $label): void
    {
        foreach (array_keys($value) as $key) {
            if (!is_string($key) || !in_array($key, $allowed, true)) {
                throw new InvalidArgumentException("$label contains an unsupported field");
            }
        }
        foreach ($allowed as $key) {
            if (!array_key_exists($key, $value)) {
                throw new InvalidArgumentException("$label is missing field: $key");
            }
        }
    }

    private static function assertMatch(mixed $value, string $pattern, string $label): void
    {
        if (!is_string($value) || preg_match($pattern, $value) !== 1) {
            throw new InvalidArgumentException("$label has an invalid format");
        }
    }

    private static function assertCanonicalIdentity(string $value): void
    {
        if ($value === '' || str_contains($value, "\0") || strlen($value) > 2048 || preg_match('//u', $value) !== 1) {
            throw new InvalidArgumentException('canonicalIdentity must be valid UTF-8, non-empty, at most 2048 bytes and contain no NUL');
        }
        $characters = preg_match_all('/./us', $value);
        if ($characters === false || $characters < 1 || $characters > 512) {
            throw new InvalidArgumentException('canonicalIdentity must contain at most 512 Unicode characters');
        }
    }
}
