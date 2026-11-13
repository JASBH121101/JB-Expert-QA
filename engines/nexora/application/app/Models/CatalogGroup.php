<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

class CatalogGroup extends Model
{
    protected $fillable = ['category_id', 'name', 'sort_order'];

    protected function casts(): array
    {
        return ['category_id' => 'integer', 'sort_order' => 'integer'];
    }

    public function category(): BelongsTo
    {
        return $this->belongsTo(CatalogCategory::class, 'category_id');
    }

    public function fields(): HasMany
    {
        return $this->hasMany(ProductFieldDefinition::class, 'group_id')
            ->orderBy('sort_order');
    }
}
