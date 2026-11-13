@extends('layouts.app')

@section('title', 'Productos · NEXORA')

@section('content')
<section class="panel">
    <div class="page-head">
        <div>
            <p class="muted eyebrow">GESTIÓN DE CATÁLOGO</p>
            <h1>Productos</h1>
            <p class="muted">{{ $products->total() }} productos registrados</p>
        </div>
        <div class="page-actions">
            <a class="secondary-button link" href="{{ route('admin.home') }}">Volver</a>
            @if ($canManage)
                <a class="primary-button link" href="{{ route('admin.products.create') }}">Nuevo producto</a>
            @endif
        </div>
    </div>

    @if (session('status'))
        <div class="notice success" role="status">{{ session('status') }}</div>
    @endif

    @forelse ($products as $product)
        <article class="product-row">
            @if ($product->image_path)
                <img class="product-thumb" src="{{ asset('storage/'.$product->image_path) }}" alt="{{ $product->name }}" loading="lazy">
            @else
                <div class="product-thumb placeholder" aria-hidden="true">N</div>
            @endif
            <div class="product-main">
                <div class="product-title">
                    <strong>{{ $product->name }}</strong>
                    <span class="state {{ $product->status }}">{{ $product->status === 'published' ? 'Publicado' : 'Borrador' }}</span>
                </div>
                <p class="muted small">{{ $product->category?->name ?? 'Sin categoría' }}</p>
                <div class="price-list">
                    @forelse ($product->prices as $price)
                        <span>{{ $price->currency_code }} {{ number_format((float) $price->amount, 2) }}</span>
                    @empty
                        <span class="muted">Sin precio</span>
                    @endforelse
                </div>
            </div>
            @if ($canManage)
                <div class="product-actions">
                    <a class="secondary-button link compact" href="{{ route('admin.products.edit', $product) }}">Editar</a>
                    <form method="POST" action="{{ route('admin.products.destroy', $product) }}" onsubmit="return confirm('¿Eliminar este producto? Esta acción no se puede deshacer.')">
                        @csrf
                        @method('DELETE')
                        <button class="secondary-button compact danger" type="submit">Eliminar</button>
                    </form>
                </div>
            @endif
        </article>
    @empty
        <div class="empty-state">
            <strong>Tu catálogo todavía está vacío.</strong>
            <p class="muted">Agrega el primer producto para comenzar.</p>
            @if ($canManage)
                <a class="primary-button link" href="{{ route('admin.products.create') }}">Crear primer producto</a>
            @endif
        </div>
    @endforelse

    <div class="pagination">{{ $products->links() }}</div>
</section>
@endsection

@push('head')
<style>
    .page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px}.eyebrow{font-size:11px;font-weight:800;letter-spacing:.12em}.page-head h1{margin:8px 0}.page-actions{display:flex;gap:8px;flex-wrap:wrap}
    .link{display:inline-flex;align-items:center;justify-content:center;text-decoration:none}.primary-button,.secondary-button{min-height:38px;padding:0 13px;border:0;border-radius:9px;font:inherit;font-size:12px;font-weight:800;cursor:pointer}.primary-button{background:#20271f;color:#fff}.secondary-button{background:#eef1e9;color:#35402b}.compact{min-height:32px;padding:0 10px}.danger{background:#fff0ee;color:#963b32}
    .product-row{display:flex;align-items:center;gap:13px;padding:14px 0;border-bottom:1px solid #edf0e9}.product-thumb{width:62px;height:62px;flex:none;object-fit:cover;border-radius:10px;background:#f2f4ee}.placeholder{display:grid;place-items:center;color:#9aa58e;font-weight:900}.product-main{flex:1;min-width:0}.product-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.product-title strong{font-size:14px}.small{font-size:12px}.product-main p{margin:5px 0}.state{padding:4px 8px;border-radius:20px;background:#fff4dd;color:#805c19;font-size:10px;font-weight:800}.state.published{background:#edf7ed;color:#286536}.price-list{display:flex;gap:7px;flex-wrap:wrap}.price-list span{font-size:11px;font-weight:750;color:#38432f}.product-actions{display:flex;gap:7px;flex:none}.product-actions form{margin:0}.empty-state{padding:38px 12px;text-align:center}.empty-state p{font-size:13px}.empty-state .link{margin-top:8px}.pagination{margin-top:16px}
    .notice{margin:12px 0;padding:12px 14px;border-radius:10px;background:#edf7ed;color:#286536;font-size:13px}
    @media(max-width:560px){.page-head{flex-direction:column}.page-actions{width:100%}.page-actions .link{flex:1}.product-row{align-items:flex-start;flex-wrap:wrap}.product-main{min-width:calc(100% - 78px)}.product-actions{width:100%;padding-left:75px}.product-actions .link,.product-actions form{flex:1}.product-actions button{width:100%}}
</style>
@endpush
