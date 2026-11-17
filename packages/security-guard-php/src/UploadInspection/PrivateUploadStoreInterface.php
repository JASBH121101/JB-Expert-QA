<?php

declare(strict_types=1);

namespace JB\SecurityGuard\UploadInspection;

interface PrivateUploadStoreInterface
{
    /** Copy an uploaded temporary file into non-public quarantine under an opaque ID. */
    public function quarantine(string $uploadId, string $sourcePath): string;

    /** Return the absolute path of the quarantined file. */
    public function quarantinePath(string $uploadId): string;

    /**
     * Atomically move the verified object into private approved storage.
     * Returns a relative path; it must not be a public URL.
     */
    public function promote(
        string $uploadId,
        string $expectedSha256,
        int $expectedSize,
        string $mimeType
    ): string;

    /** Resolve a private approved relative path to a readable absolute path. */
    public function resolveApproved(string $relativePath): string;

    /** Idempotently remove an uncommitted object from quarantine or private approved storage. */
    public function delete(string $uploadId): void;
}
