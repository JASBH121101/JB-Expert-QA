@extends('layouts.app')

@section('title', 'Campos dinámicos · NEXORA')

@section('content')
<section class="panel">
    <div class="page-head">
        <div>
            <p class="muted eyebrow">CONFIGURACIÓN DEL CATÁLOGO</p>
            <h1>Campos dinámicos</h1>
            <p class="muted">Personaliza la ficha de los productos sin modificar la estructura SQL.</p>
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

    <div class="config-card">
        <h2>Crear grupo</h2>
        <form method="POST" action="{{ route('admin.fields.groups.store') }}" class="inline-form">
            @csrf
            <label>Nombre del grupo
                <input name="name" maxlength="100" value="{{ old('name') }}" placeholder="Ej. Información adicional" required>
            </label>
            <label>Aplicar a
                <select name="category_id">
                    <option value="">Todas las categorías</option>
                    @foreach ($categories as $category)
                        <option value="{{ $category->id }}" @selected((string) old('category_id') === (string) $category->id)>{{ $category->name }}</option>
                    @endforeach
                </select>
            </label>
            <button class="primary-button" type="submit">Crear grupo</button>
        </form>
    </div>

    <div class="config-card">
        <h2>Crear campo</h2>
        @if ($groups->isNotEmpty())
            <form method="POST" action="{{ route('admin.fields.store') }}" class="field-form">
                @csrf
                @include('admin.fields._form-fields', ['field' => null, 'groups' => $groups, 'fieldTypes' => $fieldTypes])
                <button class="primary-button submit-field" type="submit">Añadir campo dinámico</button>
            </form>
        @else
            <p class="muted small">Primero crea un grupo para ordenar los campos del catálogo.</p>
        @endif
    </div>

    <div class="field-groups">
        <h2>Grupos y campos existentes</h2>
        @forelse ($groups as $group)
            <article class="group-card">
                <div class="group-heading">
                    <form method="POST" action="{{ route('admin.fields.groups.update', $group) }}" class="group-rename">
                        @csrf
                        @method('PUT')
                        <label class="sr-only" for="group-{{ $group->id }}">Nombre del grupo</label>
                        <input id="group-{{ $group->id }}" name="name" maxlength="100" value="{{ $group->name }}" required>
                        <label class="sr-only" for="group-category-{{ $group->id }}">Categoría del grupo</label>
                        <select id="group-category-{{ $group->id }}" name="category_id">
                            <option value="">Todas las categorías</option>
                            @foreach ($categories as $category)
                                <option value="{{ $category->id }}" @selected($group->category_id === $category->id)>{{ $category->name }}</option>
                            @endforeach
                        </select>
                        <button class="secondary-button compact" type="submit">Guardar grupo</button>
                    </form>
                    <span class="muted small">{{ $group->category?->name ?? 'Todas las categorías' }} · {{ $group->fields->count() }} campos</span>
                    @if ($group->fields->isEmpty())
                        <form method="POST" action="{{ route('admin.fields.groups.destroy', $group) }}" onsubmit="return confirm('¿Eliminar este grupo vacío?')">
                            @csrf
                            @method('DELETE')
                            <button class="secondary-button compact danger" type="submit">Eliminar grupo</button>
                        </form>
                    @endif
                </div>

                @forelse ($group->fields as $field)
                    <details class="field-item">
                        <summary>
                            <span><strong>{{ $field->label }}</strong><small>{{ $field->field_key }} · {{ $field->field_type }}</small></span>
                            <span class="field-badges">
                                @if ($field->is_required)<em>Obligatorio</em>@endif
                                @if ($field->is_public)<em>Público</em>@else<em class="private">Privado</em>@endif
                            </span>
                        </summary>
                        <form method="POST" action="{{ route('admin.fields.update', $field) }}" class="field-form edit-field">
                            @csrf
                            @method('PUT')
                            @include('admin.fields._form-fields', ['field' => $field, 'groups' => $groups, 'fieldTypes' => $fieldTypes])
                            <div class="field-form-actions">
                                <button class="primary-button" type="submit">Guardar cambios</button>
                        </form>
                                <form method="POST" action="{{ route('admin.fields.destroy', $field) }}" onsubmit="return confirm('Eliminar este campo también eliminará sus valores guardados en los productos. ¿Continuar?')">
                                    @csrf
                                    @method('DELETE')
                                    <button class="secondary-button danger" type="submit">Eliminar campo</button>
                                </form>
                            </div>
                    </details>
                @empty
                    <p class="muted small">Este grupo todavía no tiene campos.</p>
                @endforelse
            </article>
        @empty
            <p class="muted">No hay grupos configurados.</p>
        @endforelse
    </div>
