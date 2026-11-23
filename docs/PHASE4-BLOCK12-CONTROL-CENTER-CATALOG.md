# Phase 4 Block 12 — Control Center Engine Catalog Integration

## Purpose

The local QA Control Center now discovers the built-in Phase 4 engine registry and renders its adapter metadata in a dedicated catalog. Existing legacy audit-runner selection and history remain unchanged.

## Catalog

The default catalog registers metadata for API testing, static QA, static security, runtime security, accessibility, performance, visual QA and report/certification adapters. Registration uses trusted built-in adapter functions but does not invoke runners.

The catalog is sealed after registration. The dashboard exposes only manifest fields (ID, name, version, category, target type, execution mode, capabilities and description), not runner functions.

## API

`GET /api/phase4/engines` returns:

- `engines`: sanitized registry metadata
- `executionEnabled: false`
- `approvalRequired: true`

An optional sealed registry may be supplied through `createDashboardServer({ phase4Registry })` or `startDashboard({ phase4Registry })` for host customization.

## UI

The dashboard includes an Autonomous Engine Catalog section. It displays registered metadata and labels the catalog **DISCOVERY ONLY — EXECUTION DISABLED**. It does not create executable controls.

## Security and boundaries

- Registry listing is read-only and metadata-only.
- No runner is called during registration, dashboard initialization or catalog requests.
- The catalog does not grant permissions or bypass the central orchestrator.
- Adapter execution remains high-risk by default and requires exact policy, `qa:engine-execute` permission and external approval through the orchestrator.
- Legacy dashboard run routes are unchanged and remain bound to the original seven built-in adapters.
- No new network service, paid provider or remote dashboard is introduced.

## Verification

```bash
node --test tests/dashboard.test.js
node --test tests/engine-registry.test.js tests/engine-orchestrator.test.js
npm run test:package-distributions
```
