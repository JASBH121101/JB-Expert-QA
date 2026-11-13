<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use RuntimeException;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('product_prices', function (Blueprint $table): void {
            $table->decimal('amount', 16, 4)->change();
        });
    }

    public function down(): void
    {
        $hasAmountsAboveTwoDecimals = DB::table('product_prices')
            ->whereRaw('amount <> ROUND(amount, 2)')
            ->exists();

        if ($hasAmountsAboveTwoDecimals) {
            throw new RuntimeException(
                'Cannot reduce product price precision while amounts contain more than two decimal places.',
            );
        }

        Schema::table('product_prices', function (Blueprint $table): void {
            $table->decimal('amount', 14, 2)->change();
        });
    }
};
