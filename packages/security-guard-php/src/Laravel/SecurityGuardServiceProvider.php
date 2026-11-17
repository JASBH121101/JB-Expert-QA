<?php

declare(strict_types=1);

namespace JB\SecurityGuard\Laravel;

use Closure;
use JB\SecurityGuard\UniversalRateLimitClient;
use JB\SecurityGuard\UploadInspectionService;
use JB\SecurityGuard\UploadMalwareScanner;
use JB\SecurityGuard\UploadQuarantineStorage;
use Illuminate\Support\ServiceProvider;
use RuntimeException;

final class SecurityGuardServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->mergeConfigFrom(__DIR__ . '/../../config/jb-security-guard.php', 'jb-security-guard');
        $this->app->singleton(UniversalRateLimitClient::class, function ($app): UniversalRateLimitClient {
            $config = $app['config']->get('jb-security-guard', []);
            return new UniversalRateLimitClient(
                (string) ($config['endpoint'] ?? ''),
                (string) ($config['client_id'] ?? ''),
                (string) ($config['client_secret'] ?? ''),
                (string) ($config['failure_mode'] ?? 'closed'),
                (int) ($config['timeout_ms'] ?? 2500)
            );
        });
        $this->app->bind(RateLimitMiddleware::class, function ($app): RateLimitMiddleware {
            $resolver = $app['config']->get('jb-security-guard.identity_resolver');
            if (!is_callable($resolver)) throw new RuntimeException('jb-security-guard.identity_resolver must be callable');
            return new RateLimitMiddleware($app->make(UniversalRateLimitClient::class), Closure::fromCallable($resolver));
        });
        $this->app->bind(UploadInspectionService::class, function ($app): UploadInspectionService {
            $uploadConfig = $app['config']->get('jb-security-guard.uploads', []);
            return new UploadInspectionService(
                $app->make(UploadQuarantineStorage::class),
                $app->make(UploadMalwareScanner::class),
                (int) ($uploadConfig['max_bytes'] ?? 5 * 1024 * 1024)
            );
        });
    }

    public function boot(): void
    {
        $this->publishes([
            __DIR__ . '/../../config/jb-security-guard.php' => config_path('jb-security-guard.php'),
        ], 'jb-security-guard-config');
    }
}
