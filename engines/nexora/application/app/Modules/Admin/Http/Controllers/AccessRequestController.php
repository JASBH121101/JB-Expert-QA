<?php

namespace App\Modules\Admin\Http\Controllers;

use App\Models\LoginHelpRequest;
use App\Models\User;
use Illuminate\Http\RedirectResponse;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\View\View;

final class AccessRequestController
{
    public function index(): View
    {
        return view('admin.access-requests.index', [
            'requests' => LoginHelpRequest::query()->with('handler')->latest()->paginate(20),
            'pendingCount' => LoginHelpRequest::query()->where('status', 'pending')->count(),
        ]);
    }

    public function update(LoginHelpRequest $accessRequest, string $status): RedirectResponse
    {
        abort_unless(in_array($status, ['resolved', 'rejected'], true), 404);

        if ($accessRequest->status !== 'pending') {
            return back()->with('status', 'La solicitud ya fue gestionada.');
        }

        $accessRequest->forceFill([
            'status' => $status,
            'handled_by' => Auth::id(),
            'handled_at' => now(),
        ])->save();

        return back()->with(
            'status',
            $status === 'resolved' ? 'Solicitud resuelta.' : 'Solicitud rechazada.',
        );
    }

    public function issueTemporaryPassword(LoginHelpRequest $accessRequest): RedirectResponse
    {
        $result = DB::transaction(function () use ($accessRequest): array {
            $lockedRequest = LoginHelpRequest::query()
                ->lockForUpdate()
                ->findOrFail($accessRequest->id);

            if ($lockedRequest->status !== 'pending') {
                return ['error' => 'La solicitud ya fue gestionada.'];
            }

            $employee = User::query()
                ->where('username', $lockedRequest->username)
                ->where('role', 'employee')
                ->lockForUpdate()
                ->first();

            if (! $employee) {
                return [
                    'error' => 'No se encontró un empleado con ese usuario. Verifica el nombre o gestiona la solicitud manualmente.',
                ];
            }

            $password = Str::password(20);

            $employee->forceFill([
                'password' => $password,
                'must_change_password' => true,
            ])->save();

            $lockedRequest->forceFill([
                'status' => 'resolved',
                'handled_by' => Auth::id(),
                'handled_at' => now(),
            ])->save();

            return [
                'username' => $employee->username,
                'password' => $password,
            ];
        });

        if (isset($result['error'])) {
            return back()->withErrors(['request' => $result['error']]);
        }

        return back()->with('temporary_password_once', $result);
    }
}
