# Live research providers and coverage

JBAE's provider adapters are read-only candidate collectors. Every returned claim is forced to `unconfirmed`, and explicit human approval is still required before staging. Staging does not promote a claim to verified.

## Provider coverage matrix

| Domain / category | Current source | Supported fields in this adapter | Coverage status |
|---|---|---|---|
| Fragrance | Scento | Identity, house, perfumer, year, concentration, family, subfamily, character, notes, accords, signature materials, seasons and wear hours | Live provider; bounded smoke test |
| Body mists | Open Beauty Facts | Name, brand, body-mist source tag, GTIN, ingredient-label text and package quantity when present | Body-mists-only category search plus optional exact GTIN lookup; candidates remain unconfirmed until identity review. |
| Technology categories | CoreInfo | Smartphones, laptops, tablets, smartwatches, headphones, earbuds, speakers, TVs, monitors and consoles/handhelds (record-dependent) | Live exact-slug JSON provider; bounded smoke test |
| Nicaragua technology retail | SICSA Nicaragua | Exact product identity, SKU, NIO price, explicit stock quantity/status and sitewide delivery notice | Live exact-product page provider; tax and shipping caveats retained |
| Smartphones / tablets | Wikidata | Identity, manufacturer, OS, device type, release date, display diagonal, RAM, storage, CPU and GPU | Partial and uneven |
| Laptops / desktops / workstations | Wikidata | Identity, manufacturer, OS, device type, release date, display diagonal, RAM, storage, CPU and GPU | Partial and uneven |
| Consoles / handhelds | Wikidata | Identity, manufacturer, OS where present, device type, release date, RAM, storage, CPU and GPU | Partial and uneven |
| TVs / monitors / projectors | Wikidata | Identity, manufacturer, device type, release date and display diagonal where present | Partial and sparse |
| Audio / cameras / peripherals / networking | Wikidata | Identity, manufacturer and device type where recorded | Sparse; no complete spec-sheet coverage |

A mapped field means the provider understands its Wikidata property. It does not promise that a given product item contains that property or that the claim has an external reference. Missing data stays missing.

## Scento Perfume API

- Domain: fragrance.
- Read-only HTTPS JSON endpoints; no key or registration; open CORS.
- The provider searches `GET /search?q=...&kind=perfume` and then reads bounded matching profiles from `GET /perfumes/{slug}`.
- The response includes the perfume note pyramid, house, family, concentration and additional profile fields.
- Source links point to the matching Scento perfume page. Each candidate includes Scento as a database source, not the original manufacturer URL.
- A bounded in-memory cache is used per provider instance; it is not a bulk download or a persistent mirror.
- Scento asks API users to cache responses, keep request volume reasonable and not copy the service wholesale to rebuild a competing database. Verify current terms before commercial distribution.

Documentation: https://www.scento.com/developers/perfume-api  
Terms: https://www.scento.com/terms-of-service#perfume-api

## Open Beauty Facts body-mist discovery

