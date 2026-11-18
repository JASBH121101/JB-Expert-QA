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
    private array $approvedAttestations = [];

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

    public function promote(string $uploadId, string $expectedSha256, int $expectedSize, array $attestation): bool
    {
        $source = $this->quarantine . '/' . $uploadId;
        if (!is_file($source) ||
            filesize($source) !== $expectedSize ||
            hash_file('sha256', $source) !== $expectedSha256 ||
            ($attestation['uploadId'] ?? null) !== $uploadId ||
            ($attestation['sha256'] ?? null) !== $expectedSha256 ||
            ($attestation['size'] ?? null) !== $expectedSize ||
            ($attestation['verdict'] ?? null) !== 'clean') {
            return false;
        }
        if (!rename($source, $this->approved . '/' . $uploadId)) {
            return false;
        }
        $this->approvedAttestations[$uploadId] = $attestation;
        return true;
    }

    public function delete(string $uploadId): void
    {
        foreach ([$this->quarantine . '/' . $uploadId, $this->approved . '/' . $uploadId] as $path) {
            if (is_file($path) && !unlink($path)) {
                throw new RuntimeException('Test store could not delete upload');
            }
        }
        unset($this->approvedAttestations[$uploadId]);
    }

    public function approvedAttestation(string $uploadId): ?array
    {
        return $this->approvedAttestations[$uploadId] ?? null;
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
        private readonly bool $unavailable = false,
        private readonly bool $consume = true,
        private readonly bool $seekToEnd = false
    ) {
    }

    public function scan(mixed $stream, array $metadata): array
    {
        if ($this->unavailable) {
            throw new RuntimeException('Synthetic scanner outage');
        }
        if ($this->seekToEnd) {
            fseek($stream, 0, SEEK_END);
            return [
                'verdict' => $this->verdict,
                'sha256' => $metadata['sha256'],
                'size' => $metadata['size'],
                'engine' => 'JB-Test-Scanner',
                'version' => '1.0',
            ];
        }
        if (!$this->consume) {
            return [
                'verdict' => $this->verdict,
                'sha256' => $metadata['sha256'],
                'size' => $metadata['size'],
                'engine' => 'JB-Test-Scanner',
                'version' => '1.0',
            ];
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
        expect($attestation['schema'] === 'jb.security.upload-inspection.attestation/v1', 'PHP upload must emit the shared attestation schema');
        expect($attestation['uploadId'] === $approved['uploadId'], 'PHP attestation must bind the exact upload ID');
        expect($attestation['verdict'] === 'clean', 'PHP attestation must preserve the scanner verdict');
        expect($attestation['sha256'] === $approved['sha256'], 'PHP attestation must bind the exact content digest');
        expect($attestation['size'] === strlen($png), 'PHP attestation must bind the exact byte count');
        expect($attestation['mimeType'] === 'image/png', 'PHP attestation must bind the detected MIME type');
        expect($attestation['engine'] === 'JB-Test-Scanner' && $attestation['version'] === '1.0', 'PHP attestation must bind scanner identity and version');
        expect(is_int($attestation['scannedAtMs']) && $attestation['scannedAtMs'] >= 0, 'PHP attestation must include a non-negative scan timestamp');
        expect($store->approvedAttestation($approved['uploadId']) === $attestation, 'PHP promotion must persist the exact attestation with the approved object');
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
        $unknownAttestation = null;
        try {
            $unknown->inspect($source, 'product.png', 'image/png');
        } catch (UploadInspectionException $exception) {
            $unknownRejected = $exception->reason === 'SCAN_NOT_CLEAN';
            $unknownAttestation = $exception->attestation;
        }
        expect($unknownRejected, 'Unknown scanner verdict must not be treated as clean');
        expect(is_array($unknownAttestation) && $unknownAttestation['verdict'] === 'unknown',
            'PHP unknown result must expose its validated scanner attestation');
        expect($unknownAttestation['sha256'] === hash('sha256', $png) && $unknownAttestation['size'] === strlen($png),
            'PHP unknown attestation must bind the exact scanned bytes');
        expect($unknownStore->quarantineCount() === 1 && $unknownStore->approvedCount() === 0,
            'Unknown verdict must remain in private quarantine and never be promoted');

        $maliciousStore = new UploadInspectionTestStorage($root . '/malicious');
        $malicious = new UploadInspectionService($maliciousStore, new UploadInspectionTestScanner('malicious'));
        $malwareRejected = false;
        $malwareAttestation = null;
        try {
            $malicious->inspect($source, 'product.png', 'image/png');
        } catch (UploadInspectionException $exception) {
            $malwareRejected = $exception->reason === 'MALWARE_DETECTED';
            $malwareAttestation = $exception->attestation;
        }
        expect($malwareRejected, 'Malicious scanner verdict must be rejected');
        expect(is_array($malwareAttestation) && $malwareAttestation['verdict'] === 'malicious',
            'PHP malicious result must expose its validated scanner attestation');
        expect($malwareAttestation['sha256'] === hash('sha256', $png) && $malwareAttestation['size'] === strlen($png),
            'PHP malicious attestation must bind the exact scanned bytes');
        expect($maliciousStore->quarantineCount() === 0 && $maliciousStore->approvedCount() === 0,
            'Malicious upload must not remain available in approved storage');

        $tamperedStore = new UploadInspectionTestStorage($root . '/tampered');
        $tampered = new UploadInspectionService($tamperedStore, new UploadInspectionTestScanner('clean', true));
        $tamperedRejected = false;
        $tamperedAttestation = null;
        try {
            $tampered->inspect($source, 'product.png', 'image/png');
        } catch (UploadInspectionException $exception) {
            $tamperedRejected = $exception->reason === 'SCAN_CONTENT_MISMATCH';
            $tamperedAttestation = $exception->attestation;
        }
        expect($tamperedRejected, 'Scanner digest mismatch must fail closed');
        expect($tamperedAttestation === null, 'Digest mismatch must not expose trusted scanner attestation');
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

        $incompleteStore = new UploadInspectionTestStorage($root . '/incomplete-scan');
        $incomplete = new UploadInspectionService(
            $incompleteStore,
            new UploadInspectionTestScanner('clean', false, false, false)
        );
        $incompleteRejected = false;
        try {
            $incomplete->inspect($source, 'product.png', 'image/png');
        } catch (UploadInspectionException $exception) {
            $incompleteRejected = $exception->reason === 'SCAN_INCOMPLETE';
        }
        expect($incompleteRejected, 'A scanner that returns without consuming the complete stream must fail closed');
        expect($incompleteStore->quarantineCount() === 1 && $incompleteStore->approvedCount() === 0,
            'An incomplete scan must remain private in quarantine');

        $seekStore = new UploadInspectionTestStorage($root . '/seek-scan');
        $seekScanner = new UploadInspectionService(
            $seekStore,
            new UploadInspectionTestScanner('clean', false, false, true, true)
        );
        $seekRejected = false;
        try {
            $seekScanner->inspect($source, 'product.png', 'image/png');
        } catch (UploadInspectionException $exception) {
            $seekRejected = $exception->reason === 'SCAN_INCOMPLETE';
        }
        expect($seekRejected, 'A scanner must not satisfy complete-consumption checks by seeking to EOF');
        expect($seekStore->quarantineCount() === 1 && $seekStore->approvedCount() === 0,
            'A seek-only scan must remain private in quarantine');

        $vectorPath = dirname(__DIR__, 2) . '/security-guard-core/tests/fixtures/upload-inspection/conformance-vectors.v1.json';
        $vectors = json_decode((string) file_get_contents($vectorPath), true, 16, JSON_THROW_ON_ERROR);
        foreach ($vectors['fileCases'] as $vector) {
            $vectorSource = $root . '/vector-' . $vector['id'] . '.bin';
            file_put_contents($vectorSource, hex2bin($vector['bytesHex']));
            $vectorStore = new UploadInspectionTestStorage($root . '/vector-store-' . $vector['id']);
            $vectorService = new UploadInspectionService(
                $vectorStore,
                new UploadInspectionTestScanner($vector['scannerVerdict'])
            );
            $actual = null;
            $actualReason = null;
            try {
                $actual = $vectorService->inspect(
                    $vectorSource,
                    $vector['fileName'],
                    $vector['declaredMimeType']
                );
            } catch (UploadInspectionException $exception) {
                $actualReason = $exception->reason;
            }
            if ($vector['expected']['disposition'] === 'approved') {
                expect($actual !== null && $actual['mimeType'] === $vector['expected']['mimeType'],
                    'Shared file vector must be approved with the expected MIME type: ' . $vector['id']);
                expect($vectorStore->approvedCount() === 1 && $vectorStore->quarantineCount() === 0,
                    'Shared clean file vector must be privately promoted: ' . $vector['id']);
            } else {
                expect($actualReason === $vector['expected']['errorReason'],
                    'Shared file vector must return the expected error: ' . $vector['id']);
                expect($vectorStore->approvedCount() === 0 && $vectorStore->quarantineCount() === 0,
                    'Invalid file-type vectors must never be promoted or retained as clean: ' . $vector['id']);
            }
        }

        foreach ($vectors['scannerCases'] as $vector) {
            $vectorStore = new UploadInspectionTestStorage($root . '/scanner-vector-' . $vector['id']);
            $consume = $vector['consume'] === 'all';
            $vectorService = new UploadInspectionService(
                $vectorStore,
                new UploadInspectionTestScanner($vector['verdict'], false, false, $consume)
            );
            $actual = null;
            $actualReason = null;
            try {
                $actual = $vectorService->inspect($source, 'product.png', 'image/png');
            } catch (UploadInspectionException $exception) {
                $actualReason = $exception->reason;
            }
            if ($vector['expected']['disposition'] === 'approved') {
                expect($actual !== null, 'Complete clean scanner vector must be approved: ' . $vector['id']);
                expect($vectorStore->approvedCount() === 1 && $vectorStore->quarantineCount() === 0,
                    'Complete clean scanner vector must be privately promoted: ' . $vector['id']);
            } else {
                expect($actualReason === $vector['expected']['errorReason'],
                    'Scanner vector must return the expected error: ' . $vector['id']);
                expect($vectorStore->approvedCount() === 0,
                    'Rejected scanner vector must never be promoted: ' . $vector['id']);
                $expectedQuarantine = $vector['expected']['disposition'] === 'quarantined' ? 1 : 0;
                expect($vectorStore->quarantineCount() === $expectedQuarantine,
                    'Scanner vector quarantine disposition must match contract: ' . $vector['id']);
            }
        }
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
