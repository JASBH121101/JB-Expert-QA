<?php

namespace App\Core\Installation;

use App\Models\InstallationSettings;
use App\Models\Product;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Facades\Storage;
use RuntimeException;

final class ResetDemoInstallation
{
    /**
     * Delete order respects the foreign keys while preserving the schema and
     * migration history. This command never drops a table or runs migrate:fresh.
     */
    private const DELETE_ORDER = [
        'product_field_values',
        'product_prices',
        'products',
        'product_field_definitions',
        'catalog_groups',
        'catalog_categories',
        'business_contacts',
        'business_currencies',
        'login_help_requests',
        'password_reset_tokens',
        'sessions',
        'installation_settings',
        'users',
    ];

    public function assertAllowed(): InstallationSettings
    {
        if (config('nexora.installation_mode', 'production') !== 'demo') {
            throw new RuntimeException(__('setup.demo_reset_disabled'));
        }

        if (! Schema::hasTable('installation_settings')) {
            throw new RuntimeException(__('setup.demo_reset_not_demo_installation'));
        }

        $settings = InstallationSettings::query()->find(1);

        if (
            $settings === null
            || $settings->setup_completed_at === null
            || data_get($settings->configuration, 'environment.mode') !== 'demo'
        ) {
            throw new RuntimeException(__('setup.demo_reset_not_demo_installation'));
        }

        return $settings;
    }

    public function reset(): void
    {
        $settings = $this->assertAllowed();
        $mediaPaths = [
            data_get($settings->configuration, 'identity.logoPath'),
            data_get($settings->configuration, 'identity.coverPath'),
        ];

        if (Schema::hasTable('products')) {
            $mediaPaths = array_merge(
                $mediaPaths,
                Product::query()->whereNotNull('image_path')->pluck('image_path')->all(),
            );
        }

        DB::transaction(function (): void {
            foreach (self::DELETE_ORDER as $table) {
                if (Schema::hasTable($table)) {
                    DB::table($table)->delete();
                }
            }
        });

        foreach (array_unique(array_filter($mediaPaths, 'is_string')) as $path) {
            if ($this->isSafeRelativePath($path)) {
                Storage::disk('public')->delete($path);
            }
        }
    }

    private function isSafeRelativePath(string $path): bool
    {
        if (
            $path === ''
            || str_starts_with($path, '/')
            || str_starts_with($path, '\\')
            || str_contains($path, '..')
            || str_contains($path, "\0")
        ) {
            return false;
        }

        return preg_match('/^[a-zA-Z]:/', $path) !== 1;
    }
}
