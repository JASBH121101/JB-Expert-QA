<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class BusinessCurrency extends Model
{
    protected $table = 'business_currencies';

    protected $primaryKey = 'code';

    public $incrementing = false;

    protected $keyType = 'string';

    public $timestamps = false;

    protected $fillable = ['code', 'is_primary', 'is_enabled', 'sort_order'];

    protected function casts(): array
    {
        return [
            'is_primary' => 'boolean',
            'is_enabled' => 'boolean',
            'sort_order' => 'integer',
        ];
    }
}