- Provider ID: open-beauty-facts-cosmetics; read-only, no API key and no payment dependency. Its JBAE intake scope is restricted to body mists only.
- Structured category search accepts only category:body-mists and uses GET /api/v2/search with categories_tags_en, page 1–3 and a caller-bounded page size (maximum 10). The adapter rejects pages above 3 and all other cosmetic/personal-care categories, including body sprays, deodorants, creams, lotions and makeup.
- The review-ready product_record field returns the GTIN, name, brand, raw categories and category tags, ingredient-label text, package quantity/unit and last-modified timestamp where present. It excludes images and does not assign a JBAE productType. Candidates must have a body-mists source tag and must not carry incompatible sun-care tags such as suncare; exact identity still requires review.
- Exact GTIN/EAN/UPC lookup through GET /api/v3/product/{code}.json is optional and only returns candidates that also carry a body-mists category tag. Users do not need to supply a barcode for category discovery.
- Open Beauty Facts documents API v2 as deprecated but still supported. Its search endpoint provides structured filters, not free-text product search. The documented search ceiling is 10 requests/minute/IP; the adapter defaults to a 6.5-second request interval. The API docs also ask API users to submit an API usage form.
- The live smoke checks only body-mists across pages 1–3, with at most 10 products per page (maximum 30 source rows), deduplicated by GTIN. It never fetches the full page count and is not a catalogue crawl. Perfumes continue to use fragrance-specific sources such as Scento and 10ML.
- A product tagged both body-mists and suncare is rejected as a false positive (regression example: Nivea refreshing mist suncare, GTIN 8850029003177). An empty candidate result means no eligible record with a product name and valid GTIN was returned by that bounded body-mists query; it is not proof of global absence. Source tags are community taxonomy, not independent product verification; exact item identity and product form require review. Body sprays and general cosmetics are outside the current OBF intake scope.
- The database is ODbL 1.0, individual contents are Database Contents License 1.0 and images use CC BY-SA 3.0. The adapter never requests image fields. Product records are community-contributed and can be incomplete or inaccurate; all claims remain unconfirmed.

API overview: https://openfoodfacts.github.io/documentation/docs/Product-Opener/api/  
Structured category search: https://openfoodfacts.github.io/documentation/docs/Product-Opener/v2/search/get-search/  
Open Beauty Facts: https://world.openbeautyfacts.org/

## 10ML Fragrance Index

- Provider ID: `10ml-fragrance-index`; free, read-only JSON REST API with no API key or account.
- Search endpoint: `GET https://mcp.10ml.com/api/v1/perfumes?q={query}&limit={limit}&format=detailed&locale=en`.
- Search results preserve the 10ML record ID, product name, house, profile fields and canonical profile URL. The adapter does not crawl the 10ML house index or mirror the full catalogue.
- The provider has a bounded in-memory response cache with a five-minute TTL and a one-second minimum request interval in the live smoke workflow. The TTL follows the API's published five-minute cache window.
- The live discovery smoke checks at most two profiles for each of 12 selected Middle Eastern / Arabic-fragrance houses. A match is counted only when the returned house exactly matches the queried house after case/diacritic normalization. Mismatches remain review-only; no candidates are imported automatically.
- Every candidate includes the visible credit `Data: 10ML Fragrance Index` and a link to the API page. The service's terms, updated 2026-11-07, allow free commercial use and caching with that visible credit. They ask clients to keep a polite pace and contact 10ML before heavy-volume use.
- 10ML is an editorial perfume-knowledge source, not an independently measured wear-test provider. Do not treat its longevity/projection fields or editorial alternatives as independent laboratory/user performance tests.
- It does not establish body-mist, body-spray, attar/oil or lotion coverage. Product types remain separated.

API: https://mcp.10ml.com/api  
Terms: https://mcp.10ml.com/terms  
Credit: https://10ml.com/perfume-api

## CoreInfo device JSON

- Provider ID: `coreinfo-device-catalog`; enabled in the default technology provider registry.
- Read-only exact-slug endpoint: `GET https://www.coreinfos.in/api/device/{slug}.json`.
- A device page is linked as the canonical source and CoreInfo is attributed as the database publisher.
- The adapter reads only the requested device record; it does not bulk-download or mirror the catalogue.
- Fields are mapped from direct record properties and labelled specification groups; absent fields remain absent.
- The price field preserves the original published amount and currency. It never substitutes the site's converted currency estimate or claims to be a Nicaragua retailer quote.
- The adapter requires an exact slug and checks a returned slug when present; it does not expose broad catalogue search or guess model slugs.
- The site states that reuse is allowed with attribution and that listed prices can be indicative; every claim still remains unconfirmed in JBAE until independently reviewed.

CoreInfo publishes device records across multiple consumer-electronics categories. Its catalogue is not a Nicaragua retailer feed, and its prices are not live local availability or checkout prices. See https://www.coreinfos.in/ and https://www.coreinfos.in/methodology.


