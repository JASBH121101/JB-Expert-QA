<?php

declare(strict_types=1);

namespace JB\SecurityGuard\Tests;

use JB\SecurityGuard\UploadInspectionException;
use JB\SecurityGuard\UploadInspectionService;
use JB\SecurityGuard\UploadMalwareScanner;
use JB\SecurityGuard\UploadQuarantineStorage;
use RuntimeException;

final class UploadInspectionTestStorage implements UploadQuarantineStorage
{
    private string $quarantine;
    private string $approved;

    public function __construct(string $root)
    {
        $this->quarantine = $root . '/quarantine';
        $this->approved = $root . '/approved';
        mkdir($this->quarantine, 0700, true);
        mkdir($this->approved, 0700, true);
    }

    public function createQuarantineStream(string $uploadId): mixed
    {
        return fopen($this->quarantine . '/' . $uploadId, 'wb');
    }

    public function openQuarantineStream(string $uploadId): mixed
    {
        $path = $this->quarantine . '/' . $uploadId;
        return is_file($path) ? fopen($path, 'rb') : false;
    }

    public function promote(string $uploadId, string $expectedSha256, int $expectedSize): bool
    {
        $source = $this->quarantine . '/' . $uploadId;
        if (!is_file($source) ||
            filesize($source) !== $expectedSize ||
            hash_file('sha256', $source) !== $expectedSha256) {
            return false;
        }
        return rename($source, $this->approved . '/' . $uploadId);
    }

    public function delete(string $uploadId): void
    {
        foreach ([$this->quarantine . '/' . $uploadId, $this->approved . '/' . $uploadId] as $path) {
            if (is_file($path) && !unlink($path)) {
                throw new RuntimeException('Test store could not delete upload');
            }
        }
    }

    public function quarantineCount(): int
    {
        return count(array_diff(scandir($this->quarantine) ?: [], ['.', '..']));
    }

    public function approvedCount(): int
    {
        return count(array_diff(scandir($this->approved) ?: [], ['.', '..']));
    }
}

final class UploadInspectionTestScanner implements UploadMalwareScanner
{
    public function __construct(
        private readonly string $verdict = 'clean',
        private readonly bool $tamperDigest = false,
        private readonly bool $unavailable = false
    ) {
    }

    public function scan(mixed $stream, array $metadata): array
    {
        if ($this->unavailable) {
            throw new RuntimeException('Synthetic scanner outage');
        }
        $hash = hash_init('sha256');
        $size = 0;
        while (!feof($stream)) {
            $chunk = fread($stream, 65536);
            if ($chunk === false) throw new RuntimeException('Could not read quarantine stream');
            if ($chunk === '') break;
            $size += strlen($chunk);
            hash_update($hash, $chunk);
        }
        $sha256 = hash_final($hash);
        if ($this->tamperDigest) $sha256 = str_repeat('0', 64);
        return [
            'verdict' => $this->verdict,
            'sha256' => $sha256,
            'size' => $size,
            'engine' => 'JB-Test-Scanner',
            'version' => '1.0',
        ];
    }
}

