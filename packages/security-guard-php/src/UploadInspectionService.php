<?php

declare(strict_types=1);

namespace JB\SecurityGuard;

use Closure;
use RuntimeException;
use Throwable;



/**
 * Sequential reader over one quarantined object.
 * Only bounded read() calls are exposed; the underlying resource and seek APIs
 * are never passed to the scanner, so accounting reflects bytes actually delivered.
 */
final class UploadInspectionReadOnlyStream
{
    /** @var resource|null */
    private $source;
    private int $position = 0;
    private bool $eof = false;
    private bool $closed = false;
    private mixed $hash;

    public function __construct(
        mixed $source,
        private readonly int $expectedSize,
        private readonly string $expectedSha256
    ) {
        if (!is_resource($source) || $expectedSize < 1 ||
            !preg_match('/^[a-f0-9]{64}$/', $expectedSha256)) {
            throw new RuntimeException('Invalid upload scanner reader configuration');
        }

        $this->source = $source;
        $this->hash = hash_init('sha256');
    }

    /**
     * Return up to $count bytes actually delivered to the scanner.
     * An empty string means EOF. There is intentionally no seek operation.
     */
    public function read(int $count): string
    {
        if ($this->closed || !is_resource($this->source)) {
            throw new UploadInspectionException('SCAN_INCOMPLETE');
        }
        if ($count < 1 || $count > 1048576) {
            throw new UploadInspectionException('INVALID_SCAN_RESULT');
        }
        if ($this->eof) {
            return '';
        }

        $remaining = $this->expectedSize - $this->position;
        if ($remaining < 0) {
            throw new UploadInspectionException('SCAN_CONTENT_MISMATCH');
        }

        $bytes = fread($this->source, min($count, $remaining + 1));
        if ($bytes === false) {
            throw new UploadInspectionException('SCAN_CONTENT_MISMATCH');
        }
        if ($bytes === '') {
            if (!feof($this->source)) {
                // Non-blocking/custom streams may temporarily return no bytes
                // while more content is still available. Never treat that as EOF.
                throw new UploadInspectionException('SCAN_INCOMPLETE');
            }
            $this->eof = true;
            return '';
        }
        if (strlen($bytes) > $remaining) {
            throw new UploadInspectionException('SCAN_CONTENT_MISMATCH');
        }

        hash_update($this->hash, $bytes);
        $this->position += strlen($bytes);
        return $bytes;
    }

    /**
     * Verify that the scanner requested every byte and that those bytes match
     * the digest of the exact quarantined object.
     */
    public function verifyComplete(): string
    {
        if ($this->closed || !is_resource($this->source) ||
            $this->position !== $this->expectedSize) {
            return 'incomplete';
        }

        if (!$this->eof) {
            $extra = fread($this->source, 1);
            if ($extra === false || $extra !== '') {
                return 'content_mismatch';
            }
            if (!feof($this->source)) {
                return 'incomplete';
            }
            $this->eof = true;
        }

        $actualSha256 = hash_final(hash_copy($this->hash));
        return hash_equals($this->expectedSha256, $actualSha256)
            ? 'complete'
            : 'content_mismatch';
    }

    public function bytesRead(): int
    {
        return $this->position;
    }

    public function close(): void
    {
        $this->closed = true;
    }
}

/**
 * Runtime-native PHP upload inspection contract.
 *
 * This orchestrator deliberately supplies no production storage or antivirus
 * implementation. The host application must inject trusted adapters.
 */
final class UploadInspectionService
{
    private const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
    private const MAX_BYTES = 100 * 1024 * 1024;
    private const MAX_SIGNATURE_BYTES = 8192;

    private const TYPES = [
        'image/jpeg' => ['extensions' => ['jpg', 'jpeg']],
        'image/png' => ['extensions' => ['png']],
        'image/gif' => ['extensions' => ['gif']],
        'image/webp' => ['extensions' => ['webp']],
        'application/pdf' => ['extensions' => ['pdf']],
    ];

    private Closure $onEvent;

