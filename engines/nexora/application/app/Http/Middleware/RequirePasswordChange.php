<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

final class RequirePasswordChange
{
    public function handle(Request $request, Closure $next): Response
    {
        if (
            $request->user()?->must_change_password
            && ! $request->routeIs(
                'admin.password.change',
                'admin.password.update',
                'admin.logout',
            )
        ) {
            return redirect()->route('admin.password.change');
        }

        return $next($request);
    }
}