</section>
@endsection

@push('head')
<style>
    .page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.eyebrow{font-size:11px;font-weight:850;letter-spacing:.12em}.page-head h1{margin:8px 0}.link{display:inline-flex;align-items:center;text-decoration:none}
    .config-card{margin-top:20px;padding:16px;border:1px solid #e6eae2;border-radius:12px}.config-card h2,.field-groups>h2{font-size:15px;margin:0 0 12px}.inline-form{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,.9fr) auto;align-items:end;gap:10px}.inline-form label,.field-form label{display:grid;gap:6px;font-size:12px;font-weight:750}
    .config-card input,.config-card select,.field-form input,.field-form select,.field-form textarea,.group-rename input,.group-rename select{width:100%;min-height:39px;padding:9px 10px;border:1px solid #dfe5d8;border-radius:9px;background:#fff;font:inherit}.field-form textarea{min-height:74px;resize:vertical}
    .field-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:8px}.field-form .full{grid-column:1/-1}.field-form .checkboxes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.field-form .checkbox-option{display:flex;align-items:center;gap:7px;padding:9px;border:1px solid #e7ebdf;border-radius:9px;font-size:11px}.field-form .checkbox-option input{width:16px;height:16px;min-height:0;accent-color:#6c8d28}
    .primary-button,.secondary-button{min-height:38px;padding:0 13px;border:0;border-radius:9px;font:inherit;font-size:12px;font-weight:800;cursor:pointer}.primary-button{background:#20271f;color:#fff}.secondary-button{background:#eef1e9;color:#35402b}.compact{min-height:32px;padding:0 10px}.danger{background:#fff0ee;color:#963b32}
    .submit-field{grid-column:1/-1;justify-self:start}.field-groups{margin-top:24px}.group-card{margin-top:12px;padding:14px;border:1px solid #e6eae2;border-radius:12px}.group-heading{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.group-rename{display:grid;grid-template-columns:minmax(0,1fr) minmax(150px,.8fr) auto;flex:1;gap:7px;min-width:280px}.group-rename input,.group-rename select{min-width:0}.group-rename button{white-space:nowrap}
    .field-item{margin-top:11px;padding:11px 0;border-top:1px solid #edf0e9}.field-item summary{display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer;list-style:none}.field-item summary::-webkit-details-marker{display:none}.field-item summary strong,.field-item summary small{display:block}.field-item summary strong{font-size:13px}.field-item summary small{margin-top:3px;color:#697366;font-size:10px}.field-badges{display:flex;gap:5px;flex-wrap:wrap}.field-badges em{font-style:normal;font-size:10px;font-weight:800;padding:4px 7px;border-radius:20px;background:#edf7ed;color:#286536}.field-badges .private{background:#f1f2ef;color:#687264}
    .edit-field{margin-top:12px}.field-form-actions{grid-column:1/-1;display:flex;gap:8px;flex-wrap:wrap}.field-form-actions form{margin:0}.notice{margin:12px 0;padding:12px;border-radius:10px;font-size:13px}.success{background:#edf7ed;color:#286536}.error{background:#fff0ee;color:#963b32}.error p{margin:4px 0}.muted{color:#697366}.small{font-size:11px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
    @media(max-width:620px){.page-head{flex-direction:column}.inline-form{grid-template-columns:1fr}.inline-form button{width:100%}.field-form{grid-template-columns:1fr}.field-form .full,.field-form-actions,.submit-field{grid-column:1}.field-form .checkboxes{grid-template-columns:1fr}.group-heading{align-items:stretch;flex-direction:column}.group-rename{min-width:0;grid-template-columns:1fr}.field-item summary{align-items:flex-start;flex-direction:column}}
</style>
@endpush
