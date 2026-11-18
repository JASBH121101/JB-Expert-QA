<?php

declare(strict_types=1);

namespace JB\SecurityGuard;

use Closure;
use RuntimeException;
use Throwable;

final class UploadInspectionReadOnlyStream
{
    private const SCHEME = 'jbsg-upload-scan-v1';

    /** @var array<string, resource> */
    private static array $sources = [];
    /** @var array<string, int> */
    private static array $positions = [];
    /** @var array<string, \HashContext> */
    private static array $hashes = [];
    private static bool $registered = false;

    /** @var resource|null */
    private $source = null;
    private string $uploadId = '';
    private int $position = 0;
    public mixed $context;

    public static function open(string $uploadId, mixed $source): mixed
    {
        if (!is_resource($source)) {
            return false;
        }

        if (!self::$registered) {
            if (in_array(self::SCHEME, stream_get_wrappers(), true)) {
                throw new RuntimeException('Upload scan stream scheme is already registered');
            }
            if (!stream_wrapper_register(self::SCHEME, self::class)) {
                throw new RuntimeException('Could not register the read-only upload scan stream');
            }
            self::$registered = true;
        }

        self::$sources[$uploadId] = $source;
        $stream = @fopen(self::SCHEME . '://' . $uploadId, 'rb');
        if (!is_resource($stream)) {
            unset(self::$sources[$uploadId]);
            return false;
        }

        return $stream;
    }

    public static function verifyComplete(
        string $uploadId,
        int $expectedSize,
        string $expectedSha256
    ): string {
        if (!isset(self::$sources[$uploadId], self::$positions[$uploadId], self::$hashes[$uploadId])) {
            return 'incomplete';
        }

        $source = self::$sources[$uploadId];
        if (!is_resource($source) ||
            self::$positions[$uploadId] !== $expectedSize ||
            !feof($source)) {
            return 'incomplete';
        }

        $actualSha256 = hash_final(hash_copy(self::$hashes[$uploadId]));
        return hash_equals($expectedSha256, $actualSha256) ? 'complete' : 'content_mismatch';
    }

    public static function forget(string $uploadId): void
    {
        unset(self::$sources[$uploadId], self::$positions[$uploadId], self::$hashes[$uploadId]);
    }

    public function stream_open(string $path, string $mode, int $options, ?string &$openedPath): bool
    {
        if ($mode !== 'rb') {
            return false;
        }

        $uploadId = parse_url($path, PHP_URL_HOST);
        if (!is_string($uploadId) || !isset(self::$sources[$uploadId]) ||
            !is_resource(self::$sources[$uploadId])) {
            return false;
        }

        $this->source = self::$sources[$uploadId];
        $this->uploadId = $uploadId;
        $this->position = 0;
        self::$positions[$uploadId] = 0;
        self::$hashes[$uploadId] = hash_init('sha256');
        return true;
    }

    public function stream_read(int $count): string|false
    {
        if (!is_resource($this->source) || $count < 1) {
            return false;
        }

        $bytes = fread($this->source, $count);
        if ($bytes === false) {
            return false;
        }

        if ($bytes !== '') {
            hash_update(self::$hashes[$this->uploadId], $bytes);
        }
        $this->position += strlen($bytes);
        self::$positions[$this->uploadId] = $this->position;
        return $bytes;
    }

    public function stream_eof(): bool
    {
        return !is_resource($this->source) || feof($this->source);
    }

    public function stream_tell(): int
    {
        return $this->position;
    }

    public function stream_seek(int $offset, int $whence = SEEK_SET): bool
    {
        return false;
    }

    public function stream_stat(): array|false
    {
        return is_resource($this->source) ? fstat($this->source) : false;
    }

    public function url_stat(string $path, int $flags): array|false
    {
        return false;
    }

    public function stream_set_option(int $option, int $arg1, int $arg2): bool
    {
        if ($option === STREAM_OPTION_READ_BUFFER) {
            return $arg1 === STREAM_BUFFER_NONE && $arg2 === 0;
        }

        return false;
    }

    public function stream_flush(): bool
    {
        return true;
    }

    public function stream_close(): void
    {
        $this->source = null;
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
                'size' => $size,
                'sha256' => $sha256,
                'mimeType' => $detectedType,
            ];

            $scanSource = $this->storage->openQuarantineStream($uploadId);
            $this->assertStream($scanSource, false);
            $scanStream = UploadInspectionReadOnlyStream::open($uploadId, $scanSource);
            if (!is_resource($scanStream)) {
                fclose($scanSource);
                throw new UploadInspectionException('STORAGE_UNAVAILABLE');
            }
            $this->assertStream($scanStream, false);
            if (stream_set_read_buffer($scanStream, 0) !== 0) {
                throw new UploadInspectionException('STORAGE_UNAVAILABLE');
            }
            try {
                $scanResult = $this->scanner->scan($scanStream, $metadata);
                $scanDisposition = UploadInspectionReadOnlyStream::verifyComplete(
                    $uploadId,
                    $size,
                    $sha256
                );
                if ($scanDisposition !== 'complete') {
                    $retainQuarantine = true;
                    throw new UploadInspectionException(
                        $scanDisposition === 'content_mismatch'
                            ? 'SCAN_CONTENT_MISMATCH'
                            : 'SCAN_INCOMPLETE'
                    );
                }
            } catch (UploadInspectionException $exception) {
                throw $exception;
            } catch (Throwable) {
                $retainQuarantine = true;
                throw new UploadInspectionException('SCANNER_UNAVAILABLE');
            } finally {
                if (is_resource($scanStream)) {
                    fclose($scanStream);
                }
                UploadInspectionReadOnlyStream::forget($uploadId);
                if (is_resource($scanSource)) {
                    fclose($scanSource);
                }
            }

            if (!$this->validScanResult($scanResult)) {
                $retainQuarantine = true;
                throw new UploadInspectionException('INVALID_SCAN_RESULT');
            }

            if ($scanResult['verdict'] === 'malicious') {
                throw new UploadInspectionException('MALWARE_DETECTED');
            }

            if ($scanResult['verdict'] !== 'clean') {
                $retainQuarantine = true;
                throw new UploadInspectionException('SCAN_NOT_CLEAN');
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

            $retainQuarantine = true;
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

            if (!$this->storage->promote($uploadId, $sha256, $size, $attestation)) {
                $retainQuarantine = true;
                throw new UploadInspectionException('PROMOTION_FAILED');
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
                'scannedAt' => gmdate('c'),
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
