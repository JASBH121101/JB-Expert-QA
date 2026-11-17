<?php

declare(strict_types=1);

require_once __DIR__ . '/../src/UploadInspection/MalwareScannerInterface.php';
require_once __DIR__ . '/../src/UploadInspection/PrivateUploadStoreInterface.php';
require_once __DIR__ . '/../src/UploadInspection/UploadInspectionException.php';
require_once __DIR__ . '/../src/UploadInspection/LocalPrivateUploadStore.php';
require_once __DIR__ . '/../src/UploadInspection/ClamAvScanner.php';
require_once __DIR__ . '/../src/UploadInspection/UploadInspector.php';

use JB\SecurityGuard\UploadInspection\ClamAvScanner;
use JB\SecurityGuard\UploadInspection\LocalPrivateUploadStore;
use JB\SecurityGuard\UploadInspection\MalwareScannerInterface;
use JB\SecurityGuard\UploadInspection\UploadInspectionException;
use JB\SecurityGuard\UploadInspection\UploadInspector;

function removeUploadInspectionTestDirectory(string $directory): void
{
    if (!is_dir($directory)) return;
    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($directory, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST
    );
    foreach ($iterator as $item) {
        if ($item->isDir() && !$item->isLink()) {
            @rmdir($item->getPathname());
        } else {
            @unlink($item->getPathname());
        }
    }
    @rmdir($directory);
}

