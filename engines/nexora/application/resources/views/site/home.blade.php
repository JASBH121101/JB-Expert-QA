@extends('layouts.app')

@section('title', $settings->business_name.' · Catálogo')

@section('content')
<section class="catalog-shell">
    <header class="store-header">
        <div>
            <p class="muted eyebrow">CATÁLOGO DIGITAL</p>
            <h1>{{ $settings->business_name }}</h1>
            @if (data_get($settings->configuration, 'identity.description'))
                <p class="store-description">{{ data_get($settings->configuration, 'identity.description') }}</p>
            @endif
        </div>
        @if ($contacts->isNotEmpty())
            <div class="store-contacts">
                @foreach ($contacts as $contact)
                    <a href="https://wa.me/{{ preg_replace('/\D+/', '', $contact->phone) }}" target="_blank" rel="noopener noreferrer">
                        <span>{{ $contact->is_primary ? 'Contacto principal' : 'WhatsApp' }}</span>
                        <strong>{{ $contact->formatted_phone }}</strong>
                    </a>
                @endforeach
            </div>
        @endif
    </header>

    <form method="GET" action="{{ route('site.home') }}" class="catalog-filters">
        <label class="search-field">
            <span class="sr-only">Buscar productos</span>
            <input type="search" name="q" maxlength="100" value="{{ $search }}" placeholder="Buscar productos…">
        </label>
        <label class="category-field">
            <span class="sr-only">Filtrar categoría</span>
            <select name="category">
                <option value="">Todas las categorías</option>
                @foreach ($categories as $category)
                    <option value="{{ $category->slug }}" @selected($selectedCategory === $category->slug)>
                        {{ $category->name }}
                    </option>
                @endforeach
            </select>
        </label>
        <button class="filter-button" type="submit">Buscar</button>
        @if ($search !== '' || $selectedCategory !== '')
            <a class="clear-filter" href="{{ route('site.home') }}">Limpiar</a>
        @endif
    </form>

    <div class="catalog-heading">
        <div>
            <h2>Productos disponibles</h2>
            <p class="muted small">{{ $products->total() }} resultados</p>
        </div>
    </div>

    @if ($products->isNotEmpty())
        <div class="product-grid">
            @foreach ($products as $product)
                <a class="product-card" href="{{ route('site.product', $product->slug) }}">
                    @if ($photosEnabled && $product->image_path)
                        <img src="{{ asset('storage/'.$product->image_path) }}" alt="{{ $product->name }}" loading="lazy">
                    @else
                        <div class="product-image-placeholder" aria-hidden="true"><span>{{ mb_substr($product->name, 0, 1) }}</span></div>
                    @endif
                    <div class="product-card-body">
                        @if ($product->category)
                            <span class="product-category">{{ $product->category->name }}</span>
                        @endif
                        <h3>{{ $product->name }}</h3>
                        @if ($product->description !== '')
                            <p>{{ \Illuminate\Support\Str::limit($product->description, 92) }}</p>
                        @endif
                        <div class="card-prices">
                            @foreach ($product->prices as $price)
                                <span>{{ $price->currency_code }} {{ number_format((float) $price->amount, 2) }}</span>
                            @endforeach
                        </div>
                        <span class="view-product">Ver producto <span aria-hidden="true">→</span></span>
                    </div>
                </a>
            @endforeach
        </div>
        <div class="pagination">{{ $products->links() }}</div>
    @else
        <div class="empty-catalog">
            <span class="empty-mark" aria-hidden="true">N</span>
            <h3>No encontramos productos</h3>
            <p class="muted">Prueba con otra búsqueda o selecciona una categoría diferente.</p>
            <a href="{{ route('site.home') }}">Ver todo el catálogo</a>
        </div>
    @endif
</section>
@endsection