## SICSA Nicaragua local retailer page

- Provider ID: sicsa-nicaragua-retail; enabled in the default technology provider registry.
- Read-only exact-product lookup: GET https://sicsa.com.ni/producto/{slug}/. Queries must be a validated product slug; the adapter does not crawl the catalogue or perform broad keyword search.
- Extracted fields: product name, SKU, listed price, explicit availability/stock, and a sitewide delivery notice when present.
- Local prices are preserved as NIO. If the product price is explicitly labelled + IVA, the value is marked taxIncluded: false; otherwise tax inclusion remains unknown. JBAE does not calculate taxes or a landed price.
- Stock is retained only when an explicit quantity/status or structured availability value is present. It is a timestamped observation, not a reservation or guarantee.
- The delivery banner is kept as a sitewide policy notice, not a product-specific shipping price or promise. The product page itself says delivery cost and applicable taxes are confirmed at checkout.
- Warranty terms are not yet mapped. Do not infer a warranty period from the store name or product category.
- The provider caches an exact page briefly, paces requests, uses bounded GET requests/timeouts, and keeps every result unconfirmed pending review of exact SKU/configuration.

Initial local market reconnaissance and other stores that remain manual-review sources are listed in [Nicaragua technology market coverage](./nicaragua-technology-market.md).

## Wikidata

The provider uses the public MediaWiki Action API and a bounded batch entity lookup. It resolves search results and fetches up to 20 entity records in one `wbgetentities` request rather than opening one network connection per item. It sends a meaningful `User-Agent` in Node or `Api-User-Agent` from browser/WebView JavaScript, uses `maxlag=5`, paces requests, uses a short-lived in-memory cache, applies a timeout and surfaces `Retry-After` when rate-limited.

| JBAE field | Wikidata property | Type | Handling |
|---|---|---|---|
| manufacturer | P176 | Entity | Returns item ID, URL and English label when available |
| operating_system | P306 | Entity | Same |
| device_type | P31 | Entity | Same |
| release_date / launch_date | P577 | Time | Keeps calendar date |
| display_size | P13749 | Quantity | Keeps amount and unit URI |
| ram / ram_capacity | P13525 | Quantity | Keeps amount and unit URI; RAM uses data-size units |
| storage / storage_capacity | P2928 | Quantity | Keeps amount and unit URI |
| cpu / processor | P880 | Entity | Returns item ID, URL and English label |
| gpu | P2560 | Entity | Same |

Deprecated statements and non-value snaks are excluded. Preferred-rank statements are selected ahead of normal-rank statements; where no preferred statements exist, normal-rank statements are retained. Quantities are not converted here. In particular, a RAM/storage quantity is not assumed to be a GB decimal value without reading its unit URI.

Not currently mapped: battery capacity, camera resolution, refresh rate, brightness, charging power, wireless bands and market price. Do not substitute a superficially similar property. The current provider does not query SPARQL or crawl the catalogue.

Wikidata structured data is CC0. API users must follow its data access and rate-limit guidance, including meaningful user-agent identification where the runtime permits it, low concurrency and `Retry-After`. The adapter keeps requests sequential and batched.

Documentation:
- https://www.wikidata.org/wiki/Wikidata:Data_access
- https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits
- RAM capacity P13525: https://www.wikidata.org/wiki/Property:P13525
- Storage capacity P2928: https://www.wikidata.org/wiki/Property:P2928
- CPU P880: https://www.wikidata.org/wiki/Property:P880
- GPU P2560: https://www.wikidata.org/wiki/Property:P2560

## Additional technology sources assessed