    public function __construct(
        private readonly UploadQuarantineStorage $storage,
        private readonly UploadMalwareScanner $scanner,
        private readonly int $maxBytes = self::DEFAULT_MAX_BYTES,
        ?Closure $onEvent = null
    ) {
        if ($maxBytes < 1 || $maxBytes > self::MAX_BYTES) {
            throw new RuntimeException('maxBytes must be between 1 and 104857600');
        }

        $this->onEvent = $onEvent ?? static function (array $event): void {};
    }

    public function inspect(
        string $sourcePath,
        string $clientFileName,
        ?string $declaredMimeType = null
    ): array {
        $uploadId = bin2hex(random_bytes(16));
        $quarantineAttempted = false;
        $retainQuarantine = false;
        $source = null;
        $writer = null;

        try {
            $extension = $this->extension($clientFileName);
            $declaredType = $this->normalizeMimeType($declaredMimeType);

            if (!is_file($sourcePath) || !is_readable($sourcePath)) {
                throw new UploadInspectionException('INVALID_INPUT');
            }

            $source = @fopen($sourcePath, 'rb');
            if (!is_resource($source)) {
                throw new UploadInspectionException('SOURCE_UNAVAILABLE');
            }

            $quarantineAttempted = true;
            $writer = $this->storage->createQuarantineStream($uploadId);
            $this->assertStream($writer, true);

            $hash = hash_init('sha256');
            $size = 0;
            $prefix = '';

            while (!feof($source)) {
                $chunk = fread($source, 65536);
                if ($chunk === false) {
                    throw new UploadInspectionException('INGEST_FAILED');
                }
                if ($chunk === '') {
                    if (feof($source)) {
                        break;
                    }
                    throw new UploadInspectionException('INGEST_FAILED');
                }

                $chunkLength = strlen($chunk);
                if ($size + $chunkLength > $this->maxBytes) {
                    throw new UploadInspectionException('UPLOAD_TOO_LARGE');
                }

                $size += $chunkLength;
                hash_update($hash, $chunk);
                if (strlen($prefix) < self::MAX_SIGNATURE_BYTES) {
                    $remaining = self::MAX_SIGNATURE_BYTES - strlen($prefix);
                    $prefix .= substr($chunk, 0, $remaining);
                }

                $this->writeAll($writer, $chunk);
            }

            if (!fclose($writer)) {
                $writer = null;
                throw new UploadInspectionException('QUARANTINE_WRITE_FAILED');
            }
            $writer = null;
            fclose($source);
            $source = null;

            if ($size === 0) {
                throw new UploadInspectionException('UNSUPPORTED_TYPE');
            }

            $detectedType = $this->detectMimeType($prefix);
            if ($detectedType === null) {
                throw new UploadInspectionException('UNSUPPORTED_TYPE');
            }

            if ($extension !== null && !in_array($extension, self::TYPES[$detectedType]['extensions'], true)) {
                throw new UploadInspectionException('EXTENSION_MISMATCH');
            }

            if ($declaredType !== null &&
                !in_array($declaredType, ['application/octet-stream', 'binary/octet-stream'], true) &&
                $declaredType !== $detectedType) {
                throw new UploadInspectionException('MIME_MISMATCH');
            }

            $sha256 = hash_final($hash);
            $metadata = [
                'uploadId' => $uploadId,
                'size' => $size,
                'sha256' => $sha256,
                'detectedMimeType' => $detectedType,
                'mimeType' => $detectedType,
            ];

            $scanSource = $this->storage->openQuarantineStream($uploadId);
            $this->assertStream($scanSource, false);
            $scanStream = new UploadInspectionReadOnlyStream($scanSource, $size, $sha256);
            try {
                $scanResult = $this->scanner->scan($scanStream, $metadata);
                $scanDisposition = $scanStream->verifyComplete();
                if ($scanDisposition !== 'complete') {
                    $retainQuarantine = true;
                    throw new UploadInspectionException(
                        $scanDisposition === 'content_mismatch'
                            ? 'SCAN_CONTENT_MISMATCH'
                            : 'SCAN_INCOMPLETE'
                    );
                }
            } catch (UploadInspectionException $exception) {
                if (in_array($exception->reason, ['SCAN_INCOMPLETE', 'SCAN_CONTENT_MISMATCH'], true)) {
                    $retainQuarantine = true;
                }
                throw $exception;
            } catch (Throwable) {
                $retainQuarantine = true;
                throw new UploadInspectionException('SCANNER_UNAVAILABLE');
            } finally {
                $scanStream->close();
                if (is_resource($scanSource)) {
                    fclose($scanSource);
                }
            }

            if (!$this->validScanResult($scanResult)) {
                $retainQuarantine = true;
                throw new UploadInspectionException('INVALID_SCAN_RESULT');
            }

            if ($scanResult['sha256'] !== $sha256 || $scanResult['size'] !== $size) {
                $retainQuarantine = true;
                throw new UploadInspectionException('SCAN_CONTENT_MISMATCH');
            }

            if (!$this->validScannerLabel($scanResult['engine'], 128) ||
                !$this->validScannerLabel($scanResult['version'], 64)) {
                $retainQuarantine = true;
                throw new UploadInspectionException('INVALID_SCAN_RESULT');
            }

            $scannedAtMs = (int) floor(microtime(true) * 1000);
            $attestation = CoreV1::validateUploadInspectionAttestationV1([
                'schema' => 'jb.security.upload-inspection.attestation/v1',
                'uploadId' => $uploadId,
                'verdict' => $scanResult['verdict'],
                'sha256' => $sha256,
                'size' => $size,
                'mimeType' => $detectedType,
                'engine' => $scanResult['engine'],
                'version' => $scanResult['version'],
                'scannedAtMs' => $scannedAtMs,
            ]);

            if ($scanResult['verdict'] === 'malicious') {
                // Preserve malicious evidence in private quarantine for response and forensics.
                $retainQuarantine = true;
                throw new UploadInspectionException('MALWARE_DETECTED', attestation: $attestation);
            }

            if ($scanResult['verdict'] !== 'clean') {
                $retainQuarantine = true;
                throw new UploadInspectionException('SCAN_NOT_CLEAN', attestation: $attestation);
            }

            $retainQuarantine = true;

            try {
                $promoted = $this->storage->promote($uploadId, $sha256, $size, $attestation);
            } catch (Throwable) {
                throw new UploadInspectionException('PROMOTION_FAILED', attestation: $attestation);
            }
            if (!$promoted) {
                $retainQuarantine = true;
                throw new UploadInspectionException('PROMOTION_FAILED', attestation: $attestation);
            }

            $this->emit('approved', 'clean_scan', $uploadId);

            return [
                'status' => 'approved',
                'uploadId' => $uploadId,
                'size' => $size,
                'sha256' => $sha256,
                'mimeType' => $detectedType,
                'scanner' => [
                    'engine' => $scanResult['engine'],
                    'version' => $scanResult['version'],
                ],
                'scannedAt' => gmdate('c', (int) floor($scannedAtMs / 1000)),
                'attestation' => $attestation,
            ];
        } catch (UploadInspectionException $exception) {
            if ($quarantineAttempted && !$retainQuarantine) {
                $this->cleanup($uploadId);
            }
            $this->emit(
                $retainQuarantine ? 'quarantined' : 'rejected',
                strtolower($exception->reason),
                $uploadId
            );
            throw $exception;
        } catch (Throwable) {
            if ($quarantineAttempted && !$retainQuarantine) {
                $this->cleanup($uploadId);
            }
            $this->emit('rejected', 'processing_failed', $uploadId);
            throw new UploadInspectionException('PROCESSING_FAILED');
        } finally {
            if (is_resource($writer)) {
                fclose($writer);
            }
            if (is_resource($source)) {
                fclose($source);
            }
        }
    }

