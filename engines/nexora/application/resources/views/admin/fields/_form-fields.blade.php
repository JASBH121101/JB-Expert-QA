@php($currentOptions = $field?->options ?? [])
@php($currentOptionsText = implode("\n", $currentOptions))
@php($currentType = old('field_type', $field?->field_type ?? 'text'))
<div>
    <label>Grupo
        <select name="group_id" required>
            @foreach ($groups as $group)
                <option value="{{ $group->id }}" @selected((string) old('group_id', $field?->group_id) === (string) $group->id)>{{ $group->name }} · {{ $group->category?->name ?? 'Todas las categorías' }}</option>
            @endforeach
        </select>
    </label>
</div>
<div>
    <label>Clave interna
        <input name="field_key" maxlength="80" pattern="[a-z][a-z0-9_]*" value="{{ old('field_key', $field?->field_key) }}" placeholder="ejemplo: material" required>
    </label>
</div>
<div>
    <label>Etiqueta visible
        <input name="label" maxlength="100" value="{{ old('label', $field?->label) }}" placeholder="Ej. Material" required>
    </label>
</div>
<div>
    <label>Tipo de campo
        <select name="field_type" required>
            @foreach ($fieldTypes as $type)
                <option value="{{ $type }}" @selected($currentType === $type)>{{ ucfirst($type) }}</option>
            @endforeach
        </select>
    </label>
</div>
<div class="full">
    <label>Opciones (solo selección; una por línea)
        <textarea name="options_text" rows="3" placeholder="Opción 1&#10;Opción 2">{{ old('options_text', $currentOptionsText) }}</textarea>
    </label>
</div>
<div>
    <label>Dimensión de unidad (opcional)
        <input name="unit_dimension" maxlength="32" value="{{ old('unit_dimension', $field?->unit_dimension) }}" placeholder="volume, weight, displacement">
    </label>
</div>
<div>
    <label>Unidad (opcional)
        <input name="unit_code" maxlength="24" value="{{ old('unit_code', $field?->unit_code) }}" placeholder="ml, kg, cc, GB">
    </label>
</div>
<div>
    <label>Ancho del campo
        <select name="width" required>
            <option value="half" @selected(old('width', $field?->width ?? 'half') === 'half')>Medio</option>
            <option value="full" @selected(old('width', $field?->width ?? 'half') === 'full')>Completo</option>
        </select>
    </label>
</div>
<div class="checkboxes full">
    <label class="checkbox-option">
        <input type="checkbox" name="is_required" value="1" @checked((bool) old('is_required', $field?->is_required ?? false))>
        Obligatorio
    </label>
    <label class="checkbox-option">
        <input type="checkbox" name="is_public" value="1" @checked((bool) old('is_public', $field?->is_public ?? true))>
        Visible al público
    </label>
    <label class="checkbox-option">
        <input type="checkbox" name="is_searchable" value="1" @checked((bool) old('is_searchable', $field?->is_searchable ?? false))>
        Incluir en búsqueda
    </label>
</div>
