# Nicaragua technology market coverage

Reconnaissance date: 2026-11-07. This document distinguishes sources that have a tested automated adapter from retailers that are currently suitable only for manual review. A public website listing a product does not by itself establish authenticity, current stock, final price or warranty coverage.

## Automated source

| Retailer | Public evidence observed | Current integration |
|---|---|---|
| SICSA Nicaragua | Server-rendered product catalogue, product-specific SKU and price, explicit stock quantity on some product pages, and published delivery banner | Exact-product read-only adapter, tested for one laptop SKU. No catalogue crawler or keyword search. |

The SICSA catalogue exposes laptops, monitors, consoles, audio/headphones, printers, cameras, projectors, televisions, tablets, phones, processors, graphics cards, networking and accessories. The tested product page displayed a NIO price marked + IVA and an explicit available quantity. The product page also states that applicable taxes and delivery options/cost are confirmed at checkout.

Relevant pages:
- [SICSA online store](https://sicsa.com.ni/tienda/)
- [SICSA laptops category](https://sicsa.com.ni/categoria-producto/laptops/)

### SICSA fields and limitations

- name, sku, price, availability, and shipping_policy are mapped when the product page explicitly publishes them.
- price is preserved in NIO. Where + IVA is visible, the normalized value is marked tax-exclusive; tax rate and final checkout total are not calculated.
- availability is returned only when an explicit quantity/status or structured availability value is present. It must be refreshed before purchase.
- shipping_policy records a sitewide delivery banner only. It is not a product-specific shipping quote and does not calculate eligibility.
- Warranty is not extracted or inferred. The current adapter does not make claims about warranty duration.

## Manual-review sources

| Retailer / source | Public catalogue scope observed | Current status |
|---|---|---|
| [Celulares Lainez Solution](https://celulareslainez.com/catalogo/) | Smartphones, accessories, tablets, laptops/monitors, consoles, TVs and portable audio; catalogue advertises prices in USD and córdobas, shipping across Nicaragua and warranty on products | Manual review. Product list is client-rendered and no stable feed/API has been validated. |
| [EXTEL Nicaragua](https://www.extel.com.ni/) | Mobile devices, computing, entertainment, CCTV, connectivity, printing/accessories and network infrastructure; selected products and quotation flow | Manual review. Product-specific pricing/stock must be confirmed from the listing or sales team. |
| [JSLab](https://jslabni.com/) | Smartphones, laptops/computers, consoles, tablets, accessories and Smart TVs; site describes delivery to Managua and departments | Manual review. No stable public price/stock feed has been validated. |
| [Nica Tech](https://nicatechpro.com/) | Laptops, accessories and selected consumer technology products | Manual review. Catalogue depth and update cadence have not been independently validated. |
| [Galerías Santo Domingo technology directory](https://www.galerias.com.ni/categorias-tiendas/tecnologia/) | Directory of stores including mobile, PC, accessories and electronics retailers | Discovery source only; not a retailer product feed. |

## Comparison rules for the Nicaragua market

1. Match the exact manufacturer model, storage/RAM configuration, regional SKU and condition before comparing listings.
2. Keep local retail price separate from international MSRP or database estimates.
3. Do not compare an amount marked + IVA with a tax-inclusive amount until the tax treatment is normalized.
4. Keep shipping, payment fees, financing cost and delivery time separate from the product price.
5. Treat a stock quantity as time-sensitive evidence. Never promote a sitewide statement like “available” into a claim about a specific SKU.
6. Record warranty only from a product-specific policy, invoice condition or explicit retailer/manufacturer warranty statement.
7. All provider imports remain unconfirmed candidates and require human approval before entering the trusted knowledge store.

## Next coverage gaps

- Validate more live SICSA product pages across monitors, TVs, audio, components and networking.
- Find a stable, permitted catalogue endpoint for Lainez and EXTEL before building automated adapters.
- Add product-specific warranty and delivery extraction only after the policy pages and their applicability are tested.
- Compare the same exact SKU across at least two local stores to validate identity matching, currency, taxes and freshness end-to-end.
