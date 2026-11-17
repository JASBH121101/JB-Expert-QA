<?php

declare(strict_types=1);

namespace JB\SecurityGuard\UploadInspection;

use RuntimeException;

final class LocalPrivateUploadStore implements PrivateUploadStoreInterface
{
    private string $root;
    private string $quarantineDirectory;
    private string $approvedDirectory;

    public function __construct(string $rootPath, ?string $publicPath = null)
    {
        if (trim($rootPath) === '') {
            throw new RuntimeException('Private upload storage root is required');
        }

        if (!is_dir($rootPath) && !@mkdir($rootPath, 0700, true) && !is_dir($rootPath)) {
            throw new RuntimeException('Private upload storage root could not be created');
        }

        $root = realpath($rootPath);
        if ($root === false || is_link($rootPath)) {
            throw new RuntimeException('Private upload storage root is invalid');
        }

        if ($publicPath !== null && is_dir($publicPath)) {
            $public = realpath($publicPath);
            if ($public !== false && (rtrim($root, DIRECTORY_SEPARATOR) === rtrim($public, DIRECTORY_SEPARATOR) || $this->isWithinDirectory($root, $public))) {
                throw new RuntimeException('Private upload storage must not be inside the public directory');
            }
        }

        $this->root = rtrim($root, DIRECTORY_SEPARATOR);
        $this->quarantineDirectory = $this->root . DIRECTORY_SEPARATOR . 'quarantine';
        $this->approvedDirectory = $this->root . DIRECTORY_SEPARATOR . 'approved';

        $this->ensureDirectory($this->quarantineDirectory);
        $this->ensureDirectory($this->approvedDirectory);
    }

    public function quarantine(string $uploadId, string $sourcePath): string
    {
        $this->assertUploadId($uploadId);
        if (!is_file($sourcePath) || !is_readable($sourcePath)) {
            throw new RuntimeException('Upload source is unavailable');
        }

        $target = $this->quarantineFilePath($uploadId);
        if (file_exists($target)) {
            throw new RuntimeException('Quarantine object already exists');
        }
        if (!@copy($sourcePath, $target)) {
            if (is_file($target)) @unlink($target);
            throw new RuntimeException('Upload could not be copied into quarantine');
        }

        @chmod($target, 0600);
        return $target;
    }

    public function quarantinePath(string $uploadId): string
    {
        $this->assertUploadId($uploadId);
        return $this->quarantineFilePath($uploadId);
    }

    public function promote(
        string $uploadId,
        string $expectedSha256,
        int $expectedSize,
        string $mimeType
    ): string {
        $this->assertUploadId($uploadId);
        if (!preg_match('/^[a-f0-9]{64}$/D', $expectedSha256) || $expectedSize < 1) {
            throw new RuntimeException('Expected file digest or size is invalid');
        }

        $extensions = [
            'image/jpeg' => 'jpg',
            'image/png' => 'png',
            'image/webp' => 'webp',
        ];
        if (!isset($extensions[$mimeType])) {
            throw new RuntimeException('Approved image type is unsupported');
        }

        $source = $this->quarantineFilePath($uploadId);
        $size = is_file($source) ? filesize($source) : false;
        $sha256 = is_file($source) ? hash_file('sha256', $source) : false;
        if ($size !== $expectedSize || !is_string($sha256) || !hash_equals($expectedSha256, $sha256)) {
            throw new RuntimeException('Quarantined file changed before promotion');
        }

        $relativePath = 'approved/' . $uploadId . '.' . $extensions[$mimeType];
        $target = $this->approvedDirectory . DIRECTORY_SEPARATOR . $uploadId . '.' . $extensions[$mimeType];
        if (file_exists($target) || !@rename($source, $target)) {
            throw new RuntimeException('Verified upload could not be promoted atomically');
        }

        @chmod($target, 0600);
        return $relativePath;
    }

    public function resolveApproved(string $relativePath): string
    {
        if (!preg_match('#^approved/[a-f0-9]{32}\.(?:jpg|png|webp)$#D', $relativePath)) {
            throw new RuntimeException('Approved upload path is invalid');
        }

        $candidate = $this->approvedDirectory . DIRECTORY_SEPARATOR . basename($relativePath);
        $resolved = realpath($candidate);
        if ($resolved === false || !$this->isWithinDirectory($resolved, $this->approvedDirectory) || !is_file($resolved) || !is_readable($resolved)) {
            throw new RuntimeException('Approved upload is unavailable');
        }

        return $resolved;
    }

    public function delete(string $uploadId): void
    {
        $this->assertUploadId($uploadId);
        $paths = [$this->quarantineFilePath($uploadId)];
        foreach (['jpg', 'png', 'webp'] as $extension) {
            $paths[] = $this->approvedDirectory . DIRECTORY_SEPARATOR . $uploadId . '.' . $extension;
        }

        foreach ($paths as $path) {
            if (is_file($path) && !@unlink($path)) {
                throw new RuntimeException('Uncommitted upload cleanup failed');
            }
        }
    }

    private function quarantineFilePath(string $uploadId): string
    {
        return $this->quarantineDirectory . DIRECTORY_SEPARATOR . $uploadId . '.upload';
    }

    private function assertUploadId(string $uploadId): void
    {
        if (!preg_match('/^[a-f0-9]{32}$/D', $uploadId)) {
            throw new RuntimeException('Upload ID is invalid');
        }
    }

    private function ensureDirectory(string $path): void
    {
        if (!is_dir($path) && !@mkdir($path, 0700, true) && !is_dir($path)) {
            throw new RuntimeException('Private upload directory could not be created');
        }
        if (is_link($path)) {
            throw new RuntimeException('Private upload directory must not be a symlink');
        }
        @chmod($path, 0700);
    }

    private function isWithinDirectory(string $path, string $directory): bool
    {
        $base = rtrim($directory, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR;
        return str_starts_with($path, $base);
    }
}
