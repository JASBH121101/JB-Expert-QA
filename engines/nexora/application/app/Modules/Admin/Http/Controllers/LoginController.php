<?php

namespace App\Modules\Admin\Http\Controllers;

use App\Core\Installation\InstallationState;
use App\Models\InstallationSettings;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\View\View;

final class LoginController
{
    public function create(InstallationState $installation): View|RedirectResponse
    {
        if (! $installation->isCompleted()) {
            return redirect()->route('setup.show');
        }

        if (Auth::check()) {
            return redirect()->route('admin.home');
        }

        return view('admin.auth.login');
    }

    public function store(Request $request): RedirectResponse
    {
        $data = $request->validate([
            'username' => ['required', 'string', 'max:32'],
            'password' => ['required', 'string'],
        ]);

        $credentials = [
            'username' => strtolower(trim($data['username'])),
            'password' => $data['password'],
            'is_active' => true,
        ];

        if (! Auth::attempt($credentials, $request->boolean('remember'))) {
            return back()->withErrors([
                'username' => 'Usuario o contraseña incorrectos, o cuenta inactiva.',
            ])->onlyInput('username');
        }

        $request->session()->regenerate();

        $ownerId = InstallationSettings::query()->whereKey(1)->value('owner_id');
        $user = $request->user();

        $validAccount = $user && (
            ($user->isOwner() && $ownerId && (int) $user->id === (int) $ownerId)
            || $user->isEmployee()
        );

        if (! $validAccount) {
            Auth::logout();
            $request->session()->invalidate();
            $request->session()->regenerateToken();

            abort(403);
        }

        return redirect()->intended(route('admin.home'));
    }

    public function destroy(Request $request): RedirectResponse
    {
        Auth::logout();
        $request->session()->invalidate();
        $request->session()->regenerateToken();

        return redirect()->route('admin.login');
    }
}
