<?php

declare(strict_types=1);

namespace JB\SecurityGuard\Laravel;

use Closure;
use JB\SecurityGuard\UniversalRateLimitClient;
use JB\SecurityGuard\UploadInspection\ClamAvScanner;
use JB\SecurityGuard\UploadInspection\LocalPrivateUploadStore;
use JB\SecurityGuard\UploadInspection\MalwareScannerInterface;
use JB\SecurityGuard\UploadInspection\PrivateUploadStoreInterface;
use JB\SecurityGuard\UploadInspection\UploadInspector;
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
        $this->app->singleton(MalwareScannerInterface::class, function ($app): MalwareScannerInterface {
            $config = $app['config']->get('jb-security-guard.uploads', []);
            return new ClamAvScanner(
                (string) ($config['clamav_binary'] ?? 'clamscan'),
                (int) ($config['scanner_timeout_ms'] ?? 15000)
            );
        });
        $this->app->singleton(PrivateUploadStoreInterface::class, function ($app): PrivateUploadStoreInterface {
            $config = $app['config']->get('jb-security-guard.uploads', []);
            return new LocalPrivateUploadStore(
                (string) ($config['storage_root'] ?? storage_path('app/private/jb-security-guard')),
                public_path()
            );
        });
        $this->app->singleton(UploadInspector::class, function ($app): UploadInspector {
            $config = $app['config']->get('jb-security-guard.uploads', []);
            return new UploadInspector(
                $app->make(PrivateUploadStoreInterface::class),
                $app->make(MalwareScannerInterface::class),
                (int) ($config['max_bytes'] ?? 5242880),
                (int) ($config['max_width'] ?? 4000),
                (int) ($config['max_height'] ?? 4000)
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