    private function cleanup(string $uploadId): void
    {
        try {
            $this->storage->delete($uploadId);
        } catch (Throwable) {
            $this->emit('cleanup_failed', 'quarantine_delete_failed', $uploadId);
        }
    }

    private function emit(string $action, string $reason, string $uploadId): void
    {
        try {
            ($this->onEvent)([
                'timestamp' => gmdate('c'),
                'component' => 'jb-security-guard-php-upload',
                'action' => $action,
                'reason' => $reason,
                'correlationId' => $uploadId,
            ]);
        } catch (Throwable) {
            // Telemetry must never change the upload decision.
        }
    }

    private function assertStream(mixed $stream, bool $writable): void
    {
        if (!is_resource($stream) || get_resource_type($stream) !== 'stream') {
            throw new UploadInspectionException('STORAGE_UNAVAILABLE');
        }

        $mode = stream_get_meta_data($stream)['mode'] ?? '';
        if ($writable && !preg_match('/[waxc+]/', $mode)) {
            throw new UploadInspectionException('STORAGE_UNAVAILABLE');
        }
        if (!$writable && !str_contains($mode, 'r') && !str_contains($mode, '+')) {
            throw new UploadInspectionException('STORAGE_UNAVAILABLE');
        }
    }

    private function writeAll(mixed $stream, string $bytes): void
    {
        $offset = 0;
        $length = strlen($bytes);
        while ($offset < $length) {
            $written = fwrite($stream, substr($bytes, $offset));
            if (!is_int($written) || $written < 1) {
                throw new UploadInspectionException('QUARANTINE_WRITE_FAILED');
            }
            $offset += $written;
        }
    }