function runUploadInspectionServiceTests(): void
{
    $root = sys_get_temp_dir() . '/jb-security-guard-upload-' . bin2hex(random_bytes(6));
    mkdir($root, 0700, true);
    $source = $root . '/input.bin';
    $png = "\x89PNG\r\n\x1A\n" . 'synthetic png bytes for upload contract';
    file_put_contents($source, $png);

    try {
        $store = new UploadInspectionTestStorage($root . '/clean');
        $service = new UploadInspectionService($store, new UploadInspectionTestScanner());
        $approved = $service->inspect($source, 'product.png', 'image/png');
        expect($approved['status'] === 'approved', 'PHP upload inspector must approve a clean scanned object');
        expect($approved['sha256'] === hash('sha256', $png), 'PHP upload inspector must preserve the exact SHA-256');
        $attestation = $approved['attestation'];
        expect($attestation['schema'] === 'jb.security.upload-inspection.attestation/v1', 'PHP upload inspector must emit the shared attestation schema');
        expect($attestation['uploadId'] === $approved['uploadId'], 'PHP attestation must bind the exact upload ID');
        expect($attestation['verdict'] === 'clean', 'PHP attestation must preserve the scanner verdict');
        expect($attestation['sha256'] === $approved['sha256'], 'PHP attestation must bind the exact content digest');
        expect($attestation['size'] === strlen($png), 'PHP attestation must bind the exact byte count');
        expect($attestation['mimeType'] === 'image/png', 'PHP attestation must bind detected MIME');
        expect($attestation['engine'] === 'JB-Test-Scanner' && $attestation['version'] === '1.0', 'PHP attestation must preserve scanner identity and version');
        expect(is_int($attestation['scannedAtMs']) && $attestation['scannedAtMs'] >= 0, 'PHP attestation must include a numeric scan timestamp');
        expect($store->quarantineCount() === 0 && $store->approvedCount() === 1,
            'Only the atomically promoted private object may remain after a clean scan');

        $mismatchStore = new UploadInspectionTestStorage($root . '/mime-mismatch');
        $mismatch = new UploadInspectionService($mismatchStore, new UploadInspectionTestScanner());
        $mimeRejected = false;
        try {
            $mismatch->inspect($source, 'product.jpg', 'image/png');
        } catch (UploadInspectionException $exception) {
            $mimeRejected = $exception->reason === 'EXTENSION_MISMATCH';
        }
        expect($mimeRejected, 'PHP upload inspector must reject mismatched filename extensions');
        expect($mismatchStore->quarantineCount() === 0 && $mismatchStore->approvedCount() === 0,
            'Mismatched upload must never be retained as approved content');

        $largeStore = new UploadInspectionTestStorage($root . '/oversized');
        $large = new UploadInspectionService($largeStore, new UploadInspectionTestScanner(), 12);
        $largeRejected = false;
        try {
            $large->inspect($source, 'product.png', 'image/png');
        } catch (UploadInspectionException $exception) {
            $largeRejected = $exception->reason === 'UPLOAD_TOO_LARGE';
        }
        expect($largeRejected, 'PHP upload inspector must enforce the streaming byte cap');
        expect($largeStore->approvedCount() === 0, 'Oversized upload must never be approved');

        $unknownStore = new UploadInspectionTestStorage($root . '/unknown');
        $unknown = new UploadInspectionService($unknownStore, new UploadInspectionTestScanner('unknown'));
        $unknownRejected = false;
        try {
            $unknown->inspect($source, 'product.png', 'image/png');
        } catch (UploadInspectionException $exception) {
            $unknownRejected = $exception->reason === 'SCAN_NOT_CLEAN';
        }
        expect($unknownRejected, 'Unknown scanner verdict must not be treated as clean');
        expect($unknownStore->quarantineCount() === 1 && $unknownStore->approvedCount() === 0,
            'Unknown verdict must remain in private quarantine and never be promoted');

        $maliciousStore = new UploadInspectionTestStorage($root . '/malicious');
        $malicious = new UploadInspectionService($maliciousStore, new UploadInspectionTestScanner('malicious'));
        $malwareRejected = false;
        try {
            $malicious->inspect($source, 'product.png', 'image/png');
        } catch (UploadInspectionException $exception) {
            $malwareRejected = $exception->reason === 'MALWARE_DETECTED';
        }
        expect($malwareRejected, 'Malicious scanner verdict must be rejected');
        expect($maliciousStore->quarantineCount() === 0 && $maliciousStore->approvedCount() === 0,
            'Malicious upload must not remain available in approved storage');

        $tamperedStore = new UploadInspectionTestStorage($root . '/tampered');
        $tampered = new UploadInspectionService($tamperedStore, new UploadInspectionTestScanner('clean', true));
        $tamperedRejected = false;
        try {
            $tampered->inspect($source, 'product.png', 'image/png');
        } catch (UploadInspectionException $exception) {
            $tamperedRejected = $exception->reason === 'SCAN_CONTENT_MISMATCH';
        }
        expect($tamperedRejected, 'Scanner digest mismatch must fail closed');
        expect($tamperedStore->approvedCount() === 0, 'Digest mismatch must never be promoted');

        $unavailableStore = new UploadInspectionTestStorage($root . '/unavailable');
        $unavailable = new UploadInspectionService($unavailableStore, new UploadInspectionTestScanner('clean', false, true));
        $scannerUnavailable = false;
        try {
            $unavailable->inspect($source, 'product.png', 'image/png');
        } catch (UploadInspectionException $exception) {
            $scannerUnavailable = $exception->reason === 'SCANNER_UNAVAILABLE';
        }
        expect($scannerUnavailable, 'Scanner outage must fail closed');
        expect($unavailableStore->quarantineCount() === 1 && $unavailableStore->approvedCount() === 0,
            'Scanner outage must leave the object private in quarantine');
    } finally {
        $iterator = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::CHILD_FIRST
        );
        foreach ($iterator as $item) {
            $item->isDir() ? rmdir($item->getPathname()) : unlink($item->getPathname());
        }
        rmdir($root);
    }
}
