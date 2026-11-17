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
     * Atomically verify the quarantined object's digest and size, then promote
     * that exact immutable object to a private approved namespace.
     */
    public function promote(string $uploadId, string $expectedSha256, int $expectedSize): bool;

    /** Idempotently delete an uncommitted object by opaque server-generated ID. */
    public function delete(string $uploadId): void;
}
