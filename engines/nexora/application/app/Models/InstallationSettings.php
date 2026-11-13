<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class InstallationSettings extends Model
{
    protected $table = 'installation_settings';

    protected $fillable = [
        'id', 'business_name', 'business_type', 'owner_id',
        'configuration', 'setup_completed_at',
    ];

    protected function casts(): array
    {
        return [
            'configuration' => 'array',
            'setup_completed_at' => 'datetime',
        ];
    }
}
