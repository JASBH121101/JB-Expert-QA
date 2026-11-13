@extends('layouts.app')

@section('title', $product->name.' · '.$settings->business_name)

@section('content')
<section class="detail-shell">
    <a class="back-link" href="{{ route('site.home') }}">← Volver al catálogo</a>
    <article class="detail-card">
        <div class="detail-media">
            @if ($photosEnabled && $product->image_path)
                <img src="{{ asset('storage/'.$product->image_path) }}" alt="{{ $product->name }}">
            @else
                <div class="detail-placeholder" aria-hidden="true">{{ mb_substr($product->name, 0, 1) }}</div>
            @endif
        </div>
        <div class="detail-content">
            @if ($product->category)
                <span class="product-category">{{ $product->category->name }}</span>
            @endif
            <h1>{{ $product->name }}</h1>
            @if ($product->description !== '')
                <p class="detail-description">{{ $product->description }}</p>
            @endif

            @if ($product->prices->isNotEmpty())
                <div class="detail-prices">
                    @foreach ($product->prices as $price)
                        <div><span>{{ $price->currency_code }}</span><strong>{{ number_format((float) $price->amount, 2) }}</strong></div>
                    @endforeach
                </div>
            @endif

            @if ($product->fieldValues->isNotEmpty())
                <div class="specifications">
                    <h2>Detalles del producto</h2>
                    @foreach ($product->fieldValues as $fieldValue)
                        @php($value = data_get($fieldValue->value, 'value'))
                        @php($unitLabel = $fieldValue->definition->unitLabel())
                        @if ($value !== null && $value !== '')
                            <div class="specification-row">
                                <span>{{ $fieldValue->definition->label }}</span>
                                <strong>
                                    @if (is_bool($value))
                                        {{ $value ? 'Sí' : 'No' }}
                                    @elseif (is_array($value))
                                        {{ implode(', ', $value) }}
                                    @else
                                        {{ $value }}{{ $unitLabel ? ' '.$unitLabel : '' }}
                                    @endif
                                </strong>
                            </div>
                        @endif
                    @endforeach
                </div>
            @endif

            @if ($contacts->isNotEmpty())
                <div class="contact-actions">
                    @foreach ($contacts as $contact)
                        <a href="https://wa.me/{{ preg_replace('/\D+/', '', $contact->phone) }}" target="_blank" rel="noopener noreferrer">
                            Consultar por WhatsApp · {{ $contact->formatted_phone }}
                        </a>
                    @endforeach
                </div>
            @endif
        </div>
    </article>
</section>
@endsection

@push('head')
<style>
    .detail-shell{display:grid;gap:14px}.back-link{color:#5d6b4e;font-size:12px;font-weight:800;text-decoration:none}.detail-card{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:24px;padding:22px;border:1px solid #e5e9df;border-radius:16px;background:#fff}.detail-media img,.detail-placeholder{width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:12px;background:#f1f4ed}.detail-placeholder{display:grid;place-items:center;color:#98a28e;font-size:70px;font-weight:900}.detail-content{min-width:0}.product-category{font-size:10px;font-weight:850;letter-spacing:.06em;color:#788469;text-transform:uppercase}.detail-content h1{margin:8px 0;font-size:clamp(25px,4vw,36px)}.detail-description{color:#687264;font-size:14px;line-height:1.7;white-space:pre-wrap}.detail-prices{display:flex;gap:9px;flex-wrap:wrap;margin:18px 0}.detail-prices div{display:grid;gap:2px;min-width:110px;padding:12px;border:1px solid #e6eae2;border-radius:10px}.detail-prices span{color:#687264;font-size:10px;font-weight:800}.detail-prices strong{font-size:17px}
    .specifications{margin-top:18px;padding-top:15px;border-top:1px solid #edf0e9}.specifications h2{font-size:15px;margin:0 0 8px}.specification-row{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid #f0f2ed;font-size:12px}.specification-row span{color:#687264}.specification-row strong{text-align:right}.contact-actions{display:grid;gap:8px;margin-top:20px}.contact-actions a{padding:12px;border-radius:10px;background:#eff4e9;color:#415233;text-decoration:none;text-align:center;font-size:12px;font-weight:850}
    @media(max-width:700px){.detail-card{grid-template-columns:1fr;padding:15px;gap:17px}.detail-media img,.detail-placeholder{aspect-ratio:16/10}.specification-row{gap:8px}}
</style>
@endpush
