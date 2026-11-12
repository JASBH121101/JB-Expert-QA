# Comparación exacta entre comercios de Nicaragua

## Propósito

`compareNicaraguaRetailerOffers()` consulta URLs exactas de producto en RadioShack, La Curacao y SIMAN. No busca categorías ni rastrea catálogos. Cada adaptador conserva sus restricciones de host, ruta, lectura GET, caché y timeout.

## Regla de identidad

El motor compara primero los identificadores universales (GTIN/EAN/UPC) y los identificadores de fabricante (MPN), y valida RAM/almacenamiento detectables en el nombre del producto. Un SKU interno de tienda no se trata como código universal, aunque una página lo etiquete incorrectamente como UPC si el mismo valor también aparece como SKU.

- `exact_variant`: todas las tiendas solicitadas coinciden en la misma variante.
- `partial_exact_variant`: al menos dos tiendas coinciden exactamente, pero una o más tiendas quedaron sin identidad suficiente; solo se puede comparar ese subconjunto.
- `review_required`: faltan identificadores comunes o hay atributos de variante insuficientes/conflictivos.
- `mismatch`: hay un conflicto explícito entre identificadores universales o identificadores de fabricante.
- `incomplete`: al menos una tienda no entregó identidad utilizable.

Los precios se ordenan únicamente dentro del conjunto con identidad exacta demostrada, cuando cada tienda de ese conjunto publica un precio y todas usan la misma moneda y el mismo estado de inclusión de impuestos. Si falta una tienda, el resultado se marca `partial_comparable` y no declara ganador global. No se convierten monedas ni se estiman IVA, envío, financiación o cargos de checkout.

## Resultado y seguridad

Cada oferta conserva URL, valores publicados, fuentes y marcas de tiempo por campo. Los datos continúan como candidatos no confirmados; la comparación no escribe en la base de conocimiento ni verifica datos de forma automática. La disponibilidad debe confirmarse con la tienda antes de comprar.

## Primer caso de smoke

Samsung Galaxy A17 4 GB RAM / 128 GB, gris:

- RadioShack: `https://www.radioshackla.com/nicaragua/celular-samsung-a17-128-gb-6-7-470890800019-gris/p`
- La Curacao: `https://www.lacuracaonline.com/nicaragua/celular-samsung-a17-128-gb-6-7-470890800019-gris/p`
- SIMAN: `https://ni.siman.com/celular-samsung-galaxy-a17-128gb-4gb-ram-pantalla-6-7---17-02-cm--octa-core-camara-trasera-triple-50mp-/p`

Las URLs son muestras concretas; una respuesta bloqueada, ausente o desactualizada se reporta como incompleta/diferida. No se da por supuesto que un slug funcione en el storefront de otro país.

## First live comparison observation

