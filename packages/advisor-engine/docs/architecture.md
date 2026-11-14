# JB Advisor Engine — Architecture

## Identity
- Product: JB Advisor Engine (JBAE)
- Tagline: Understand. Compare. Recommend.
- Package: `@jb/advisor-engine`

## Core layers
1. Advisor Core: deterministic request validation and orchestration.
2. Research Engine: bounded provider retrieval and unconfirmed research candidates.
3. Evidence Engine: provenance, timestamps, confidence, immutable claims and conflict handling.
4. Comparison Engine: domain-scoped scoring and evidence-aware comparisons.
5. Product Identity Matcher: source matching with identifier and variant conflict checks; no automatic merges.
6. Recommendation Engine: preference weighting, coverage gates and explainable ranking.
7. Knowledge Engine: versioned local snapshots, validated migrations, evidence persistence and backup/restore.
8. Domain adapters: separate Fragrance and Technology schemas, types and units.

## Boundaries
- JBAE does not depend on JB Expert QA, JB Security Guard or JB Malware Engine at runtime.
- JB Expert QA is a sibling package in the same monorepo and may inspect JBAE as a read-only quality gate.
- The Android/host application owns UI, authentication, native plugin setup, network permissions and persistent storage configuration.
- External providers retrieve candidates; JBAE validates and stages evidence under explicit approval rules.
- No paid API is needed by the deterministic core.

## Domain policy
- Fragrance concentration is distinct from body mist, body spray, attar/oil and lotion.
- Technology device types have category-specific fields and scoring.
- USD and NIO remain separate unless the caller supplies a dated, sourced FX conversion.
- Missing facts are never imputed. Longevity, projection, battery life and camera quality require eligible evidence.
- Candidate comparison is relative to the supplied data and selected criteria, not an absolute quality guarantee.

## Autonomy and approval
Research may create unconfirmed candidates automatically. Human approval is required to stage those candidates, promote claims, change trusted-source policy or verified facts, and perform destructive knowledge operations. Purchases, payments, marketplace publication and sharing private data are outside the engine's authority.

## Security, cost and offline behavior
Core rules and local knowledge work offline. Paid services are opt-in. Never commit API keys, tokens, private customer data or local environment files. External model output is advisory and cannot silently overwrite verified facts.

## Validation status
The engine source and tests are in the monorepo package. The native Android adapter, full host-app integration, process-restart recovery and production provider behavior still require validation in the consuming application.
