<?php

namespace App\Http\Middleware;

use App\Models\InstallationSettings;
use App\Modules\Setup\Services\LanguageCatalog;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\App;
use Symfony\Component\HttpFoundation\Response;
use Throwable;

final class ApplyInstallationLocale
{
    public function handle(Request $request, Closure $next): Response
    {
        try {
            $settings = InstallationSettings::query()->find(1);
            $locale = data_get($settings?->configuration, 'regional.locale');

            if (is_string($locale) && array_key_exists($locale, LanguageCatalog::all())) {
                App::setLocale($locale);
            }
        } catch (Throwable) {
            // The installer must remain accessible before the schema exists.
        }

        return $next($request);
    }
}
