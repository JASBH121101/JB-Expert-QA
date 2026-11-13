<?php

namespace App\Modules\Admin\Http\Controllers;

use App\Models\CatalogCategory;
use App\Models\CatalogGroup;
use App\Models\ProductFieldDefinition;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;
use Illuminate\View\View;

final class FieldDefinitionController
{
    private const FIELD_TYPES = [
        'text',
        'textarea',
        'number',
        'select',
        'multiselect',
        'boolean',
        'date',
    ];

    public function index(): View
    {
        return view('admin.fields.index', [
            'categories' => CatalogCategory::query()->orderBy('sort_order')->orderBy('name')->get(),
            'groups' => CatalogGroup::query()
                ->with(['category', 'fields' => static fn ($query) => $query->orderBy('sort_order')])
                ->orderBy('sort_order')
                ->orderBy('name')
                ->get(),
            'fieldTypes' => self::FIELD_TYPES,
        ]);
    }

    public function storeGroup(Request $request): RedirectResponse
    {
        $data = $request->validate([
            'name' => ['required', 'string', 'max:100'],
            'category_id' => ['nullable', 'integer', 'exists:catalog_categories,id'],
        ]);

        CatalogGroup::query()->create([
            'category_id' => $data['category_id'] ?? null,
            'name' => trim($data['name']),
            'sort_order' => (int) CatalogGroup::query()
                ->where('category_id', $data['category_id'] ?? null)
                ->max('sort_order') + 1,
        ]);

        return back()->with('status', 'Grupo creado correctamente.');
    }

    public function updateGroup(Request $request, CatalogGroup $group): RedirectResponse
    {
        $data = $request->validate([
            'name' => ['required', 'string', 'max:100'],
            'category_id' => ['nullable', 'integer', 'exists:catalog_categories,id'],
        ]);

        $group->update([
            'category_id' => $data['category_id'] ?? null,
            'name' => trim($data['name']),
        ]);

        return back()->with('status', 'Grupo actualizado.');
    }

    public function destroyGroup(CatalogGroup $group): RedirectResponse
    {
        if ($group->fields()->exists()) {
            return back()->withErrors([
                'group' => 'Mueve o elimina los campos del grupo antes de eliminarlo.',
            ]);
        }

        $group->delete();

        return back()->with('status', 'Grupo eliminado.');
    }

    public function store(Request $request): RedirectResponse
    {
        $data = $this->validatedField($request);

        ProductFieldDefinition::query()->create([
            ...$this->fieldAttributes($data),
            'sort_order' => (int) ProductFieldDefinition::query()
                ->where('group_id', $data['group_id'])
                ->max('sort_order') + 1,
        ]);

        return back()->with('status', 'Campo dinámico creado.');
    }

    public function update(Request $request, ProductFieldDefinition $field): RedirectResponse
    {
        $data = $this->validatedField($request, $field);

        $field->forceFill($this->fieldAttributes($data))->save();

        return back()->with('status', 'Campo dinámico actualizado.');
    }

    public function destroy(ProductFieldDefinition $field): RedirectResponse
    {
        $field->delete();

        return back()->with('status', 'Campo eliminado. Los valores de este campo también fueron eliminados.');
    }

    private function validatedField(
        Request $request,
        ?ProductFieldDefinition $field = null,
    ): array {
        $request->merge([
            'field_key' => strtolower(trim((string) $request->input('field_key'))),
            'label' => trim((string) $request->input('label')),
        ]);

        $data = $request->validate([
            'group_id' => ['required', 'integer', 'exists:catalog_groups,id'],
            'field_key' => [
                'required',
                'string',
                'min:2',
                'max:80',
                'regex:/^[a-z][a-z0-9_]*$/',
                Rule::unique('product_field_definitions', 'field_key')->ignore($field?->id),
            ],
            'label' => ['required', 'string', 'max:100'],
            'field_type' => ['required', Rule::in(self::FIELD_TYPES)],
            'options_text' => ['nullable', 'string', 'max:2000'],
            'unit_dimension' => ['nullable', 'string', 'max:32', 'regex:/^[a-z0-9_-]*$/'],
            'unit_code' => ['nullable', 'string', 'max:24'],
            'is_required' => ['sometimes', 'boolean'],
            'is_public' => ['sometimes', 'boolean'],
            'is_searchable' => ['sometimes', 'boolean'],
            'width' => ['required', Rule::in(['half', 'full'])],
        ]);

        $options = $this->parseOptions($data['options_text'] ?? '');

        if (in_array($data['field_type'], ['select', 'multiselect'], true) && $options === []) {
            throw ValidationException::withMessages([
                'options_text' => 'Los campos de selección necesitan al menos una opción, una por línea.',
            ]);
        }

        $data['options'] = $options;

        return $data;
    }

    private function fieldAttributes(array $data): array
    {
        $isPublic = (bool) ($data['is_public'] ?? false);

        return [
            'group_id' => (int) $data['group_id'],
            'field_key' => strtolower(trim($data['field_key'])),
            'label' => $data['label'],
            'field_type' => $data['field_type'],
            'options' => in_array($data['field_type'], ['select', 'multiselect'], true)
                ? $data['options']
                : null,
            'unit_dimension' => ($data['unit_dimension'] ?? '') ?: null,
            'unit_code' => ($data['unit_code'] ?? '') ?: null,
            'is_required' => (bool) ($data['is_required'] ?? false),
            'is_public' => $isPublic,
            'is_searchable' => $isPublic && (bool) ($data['is_searchable'] ?? false),
            'width' => $data['width'],
        ];
    }

    private function parseOptions(string $rawOptions): array
    {
        $options = preg_split('/\r\n|\r|\n/', $rawOptions);
        $options = $options === false ? [] : $options;

        return array_values(array_unique(array_filter(
            array_map(static fn (string $option): string => trim($option), $options),
            static fn (string $option): bool => $option !== '',
        )));
    }
}
