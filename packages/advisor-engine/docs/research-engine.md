# Research Engine

## Responsibility

ResearchEngine coordinates external research providers without owning their network implementation. A provider implements `search({ domain, subjectId, field, query, limit })` and returns source-backed candidate objects. Providers may later connect to official sources, distributor catalogs, independent tests, curated databases or offline indexes.

## Candidate trust boundary

Provider results never control the Evidence status. Every result is converted into an `unconfirmed` evidence candidate, even when a provider includes a claimed status such as `verified`. The engine validates:
- provider identity and domain support;
- subject and field scope from the request (providers cannot override them);
- provider-scoped unique result IDs and non-null values;
- HTTP(S) source URL, source name and source type;
- confidence range, evidence timestamp and record integrity through `createResearchCandidate()`.

Every candidate retains the source policy assessment, retrieval timestamp and provider ID. The source reliability assessment is a heuristic, not a calibrated probability or automatic verification decision.

## Human approval

Research results stay in the engine's pending queue. They are not written to the KnowledgeStore automatically. `stageCandidate(candidateId, { knowledgeStore, approved: true })` requires explicit approval and writes the evidence only as `unconfirmed`. Verification or cross-checking requires a separate review process and supporting evidence; retrieval alone cannot elevate status.

The pending queue has a configurable capacity. Duplicate evidence IDs are rejected across both pending and already staged results, rather than silently replaced.

## Request limits and errors

Each request selects a registered provider and supplies a domain, subject ID, field, query and result limit (1–20). Optional provider domain allowlists are enforced. Malformed provider responses, unsupported domains, unsafe links, invalid evidence records and storage errors fail closed.

## Scope and limitations

This is a provider adapter contract and candidate orchestration layer, not a built-in web crawler. No third-party APIs are called until the app injects a provider implementation. Credentials must be held by the platform secure store or server-side integration, never embedded in the APK. External provider costs remain opt-in.
