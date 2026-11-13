<?php

namespace App\Modules\Admin\Http\Controllers;

use App\Models\LoginHelpRequest;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

final class LoginHelpController
{
    public function store(Request $request): RedirectResponse
    {
        $data = $request->validate([
            'username' => [
                'required',
                'string',
                'min:3',
                'max:32',
                'regex:/^[A-Za-z0-9._-]+$/',
            ],
            'reason' => [
                'required',
                Rule::in([
                    'forgot_password',
                    'username_not_working',
                    'account_locked',
                    'other',
                ]),
            ],
            'details' => ['nullable', 'string', 'max:500'],
        ]);

        LoginHelpRequest::query()->create([
            'username' => strtolower(trim($data['username'])),
            'reason' => $data['reason'],
            'details' => trim((string) ($data['details'] ?? '')) ?: null,
            'status' => 'pending',
            'ip_address' => $request->ip(),
        ]);

        return redirect()->route('admin.login')->with(
            'status',
            'Solicitud recibida. El administrador podrá revisarla desde el panel.',
        );
    }
}
