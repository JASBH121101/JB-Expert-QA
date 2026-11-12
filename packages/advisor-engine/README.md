# JB Advisor Engine

**Understand. Compare. Recommend.**

JB Advisor Engine (JBAE) is an independently versioned, provider-agnostic advisory engine for fragrance and personal technology.

## Domains

- **Fragrance Advisor:** product normalization, scent-profile matching, customer-intent parsing, performance evidence handling and recommendations.
- **Tech Advisor:** device normalization, structured comparison, category-aware scoring and recommendations.

## Architecture

JBAE separates deterministic advisor orchestration, research providers, evidence records and trust policy, comparison, recommendations, product identity matching, and versioned local knowledge. The Capacitor SQLite adapter is an integration adapter; the host Android application installs and configures its native SQLite plugin.

## Trust and autonomy

- Retrieved facts enter as unconfirmed candidates, never as verified facts.
- Research ingestion does not overwrite verified knowledge.
- Human approval is required to stage candidates or change trusted facts and policies.
- Missing values remain missing; unsupported evidence is not invented.
- Price currencies and units are not silently converted.
- Paid APIs and external model services are not required by the core engine.

## Installation and use

Node.js 22 or newer. The core package has no runtime third-party dependencies.

```js
import { AdvisorCore, DOMAINS, ResearchEngine, compareProducts } from "@jb/advisor-engine";
```

The advisor ranks only supplied candidate products. Live discovery is performed separately through explicitly configured research providers.

## Development

From the monorepo root: `npm install`, `npm test`, `npm run check`. From this package directory: `npm test` and `npm run check`.

## Independence

JBAE does not import JB Expert QA, JB Security Guard, or JB Malware Engine at runtime. QA tooling may inspect it as a read-only quality gate; JBAE does not require those engines to operate.

## Status

Development-stage engine. Integration and CI validation are in progress. No npm publication or production deployment is performed by this change.
