<?php

namespace App\Modules\Admin\Http\Controllers;

use App\Models\InstallationSettings;
use App\Models\LoginHelpRequest;
use App\Models\Product;
use App\Models\User;
use Illuminate\View\View;

final class DashboardController
{
    public function __invoke(): View
    {
        $user = auth()->user();

        return view('admin.dashboard', [
            'settings' => InstallationSettings::query()->findOrFail(1),
            'productCount' => Product::query()->count(),
            'publishedCount' => Product::query()->published()->count(),
            'employeeCount' => User::query()->where('role', 'employee')->count(),
            'pendingHelpCount' => $user->isOwner()
                ? LoginHelpRequest::query()->where('status', 'pending')->count()
                : 0,
        ]);
    }
}
