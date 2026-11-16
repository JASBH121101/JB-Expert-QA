<?php

declare(strict_types=1);

namespace JB\SecurityGuard;

use Closure;
use RuntimeException;
use Throwable;

final class UniversalRateLimitClient
{
    private Closure $transport;
    private string $failureMode;

    public function __construct(
        private readonly string $endpoint,
        private readonly string $clientId,
        private readonly string $clientSecret,
        string $failureMode = 'closed',
        private readonly int $timeoutMs = 2500,
        ?Closure $transport = null
    ) {
        $url = parse_url($endpoint);
        if (!is_array($url) || ($url['scheme'] ?? null) !== 'https' || empty($url['host']) ||
            isset($url['user']) || isset($url['pass']) || isset($url['query']) || isset($url['fragment'])) {
            throw new RuntimeException('endpoint must be an absolute HTTPS URL without embedded credentials, query, or fragment');
        }
        if (!preg_match('/^[A-Za-z0-9:_-]{1,96}$/D', $clientId)) {
            throw new RuntimeException('clientId has an invalid format');
        }
        if (strlen($clientSecret) < 32 || strlen($clientSecret) > 512) {
            throw new RuntimeException('clientSecret must contain 32-512 bytes');
        }
        if (!in_array($failureMode, ['open', 'closed'], true)) {
            throw new RuntimeException('failureMode must be open or closed');
        }
        if ($timeoutMs < 100 || $timeoutMs > 15000) {
            throw new RuntimeException('timeoutMs must be from 100 to 15000');
        }
        $this->failureMode = $failureMode;
        $this->transport = $transport ?? Closure::fromCallable([$this, 'sendHttpRequest']);
    }

    public function check(string $identity, string $scope, string $policy): array
    {
        if (trim($identity) === '' || strlen($identity) > 2048 || str_contains($identity, "\0") ||
            preg_match('//u', $identity) !== 1 || self::utf16CodeUnitLength($identity) > 512) {
            throw new RuntimeException('identity must be valid UTF-8, contain no NUL, and use at most 512 UTF-16 code units and 2048 bytes');
        }
        if (!preg_match('/^[A-Za-z0-9:_-]{1,96}$/D', $scope) ||
            !preg_match('/^[A-Za-z0-9:_-]{1,96}$/D', $policy)) {
            throw new RuntimeException('scope and policy must be safe identifiers');
        }

        $payload = json_encode([
            'identity' => $identity,
            'scope' => $scope,
            'policy' => $policy,
        ], JSON_THROW_ON_ERROR);
        $headers = [
            'Content-Type' => 'application/json',
            'Accept' => 'application/json',
            'X-JB-Client-ID' => $this->clientId,
            'Authorization' => 'Bearer ' . $this->clientSecret,
        ];

        try {
            $response = ($this->transport)($this->endpoint, $headers, $payload, $this->timeoutMs);
            if (!is_array($response) || !is_int($response['status'] ?? null) ||
                !is_array($response['headers'] ?? null) || !is_string($response['body'] ?? null) ||
                strlen($response['body']) > 16384) {
                return $this->deny();
            }
        } catch (Throwable) {
            return $this->unavailable();
        }

        $status = $response['status'];
        if ($status === 200) {
            try {
                $body = json_decode($response['body'], true, 8, JSON_THROW_ON_ERROR);
            } catch (Throwable) {
                return $this->deny();
            }
            if (!is_array($body) || ($body['allowed'] ?? null) !== true ||
                ($body['scope'] ?? null) !== $scope || ($body['policy'] ?? null) !== $policy) {
                return $this->deny();
            }
            return [
                'allowed' => true, 'exceeded' => false, 'enforced' => false,
                'unavailable' => false, 'status' => null, 'retryAfterSeconds' => null,
            ];
        }
        if ($status === 429) {
            $retry = $response['headers']['retry-after'] ?? $response['headers']['Retry-After'] ?? '60';
            $retry = filter_var($retry, FILTER_VALIDATE_INT);
            $retry = is_int($retry) ? max(1, min(60, $retry)) : 60;
            return [
                'allowed' => false, 'exceeded' => true, 'enforced' => true,
                'unavailable' => false, 'status' => 429, 'retryAfterSeconds' => $retry,
            ];
        }
        if ($status === 503) {
            return $this->unavailable();
        }

        // Authentication and configuration errors are never fail-open.
        return $this->deny();
    }

    private function unavailable(): array
    {
        if ($this->failureMode === 'open') {
            return [
                'allowed' => true, 'exceeded' => false, 'enforced' => false,
                'unavailable' => true, 'status' => null, 'retryAfterSeconds' => null,
            ];
        }
        return [
            'allowed' => false, 'exceeded' => false, 'enforced' => true,
            'unavailable' => true, 'status' => 503, 'retryAfterSeconds' => 5,
        ];
    }

    private function deny(): array
    {
        return [
            'allowed' => false, 'exceeded' => false, 'enforced' => true,
            'unavailable' => true, 'status' => 503, 'retryAfterSeconds' => 5,
        ];
    }

    private static function utf16CodeUnitLength(string $value): int
    {
        $matches = [];
        if (preg_match_all('/./us', $value, $matches) === false) {
            throw new RuntimeException('identity must be valid UTF-8');
        }
        $units = 0;
        foreach ($matches[0] as $character) {
            $units += strlen($character) === 4 ? 2 : 1;
        }
        return $units;
    }

    private function sendHttpRequest(string $url, array $headers, string $body, int $timeoutMs): array
    {
        $lines = [];
        foreach ($headers as $name => $value) $lines[] = $name . ': ' . $value;
        $context = stream_context_create([
            'http' => [
                'method' => 'POST',
                'header' => implode("\r\n", $lines),
                'content' => $body,
                'timeout' => $timeoutMs / 1000,
                'ignore_errors' => true,
                'follow_location' => 0,
                'max_redirects' => 0,
                'protocol_version' => 1.1,
            ],
            'ssl' => ['verify_peer' => true, 'verify_peer_name' => true],
        ]);
        $responseStream = @fopen($url, 'rb', false, $context);
        if ($responseStream === false) {
            throw new RuntimeException('Universal rate-limit endpoint did not respond');
        }
        // Read one byte beyond the accepted cap so oversized responses fail closed.
        $responseBody = stream_get_contents($responseStream, 16385);
        fclose($responseStream);
        $rawHeaders = $http_response_header ?? [];
        $status = 0;
        $responseHeaders = [];
        foreach ($rawHeaders as $line) {
            if (preg_match('/^HTTP\/\S+\s+(\d{3})/', $line, $matches)) {
                $status = (int) $matches[1];
                continue;
            }
            $position = strpos($line, ':');
            if ($position !== false) {
                $responseHeaders[strtolower(trim(substr($line, 0, $position)))] = trim(substr($line, $position + 1));
            }
        }
        if ($status === 0) throw new RuntimeException('Universal rate-limit endpoint did not respond');
        return ['status' => $status, 'headers' => $responseHeaders, 'body' => $responseBody === false ? '' : $responseBody];
    }
}
