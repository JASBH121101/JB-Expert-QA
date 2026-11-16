# NEXORA profiles in JB Threat Lab

## Independent certification targets

Threat Lab validates the two NEXORA deliverables as separate targets. A pass in one target never certifies the other.

| Target | Pinned source | Product boundary |
| --- | --- | --- |
| \`nexora-configurable-catalog\` | \`JASBH121101/Nexora\` commit \`63f0608d0b00d633b1ad147ab2318fc099b8a99e\`, branch \`feature/nexora-configurable-catalog\` (PR #5) | Frontend demonstration only: HTML/CSS/JS, editable setup/template contract, browser localStorage and responsive admin. It is not real authentication, server persistence, or secure image upload. |
| \`nexora-site-engine\` | \`JASBH121101/Nexora\` commit \`3f68126ecc58b088c071007c5116bc95426d159b\`, branch \`docs/nexora-approved-upgrades-2026-11\` | Laravel 13 / PHP 8.3 application with independent installation, public catalogue, permissions, exports and owner-only domain management. |

The Catalog pin is the repaired head of `feature/nexora-configurable-catalog` after PR #12 was merged. That fix hardens the browser demo storage contract and adds four focused regression cases; this certification applies to that exact proposed prototype, not to the repository's \`main\` branch. The Site Engine pin is the dedicated upgrades branch, including the merged Site Engine and domain improvements. Updating either pin requires an intentional Threat Lab change and a new CI run.

## Scenario matrix

### NEXORA Configurable Catalog — six prototype tiers

1. Basic: sample business/product data integrity.
2. Intermediate: four-step setup contract, templates, dynamic fields, measurement dimensions, optional photos and demo-only setup boundary.
3. Advanced: localStorage shape validation, copy-on-write product persistence, settings record validation, HTML escaping and WhatsApp link normalization.
4. Expert: responsive admin constraints and overflow containment.
5. Extreme: all demo test files in one regression run, including malformed-but-valid JSON, non-array writes and multi-business storage-isolation regressions.
6. Superextreme: full demo suite plus explicit checks that the prototype does not collect real passwords and remains browser-local.

### NEXORA Site Engine — six Laravel tiers

1. Basic: atomic setup creates one authenticated owner and seeds the selected template.
2. Intermediate: published-only catalogue, product detail, private-field exclusion and sitemap behavior.
3. Advanced: role permissions, overrides, unknown identifiers and inactive-user denial.
4. Expert: export field visibility and independent create/download authorization.
5. Extreme: site-domain owner boundary, DNS TXT/TLS verification through deterministic fake adapters, and published-host enforcement.
6. Superextreme: complete Laravel Feature and Unit suite against the PHPUnit in-memory SQLite database.

## Execution and safety

The dedicated workflow checks out both source pins and runs the real product tests:
- The catalog profile runs the prototype's Node test files.
- The Site Engine profile runs PHPUnit against its actual Laravel application. Its domain tests inject deterministic DNS/TLS fakes; they do not query public DNS, connect to port 443, alter domain records, configure a VPS, or issue certificates.
- A separate PostgreSQL 16 run verifies the full Site Engine suite on the supported database engine.
- No production database, customer data, live domain, deployment, paid service or external provider is used.

The profile integration test is intentionally skipped by generic Threat Lab CI when its two pinned checkouts are not supplied. The dedicated \`NEXORA Threat Lab Profiles\` workflow supplies both checkouts, sets NEXORA_PROFILE_REQUIRED=true and verifies the actual Git HEAD against both declared source pins; all six tiers in each target to pass with no adapter skips.

## Scope of claims

A six-tier \`ready\` result means all six registered scenarios for that pinned source passed. It does not establish that a product is free of unknown defects or certify capabilities outside these scenarios. In particular, the Configurable Catalog remains a frontend prototype; the test suite does not upgrade it into the Laravel Site Engine.


## Catalog storage hardening regression set

The pinned Catalog source includes the NEXORA demo storage fix merged through PR #12:
- Invalid but parseable localStorage product values (for example `null`, primitive values, or objects) fall back to a detached copy of the demo catalogue.
- Product writes reject non-array payloads and preserve the last valid stored catalogue.
- Settings reads ignore arrays and primitive records; settings writes accept only plain object-shaped values.
- Repeated bounded round-trips across two business IDs verify there is no cross-business data leakage and no mutation through detached reads.

These are browser-demo reliability tests only. They do not imply server-side persistence, authentication, or production data protection.
