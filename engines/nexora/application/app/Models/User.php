<?php

namespace App\Models;

use App\Core\Authorization\PermissionCatalog;
use Illuminate\Auth\MustVerifyEmail as MustVerifyEmailTrait;
use Illuminate\Contracts\Auth\MustVerifyEmail as MustVerifyEmailContract;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Attributes\Hidden;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;

#[Fillable([
    'name',
    'username',
    'email',
    'password',
    'role',
    'is_active',
    'must_change_password',
    'permissions',
])]
#[Hidden(['password', 'remember_token'])]
class User extends Authenticatable implements MustVerifyEmailContract
{
    use MustVerifyEmailTrait;
    use Notifiable;

    protected function casts(): array
    {
        return [
            'email_verified_at' => 'datetime',
            'password' => 'hashed',
            'is_active' => 'boolean',
            'must_change_password' => 'boolean',
            'permissions' => 'array',
        ];
    }

    public function isOwner(): bool
    {
        return $this->role === 'owner';
    }

    public function isEmployee(): bool
    {
        return $this->role === 'employee';
    }

    public function hasPermission(string $permission): bool
    {
        if ($this->isOwner()) {
            return true;
        }

        if (! $this->isEmployee() || ! $this->is_active) {
            return false;
        }

        $grantedPermissions = $this->permissions ?? [];

        if ($permission === 'catalog.view' && in_array('catalog.manage', $grantedPermissions, true)) {
            return true;
        }

        return in_array($permission, $grantedPermissions, true)
            && array_key_exists($permission, PermissionCatalog::labels());
    }
}
