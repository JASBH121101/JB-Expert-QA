<?php

namespace App\Modules\Admin\Http\Controllers;

use App\Core\Library\Money\CurrencyCatalog;
use App\Models\BusinessCurrency;
use App\Models\CatalogCategory;
use App\Models\CatalogGroup;
use App\Models\InstallationSettings;
use App\Models\Product;
use App\Models\ProductFieldDefinition;
use App\Models\ProductFieldValue;
use App\Models\ProductPrice;
use Closure;
use Illuminate\Database\Query\Builder as QueryBuilder;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;
use Illuminate\View\View;
use Throwable;

final class ProductController
{
    public function index(): View
    {
        return view('admin.products.index', [
            'products' => Product::query()
                ->with(['category', 'prices'])
                ->latest()
                ->paginate(20),
            'canManage' => auth()->user()->hasPermission('catalog.manage'),
        ]);
    }

    public function create(): View
    {
        return view('admin.products.form', $this->formData());
    }

    public function store(Request $request): RedirectResponse
    {
        $validated = $this->validateProduct($request);
        $imagePath = $request->hasFile('image')
            ? $request->file('image')->store('products', 'public')
            : null;

        try {
            $product = DB::transaction(function () use ($validated, $imagePath): Product {
                $product = Product::query()->create([
                    'category_id' => $validated['category_id'] ?? null,
                    'name' => trim($validated['name']),
                    'slug' => $this->uniqueSlug($validated['name']),
                    'description' => $validated['description'] ?? '',
                    'status' => $validated['status'],
                    'image_path' => $imagePath,
                    'is_featured' => (bool) ($validated['is_featured'] ?? false),
                    'sort_order' => (int) Product::query()->max('sort_order') + 1,
                ]);

                $this->syncProductData($product, $validated);

                return $product;
            });
        } catch (Throwable $exception) {
            if ($imagePath !== null) {
                Storage::disk('public')->delete($imagePath);
            }

            throw $exception;
        }

        return redirect()->route('admin.products.index')
            ->with('status', 'Producto creado correctamente.');
    }

    public function edit(Product $product): View
    {
        return view('admin.products.form', $this->formData($product));
    }

    public function update(Request $request, Product $product): RedirectResponse
    {
        $validated = $this->validateProduct($request);
        $oldImagePath = $product->image_path;
        $newImagePath = $request->hasFile('image')
            ? $request->file('image')->store('products', 'public')
            : null;

        $removeImage = (bool) ($validated['remove_image'] ?? false);
        $imagePath = $newImagePath ?? ($removeImage ? null : $oldImagePath);

        try {
            DB::transaction(function () use ($product, $validated, $imagePath): void {
                $product->forceFill([
                    'category_id' => $validated['category_id'] ?? null,
                    'name' => trim($validated['name']),
                    'slug' => $this->uniqueSlug($validated['name'], $product->id),
                    'description' => $validated['description'] ?? '',
                    'status' => $validated['status'],
                    'image_path' => $imagePath,
                    'is_featured' => (bool) ($validated['is_featured'] ?? false),
                ])->save();

                $this->syncProductData($product, $validated);
            });
        } catch (Throwable $exception) {
            if ($newImagePath !== null) {
                Storage::disk('public')->delete($newImagePath);
            }

            throw $exception;
        }

        if ($oldImagePath !== null && $oldImagePath !== $imagePath) {
            Storage::disk('public')->delete($oldImagePath);
        }

        return redirect()->route('admin.products.index')
            ->with('status', 'Producto actualizado correctamente.');
    }

    public function destroy(Product $product): RedirectResponse
    {
        $imagePath = $product->image_path;

        DB::transaction(function () use ($product): void {
            $product->delete();
        });

        if ($imagePath !== null) {
            Storage::disk('public')->delete($imagePath);
        }

        return back()->with('status', 'Producto eliminado.');
    }

    private function formData(?Product $product = null): array
    {
        $product?->load(['fieldValues.definition', 'prices']);

        $values = [];

        foreach ($product?->fieldValues ?? collect() as $fieldValue) {
            $fieldKey = $fieldValue->definition?->field_key;

            if ($fieldKey !== null) {
                $values[$fieldKey] = $fieldValue->value['value'] ?? null;
            }
        }

        $settings = InstallationSettings::query()->findOrFail(1);
        $photosEnabled = (bool) data_get($settings->configuration, 'identity.photosEnabled', true);

        return [
            'product' => $product,
            'settings' => $settings,
            'categories' => CatalogCategory::query()
                ->where(function ($query) use ($product): void {
                    $query->where('is_active', true);

                    if ($product?->category_id !== null) {
                        $query->orWhere('id', $product->category_id);
                    }
                })
                ->orderBy('sort_order')
                ->orderBy('name')
                ->get(),
            'fieldGroups' => CatalogGroup::query()
                ->with(['category', 'fields' => static fn ($query) => $query->orderBy('sort_order')])
                ->orderBy('sort_order')
                ->get(),
            'currencies' => BusinessCurrency::query()
                ->where('is_enabled', true)
                ->orderBy('sort_order')
                ->get(),
            'values' => $values,
            'prices' => $product?->prices?->keyBy('currency_code') ?? collect(),
            'photosEnabled' => $photosEnabled,
        ];
    }

