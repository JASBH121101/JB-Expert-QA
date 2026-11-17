<?php

declare(strict_types=1);

namespace JB\SecurityGuard\UploadInspection;

use RuntimeException;

final class UploadInspectionException extends RuntimeException
{
    public function __construct(
        public readonly string $errorCode,
        string $message = 'Upload inspection failed'
    ) {
        parent::__construct($message);
    }
}
