@extends('layouts.app')

@php($isEdit = isset($product) && $product !== null)
@php($selectedCategoryId = (string) old('category_id', $product?->category_id ?? ''))

@section('title', ($isEdit ? 'Editar producto' : 'Nuevo producto').' · NEXORA')

@section('content')
<section class="panel">
    <div class="page-head">
        <div>
            <p class="muted eyebrow">GESTIÓN DE CATÁLOGO</p>
            <h1>{{ $isEdit ? 'Editar producto' : 'Nuevo producto' }}</h1>
            <p class="muted">Los campos disponibles dependen de la plantilla de este negocio.</p>
        </div>
        <a class="secondary-button link" href="{{ route('admin.products.index') }}">Volver</a>
    </div>

    @if ($errors->any())
        <div class="notice error" role="alert">
            <strong>Revisa los datos del producto.</strong>
            @foreach ($errors->all() as $error)
                <p>{{ $error }}</p>
            @endforeach
        </div>
    @endif

    <form method="POST"
        action="{{ $isEdit ? route('admin.products.update', $product) : route('admin.products.store') }}"
        enctype="multipart/form-data"
        class="product-form">
        @csrf
        @if ($isEdit)
            @method('PUT')
        @endif

        <div class="form-section">
            <h2>Información general</h2>
            <label>Nombre del producto
                <input name="name" maxlength="120" required value="{{ old('name', $product?->name) }}" placeholder="Ej. Producto de muestra">
            </label>
            <label>Categoría
                <select id="product-category" name="category_id">
                    <option value="">Sin categoría</option>
                    @foreach ($categories as $category)
                        <option value="{{ $category->id }}" @selected((string) old('category_id', $product?->category_id) === (string) $category->id)>
                            {{ $category->name }}
                        </option>
                    @endforeach
                </select>
            </label>
            <label>Descripción
                <textarea name="description" rows="4" maxlength="5000" placeholder="Describe el producto">{{ old('description', $product?->description) }}</textarea>
            </label>
            <div class="field-grid">
                <label>Estado
                    <select name="status" required>
                        <option value="draft" @selected(old('status', $product?->status ?? 'draft') === 'draft')>Borrador</option>
                        <option value="published" @selected(old('status', $product?->status ?? 'draft') === 'published')>Publicado</option>
                    </select>
                </label>
                <label class="checkbox-field">
                    <input type="checkbox" name="is_featured" value="1" @checked((bool) old('is_featured', $product?->is_featured ?? false))>
                    <span>Destacar producto</span>
                </label>
            </div>
        </div>

        @if ($photosEnabled)
            <div class="form-section">
                <h2>Fotografía</h2>
                @if ($isEdit && $product->image_path)
                    <div class="current-image">
                        <img src="{{ asset('storage/'.$product->image_path) }}" alt="{{ $product->name }}">
                        <label class="checkbox-field">
                            <input type="checkbox" name="remove_image" value="1" @checked(old('remove_image'))>
                            <span>Quitar fotografía actual</span>
                        </label>
                    </div>
                @endif
                <label>Imagen principal (opcional)
                    <input type="file" name="image" accept="image/jpeg,image/png,image/webp">
                </label>
                <p class="muted small">JPG, PNG o WebP. Máximo 5 MB y 4000 × 4000 píxeles.</p>
            </div>
        @endif

        <div class="form-section">
            <h2>Precios</h2>
            <p class="muted small">Introduce manualmente los precios en las monedas habilitadas. No se realizan conversiones automáticas.</p>
            <div class="field-grid">
                @foreach ($currencies as $currency)
                    <label>{{ $currency->code }} · {{ \App\Core\Library\Money\CurrencyCatalog::symbol($currency->code) }}` }}
                        <input
                            type="number"
                            name="prices[{{ $currency->code }}]"
                            min="0"
                            max="999999999999.9999"
                            step="{{ \App\Core\Library\Money\CurrencyCatalog::step($currency->code) }}"
                            value="{{ old('prices.'.$currency->code, $prices[$currency->code]->amount ?? '') }}"
                            placeholder="{{ \App\Core\Library\Money\CurrencyCatalog::placeholder($currency->code) }}"
                        >
                        <small class="muted">Hasta {{ \App\Core\Library\Money\CurrencyCatalog::minorUnits($currency->code) }} decimales</small>
                    </label>
                @endforeach
            </div>
        </div>

        @forelse ($fieldGroups as $group)
            <div
                class="form-section"
                data-field-group
                data-category-id="{{ $group->category_id ?? '' }}"
                @if ($group->category_id !== null && (string) $group->category_id !== $selectedCategoryId) hidden @endif
            >
                <h2>{{ $group->name }}@if ($group->category) <span class="muted small">· {{ $group->category->name }}</span>@endif</h2>
                <div class="field-grid">
                    @foreach ($group->fields as $field)
                        @php($fieldValue = old('fields.'.$field->field_key, $values[$field->field_key] ?? null))
                        @php($unitLabel = $field->unitLabel())
                        <div class="dynamic-field {{ $field->width === 'full' ? 'full' : '' }}">
                            @switch($field->field_type)
                                @case('textarea')
                                    <label>{{ $field->label }}{{ $field->is_required ? ' *' : '' }}
                                        <textarea name="fields[{{ $field->field_key }}]" rows="3" @required($field->is_required)>{{ $fieldValue }}</textarea>
                                    </label>
                                    @break
                                @case('select')
                                    <label>{{ $field->label }}{{ $field->is_required ? ' *' : '' }}
                                        <select name="fields[{{ $field->field_key }}]" @required($field->is_required)>
                                            <option value="">Selecciona</option>
                                            @foreach (($field->options ?? []) as $option)
                                                <option value="{{ $option }}" @selected((string) $fieldValue === (string) $option)>{{ $option }}</option>
                                            @endforeach
                                        </select>
                                    </label>
                                    @break
                                @case('multiselect')
                                    <label>{{ $field->label }}{{ $field->is_required ? ' *' : '' }}
                                        <select name="fields[{{ $field->field_key }}][]" multiple @required($field->is_required)>
                                            @foreach (($field->options ?? []) as $option)
                                                <option value="{{ $option }}" @selected(in_array($option, (array) $fieldValue, true))>{{ $option }}</option>
                                            @endforeach
                                        </select>
                                    </label>
                                    @break
                                @case('boolean')
                                    <label class="checkbox-field">
                                        <input type="hidden" name="fields[{{ $field->field_key }}]" value="0">
                                        <input type="checkbox" name="fields[{{ $field->field_key }}]" value="1" @checked((bool) $fieldValue)>
                                        <span>{{ $field->label }}</span>
                                    </label>
                                    @break
                                @case('date')
                                    <label>{{ $field->label }}{{ $field->is_required ? ' *' : '' }}
                                        <input type="date" name="fields[{{ $field->field_key }}]" value="{{ $fieldValue }}" @required($field->is_required)>
                                    </label>
                                    @break
                                @default
                                    <label>{{ $field->label }}{{ $unitLabel ? ' ('.$unitLabel.')' : '' }}{{ $field->is_required ? ' *' : '' }}
                                        <input
                                            type="{{ $field->field_type === 'number' ? 'number' : 'text' }}"
                                            name="fields[{{ $field->field_key }}]"
                                            value="{{ $fieldValue }}"
                                            @if ($field->field_type === 'number') step="any" @endif
                                            @required($field->is_required)
                                        >
                                    </label>
                            @endswitch
                        </div>
                    @endforeach
                </div>
            </div>
        @empty
            <div class="notice">Esta plantilla todavía no tiene campos adicionales definidos.</div>
        @endforelse

        <div class="form-actions">
            <a class="secondary-button link" href="{{ route('admin.products.index') }}">Cancelar</a>
            <button class="primary-button" type="submit">{{ $isEdit ? 'Guardar cambios' : 'Crear producto' }}</button>
        </div>
    </form>
</section>
@endsection

@push('head')
<style>
    .page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.eyebrow{font-size:11px;font-weight:800;letter-spacing:.12em}.page-head h1{margin:8px 0}.link{display:inline-flex;align-items:center;justify-content:center;text-decoration:none}
    .product-form{display:grid;gap:18px;margin-top:20px}.form-section{padding:16px;border:1px solid #e6eae2;border-radius:12px}.form-section[hidden]{display:none}.form-section h2{font-size:15px;margin:0 0 12px}.form-section p{margin:0 0 10px}
    .product-form label{display:grid;gap:7px;margin:10px 0;font-size:12px;font-weight:700}.product-form input:not([type=checkbox]),.product-form select,.product-form textarea{width:100%;min-width:0;min-height:42px;padding:10px;border:1px solid #dfe5d8;border-radius:9px;background:#fff;color:#20271f;font:inherit}.product-form textarea{resize:vertical}
    .field-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.dynamic-field{min-width:0}.dynamic-field.full{grid-column:1/-1}
    .checkbox-field{display:flex!important;align-items:center;gap:9px;min-height:40px}.checkbox-field input[type=checkbox]{width:17px;height:17px;flex:none;accent-color:#6c8d28}.checkbox-field span{font-size:12px}
    .current-image{display:flex;align-items:center;gap:14px;margin:10px 0}.current-image img{width:90px;height:90px;object-fit:cover;border-radius:10px}.small{font-size:12px}
    .form-actions{display:flex;justify-content:flex-end;gap:8px}.primary-button,.secondary-button{min-height:40px;padding:0 15px;border:0;border-radius:9px;font:inherit;font-size:12px;font-weight:800;cursor:pointer}.primary-button{background:#20271f;color:#fff}.secondary-button{background:#eef1e9;color:#35402b}
    .notice{padding:12px;border-radius:10px;background:#f4f6ef;color:#56614d;font-size:13px}.error{background:#fff0ee;color:#963b32}
    @media(max-width:560px){.page-head{flex-direction:column}.field-grid{grid-template-columns:1fr}.form-section{padding:13px}.form-actions .link,.form-actions button{flex:1}.current-image{align-items:flex-start;flex-direction:column}}
</style>
@endpush

@push('scripts')
<script>
(() => {
    const categorySelect = document.getElementById('product-category');
    const groups = [...document.querySelectorAll('[data-field-group]')];

    if (!categorySelect || groups.length === 0) return;

    const syncCategoryFields = () => {
        const selectedCategory = categorySelect.value;

        groups.forEach((group) => {
            const categoryId = group.dataset.categoryId;
            const visible = categoryId === '' || categoryId === selectedCategory;

            group.hidden = !visible;
            group.querySelectorAll('input, select, textarea').forEach((field) => {
                field.disabled = !visible;
            });
        });
    };

    categorySelect.addEventListener('change', syncCategoryFields);
    syncCategoryFields();
})();
</script>
@endpush
