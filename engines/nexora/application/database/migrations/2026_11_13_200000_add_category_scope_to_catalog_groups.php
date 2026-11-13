<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('catalog_groups', function (Blueprint $table): void {
            $table->foreignId('category_id')
                ->nullable()
                ->constrained('catalog_categories')
                ->restrictOnDelete();

            $table->index(['category_id', 'sort_order']);
        });
    }

    public function down(): void
    {
        Schema::table('catalog_groups', function (Blueprint $table): void {
            $table->dropIndex(['category_id', 'sort_order']);
            $table->dropConstrainedForeignId('category_id');
        });
    }
};
