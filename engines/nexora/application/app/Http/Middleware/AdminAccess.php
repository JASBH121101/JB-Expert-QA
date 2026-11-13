<?php

namespace App\Http\Middleware;

use App\Models\InstallationSettings;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

final class AdminAccess
{
    public function handle(Request $request, Closure $next): Response
    {
        $user = $request->user();
        $ownerId = InstallationSettings::query()->whereKey(1)->value('owner_id');

        $isOwner = $user
            && $user->isOwner()
            && $ownerId
            && (int) $user->id === (int) $ownerId;

        $isActiveEmployee = $user
            && $user->isEmployee()
            && $user->is_active;

        abort_unless($isOwner || $isActiveEmployee, 403);

        return $next($request);
    }
}
