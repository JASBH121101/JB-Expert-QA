<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class ProductFieldValue extends Model
{
    public $timestamps = false;

    protected $fillable = ['product_id', 'field_definition_id', 'value'];

    protected function casts(): array
    {
        return ['value' => 'array'];
    }

    public function product(): BelongsTo
    {
        return $this->belongsTo(Product::class, 'product_id');
    }

    public function definition(): BelongsTo
    {
        return $this->belongsTo(ProductFieldDefinition::class, 'field_definition_id');
    }
}
