<?php

namespace App\Modules\Admin\Http\Controllers;

use Illuminate\Auth\Events\Verified;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;

final class VerifyEmailController
{
    public function __invoke(Request $request, int $id, string $hash): RedirectResponse
    {
        $user = $request->user();

        abort_unless($user && (int) $user->getKey() === $id, 403);
        abort_unless(hash_equals(sha1($user->getEmailForVerification()), $hash), 403);

        if (! $user->hasVerifiedEmail()) {
            $user->markEmailAsVerified();
            event(new Verified($user));
        }

        return redirect()->route('admin.home')->with('status', 'Correo verificado correctamente.');
    }
}