function runUploadInspectionTests(): void
{
    $base = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'jbsg-php-upload-' . bin2hex(random_bytes(8));
    $privateRoot = $base . DIRECTORY_SEPARATOR . 'private';
    $publicRoot = $base . DIRECTORY_SEPARATOR . 'public';
    if (!@mkdir($publicRoot, 0700, true)) {
        throw new RuntimeException('Test public directory could not be created');
    }

    $sourcePath = $base . DIRECTORY_SEPARATOR . 'source.png';
    $png = base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', true);
    if (!is_string($png) || file_put_contents($sourcePath, $png) !== strlen($png)) {
        removeUploadInspectionTestDirectory($base);
        throw new RuntimeException('Valid PNG test fixture could not be created');
    }

    try {
        $store = new LocalPrivateUploadStore($privateRoot, $publicRoot);
        $cleanScanner = new class implements MalwareScannerInterface {
            public function scan(string $absolutePath): array
            {
                if (!is_file($absolutePath) || !is_readable($absolutePath)) {
                    throw new RuntimeException('Scanner did not receive the quarantined file');
                }
                return ['verdict' => 'clean', 'engine' => 'TestScanner', 'version' => '1.0'];
            }
        };

        $inspector = new UploadInspector($store, $cleanScanner, 1024, 100, 100);
        $approved = $inspector->inspect($sourcePath, 'catalog-photo.png', 'image/png');
        expect($approved['status'] === 'approved', 'PHP upload inspector must approve a scanned clean PNG');
        expect($approved['mimeType'] === 'image/png' && $approved['size'] === strlen($png), 'PHP upload inspector must return verified type and size');
        expect(preg_match('#^approved/[a-f0-9]{32}\\.png$#D', $approved['path']) === 1, 'Approved object path must use an opaque ID and safe extension');
        $approvedPath = $store->resolveApproved($approved['path']);
        expect(is_file($approvedPath), 'Clean upload must be moved to private approved storage');
        expect(!is_file($store->quarantinePath($approved['uploadId'])), 'Clean upload must leave quarantine after promotion');
        expect(!str_starts_with($approvedPath, $publicRoot . DIRECTORY_SEPARATOR), 'Approved uploads must not be stored under the public directory');
        $store->delete($approved['uploadId']);
        expect(!file_exists($approvedPath), 'Uncommitted approved object cleanup must be idempotent');

        $unknownScanner = new class implements MalwareScannerInterface {
            public function scan(string $absolutePath): array
            {
                return ['verdict' => 'unknown', 'engine' => 'ClamAV', 'version' => 'unavailable'];
            }
        };
        $unknownInspector = new UploadInspector($store, $unknownScanner, 1024, 100, 100);
        $unknown = $unknownInspector->inspect($sourcePath, 'review.png', 'image/png');
        expect($unknown['status'] === 'quarantined', 'Unknown scanner verdict must remain quarantined');
        expect(is_file($store->quarantinePath($unknown['uploadId'])), 'Unknown scanner verdict must remain in private quarantine');
        $store->delete($unknown['uploadId']);

        $maliciousScanner = new class implements MalwareScannerInterface {
            public ?string $scannedPath = null;
            public function scan(string $absolutePath): array
            {
                $this->scannedPath = $absolutePath;
                return ['verdict' => 'malicious', 'engine' => 'TestScanner', 'version' => '1.0'];
            }
        };
        $maliciousInspector = new UploadInspector($store, $maliciousScanner, 1024, 100, 100);
        $malwareRejected = false;
        try {
            $maliciousInspector->inspect($sourcePath, 'malware.png', 'image/png');
        } catch (UploadInspectionException $exception) {
            $malwareRejected = $exception->errorCode === 'MALWARE_DETECTED';
        }
        expect($malwareRejected, 'Malicious scanner verdict must reject the upload');
        expect(is_string($maliciousScanner->scannedPath) && !file_exists($maliciousScanner->scannedPath), 'Malicious upload must be removed from quarantine');

        $extensionRejected = false;
        try {
            $inspector->inspect($sourcePath, 'misleading.jpg', 'image/png');
        } catch (UploadInspectionException $exception) {
            $extensionRejected = $exception->errorCode === 'EXTENSION_MISMATCH';
        }
        expect($extensionRejected, 'PHP upload inspector must reject an extension/signature mismatch');

        $missingClamAv = new ClamAvScanner($base . DIRECTORY_SEPARATOR . 'missing-clamscan');
        $unavailable = $missingClamAv->scan($sourcePath);
        expect(($unavailable['verdict'] ?? null) === 'unknown', 'Missing ClamAV must fail closed as an unknown verdict');

        $fakeClamAv = $base . DIRECTORY_SEPARATOR . 'fake-clamscan';
        $fakeScript = <<<'SH'
#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' 'ClamAV 1.4.2'
  exit 0
fi
if [ -n "$JB_TEST_CLAMAV_MALICIOUS" ]; then
  printf '%s\\n' "$3: Eicar-Signature FOUND"
  exit 1
fi
if [ -n "$JB_TEST_CLAMAV_UNKNOWN" ]; then
  printf '%s\\n' 'scanner internal error'
  exit 2
fi
printf '%s\\n' "$3: OK"
exit 0
SH;
        if (file_put_contents($fakeClamAv, $fakeScript) !== strlen($fakeScript) || !@chmod($fakeClamAv, 0700)) {
            throw new RuntimeException('Fake ClamAV test executable could not be prepared');
        }

        $cleanClamAv = new ClamAvScanner($fakeClamAv);
        $cleanResult = $cleanClamAv->scan($sourcePath);
        expect(($cleanResult['verdict'] ?? null) === 'clean', 'ClamAV adapter must accept an explicit clean result');
        expect(($cleanResult['version'] ?? null) === '1.4.2', 'ClamAV adapter must capture a bounded engine version');

        $maliciousClamAv = new ClamAvScanner($fakeClamAv);
        putenv('JB_TEST_CLAMAV_MALICIOUS=1');
        try {
            $maliciousResult = $maliciousClamAv->scan($sourcePath);
        } finally {
            putenv('JB_TEST_CLAMAV_MALICIOUS');
        }
        expect(($maliciousResult['verdict'] ?? null) === 'malicious', 'ClamAV adapter must reject a FOUND result');

        $unknownClamAv = new ClamAvScanner($fakeClamAv);
        putenv('JB_TEST_CLAMAV_UNKNOWN=1');
        try {
            $unknownResult = $unknownClamAv->scan($sourcePath);
        } finally {
            putenv('JB_TEST_CLAMAV_UNKNOWN');
        }
        expect(($unknownResult['verdict'] ?? null) === 'unknown', 'ClamAV adapter must fail closed for scanner errors');

        $publicRootRejected = false;
        try {
            new LocalPrivateUploadStore($publicRoot, $publicRoot);
        } catch (RuntimeException) {
            $publicRootRejected = true;
        }
        expect($publicRootRejected, 'Private upload storage must reject a public storage root');
    } finally {
        removeUploadInspectionTestDirectory($base);
    }
}