    private function validateProduct(Request $request): array
    {
        $categoryId = filter_var($request->input('category_id'), FILTER_VALIDATE_INT);
        $definitions = ProductFieldDefinition::query()
            ->availableForCategory($categoryId !== false && $categoryId > 0 ? $categoryId : null)
            ->orderBy('sort_order')
            ->get();
        $currencies = BusinessCurrency::query()
            ->where('is_enabled', true)
            ->orderBy('sort_order')
            ->get();

        $fieldKeys = $definitions->pluck('field_key')->all();
        $currencyCodes = $currencies->pluck('code')->all();
        $settings = InstallationSettings::query()->findOrFail(1);
        $photosEnabled = (bool) data_get($settings->configuration, 'identity.photosEnabled', true);

        if ($currencies->isEmpty()) {
            throw ValidationException::withMessages([
                'prices' => 'Activa al menos una moneda antes de registrar productos.',
            ]);
        }

        $fieldArrayRule = $fieldKeys === []
            ? ['sometimes', 'array']
            : ['sometimes', 'array:'.implode(',', $fieldKeys)];

        $priceArrayRule = ['required', 'array:'.implode(',', $currencyCodes)];

        $rules = [
            'name' => ['required', 'string', 'max:120'],
            'category_id' => [
                'nullable',
                'integer',
                Rule::exists('catalog_categories', 'id')
                    ->where(static fn (QueryBuilder $query) => $query->where('is_active', true)),
            ],
            'description' => ['nullable', 'string', 'max:5000'],
            'status' => ['required', Rule::in(['draft', 'published'])],
            'is_featured' => ['sometimes', 'boolean'],
            'fields' => $fieldArrayRule,
            'prices' => $priceArrayRule,
            'remove_image' => ['sometimes', 'boolean'],
            'image' => $photosEnabled
                ? ['nullable', 'image', 'mimes:jpg,jpeg,png,webp', 'max:5120', 'dimensions:max_width=4000,max_height=4000']
                : ['prohibited'],
        ];

        foreach ($currencyCodes as $currencyCode) {
            $rules['prices.'.$currencyCode] = [
                'nullable',
                'numeric',
                'min:0',
                static function (string $attribute, mixed $value, Closure $fail) use ($currencyCode): void {
                    if (! CurrencyCatalog::isValidAmount($value, $currencyCode)) {
                        $precision = CurrencyCatalog::minorUnits($currencyCode) ?? 2;
                        $fail("El precio de {$currencyCode} admite hasta {$precision} decimales y 12 dígitos enteros.");
                    }
                },
            ];
        }

        foreach ($definitions as $definition) {
            $fieldRules = [$definition->is_required ? 'required' : 'nullable'];

            switch ($definition->field_type) {
                case 'textarea':
                    $fieldRules[] = 'string';
                    $fieldRules[] = 'max:5000';
                    break;

                case 'number':
                    $fieldRules[] = 'numeric';
                    $fieldRules[] = 'min:-999999999';
                    $fieldRules[] = 'max:999999999';
                    break;

                case 'select':
                    $fieldRules[] = 'string';
                    if (is_array($definition->options) && $definition->options !== []) {
                        $fieldRules[] = Rule::in($definition->options);
                    }
                    break;

                case 'multiselect':
                    $fieldRules[] = 'array';
                    if (is_array($definition->options) && $definition->options !== []) {
                        $rules['fields.'.$definition->field_key.'.*'] = [
                            'string',
                            Rule::in($definition->options),
                        ];
                    }
                    break;

                case 'boolean':
                    $fieldRules[] = 'boolean';
                    break;

                case 'date':
                    $fieldRules[] = 'date';
                    break;

                default:
                    $fieldRules[] = 'string';
                    $fieldRules[] = 'max:255';
                    break;
            }

            $rules['fields.'.$definition->field_key] = $fieldRules;
        }

        $validated = $request->validate($rules);

        $prices = collect($validated['prices'] ?? [])
            ->filter(static fn ($amount): bool => $amount !== null && $amount !== '');

        if ($prices->isEmpty()) {
            throw ValidationException::withMessages([
                'prices' => 'Agrega al menos un precio en una de las monedas habilitadas.',
            ]);
        }

        $validated['prices'] = $prices->all();

        return $validated;
    }

    private function syncProductData(Product $product, array $validated): void
    {
        $definitions = ProductFieldDefinition::query()
            ->availableForCategory($product->category_id)
            ->get()
            ->keyBy('field_key');

        $product->fieldValues()
            ->whereIn('field_definition_id', $definitions->pluck('id'))
            ->delete();
        $product->prices()->delete();

        $fieldValues = $validated['fields'] ?? [];

        foreach ($definitions as $fieldKey => $definition) {
            $value = $fieldValues[$fieldKey] ?? null;

            if ($definition->field_type === 'boolean') {
                $value = (bool) $value;
            }

            if ($value === null || $value === '') {
                continue;
            }

            ProductFieldValue::query()->create([
                'product_id' => $product->id,
                'field_definition_id' => $definition->id,
                'value' => ['value' => $value],
            ]);
        }

        foreach ($validated['prices'] as $currencyCode => $amount) {
            ProductPrice::query()->create([
                'product_id' => $product->id,
                'currency_code' => $currencyCode,
                'amount' => $amount,
            ]);
        }
    }

    private function uniqueSlug(string $name, ?int $ignoreProductId = null): string
    {
        $base = Str::slug($name);

        if ($base === '') {
            $base = 'producto';
        }

        $slug = $base;
        $suffix = 2;

        while (
            Product::query()
                ->where('slug', $slug)
                ->when($ignoreProductId, static fn ($query) => $query->where('id', '!=', $ignoreProductId))
                ->exists()
        ) {
            $slug = $base.'-'.$suffix++;
        }

        return $slug;
    }
}