@push('head')
<style>
    .catalog-shell{display:grid;gap:22px}.store-header{display:flex;align-items:flex-start;justify-content:space-between;gap:22px;padding:22px;border:1px solid #e5e9df;border-radius:16px;background:#fff}.eyebrow{font-size:11px;font-weight:850;letter-spacing:.13em}.store-header h1{margin:8px 0;font-size:clamp(27px,5vw,38px)}.store-description{max-width:600px;margin:7px 0;color:#697366;font-size:14px;line-height:1.6}
    .store-contacts{display:grid;gap:8px;min-width:190px}.store-contacts a{display:grid;gap:3px;padding:10px 12px;border:1px solid #e6eae2;border-radius:10px;color:#35402b;text-decoration:none}.store-contacts span{font-size:10px;color:#697366}.store-contacts strong{font-size:12px}
    .catalog-filters{display:grid;grid-template-columns:minmax(0,1fr) minmax(180px,230px) auto auto;gap:9px}.catalog-filters input,.catalog-filters select{width:100%;min-height:44px;padding:10px 12px;border:1px solid #dfe5d8;border-radius:10px;background:#fff;font:inherit;font-size:13px}.filter-button{min-height:44px;padding:0 18px;border:0;border-radius:10px;background:#20271f;color:#fff;font:inherit;font-size:12px;font-weight:800}.clear-filter{display:flex;align-items:center;padding:0 7px;color:#59634f;font-size:12px}
    .catalog-heading{display:flex;align-items:center;justify-content:space-between}.catalog-heading h2{margin:0;font-size:19px}.catalog-heading p{margin:4px 0 0}.small{font-size:12px}
    .product-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:15px}.product-card{display:flex;flex-direction:column;min-width:0;overflow:hidden;border:1px solid #e5e9df;border-radius:14px;background:#fff;color:#20271f;text-decoration:none;transition:transform .15s ease,border-color .15s ease}.product-card:hover{transform:translateY(-2px);border-color:#c9d3bd}.product-card>img,.product-image-placeholder{width:100%;aspect-ratio:4/3;object-fit:cover;background:#f1f4ed}.product-image-placeholder{display:grid;place-items:center;color:#98a28e;font-size:42px;font-weight:900}.product-card-body{display:flex;flex:1;flex-direction:column;gap:7px;padding:14px}.product-category{font-size:10px;font-weight:800;letter-spacing:.05em;color:#788469;text-transform:uppercase}.product-card h3{margin:0;font-size:15px;line-height:1.3}.product-card p{margin:0;color:#687264;font-size:12px;line-height:1.5}.card-prices{display:flex;gap:7px;flex-wrap:wrap;margin-top:4px}.card-prices span{font-size:12px;font-weight:850;color:#37432f}.view-product{display:flex;justify-content:space-between;align-items:center;margin-top:auto;padding-top:9px;color:#65714f;font-size:11px;font-weight:850}
    .empty-catalog{padding:44px 14px;text-align:center;border:1px dashed #dfe5d8;border-radius:15px;background:#fff}.empty-mark{display:grid;place-items:center;width:46px;height:46px;margin:0 auto 10px;border-radius:14px;background:#f1f4ed;color:#8a997c;font-size:22px;font-weight:900}.empty-catalog h3{margin:7px 0;font-size:17px}.empty-catalog p{font-size:13px}.empty-catalog a{display:inline-block;margin-top:8px;color:#596b3f;font-size:12px;font-weight:800}
    .pagination{margin-top:4px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
    @media(max-width:760px){.store-header{flex-direction:column}.store-contacts{grid-template-columns:repeat(2,minmax(0,1fr));width:100%}.catalog-filters{grid-template-columns:1fr 1fr}.search-field{grid-column:1/-1}.filter-button{width:100%}.product-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
    @media(max-width:480px){.wrap{width:min(100% - 22px,920px);padding:22px 0}.store-header{padding:17px}.store-contacts{grid-template-columns:1fr}.catalog-filters{grid-template-columns:1fr}.search-field{grid-column:auto}.product-grid{gap:9px}.product-card-body{padding:11px}.product-card h3{font-size:13px}.product-card p{font-size:11px}.card-prices span{font-size:11px}}
</style>
@endpush
