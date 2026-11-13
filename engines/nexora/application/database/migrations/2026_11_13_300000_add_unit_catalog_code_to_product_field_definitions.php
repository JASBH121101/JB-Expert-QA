<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('product_field_definitions', function (Blueprint $table): void {
            $table->string('unit_catalog_code', 32)->nullable()->after('unit_code');
        });

        $backfills = [
            ['dimension' => 'volume', 'legacy' => ['ml'], 'canonical' => 'ml'],
            ['dimension' => 'count', 'legacy' => ['piezas', 'pieces', 'piece'], 'canonical' => 'piece'],
            ['dimension' => 'digital', 'legacy' => ['MB', 'GB', 'TB'], 'canonical' => null],
            ['dimension' => 'length', 'legacy' => ['pulgadas', 'inches', 'in'], 'canonical' => 'in'],
            ['dimension' => 'weight', 'legacy' => ['kg'], 'canonical' => 'kg'],
            ['dimension' => 'displacement', 'legacy' => ['cc'], 'canonical' => 'cc'],
        ];

        foreach ($backfills as $mapping) {
            if ($mapping['canonical'] !== null) {
                DB::table('product_field_definitions')
                    ->where('unit_dimension', $mapping['dimension'])
                    ->whereIn('unit_code', $mapping['legacy'])
                    ->update(['unit_catalog_code' => $mapping['canonical']]);

                continue;
            }

            foreach ($mapping['legacy'] as $code) {
                DB::table('product_field_definitions')
                    ->where('unit_dimension', $mapping['dimension'])
                    ->where('unit_code', $code)
                    ->update(['unit_catalog_code' => $code]);
            }
        }
    }

    public function down(): void
    {
        Schema::table('product_field_definitions', function (Blueprint $table): void {
            $table->dropColumn('unit_catalog_code');
        });
    }
};
