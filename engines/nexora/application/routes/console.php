<?php

use App\Core\Installation\ResetDemoInstallation;
use Illuminate\Support\Facades\Artisan;

Artisan::command('nexora:status', function (): void {
    $this->info('NEXORA application bootstrap is available.');
    $this->line('Installation mode: '.config('nexora.installation_mode', 'production'));
})->purpose('Display NEXORA bootstrap status');

Artisan::command('nexora:demo:reset {--confirm= : Type RESET-DEMO-DATA to confirm the demo reset}', function (
    ResetDemoInstallation $reset,
): int {
    try {
        $reset->assertAllowed();
    } catch (RuntimeException $exception) {
        $this->error($exception->getMessage());

        return 1;
    }

    if ($this->option('confirm') !== 'RESET-DEMO-DATA') {
        $this->error(__('setup.demo_reset_confirmation_required'));

        return 1;
    }

    try {
        $reset->reset();
    } catch (Throwable $exception) {
        report($exception);
        $this->error(__('setup.demo_reset_failed', ['error' => $exception->getMessage()]));

        return 1;
    }

    $this->info(__('setup.demo_reset_completed'));

    return 0;
})->purpose('Reset only an explicitly marked NEXORA demo installation');
