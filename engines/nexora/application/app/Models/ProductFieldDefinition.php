<?php

namespace App\Models;

use App\Core\Library\Measurement\UnitCatalog;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

class ProductFieldDefinition extends Model
{
    protected $fillable = [
        'group_id', 'field_key', 'label', 'field_type', 'options',
        'unit_dimension', 'unit_code', 'unit_catalog_code', 'is_required', 'is_public',
        'is_searchable', 'width', 'sort_order',
    ];

    protected function casts(): array
    {
        return [
            'options' => 'array',
            'is_required' => 'boolean',
            'is_public' => 'boolean',
            'is_searchable' => 'boolean',
            'sort_order' => 'integer',
        ];
    }

    public function group(): BelongsTo
    {
        return $this->belongsTo(CatalogGroup::class, 'group_id');
    }

    public function scopeAvailableForCategory(Builder $query, ?int $categoryId): Builder
    {
        return $query->whereHas('group', static function (Builder $group) use ($categoryId): void {
            $group->where(function (Builder $scope) use ($categoryId): void {
                $scope->whereNull('category_id');

                if ($categoryId !== null) {
                    $scope->orWhere('category_id', $categoryId);
                }
            });
        });
    }

    public function scopeAvailableForCurrentProductCategory(Builder $query): Builder
    {
        return $query->whereHas('group', static function (Builder $group): void {
            $group->where(function (Builder $scope): void {
                $scope->whereNull('catalog_groups.category_id')
                    ->orWhereColumn('catalog_groups.category_id', 'products.category_id');
            });
        });
    }

    public function unitLabel(?string $locale = null): ?string
    {
        $catalogCode = $this->unit_catalog_code
            ?: UnitCatalog::canonicalCode($this->unit_code, $this->unit_dimension);

        if ($catalogCode === null) {
            return $this->unit_code;
        }

        return UnitCatalog::label(
            $catalogCode,
            $locale ?? app()->getLocale(),
            $this->unit_dimension,
        ) ?? $this->unit_code;
    }

    public function values(): HasMany
    {
        return $this->hasMany(ProductFieldValue::class, 'field_definition_id');
    }
}
