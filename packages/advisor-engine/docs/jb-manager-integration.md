# JB Manager integration contract

## Status and boundary

This document defines how a host application can consume JB Advisor Engine (JBAE). The engine repository contains the deterministic library, domain adapters, local knowledge contracts and Capacitor SQLite adapter. It does **not** contain the JB Manager screen, Android application shell, native plugin installation, APK packaging or device lifecycle code.

The current working branch is `feature/jb-advisor-engine`. Integrate from this branch only in a controlled consumer-repository change; do not assume the engine is already deployed in JB Manager.

## Package entry point

The package exposes its root ESM API from `src/index.js`:

```js
import {
  DOMAINS,
  createAdvisorCore,
  KnowledgeStore,
  CapacitorSQLiteKnowledgeAdapter,
} from "jb-advisor-engine";
```

For a local workspace, add the repository as a workspace dependency. For a private Git dependency, the consuming build environment must have authorized GitHub access. Keep this engine dependency pinned to a reviewed commit or release; do not float production builds on a moving feature branch.

## Offline knowledge initialization

The Android host owns the SQLite connection lifecycle. It must create and open the native connection before giving it to JBAE:

```js
const adapter = new CapacitorSQLiteKnowledgeAdapter({
  db: openedSQLiteDBConnection,
});
const knowledgeStore = await KnowledgeStore.open({ adapter });
const advisor = createAdvisorCore({ knowledgeStore });
```

The adapter requires an already-opened `SQLiteDBConnection` with the methods documented in [Capacitor SQLite](./capacitor-sqlite.md). It does not import Capacitor or create the database connection itself. The host must handle first-run seed import, permissions, close/release, backup policy and recovery after process termination.

A Node-only integration test may use `MemoryKnowledgeAdapter`; it is a test/reference adapter, not durable production storage.

## Candidate and request contract

JBAE is a deterministic decision engine, not a product-discovery endpoint. The host application is responsible for finding candidates in the local catalog or another approved source, then passing 2–4 distinct candidates to `AdvisorCore.advise()`.

Example:

```js
const result = advisor.advise({
  domain: DOMAINS.FRAGRANCE,
  products: shortlistedCandidates,
  customerMessage: "Busco algo fresco y suave para el día a día.",
  evidencePolicy: { allowReported: false },
});
```

Each candidate must contain a stable unique `id`, `name`, `productType` and domain-specific `attributes`. For fragrance requests, supported structured preferences can also be provided in `preferences`; explicit structured values override the phrase-based values extracted from `customerMessage`.

The phrase parser is conservative. It emits recognized signals only and reports `needsClarification` when it cannot understand a request. The host should display clarification prompts rather than inventing missing preferences.

For a non-intrusive fragrance request such as “que no sea hostigoso”, the engine treats intensity, projection and sillage ceilings as hard constraints. The corresponding candidate attributes (`intensityLevel`, `projectionLevel` and `sillageLevel`) must be present and within the requested limits; unknown values do not pass the constraint.

## Result handling

The caller should use the structured response, not parse generated prose:

- `recommendation`: scored recommendation based on the selected profile/priorities and evidence policy.
- `preferenceMatch`: fragrance-specific matching, eligibility, constraints, coverage and tie/no-match decision.
- `customerIntent`: recognized customer signals and normalized preferences.
- `customerExplanation`: customer-facing Spanish explanation or an explicit clarification, tie or no-eligible-match outcome.
- `performance`: fragrance performance profiles. Duration/projection intervals are only exposed when eligible evidence supports them.
- `limitations`: boundaries that should remain visible to downstream UI and support content.

Do not convert `reported` observations into verified facts. `evidencePolicy.allowReported` defaults to false and must be enabled deliberately. Without an EvidenceStore, catalog attributes are `not_assessed`, not independently verified. Long-lasting intent changes ranking priorities; it does not create a duration estimate.

## Side effects and privacy

`advise()` is synchronous and deterministic. It does not perform network requests, call external AI providers, write to the KnowledgeStore, publish a product or mutate evidence. The host controls candidate retrieval, customer-data retention, consent, UI and all persistence actions.

Do not put API credentials or customer identifiers in the APK or in engine requests unless the host has a documented, necessary data-handling purpose. Keep secrets in the host's secure environment.

## Consumer validation gate

Before enabling the adviser in a JB Manager release:

1. Pin the JBAE dependency to a reviewed commit.
2. Run the consumer application's type/syntax checks and complete test suite.
3. Verify local candidate retrieval returns 2–4 unique, normalized candidates.
4. Test no-match, tie, missing-attribute, conflicting-evidence and reported-only cases in the UI.
5. Verify seed import, database reopen and process-kill recovery on an Android emulator and a physical device.
6. Confirm the UI displays evidence limitations and never presents unsupported duration/projection claims.

Passing the engine CI is not proof that the Android integration works; native device validation remains a separate release gate.