Observed at **2026-11-08 01:47:02 UTC** by provider smoke run
[42435612461](https://github.com/JASBH121101/TECH-PERFUMS-ADVISE/actions/runs/42435612461):

| Retailer | Identity evidence | Displayed price | Stock | Comparison treatment |
|---|---|---:|---|---|
| RadioShack Nicaragua | GTIN `8806097667995`; MPN `SMA175FZAFGTO`; SKU `470890800019` | C$8,999.00 | In stock | Included |
| La Curacao Nicaragua | GTIN `8806097667995`; MPN `SMA175FZAFGTO`; SKU `470890800019` | C$8,999.00 | In stock | Included |
| Almacenes SIMAN Nicaragua | Public variants endpoint: grey 4 GB / 128 GB variant, internal SKU `8717841`; no GTIN or MPN returned | C$7,999.13 | 3 units reported for grey SKU | Excluded from price ranking pending manufacturer-identity proof |

The engine returned `partial_exact_variant` and `partial_comparable`: RadioShack and La Curacao matched on the same Samsung Galaxy A17 4 GB / 128 GB grey variant, while SIMAN remained `identity_incomplete`. The matching subset had a displayed-price tie at C$8,999.00; there is no winner between those two stores in this observation.

SIMAN's lower displayed price is **not** evidence of a lower price for the same exact variant until a stable manufacturer identifier or equivalent SKU-level identity is verified. Tax inclusion was not published consistently as an explicit fact, so these are displayed-price observations only—not final tax-inclusive or delivered totals. Stock and prices are snapshots and must be rechecked before purchase.

A second, bounded live inspection at **2026-11-08 03:29 UTC** (smoke run [42442837682](https://github.com/JASBH121101/TECH-PERFUMS-ADVISE/actions/runs/42442837682)) queried VTEX's documented public product-variations endpoint for SIMAN product ID `8717842`. It exposed three SKU variants: Azul (`8717840`), Gris (`8717841`) and Negro (`8717842`), each with 128 GB capacity. The grey SKU reported availability of 3 units and a best price corresponding to C$7,999.13; the public product-search response reported the same displayed price for all three variants. The diagnostic returned an internal SIMAN SKU ID, not a manufacturer GTIN/MPN. The indexed detail page's selected blue variant shows model `SM-A175FZKFGTO`, while RadioShack/La Curacao's grey listing shows MPN `SMA175FZAFGTO`; the blue model must not be applied to SIMAN's grey SKU. SIMAN's grey variant is now identified as a candidate at SKU level, but the A17 three-store comparison remains blocked until a manufacturer identifier or equivalent independently verifiable model evidence is available for that exact grey SKU.

## Production adapter verification

On **2026-11-08 03:41 UTC**, live provider smoke run [42443703944](https://github.com/JASBH121101/TECH-PERFUMS-ADVISE/actions/runs/42443703944) exercised the production `createSimanResearchProvider()` adapter's `variants` field. It returned SIMAN's exact grey SKU `8717841` (128 GB), displayed price C$7,999.13, and an explicit in-stock quantity of 3. The result also explicitly retained `manufacturerIdentifiers.gtin = null` and `manufacturerIdentifiers.mpn = null`. This validates SKU-level variant retrieval; it does **not** establish manufacturer-identifier equivalence with RadioShack or La Curacao. The exact A17 comparison therefore remains `partial_exact_variant` / `partial_comparable`, with SIMAN excluded from ranking and no overall market winner.

The production adapter makes two bounded GET requests: the exact product-text-link Search API and the documented public `/api/catalog_system/pub/products/variations/{productId}` endpoint. Both requests are restricted to exact allowlisted paths on `https://ni.siman.com`; redirects to other paths are rejected. No private Catalog endpoints, credentials, writes, or checkout actions are used. The returned evidence retains both API URLs.

Exact source pages:
- RadioShack: https://www.radioshackla.com/nicaragua/celular-samsung-a17-128-gb-6-7-470890800019-gris/p
- La Curacao: https://www.lacuracaonline.com/nicaragua/celular-samsung-a17-128-gb-6-7-470890800019-gris/p
- SIMAN: https://ni.siman.com/celular-samsung-galaxy-a17-128gb-4gb-ram-pantalla-6-7---17-02-cm--octa-core-camara-trasera-triple-50mp-/p


## El Gallo Más Gallo — live indexed evidence and adapter limitation

A bounded public-web inspection on **2026-11-08** found the exact Nicaragua product detail for Samsung Galaxy A17, 4 GB RAM / 128 GB, grey:

- Product URL: https://www.elgallomasgallo.com.ni/celular-4g-samsung-galaxy-a17-gris-4gb-ram-128gb-199205
- Published retailer SKU: `199205`
- Product identity: Samsung Galaxy A17, 4 GB RAM, 128 GB, grey
- Displayed special price in the indexed detail: C$7,999
- Published availability label: Disponible

The retailer's indexed product detail supports these values as a public-web observation, but it does not provide a manufacturer GTIN/MPN in the inspected text. A direct page retrieval through the bounded provider smoke environment returned `fetch failed`; a separate page-open inspection returned a JavaScript-required interstitial rather than the product document. Therefore the production adapter remains **DEFERRED** for live automated extraction. Do not copy the indexed price or availability into a production adapter result, do not infer manufacturer identity from the retailer SKU, and do not rank this offer against another store until the adapter can retrieve and parse the exact product page through a stable, permitted method.

This distinction is intentional: the product listing is publicly discoverable, while automated retrieval by the current adapter is not yet verified. The adapter must remain read-only and restricted to exact product URLs; no category crawling, private endpoints, authentication bypass, or checkout actions are permitted.
