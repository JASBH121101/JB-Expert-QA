<?php

declare(strict_types=1);

namespace JB\SecurityGuard\UploadInspection;

use finfo;
use Throwable;

final class UploadInspector
{
    private const TYPES = [
        'image/jpeg' => ['extensions' => ['jpg', 'jpeg'], 'imageType' => 2, 'extension' => 'jpg'],
        'image/png' => ['extensions' => ['png'], 'imageType' => 3, 'extension' => 'png'],
        'image/webp' => ['extensions' => ['webp'], 'imageType' => 18, 'extension' => 'webp'],
    ];

    public function __construct(
        private readonly PrivateUploadStoreInterface $store,
        private readonly MalwareScannerInterface $scanner,
        private readonly int $maxBytes = 5242880,
        private readonly int $maxWidth = 4000,
        private readonly int $maxHeight = 4000
    ) {
        if ($maxBytes < 1 || $maxBytes > 52428800) {
            throw new \InvalidArgumentException('maxBytes must be between 1 and 52428800');
        }
        if ($maxWidth < 1 || $maxWidth > 10000 || $maxHeight < 1 || $maxHeight > 10000) {
            throw new \InvalidArgumentException('image dimensions must be between 1 and 10000');
        }
    }

    public function inspect(string $sourcePath, string $clientFileName, ?string $declaredMimeType = null): array
    {
        if (!is_file($sourcePath) || !is_readable($sourcePath)) {
            throw new UploadInspectionException('INVALID_INPUT');
        }

        $size = filesize($sourcePath);
        if (!is_int($size) || $size < 1) {
            throw new UploadInspectionException('INVALID_INPUT');
        }
        if ($size > $this->maxBytes) {
            throw new UploadInspectionException('UPLOAD_TOO_LARGE');
        }

        $extension = strtolower(pathinfo($clientFileName, PATHINFO_EXTENSION));
        $finfo = new finfo(FILEINFO_MIME_TYPE);
        $mimeType = $finfo->file($sourcePath);
        if (!is_string($mimeType) || !isset(self::TYPES[$mimeType])) {
            throw new UploadInspectionException('UNSUPPORTED_TYPE');
        }

        $type = self::TYPES[$mimeType];
        if (!in_array($extension, $type['extensions'], true)) {
            throw new UploadInspectionException('EXTENSION_MISMATCH');
        }

        $declared = strtolower(trim((string) $declaredMimeType));
        if ($declared === 'image/jpg') $declared = 'image/jpeg';
        if ($declared !== '' && !in_array($declared, ['application/octet-stream', 'binary/octet-stream', $mimeType], true)) {
            throw new UploadInspectionException('MIME_MISMATCH');
        }

        $image = @getimagesize($sourcePath);
        if (!is_array($image) || ($image[2] ?? null) !== $type['imageType']) {
            throw new UploadInspectionException('UNSUPPORTED_TYPE');
        }
        $width = $image[0] ?? 0;
        $height = $image[1] ?? 0;
        if (!is_int($width) || !is_int($height) || $width < 1 || $height < 1 ||
            $width > $this->maxWidth || $height > $this->maxHeight) {
            throw new UploadInspectionException('IMAGE_DIMENSIONS');
        }

        $uploadId = bin2hex(random_bytes(16));
        try {
            $this->store->quarantine($uploadId, $sourcePath);
        } catch (Throwable) {
            throw new UploadInspectionException('STORAGE_UNAVAILABLE');
        }

        $quarantinePath = $this->store->quarantinePath($uploadId);
        $quarantineSize = is_file($quarantinePath) ? filesize($quarantinePath) : false;
        $sha256 = is_file($quarantinePath) ? hash_file('sha256', $quarantinePath) : false;
        if (!is_int($quarantineSize) || $quarantineSize !== $size ||
            !is_string($sha256) || !preg_match('/^[a-f0-9]{64}$/D', $sha256)) {
            $this->safeDelete($uploadId);
            throw new UploadInspectionException('INVALID_SCAN_RESULT');
        }

        try {
            $scan = $this->scanner->scan($quarantinePath);
        } catch (Throwable) {
            $scan = ['verdict' => 'unknown', 'engine' => 'scanner', 'version' => 'unavailable'];
        }

        $afterSize = is_file($quarantinePath) ? filesize($quarantinePath) : false;
        $afterSha256 = is_file($quarantinePath) ? hash_file('sha256', $quarantinePath) : false;
        if ($afterSize !== $size || !is_string($afterSha256) || !hash_equals($sha256, $afterSha256)) {
            $this->safeDelete($uploadId);
            throw new UploadInspectionException('INVALID_SCAN_RESULT');
        }

        $verdict = is_array($scan) ? ($scan['verdict'] ?? 'unknown') : 'unknown';
        if ($verdict === 'malicious') {
            $this->safeDelete($uploadId);
            throw new UploadInspectionException('MALWARE_DETECTED');
        }

        $engine = is_array($scan) ? ($scan['engine'] ?? null) : null;
        $version = is_array($scan) ? ($scan['version'] ?? null) : null;
        if ($verdict !== 'clean' || !$this->validScannerLabel($engine) || !$this->validScannerLabel($version)) {
            return [
                'status' => 'quarantined',
                'uploadId' => $uploadId,
                'sha256' => $sha256,
                'size' => $size,
                'mimeType' => $mimeType,
                'reason' => 'SCAN_UNKNOWN',
            ];
        }

        try {
            $relativePath = $this->store->promote($uploadId, $sha256, $size, $mimeType);
            $approvedPath = $this->store->resolveApproved($relativePath);
        } catch (Throwable) {
            $this->safeDelete($uploadId);
            throw new UploadInspectionException('APPROVAL_FAILED');
        }

        $approvedSize = is_file($approvedPath) ? filesize($approvedPath) : false;
        $approvedSha256 = is_file($approvedPath) ? hash_file('sha256', $approvedPath) : false;
        if ($approvedSize !== $size || !is_string($approvedSha256) || !hash_equals($sha256, $approvedSha256)) {
            $this->safeDelete($uploadId);
            throw new UploadInspectionException('APPROVAL_FAILED');
        }

        return [
            'status' => 'approved',
            'uploadId' => $uploadId,
            'path' => $relativePath,
            'sha256' => $sha256,
            'size' => $size,
            'mimeType' => $mimeType,
            'scanner' => ['engine' => $engine, 'version' => $version],
            'scannedAt' => gmdate('c'),
        ];
    }

    private function validScannerLabel(mixed $value): bool
    {
        return is_string($value) && strlen($value) >= 1 && strlen($value) <= 80 &&
            preg_match('/^[A-Za-z0-9][A-Za-z0-9 ._+-]*$/D', $value) === 1;
    }

    private function safeDelete(string $uploadId): void
    {
        try {
            $this->store->delete($uploadId);
        } catch (Throwable) {
            // Cleanup failure leaves the object in private storage for retention cleanup.
        }
    }
}
