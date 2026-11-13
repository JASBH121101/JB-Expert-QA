<?php

namespace App\Modules\Admin\Http\Controllers;

use App\Models\CatalogCategory;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;
use Illuminate\View\View;

final class CategoryController
{
    public function index(): View
    {
        return view('admin.categories.index', [
            'categories' => CatalogCategory::query()
                ->withCount('products')
                ->orderBy('sort_order')
                ->orderBy('name')
                ->get(),
        ]);
    }

    public function store(Request $request): RedirectResponse
    {
        $request->merge(['name' => trim((string) $request->input('name'))]);

        $data = $request->validate([
            'name' => ['required', 'string', 'max:80', 'unique:catalog_categories,name'],
        ]);

        CatalogCategory::query()->create([
            'name' => $data['name'],
            'slug' => $this->uniqueSlug($data['name']),
            'sort_order' => (int) CatalogCategory::query()->max('sort_order') + 1,
            'is_active' => true,
        ]);

        return back()->with('status', 'Categoría creada correctamente.');
    }

    public function update(Request $request, CatalogCategory $category): RedirectResponse
    {
        $request->merge(['name' => trim((string) $request->input('name'))]);

        $data = $request->validate([
            'name' => [
                'required',
                'string',
                'max:80',
                Rule::unique('catalog_categories', 'name')->ignore($category->id),
            ],
        ]);

        $category->forceFill([
            'name' => $data['name'],
            'slug' => $this->uniqueSlug($data['name'], $category->id),
        ])->save();

        return back()->with('status', 'Categoría actualizada.');
    }

    public function updateStatus(Request $request, CatalogCategory $category): RedirectResponse
    {
        $data = $request->validate([
            'is_active' => ['required', 'boolean'],
        ]);

        $category->forceFill([
            'is_active' => (bool) $data['is_active'],
        ])->save();

        return back()->with(
            'status',
            $category->is_active ? 'Categoría activada.' : 'Categoría desactivada.',
        );
    }

    private function uniqueSlug(string $name, ?int $ignoreCategoryId = null): string
    {
        $base = Str::slug($name);

        if ($base === '') {
            $base = 'categoria';
        }

        $slug = $base;
        $suffix = 2;

        while (
            CatalogCategory::query()
                ->where('slug', $slug)
                ->when($ignoreCategoryId, static fn ($query) => $query->where('id', '!=', $ignoreCategoryId))
                ->exists()
        ) {
            $slug = $base.'-'.$suffix++;
        }

        return $slug;
    }
}
