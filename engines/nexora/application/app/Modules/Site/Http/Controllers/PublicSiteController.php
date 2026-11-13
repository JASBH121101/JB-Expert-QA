<?php

namespace App\Modules\Site\Http\Controllers;

use App\Core\Installation\InstallationState;
use App\Models\BusinessContact;
use App\Models\CatalogCategory;
use App\Models\InstallationSettings;
use App\Models\Product;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\View\View;

final class PublicSiteController
{
    public function __invoke(
        Request $request,
        InstallationState $installation,
    ): View|RedirectResponse {
        if (! $installation->isCompleted()) {
            return redirect()->route('setup.show');
        }

        $filters = $request->validate([
            'q' => ['nullable', 'string', 'max:100'],
            'category' => ['nullable', 'string', 'max:100'],
        ]);

        $search = trim((string) ($filters['q'] ?? ''));
        $categorySlug = (string) ($filters['category'] ?? '');

        $products = Product::query()
            ->published()
            ->with(['category', 'prices'])
            ->when($search !== '', function (Builder $query) use ($search): void {
                $query->where(function (Builder $builder) use ($search): void {
                    $builder->where('name', 'like', '%'.$search.'%')
                        ->orWhere('description', 'like', '%'.$search.'%')
                        ->orWhereHas('fieldValues', function (Builder $values) use ($search): void {
                            $values->whereHas('definition', static fn (Builder $definition): Builder => $definition
                                ->where('is_public', true)
                                ->where('is_searchable', true)
                                ->availableForCurrentProductCategory())
                                ->where('value', 'like', '%'.$search.'%');
                        });
                });
            })
            ->when($categorySlug !== '', function (Builder $query) use ($categorySlug): void {
                $query->whereHas('category', function (Builder $categoryQuery) use ($categorySlug): void {
                    $categoryQuery
                        ->where('slug', $categorySlug)
                        ->where('is_active', true);
                });
            })
            ->orderByDesc('is_featured')
            ->orderBy('sort_order')
            ->orderBy('name')
            ->paginate(12)
            ->withQueryString();

        $settings = InstallationSettings::query()->findOrFail(1);

        return view('site.home', [
            'settings' => $settings,
            'products' => $products,
            'categories' => CatalogCategory::query()
                ->where('is_active', true)
                ->whereHas('products', static fn (Builder $query): Builder => $query->published())
                ->orderBy('sort_order')
                ->orderBy('name')
                ->get(),
            'contacts' => BusinessContact::query()
                ->where('show_public', true)
                ->orderByDesc('is_primary')
                ->orderBy('sort_order')
                ->get(),
            'search' => $search,
            'selectedCategory' => $categorySlug,
            'photosEnabled' => (bool) data_get($settings->configuration, 'identity.photosEnabled', true),
        ]);
    }

    public function show(string $slug, InstallationState $installation): View|RedirectResponse
    {
        if (! $installation->isCompleted()) {
            return redirect()->route('setup.show');
        }

        $settings = InstallationSettings::query()->findOrFail(1);
        $product = Product::query()
            ->published()
            ->with(['category', 'prices'])
            ->where('slug', $slug)
            ->firstOrFail();

        $product->load([
            'fieldValues' => static fn ($query) => $query
                ->whereHas('definition', static fn ($definition) => $definition
                    ->where('is_public', true)
                    ->availableForCategory($product->category_id))
                ->with('definition'),
        ]);

        return view('site.product', [
            'settings' => $settings,
            'product' => $product,
            'contacts' => BusinessContact::query()
                ->where('show_public', true)
                ->orderByDesc('is_primary')
                ->orderBy('sort_order')
                ->get(),
            'photosEnabled' => (bool) data_get($settings->configuration, 'identity.photosEnabled', true),
        ]);
    }
}
