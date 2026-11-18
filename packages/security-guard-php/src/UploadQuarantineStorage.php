<?php

declare(strict_types=1);

namespace JB\SecurityGuard;

interface UploadQuarantineStorage
{
    /** Return a writable stream backed only by private quarantine storage. */
    public function createQuarantineStream(string $uploadId): mixed;

    /** Return a readable stream for the complete quarantined object. */
    public function openQuarantineStream(string $uploadId): mixed;

    /**
     * Atomically verify the exact quarantined object and persist its clean
     * upload-inspection attestation with the promoted bytes in private storage.
     */
    public function promote(string $uploadId, string $expectedSha256, int $expectedSize, array $attestation): bool;

    /** Idempotently delete an uncommitted object by opaque server-generated ID. */
    public function delete(string $uploadId): void;
}