    private function extension(string $fileName): ?string
    {
        if ($fileName === '' || strlen($fileName) > 255 ||
            preg_match('/[\x00-\x1f\x7f]/', $fileName)) {
            throw new UploadInspectionException('INVALID_INPUT');
        }

        $basename = basename(str_replace('\\', '/', $fileName));
        $dot = strrpos($basename, '.');
        if ($dot === false || $dot === 0 || $dot === strlen($basename) - 1) {
            return null;
        }
        return strtolower(substr($basename, $dot + 1));
    }

    private function normalizeMimeType(?string $value): ?string
    {
        if ($value === null || trim($value) === '') {
            return null;
        }
        $normalized = strtolower(trim(explode(';', $value, 2)[0]));
        if (strlen($normalized) > 128 ||
            !preg_match('/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/D', $normalized)) {
            throw new UploadInspectionException('INVALID_INPUT');
        }
        return $normalized;
    }

    private function detectMimeType(string $prefix): ?string
    {
        foreach (self::TYPES as $mimeType => $_definition) {
            $matches = match ($mimeType) {
                'image/jpeg' => strlen($prefix) >= 3 && substr($prefix, 0, 3) === "\xFF\xD8\xFF",
                'image/png' => strlen($prefix) >= 8 && substr($prefix, 0, 8) === "\x89PNG\r\n\x1A\n",
                'image/gif' => strlen($prefix) >= 6 && in_array(substr($prefix, 0, 6), ['GIF87a', 'GIF89a'], true),
                'image/webp' => strlen($prefix) >= 12 && substr($prefix, 0, 4) === 'RIFF' && substr($prefix, 8, 4) === 'WEBP',
                'application/pdf' => strlen($prefix) >= 5 && substr($prefix, 0, 5) === '%PDF-',
                default => false,
            };
            if ($matches) {
                return $mimeType;
            }
        }
        return null;
    }

    private function validScanResult(mixed $result): bool
    {
        return is_array($result) &&
            in_array($result['verdict'] ?? null, ['clean', 'malicious', 'unknown'], true) &&
            is_int($result['size'] ?? null) &&
            is_string($result['sha256'] ?? null) &&
            preg_match('/^[a-f0-9]{64}$/D', $result['sha256']) === 1 &&
            is_string($result['engine'] ?? null) &&
            is_string($result['version'] ?? null);
    }

    private function validScannerLabel(string $value, int $maximumLength): bool
    {
        return $value !== '' && strlen($value) <= $maximumLength &&
            preg_match('/^[A-Za-z0-9][A-Za-z0-9 ._+-]*$/D', $value) === 1;
    }
}
