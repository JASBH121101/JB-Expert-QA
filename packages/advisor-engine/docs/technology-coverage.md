# Technology coverage model

The technology domain accepts a shared normalized product envelope while retaining category-specific attributes. The current taxonomy includes:

- Mobile: smartphone, tablet, smartwatch, fitness tracker.
- Computing: laptop, desktop, workstation.
- Gaming: console, handheld console.
- Displays: television, monitor, projector.
- Audio: headphones, earbuds, speaker.
- Imaging: camera.
- Networking and peripherals: router, network device, printer, accessory, other.

## Attribute groups

- Compute: processor/chipset, CPU model and cores, GPU, compute units, memory bandwidth.
- Memory and storage: RAM, storage capacity and type, memory type, SSD read/write rates, expandable storage.
- Display: panel/display technology, resolution, aspect ratio, diagonal size, refresh rate, brightness, HDR formats, variable refresh rate and touch.
- Power and thermal: battery capacity (mAh and Wh kept separate), measured battery life, charging power, fan count and power supply.
- Imaging and audio: camera system, megapixels, video resolution/FPS, camera features, audio codec, supported codecs, noise cancellation and speaker power.
- Connectivity and I/O: network bands/generation, Wi-Fi, Bluetooth, wireless standards, ports, SIM types and wireless range.
- Form, support and compatibility: weight, build material, software support, stylus/keyboard support, compatible devices/platforms, water resistance.
- Advisory scores: performance, camera, video, display, gaming, productivity, portability, thermal stability, efficiency, build quality, audio, connectivity, repairability and value.

Provider coverage now includes CoreInfo device records (exact-slug JSON), TechAPI exact-slug component/device records, and selected Wikidata facts. Current live smoke coverage includes TechAPI smartphone, laptop, monitor, SoC, GPU, CPU, tablet, smartwatch, PDA and identity-only device-catalog records, plus CoreInfo smartphone, laptop, tablet and smartwatch examples. This validates bounded endpoint availability and response parsing only, not the completeness or factual correctness of every device field. CoreInfo currently lists smartphones, tablets, smartwatches, laptops, earbuds, TVs, speakers, headphones, monitors, consoles/handhelds and smart rings; TechAPI exposes smartphone, tablet, watch, PDA, laptop, monitor, SoC, GPU, CPU and identity-only device-catalog resources. TechAPI mapping keeps single storage capacity (`storage_gb`) separate from phone storage options (`storage_options_gb`) and includes detail fields specific to processors, graphics cards, SoCs and monitors. Provider coverage is record- and field-dependent, not a guarantee that every product has a complete spec sheet.

The adapter validates field types and positive numeric metrics, freezes copied attributes, and normalizes explicit units. Battery mAh and Wh remain distinct; no conversion is attempted without voltage. Unknown category-specific attributes may still be retained as JSON-compatible data, but only allowlisted typed fields receive strict type validation. Evidence IDs remain field-scoped and must be resolved by the EvidenceStore before strict comparison.

## Coverage is not verification

A supported field means the local model can represent it; it does not mean a provider supplies it. Each imported value must carry its own source, timestamp, status and evidence ID. Provider coverage must be measured per category and field. Missing data must remain missing rather than being inferred. The current Wikidata provider is intentionally limited and does not provide a complete spec sheet.


## Nicaragua market data

SICSA's exact-product provider can represent locally listed NIO prices and explicit product stock, and preserves the + IVA tax label instead of silently adding or removing tax. It retains a sitewide delivery banner as policy context only; shipping cost and final taxes remain checkout-dependent. Product-level warranty extraction is not implemented.

Other identified Nicaragua retailers (Celulares Lainez Solution, EXTEL, JSLab and Nica Tech) are currently manual-review sources. Their catalogues cover additional mobile, audio, TV, console, laptop and accessory categories, but no stable public API/feed has yet been validated for automated ingestion. See [Nicaragua technology market coverage](./nicaragua-technology-market.md).

Local prices must not be ranked as all-in prices until tax treatment, product configuration, stock freshness, delivery and financing terms are normalized. A store's marketing statement about availability or warranty is not a product-specific claim unless the exact listing states it.
