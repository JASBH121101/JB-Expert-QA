<?php

use App\Http\Middleware\AdminAccess;
use App\Http\Middleware\ApplyInstallationLocale;
use App\Http\Middleware\OwnerOnly;
use App\Http\Middleware\RequirePasswordChange;
use App\Http\Middleware\RequirePermission;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        $middleware->trustProxies(at: '*');
        $middleware->web(append: [ApplyInstallationLocale::class]);

        $middleware->alias([
            'admin.access' => AdminAccess::class,
            'owner' => OwnerOnly::class,
            'password.change.required' => RequirePasswordChange::class,
            'permission' => RequirePermission::class,
        ]);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        $exceptions->shouldRenderJsonWhen(
            fn (Request $request) => $request->is('api/*') || $request->expectsJson(),
        );
    })
    ->create();
