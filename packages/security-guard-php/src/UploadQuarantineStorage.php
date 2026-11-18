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
     * Atomically verify the quarantined object's digest and size, validate that
     * the attestation binds this exact clean object, then promote the bytes and
     * persist the attestation together in a private approved namespace.
     *
     * The adapter must not commit the object separately from the attestation.
     */
    public function promote(string $uploadId, string $expectedSha256, int $expectedSize, array $attestation): bool;

    /** Idempotently delete an uncommitted object by opaque server-generated ID. */
    public function delete(string $uploadId): void;
}
