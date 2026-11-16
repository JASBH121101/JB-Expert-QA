# NEXORA profiles in JB Threat Lab

## Independent certification targets

Threat Lab validates the two NEXORA deliverables as separate targets. A pass in one target never certifies the other.

| Target | Pinned source | Product boundary |
| --- | --- | --- |
| \`nexora-configurable-catalog\` | \`JASBH121101/Nexora\` commit \`88c4876c9678b93dadde55f79fe9d04890900741\`, branch \`feature/nexora-configurable-catalog\` (PR #5) | Frontend demonstration only: HTML/CSS/JS, editable setup/template contract, browser localStorage and responsive admin. It is not real authentication, server persistence, or secure image upload. |
| \`nexora-site-engine\` | \`JASBH121101/Nexora\` commit \`3f68126ecc58b088c071007c5116bc95426d159b\`, branch \`docs/nexora-approved-upgrades-2026-11\` | Laravel 13 / PHP 8.3 application with independent installation, public catalogue, permissions, exports and owner-only domain management. |

The catalog source is the head of draft PR #5; this certification applies to that exact proposed prototype, not to the repository's \`main\` branch. The Site Engine pin is the dedicated upgrades branch, including the merged Site Engine and domain improvements. Updating either pin requires an intentional Threat Lab change and a new CI run.

## Scenario matrix

### NEXORA Configurable Catalog — six prototype tiers

1. Basic: sample business/product data integrity.
2. Intermediate: four-step setup contract, templates, dynamic fields, measurement dimensions, optional photos and demo-only setup boundary.
3. Advanced: localStorage behavior, HTML escaping and WhatsApp link normalization.
4. Expert: responsive admin constraints and overflow containment.
5. Extreme: all demo test files in one regression run.
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

The profile integration test is intentionally skipped by generic Threat Lab CI when its two pinned checkouts are not supplied. The dedicated \`NEXORA Threat Lab Profiles\` workflow supplies both checkouts and requires all six tiers in each target to pass with no adapter skips.

## Scope of claims

A six-tier \`ready\` result means all six registered scenarios for that pinned source passed. It does not establish that a product is free of unknown defects or certify capabilities outside these scenarios. In particular, the Configurable Catalog remains a frontend prototype; the test suite does not upgrade it into the Laravel Site Engine.
