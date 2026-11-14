# Domain Adapters

## Technology Core

`normalizeTechnologyProduct()` supports smartphones, tablets, laptops, desktops, workstations, consoles, handheld consoles, televisions, monitors, projectors, smartwatches, fitness trackers, headphones, earbuds, speakers, cameras, routers, network devices, printers, accessories and other explicitly typed devices.

The adapter normalizes explicit unit-bearing values to canonical fields such as `ramGB`, `storageGB`, `displaySizeInches`, `weightGrams`, `batteryCapacityMah` and `batteryCapacityWh`. Storage TB is converted using 1 TB = 1024 GB. Display centimeters are converted to inches. Weight kilograms are converted to grams. Battery capacity requires an explicit mAh or Wh unit and remains in a separate canonical field; the adapter never compares unlike battery units.

Price fields stay separate as `priceUSD` and `priceNIO`. Currency conversion is not performed implicitly. Quality scores are accepted only on the 0–100 scale and must be supplied by a measurement/research layer; raw megapixels are not treated as camera quality. The taxonomy is broader than the current live provider coverage: category support in the model does not imply that every category has a complete source or spec sheet.

## Fragrance Core

`normalizeFragranceProduct()` accepts perfume, body mist, body spray, attar/oil and body lotion as separate product types. Concentration (Extrait, Parfum, EDP, EDT, EDC) is an independent perfume attribute; body products cannot silently inherit an EDP/EDT classification.

Longevity intervals are preserved as `longevityMinHours` and `longevityMaxHours`; the adapter does not fabricate a midpoint. Projection, longevity and sillage remain separate measured/reported attributes, not deductions from concentration or notes.

## Shared policy

Both adapters preserve product IDs and evidence IDs, validate supported domain boundaries, normalize only explicit units, and avoid filling missing values. They are deterministic and usable offline.

Both adapters validate evidence-ID containers before preserving them. When category metadata is available, downstream comparison uses it to prevent cross-type comparisons.
