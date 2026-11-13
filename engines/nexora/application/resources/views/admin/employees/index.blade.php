@extends('layouts.app')

@section('title', 'Empleados · NEXORA')

@section('content')
<section class="panel">
    <div class="page-head">
        <div>
            <p class="muted eyebrow">GESTIÓN DE ACCESO</p>
            <h1>Empleados</h1>
            <p class="muted">Crea cuentas y decide qué puede hacer cada empleado.</p>
        </div>
        <a class="secondary-button link" href="{{ route('admin.home') }}">Volver</a>
    </div>

    @if (session('status'))
        <div class="notice success">{{ session('status') }}</div>
    @endif
    @if ($errors->any())
        <div class="notice error">
            @foreach ($errors->all() as $error)
                <p>{{ $error }}</p>
            @endforeach
        </div>
    @endif
    @if (session('employee_credentials_once'))
        <div class="notice credentials">
            <strong>Guarda estos datos ahora; la contraseña temporal no volverá a mostrarse.</strong>
            <p>Usuario: <code>{{ session('employee_credentials_once.username') }}</code></p>
            <p>Contraseña: <code>{{ session('employee_credentials_once.password') }}</code></p>
            <p>El empleado deberá cambiarla al ingresar.</p>
        </div>
    @endif

    <div class="subpanel">
        <h2>Crear cuenta</h2>
        <form method="POST" action="{{ route('admin.employees.store') }}" class="employee-form">
            @csrf
            <label>Nombre completo
                <input name="name" maxlength="100" value="{{ old('name') }}" required>
            </label>
            <label>Nombre de usuario
                <input name="username" minlength="3" maxlength="32" pattern="[A-Za-z0-9._-]+" value="{{ old('username') }}" required>
            </label>
            <label>Correo para recuperación
                <input name="email" type="email" maxlength="255" value="{{ old('email') }}" required>
            </label>
            <button class="primary-button" type="submit">Crear empleado</button>
        </form>
        <p class="muted small">El correo no sirve para iniciar sesión. La contraseña temporal se muestra una sola vez.</p>
    </div>

    <div class="employee-list">
        <h2>Cuentas registradas</h2>
        @forelse ($employees as $employee)
            <article class="employee-card">
                <div class="employee-row">
                    <div>
                        <strong>{{ $employee->name }}</strong>
                        <p class="muted small">{{ $employee->username }} · {{ $employee->email }}</p>
                    </div>
                    <div class="actions">
                        <span class="{{ $employee->is_active ? 'active' : 'inactive' }}">
                            {{ $employee->is_active ? 'Activa' : 'Suspendida' }}
                        </span>
                        <form method="POST" action="{{ route('admin.employees.status', $employee) }}">
                            @csrf
                            <input type="hidden" name="is_active" value="{{ $employee->is_active ? '0' : '1' }}">
                            <button class="secondary-button compact" type="submit">
                                {{ $employee->is_active ? 'Suspender' : 'Activar' }}
                            </button>
                        </form>
                    </div>
                </div>

                <details class="permission-details">
                    <summary>Permisos asignados ({{ count($employee->permissions ?? []) }})</summary>
                    <form method="POST" action="{{ route('admin.employees.permissions', $employee) }}">
                        @csrf
                        <div class="permission-grid">
                            @foreach ($availablePermissions as $permission => $label)
                                <label class="permission-option">
                                    <input
                                        type="checkbox"
                                        name="permissions[]"
                                        value="{{ $permission }}"
                                        @checked(in_array($permission, $employee->permissions ?? [], true))
                                    >
                                    <span>{{ $label }}</span>
                                </label>
                            @endforeach
                        </div>
                        <button class="secondary-button save-permissions" type="submit">Guardar permisos</button>
                    </form>
                </details>
            </article>
        @empty
            <p class="muted">Todavía no hay empleados registrados.</p>
        @endforelse
        {{ $employees->links() }}
    </div>
</section>
@endsection

@push('head')
<style>
    .page-head{display:flex;justify-content:space-between;gap:12px}.eyebrow{font-size:11px;font-weight:800}.page-head h1{margin:8px 0}.link{display:inline-flex;align-items:center;text-decoration:none}
    .subpanel{margin-top:22px;padding:16px;border:1px solid #e6eae2;border-radius:13px}.subpanel h2,.employee-list h2{font-size:16px;margin:0 0 12px}
    .employee-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.employee-form label{display:grid;gap:7px;font-size:12px;font-weight:700}
    .employee-form input{min-height:42px;padding:10px;border:1px solid #dfe5d8;border-radius:9px;font:inherit}
    .primary-button,.secondary-button{min-height:38px;padding:0 13px;border:0;border-radius:9px;font:inherit;font-size:12px;font-weight:800;cursor:pointer}
    .primary-button{background:#20271f;color:white}.secondary-button{background:#eef1e9;color:#35402b}.employee-form button{align-self:end}
    .small{font-size:12px}.employee-list{margin-top:24px}.employee-card{padding:14px 0;border-bottom:1px solid #edf0e9}
    .employee-row{display:flex;align-items:center;justify-content:space-between;gap:12px}.employee-row p{margin:5px 0 0}
    .actions{display:flex;align-items:center;gap:10px;font-size:11px;font-weight:800}.active{color:#347b43}.inactive{color:#a33d35}.compact{min-height:34px}
    .permission-details{margin-top:12px;padding-top:10px;border-top:1px solid #edf0e9}.permission-details summary{font-size:12px;font-weight:800;cursor:pointer}
    .permission-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:12px 0}
    .permission-option{display:flex;align-items:flex-start;gap:8px;padding:10px;border:1px solid #e6eae2;border-radius:9px;font-size:12px;font-weight:600}
    .permission-option input{flex:none;width:16px;height:16px;margin:1px 0;accent-color:#6c8d28}
    .save-permissions{min-height:34px}.notice{margin:13px 0;padding:12px;border-radius:10px;font-size:13px}.success,.credentials{background:#edf7ed;color:#286536}.error{background:#fff0ee;color:#963b32}.credentials code{overflow-wrap:anywhere}
    @media(max-width:560px){.page-head{flex-direction:column}.employee-form{grid-template-columns:1fr}.employee-row{align-items:flex-start;flex-direction:column}.actions{width:100%;justify-content:space-between}.permission-grid{grid-template-columns:1fr}}
</style>
@endpush
