@extends('layouts.app')
@section('title','Cambiar contraseña · NEXORA')
@section('content')
<section class="panel auth-panel"><p class="muted eyebrow">SEGURIDAD DE CUENTA</p><h1>Actualiza tu contraseña</h1><p class="muted">Debes reemplazar la contraseña temporal antes de continuar.</p>
@if($errors->any())<div class="alert error">@foreach($errors->all() as $error)<p>{{$error}}</p>@endforeach</div>@endif
<form method="POST" action="{{route('admin.password.update')}}">@csrf
<label for="current_password">Contraseña temporal o actual</label><input id="current_password" name="current_password" type="password" autocomplete="current-password" required>
<label for="password">Nueva contraseña</label><input id="password" name="password" type="password" minlength="12" autocomplete="new-password" required>
<label for="password_confirmation">Confirmar nueva contraseña</label><input id="password_confirmation" name="password_confirmation" type="password" minlength="12" autocomplete="new-password" required>
<button class="primary-button" type="submit">Guardar contraseña</button></form></section>
@endsection
@push('head')<style>.auth-panel{max-width:480px;margin:34px auto 0}.eyebrow{font-size:12px;font-weight:800}.auth-panel label{display:block;margin:16px 0 7px;font-size:13px;font-weight:700}.auth-panel input{width:100%;min-height:44px;padding:11px;border:1px solid #dfe5d8;border-radius:10px;font:inherit}.primary-button{width:100%;min-height:44px;margin-top:12px;border:0;border-radius:10px;background:#20271f;color:white;font-weight:750}.alert{padding:12px;background:#fff0ee;color:#963b32;border-radius:10px;font-size:13px}</style>@endpush