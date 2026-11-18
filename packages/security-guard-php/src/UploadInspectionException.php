<?php

declare(strict_types=1);

namespace JB\SecurityGuard;

use RuntimeException;

final class UploadInspectionException extends RuntimeException
{
    public function __construct(
        public readonly string $reason,
        string $message = 'Upload could not be safely approved',
        public readonly ?array $attestation = null
    ) {
        parent::__construct($message);
    }
}
