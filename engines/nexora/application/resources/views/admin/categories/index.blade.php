@extends('layouts.app')

@section('title', 'Categorías · NEXORA')

@section('content')
<section class="panel">
    <div class="page-head">
        <div>
            <p class="muted eyebrow">CONFIGURACIÓN DEL CATÁLOGO</p>
            <h1>Categorías</h1>
            <p class="muted">Organiza los productos que verá el visitante.</p>
        </div>
        <a class="secondary-button link" href="{{ route('admin.home') }}">Volver</a>
    </div>

    @if (session('status'))
        <div class="notice success" role="status">{{ session('status') }}</div>
    @endif
    @if ($errors->any())
        <div class="notice error" role="alert">
            @foreach ($errors->all() as $error)
                <p>{{ $error }}</p>
            @endforeach
        </div>
    @endif

    <form method="POST" action="{{ route('admin.categories.store') }}" class="create-form">
        @csrf
        <label>Nueva categoría
            <input name="name" maxlength="80" value="{{ old('name') }}" placeholder="Ej. Accesorios" required>
        </label>
        <button class="primary-button" type="submit">Añadir categoría</button>
    </form>

    <div class="category-list">
        @forelse ($categories as $category)
            <article class="category-card">
                <div class="category-meta">
                    <div>
                        <strong>{{ $category->name }}</strong>
                        <p class="muted small">{{ $category->products_count }} productos · /{{ $category->slug }}</p>
                    </div>
                    <span class="state {{ $category->is_active ? 'active' : 'inactive' }}">
                        {{ $category->is_active ? 'Activa' : 'Inactiva' }}
                    </span>
                </div>
                <div class="category-actions">
                    <form method="POST" action="{{ route('admin.categories.update', $category) }}" class="rename-form">
                        @csrf
                        @method('PUT')
                        <label class="sr-only" for="category-{{ $category->id }}">Nombre de categoría</label>
                        <input id="category-{{ $category->id }}" name="name" maxlength="80" value="{{ $category->name }}" required>
                        <button class="secondary-button compact" type="submit">Guardar nombre</button>
                    </form>
                    <form method="POST" action="{{ route('admin.categories.status', $category) }}">
                        @csrf
                        <input type="hidden" name="is_active" value="{{ $category->is_active ? '0' : '1' }}">
                        <button class="secondary-button compact" type="submit">
                            {{ $category->is_active ? 'Desactivar' : 'Activar' }}
                        </button>
                    </form>
                </div>
            </article>
        @empty
            <p class="muted">No hay categorías registradas.</p>
        @endforelse
    </div>
</section>
@endsection

@push('head')
<style>
    .page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.eyebrow{font-size:11px;font-weight:850;letter-spacing:.12em}.page-head h1{margin:8px 0}.link{display:inline-flex;align-items:center;text-decoration:none}
    .create-form{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:10px;margin:22px 0;padding:16px;border:1px solid #e6eae2;border-radius:12px}.create-form label{display:grid;gap:7px;font-size:12px;font-weight:750}.create-form input,.rename-form input{width:100%;min-height:40px;padding:9px 11px;border:1px solid #dfe5d8;border-radius:9px;font:inherit}
    .primary-button,.secondary-button{min-height:38px;padding:0 13px;border:0;border-radius:9px;font:inherit;font-size:12px;font-weight:800;cursor:pointer}.primary-button{background:#20271f;color:#fff}.secondary-button{background:#eef1e9;color:#35402b}.compact{min-height:34px;padding:0 10px}
    .category-card{padding:14px 0;border-bottom:1px solid #edf0e9}.category-meta{display:flex;justify-content:space-between;gap:12px;align-items:center}.category-meta p{margin:5px 0 0}.small{font-size:11px}.state{font-size:10px;font-weight:850;padding:4px 8px;border-radius:20px}.active{background:#edf7ed;color:#286536}.inactive{background:#fff0ee;color:#963b32}
    .category-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.category-actions form{margin:0}.rename-form{display:flex;flex:1;gap:8px;min-width:220px}.rename-form input{flex:1;min-width:0}
    .notice{margin:12px 0;padding:12px;border-radius:10px;font-size:13px}.success{background:#edf7ed;color:#286536}.error{background:#fff0ee;color:#963b32}.error p{margin:4px 0}
    .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
    @media(max-width:560px){.page-head{flex-direction:column}.create-form{grid-template-columns:1fr}.create-form button{width:100%}.category-meta{align-items:flex-start;flex-direction:column}.category-actions{display:grid;grid-template-columns:1fr}.rename-form{min-width:0}.rename-form button{white-space:nowrap}}
</style>
@endpush
