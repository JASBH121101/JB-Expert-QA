# NEXORA product profiles in JB Threat Lab

## Independent certification targets

Threat Lab validates two NEXORA deliverables separately. A pass for one target never certifies the other.

| Target | Immutable source pin | Product boundary |
| --- | --- | --- |
| `nexora-configurable-catalog` | `JASBH121101/Nexora@63f0608d0b00d633b1ad147ab2318fc099b8a99e` — Catalog branch after the demo storage fix from PR #12 | Frontend prototype only: HTML/CSS/JS, editable setup/templates, localStorage demo persistence and responsive admin. Not real authentication, server persistence, or secure server-side image storage. |
| `nexora-site-engine` | `JASBH121101/Nexora@afa0572d35f94b5c02a40d75001a2b2acd7f8b66` — head of draft PR #14, stacked on draft PR #13 | Laravel 13 / PHP 8.3 application including private product-image handling and TOTP MFA. This is a proposed source revision, not a merged or production release. |

Both pins are exact commit SHAs and the integration test verifies the checked-out Git HEAD before executing product tests. Updating either pin requires a deliberate change to the test constants, workflow, documentation and a fresh CI run.

## Scenario matrix

### Configurable Catalog — six prototype tiers

1. **Basic:** sample business/product data integrity.
2. **Intermediate:** setup wizard, templates, dynamic fields, measurement dimensions and demo-only setup boundary.
3. **Advanced:** browser localStorage shape validation, copy-on-write product persistence, HTML escaping and WhatsApp link normalization.
4. **Expert:** responsive admin constraints and overflow containment.
5. **Extreme:** all prototype test files together as a cross-file regression.
6. **Superextreme:** full demo suite plus explicit checks that the prototype does not collect real passwords or claim server persistence.

The Catalog remains a browser-side demonstration. Its profile does not certify server authentication, backend persistence or protected image delivery.

### Laravel Site Engine — ten scenarios across six tiers

1. **Basic:** atomic setup creates one owner and seeds the selected template.
2. **Intermediate:** published-only catalogue, public product details, private-field exclusion and sitemap behavior.
3. **Advanced — permissions:** role permissions, explicit overrides, unknown identifiers and inactive-user denial.
4. **Advanced — currency:** ISO-style currency metadata, currency-specific minor-unit precision, decimal validation and locale formatting.
5. **Advanced — localization/catalogues:** locale, country, currency and calling-code catalogue integrity and stable identifiers.
6. **Expert — exports:** export field visibility and independent create/download authorization.
7. **Expert — private images:** raster re-encoding, quarantine/private storage, published-only public delivery and field-level admin authorization.
8. **Expert — MFA/TOTP:** encrypted TOTP enrollment, login challenge, replay rejection, one-time recovery codes and protected MFA disable.
9. **Extreme — domains/TLS:** owner-only domain management, DNS TXT/TLS behavior through deterministic fake adapters and published-host enforcement.
10. **Superextreme — full suite:** complete Laravel Feature and Unit suite on in-memory SQLite.

All six difficulty tiers must be covered, all ten Site Engine scenarios must pass, and no scenario may be skipped for the target to report ready.

## Execution and safety

The dedicated workflow is `.github/workflows/nexora-product-certification.yml`. It checks out both product SHAs read-only, installs the Site Engine's locked Composer dependencies, runs the two independent Threat Lab reports, executes the complete Laravel suite against an ephemeral PostgreSQL 16 service, and uploads separate Catalog and Site Engine JSON reports.

- Catalog scenarios run only the checked-out prototype's Node test files.
- Site Engine targeted scenarios run PHPUnit against its configured in-memory SQLite database. The complete Laravel suite also runs separately against disposable CI PostgreSQL 16.
- The workflow runs PHP 8.3 and Node.js 22.
- Domain/TLS checks use deterministic test doubles; they do not query public DNS, connect to external TLS endpoints, alter DNS, or issue certificates.
- The profile child processes use a minimal explicit environment. CI credentials and checkout credentials are not forwarded to product test processes.
- The adapters do not use production databases, customer data, live domains, deployments, paid services or external malware providers.

Composer dependency installation may retrieve packages in the CI setup phase. The product test adapters themselves are local and do not make external network requests.

## Evidence and certification boundaries

The workflow produces two separate report artifacts. Each report records the exact source SHA and only the scenarios for that target.

The Site Engine pin is the proposed head of Nexora PR #14, which is stacked on PR #13. Both product PRs are still separate from JB Threat Lab and remain subject to their own review/merge decisions. Passing this profile does not merge either Nexora PR, change Nexora `main`, publish a release or certify production deployment.

A six-tier `ready` result means only that all registered scenarios for that exact pinned source passed. It does not establish absence of unknown vulnerabilities or certify capabilities outside the documented product scope. Product defects must be fixed in the corresponding Nexora branch, not in the Threat Lab adapter.
