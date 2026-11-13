<?php

namespace App\Core\Installation;

use App\Models\InstallationSettings;
use Illuminate\Support\Facades\Schema;
use Throwable;

final class InstallationState
{
    private const REQUIRED_TABLES = [
        'migrations',
        'users',
        'password_reset_tokens',
        'sessions',
        'installation_settings',
        'business_contacts',
        'business_currencies',
        'catalog_categories',
        'catalog_groups',
        'product_field_definitions',
        'products',
        'product_field_values',
        'product_prices',
        'login_help_requests',
    ];

    public function hasSchema(): bool
    {
        try {
            foreach (self::REQUIRED_TABLES as $table) {
                if (! Schema::hasTable($table)) {
                    return false;
                }
            }

            return true;
        } catch (Throwable) {
            return false;
        }
    }

    public function isCompleted(): bool
    {
        if (! $this->hasSchema()) {
            return false;
        }

        try {
            return InstallationSettings::query()
                ->whereKey(1)
                ->whereNotNull('setup_completed_at')
                ->exists();
        } catch (Throwable) {
            return false;
        }
    }
}
