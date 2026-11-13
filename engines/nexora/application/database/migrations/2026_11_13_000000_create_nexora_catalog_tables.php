<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('installation_settings', function (Blueprint $table): void {
            $table->unsignedTinyInteger('id')->primary();
            $table->string('business_name', 120);
            $table->string('business_type', 40)->default('other');
            $table->foreignId('owner_id')->nullable()->constrained('users')->nullOnDelete();
            $table->jsonb('configuration')->nullable();
            $table->timestamp('setup_completed_at')->nullable();
            $table->timestamps();
        });

        Schema::create('business_contacts', function (Blueprint $table): void {
            $table->id();
            $table->string('phone', 20);
            $table->boolean('is_primary')->default(false);
            $table->boolean('show_public')->default(true);
            $table->unsignedSmallInteger('sort_order')->default(0);
            $table->timestamps();
            $table->index(['show_public', 'sort_order']);
        });

        Schema::create('business_currencies', function (Blueprint $table): void {
            $table->char('code', 3)->primary();
            $table->boolean('is_primary')->default(false);
            $table->boolean('is_enabled')->default(true);
            $table->unsignedSmallInteger('sort_order')->default(0);
        });

        Schema::create('catalog_categories', function (Blueprint $table): void {
            $table->id();
            $table->string('name', 80);
            $table->string('slug', 100)->unique();
            $table->unsignedSmallInteger('sort_order')->default(0);
            $table->boolean('is_active')->default(true);
            $table->timestamps();
        });

        Schema::create('catalog_groups', function (Blueprint $table): void {
            $table->id();
            $table->string('name', 100);
            $table->unsignedSmallInteger('sort_order')->default(0);
            $table->timestamps();
        });

        Schema::create('product_field_definitions', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('group_id')->constrained('catalog_groups')->cascadeOnDelete();
            $table->string('field_key', 80)->unique();
            $table->string('label', 100);
            $table->string('field_type', 24);
            $table->jsonb('options')->nullable();
            $table->string('unit_dimension', 32)->nullable();
            $table->string('unit_code', 24)->nullable();
            $table->boolean('is_required')->default(false);
            $table->boolean('is_public')->default(true);
            $table->boolean('is_searchable')->default(false);
            $table->string('width', 8)->default('half');
            $table->unsignedSmallInteger('sort_order')->default(0);
            $table->timestamps();
            $table->index(['group_id', 'sort_order']);
            $table->index(['is_public', 'is_searchable']);
        });

        Schema::create('products', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('category_id')->nullable()->constrained('catalog_categories')->nullOnDelete();
            $table->string('name', 120);
            $table->string('slug', 140)->unique();
            $table->text('description');
            $table->string('status', 16)->default('draft');
            $table->string('image_path')->nullable();
            $table->boolean('is_featured')->default(false);
            $table->unsignedInteger('sort_order')->default(0);
            $table->timestamps();
            $table->index(['status', 'category_id', 'sort_order']);
        });

        Schema::create('product_field_values', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('product_id')->constrained('products')->cascadeOnDelete();
            $table->foreignId('field_definition_id')->constrained('product_field_definitions')->cascadeOnDelete();
            $table->jsonb('value')->nullable();
            $table->unique(['product_id', 'field_definition_id']);
        });

        Schema::create('product_prices', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('product_id')->constrained('products')->cascadeOnDelete();
            $table->char('currency_code', 3);
            $table->decimal('amount', 14, 2);
            $table->unique(['product_id', 'currency_code']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('product_prices');
        Schema::dropIfExists('product_field_values');
        Schema::dropIfExists('products');
        Schema::dropIfExists('product_field_definitions');
        Schema::dropIfExists('catalog_groups');
        Schema::dropIfExists('catalog_categories');
        Schema::dropIfExists('business_currencies');
        Schema::dropIfExists('business_contacts');
        Schema::dropIfExists('installation_settings');
    }
};
