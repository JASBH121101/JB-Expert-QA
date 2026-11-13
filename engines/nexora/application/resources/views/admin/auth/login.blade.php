@extends('layouts.app')
@section('title','Acceso · NEXORA')
@section('content')
<section class="panel auth-panel">
 <p class="muted eyebrow">NEXORA ADMIN</p><h1>Iniciar sesión</h1><p class="muted">Ingresa con tu nombre de usuario y contraseña.</p>
 @if(session('status'))<div class="notice success" role="status">{{session('status')}}</div>@endif
 @if($errors->any())<div class="alert error" role="alert">@foreach($errors->all() as $error)<p>{{$error}}</p>@endforeach</div>@endif
 <form method="POST" action="{{route('admin.login.store')}}">@csrf
  <label for="username">Nombre de usuario</label><input id="username" name="username" maxlength="32" autocomplete="username" value="{{old('username')}}" required autofocus>
  <label for="password">Contraseña</label><input id="password" name="password" type="password" autocomplete="current-password" required>
  <label class="remember"><input type="checkbox" name="remember" value="1"> Mantener sesión iniciada</label>
  <button class="primary-button" type="submit">Ingresar al panel</button>
 </form>
 <details class="help"><summary>¿Problemas para ingresar?</summary><p class="muted small">Envía una solicitud al propietario. No necesitas iniciar sesión.</p>
  <form method="POST" action="{{route('admin.login.help')}}">@csrf
   <label for="help-username">Tu nombre de usuario</label><input id="help-username" name="username" maxlength="32" value="{{old('username')}}" required>
   <label for="help-reason">Motivo</label><select id="help-reason" name="reason" required><option value="">Selecciona un motivo</option><option value="forgot_password">Olvidé mi contraseña</option><option value="username_not_working">Mi usuario no funciona</option><option value="account_locked">Mi cuenta parece bloqueada</option><option value="other">Otro problema</option></select>
   <label for="help-details">Detalles (opcional)</label><textarea id="help-details" name="details" rows="3" maxlength="500"></textarea><button class="secondary-button" type="submit">Enviar solicitud</button>
  </form>
 </details>
</section>
@endsection
@push('head')
<style>
.auth-panel{max-width:480px;margin:34px auto 0}.eyebrow{font-size:12px;font-weight:800;letter-spacing:.12em}.auth-panel label{display:block;margin:16px 0 7px;font-size:13px;font-weight:700}.auth-panel input,.auth-panel select,.auth-panel textarea{width:100%;min-height:44px;padding:11px 12px;border:1px solid #dfe5d8;border-radius:10px;font:inherit}.remember{display:flex!important;align-items:center;gap:8px}.remember input{width:16px;height:16px}.primary-button,.secondary-button{width:100%;min-height:44px;margin-top:12px;border:0;border-radius:10px;font:inherit;font-weight:750;cursor:pointer}.primary-button{background:#20271f;color:white}.secondary-button{background:#eef1e9;color:#35402b}.alert,.notice{padding:12px 14px;border-radius:10px;font-size:13px}.error{background:#fff0ee;color:#963b32}.success{background:#edf7ed;color:#286536}.help{margin-top:20px;padding-top:16px;border-top:1px solid #edf0e9}.help summary{font-size:13px;font-weight:800;cursor:pointer}.small{font-size:12px}
</style>
@endpush