<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('users', function (Blueprint $table): void {
            $table->string('username', 32)->nullable()->unique();
            $table->string('role', 16)->default('owner');
            $table->boolean('is_active')->default(true);
            $table->boolean('must_change_password')->default(false);
            $table->jsonb('permissions')->nullable();
        });

        $used = [];

        foreach (DB::table('users')->select(['id', 'email'])->orderBy('id')->get() as $row) {
            $base = preg_replace(
                '/[^a-z0-9._-]/',
                '',
                strtolower((string) strtok((string) $row->email, '@')),
            ) ?: 'usuario';

            $base = substr($base, 0, 24);
            $username = $base;
            $suffix = 1;

            while (isset($used[$username])) {
                $ending = (string) $suffix++;
                $username = sprintf('%s%s', substr($base, 0, 32 - strlen($ending)), $ending);
            }

            $used[$username] = true;

            DB::table('users')
                ->where('id', $row->id)
                ->update(['username' => $username]);
        }

        Schema::create('login_help_requests', function (Blueprint $table): void {
            $table->id();
            $table->string('username', 32);
            $table->string('reason', 32);
            $table->text('details')->nullable();
            $table->string('status', 16)->default('pending');
            $table->foreignId('handled_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamp('handled_at')->nullable();
            $table->string('ip_address', 45)->nullable();
            $table->timestamps();
            $table->index(['status', 'created_at']);
            $table->index(['username', 'created_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('login_help_requests');

        Schema::table('users', function (Blueprint $table): void {
            $table->dropUnique(['username']);
            $table->dropColumn([
                'username',
                'role',
                'is_active',
                'must_change_password',
                'permissions',
            ]);
        });
    }
};
