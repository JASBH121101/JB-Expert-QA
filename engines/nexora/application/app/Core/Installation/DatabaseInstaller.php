<?php

namespace App\Core\Installation;

use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use RuntimeException;

final class DatabaseInstaller
{
    public function prepare(InstallationState $installation): void
    {
        if ($installation->isCompleted()) {
            throw new RuntimeException(__('setup.database_already_completed'));
        }

        $connection = DB::connection();
        $driver = $connection->getDriverName();

        $supportedDriver = $driver === 'pgsql'
            || (app()->environment('testing') && $driver === 'sqlite');

        if ($supportedDriver === false) {
            throw new RuntimeException(
                __('setup.database_requires_postgres'),
            );
        }

        $connection->getPdo();

        $schema = $connection->getSchemaBuilder();
        $tables = $schema->getTableListing();

        if ($schema->hasTable('migrations') === false && count($tables) > 0) {
            throw new RuntimeException(
                __('setup.database_not_empty'),
            );
        }

        if ($schema->hasTable('migrations')) {
            $migrationFiles = glob(database_path('migrations/*.php'));
            $migrationFiles = $migrationFiles === false ? [] : $migrationFiles;

            $knownMigrations = collect($migrationFiles)
                ->map(static fn (string $path): string => pathinfo($path, PATHINFO_FILENAME))
                ->all();

            $unknownMigrations = DB::table('migrations')
                ->pluck('migration')
                ->reject(static fn (string $migration): bool => in_array($migration, $knownMigrations, true));

            if ($unknownMigrations->isNotEmpty()) {
                throw new RuntimeException(
                    __('setup.database_foreign_migrations'),
                );
            }
        }

        $exitCode = Artisan::call('migrate', ['--force' => true]);

        if ($exitCode !== 0 || $installation->hasSchema() === false) {
            throw new RuntimeException(
                __('setup.database_migration_failed'),
            );
        }
    }
}
