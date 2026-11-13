<?php

namespace App\Models;

use App\Modules\Setup\Services\CountryDialingCodeCatalog;
use Illuminate\Database\Eloquent\Model;

class BusinessContact extends Model
{
    protected $fillable = ['phone', 'is_primary', 'show_public', 'sort_order'];

    protected function casts(): array
    {
        return [
            'is_primary' => 'boolean',
            'show_public' => 'boolean',
            'sort_order' => 'integer',
        ];
    }

    public function getFormattedPhoneAttribute(): string
    {
        return CountryDialingCodeCatalog::formatInternational($this->phone);
    }
}