- **CoreInfo:** enabled in the default technology provider registry and smoke-tested through exact-slug JSON lookups for a Huawei Nova 16 SE smartphone and an HP 15-fc0500AU laptop. The live smoke matrix is being expanded to include tablets and smartwatches. This verifies bounded endpoint access and response parsing only; it is not a full catalogue quality audit or a certification of every mapped field. Prices may be in INR and FX conversions are estimates; never treat those as Nicaragua retail prices.
- **TechSpecs API:** broad coverage across phones, tablets, watches, desktops, laptops, displays and GPUs, but it requires a token and says commercial caching/storage requires a separate license. It is not enabled by default.
- **Specspool:** covers phones, tablets and watches, but its free tier is non-commercial and its paid tier bills per unit. It is not enabled by default.
- **Techfleet Atlas:** advertises a free monthly request allowance and CC BY attribution, but requires a key and needs independent runtime, terms and provenance validation before integration.

No paid provider is mandatory. A provider requiring paid access, commercial licensing, or user-held API credentials remains opt-in and cannot be activated without an explicit decision.

## TechAPI static specifications (optional; not enabled by default)

TechAPI serves static JSON records without an API key. Its current API collections include smartphones, tablets, watches, PDAs, laptops, monitors, SoCs, discrete GPUs, CPUs and an identity-only device catalog. JBAE integrates exact-slug detail lookups only; it does not fetch or mirror category-wide index files. The adapter maps category-specific CPU/GPU/SoC/monitor fields and keeps a single `storage_gb` capacity distinct from the smartphone `storage_options_gb` list.

Use `createTechApiResearchProvider()` and query with an exact `resource:slug`, for example `smartphones:iphone-18-pro-max`. Supported resources are `smartphones`, `tablets`, `watches`, `pdas`, `laptops`, `monitors`, `socs`, `gpus`, `cpus` and `device-catalog`. The device catalog is identity-only: its missing specifications must remain missing and must not be inferred. Mapped fields include identity, manufacturer, release date, reference MSRP in USD, RAM, storage capacity/options, CPU/SoC, GPU, display size/resolution/aspect ratio/refresh, camera arrays, battery, wired/wireless charging, weight, dimensions, IP rating, OS and connectivity where present in the record. Schema variants include laptop cpu_name, gpu_name, storage_gb, and monitor size_inch/resolution fields.

Each candidate preserves up to ten canonical `source_urls` from the record. Its own `verified` flag is recorded only as upstream metadata; JBAE forces the evidence status to `unconfirmed` and requires human review. Exact model/variant identity still needs checking.

**License warning:** TechAPI's data is CC BY-SA 4.0, not MIT. Reuse requires attribution ("Data from TechAPI") and share-alike compliance for adaptations/redistributions. The code adapter is optional and the provider is excluded from the default registry. It is not enabled for commercial distribution until the product's data licensing plan is reviewed. Do not copy or redistribute its full catalogue. See https://github.com/GetTechAPI/TechAPI and https://creativecommons.org/licenses/by-sa/4.0/.

## Trust and limitations

Provider confidence values are input heuristics, not calibrated probabilities and not verification. A recent retrieval does not prove the product identity matches the intended regional SKU, that the claim is complete, or that a retailer listing applies in Nicaragua. Claims should be cross-checked against manufacturer documentation or independent tests before verification.

The live smoke workflow performs a bounded Scento Layton lookup; Wikidata Steam Deck probes; exact-slug TechAPI checks for a smartphone, laptop, monitor, SoC, GPU, CPU, tablet, smartwatch, PDA and identity-only device-catalog entry; and CoreInfo checks for a smartphone, laptop, two tablets and a smartwatch. The latest successful smoke run passed all ten TechAPI samples and all five CoreInfo category samples. Wikidata may be deferred when its upstream service reports `maxlag`; a deferred probe is not counted as a pass. These checks validate bounded endpoint access and response parsing, not overall catalogue completeness, factual accuracy, or Nicaragua-local prices. Results always remain unconfirmed candidates.

If the network is unavailable, provider calls fail explicitly; local catalog search, comparison and recommendations remain usable from persisted knowledge.
