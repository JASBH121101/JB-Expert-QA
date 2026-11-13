<?php

namespace App\Modules\Admin\Http\Controllers;

use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\View\View;

final class PasswordController
{
    public function edit(): View
    {
        return view('admin.auth.change-password');
    }

    public function update(Request $request): RedirectResponse
    {
        $data = $request->validate([
            'current_password' => ['required', 'current_password'],
            'password' => [
                'required',
                'string',
                'min:12',
                'confirmed',
                'different:current_password',
            ],
        ]);

        $request->user()->forceFill([
            'password' => $data['password'],
            'must_change_password' => false,
        ])->save();

        $request->session()->regenerate();

        return redirect()->route('admin.home')->with(
            'status',
            'Contraseña actualizada correctamente.',
        );
    }
}
