<?php

namespace App\Http\Middleware;

use App\Models\InstallationSettings;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

final class OwnerOnly
{
    public function handle(Request $request, Closure $next): Response
    {
        $ownerId = InstallationSettings::query()->whereKey(1)->value('owner_id');
        $user = $request->user();

        abort_unless(
            $ownerId
            && $user
            && $user->isOwner()
            && $user->is_active
            && (int) $user->id === (int) $ownerId,
            403,
        );

        return $next($request);
    }
}
