<?php

namespace App\Core\Installation;

use Illuminate\Support\Facades\DB;
use Throwable;

final class ServerRequirements
{
    public function checks(): array
    {
        return [
            $this->checkPhpVersion(),
            $this->checkRequiredExtensions(),
            $this->checkDatabaseConnection(),
            ...$this->checkWritableDirectories(),
        ];
    }

    private function checkPhpVersion(): array
    {
        $minimum = '8.3.0';
        $passed = version_compare(PHP_VERSION, $minimum, '>=');

        return [
            'key' => 'php',
            'label' => __('setup.checks.php_label'),
            'passed' => $passed,
            'detail' => __('setup.checks.php_detail', ['detected' => PHP_VERSION, 'minimum' => $minimum]),
        ];
    }

    private function checkRequiredExtensions(): array
    {
        $driver = (string) config('database.connections.'.config('database.default').'.driver', config('database.default'));
        $pdoExtension = match ($driver) {
            'pgsql' => 'pdo_pgsql',
            'sqlite' => 'pdo_sqlite',
            default => null,
        };

        $required = [
            'ctype', 'curl', 'dom', 'fileinfo', 'filter', 'hash',
            'mbstring', 'openssl', 'pcre', 'pdo', 'session',
            'tokenizer', 'xml',
        ];

        if ($pdoExtension !== null) {
            $required[] = $pdoExtension;
        }
        $missing = array_values(array_filter(
            $required,
            static fn (string $extension): bool => ! extension_loaded($extension),
        ));

        return [
            'key' => 'extensions',
            'label' => __('setup.checks.extensions_label'),
            'passed' => $missing === [],
            'detail' => $missing === []
                ? __('setup.checks.extensions_passed')
                : __('setup.checks.extensions_missing', ['extensions' => implode(', ', $missing)]),
        ];
    }

    private function checkDatabaseConnection(): array
    {
        try {
            DB::connection()->getPdo();

            return [
                'key' => 'database',
                'label' => __('setup.checks.database_label'),
                'passed' => true,
                'detail' => __('setup.checks.database_passed'),
            ];
        } catch (Throwable $exception) {
            return [
                'key' => 'database',
                'label' => __('setup.checks.database_label'),
                'passed' => false,
                'detail' => app()->environment('production')
                    ? __('setup.checks.database_failed')
                    : __('setup.checks.database_failed_debug', ['error' => $exception->getMessage()]),
            ];
        }
    }

    private function checkWritableDirectories(): array
    {
        $directories = [
            'storage' => storage_path(),
            'storage/app' => storage_path('app'),
            'storage/framework/cache' => storage_path('framework/cache'),
            'storage/framework/sessions' => storage_path('framework/sessions'),
            'storage/framework/views' => storage_path('framework/views'),
            'storage/logs' => storage_path('logs'),
            'bootstrap/cache' => base_path('bootstrap/cache'),
        ];
        $unwritable = array_keys(array_filter(
            $directories,
            static fn (string $path): bool => ! is_dir($path) || ! is_writable($path),
        ));

        return [[
            'key' => 'permissions',
            'label' => __('setup.checks.permissions_label'),
            'passed' => $unwritable === [],
            'detail' => $unwritable === []
                ? __('setup.checks.permissions_passed')
                : __('setup.checks.permissions_failed', ['directories' => implode(', ', $unwritable)]),
        ]];
    }
}
