# Report & Certification Engine Adapter — Phase 4 Block 11

## Purpose

Expose the existing dashboard analytics and consolidated report logic through the versioned JB QA engine registry. This adapter does not re-run audits, calculate new specialist scores, persist dashboard history, or treat a mixed-engine summary as a single-target certification.

## Input contract

The adapter accepts a bounded local history payload:

- Up to 2,000 audit records.
- Up to 64 registered engine definitions.
- Up to 100 finding details per record and 5,000 total finding details.
- Outcomes must be one of `passed`, `passed_with_observations`, or `not_passed`.
- Finding severity must be one of `critical`, `high`, `medium`, `low`, or `info`.
- Unknown fields, sparse arrays, getters/setters, invalid timestamps, unrecognized outcomes and invalid scores fail closed.

Target identities are hashed before entering analytics and exports. The adapter uses the existing latest-snapshot-per-engine-and-target calculation.

## Certification states

- `NOT_ASSESSED`: no saved audit snapshot exists.
- `NOT_PASSED`: at least one latest engine/target snapshot did not pass.
- `REVIEW_REQUIRED`: critical or high findings remain.
- `OBSERVATIONS`: findings or passed-with-observations results remain.
- `PASSED_WITHIN_RECORDED_SCOPE`: no findings were recorded in the latest saved snapshots.

The assessment is strictly limited to supplied retained history. Engine coverage does not mean every engine audited the same target. Scores are not averaged into a cross-engine score and are not comparable across different engines or targets. A pass within recorded scope is not a third-party certification, penetration test, accessibility conformance statement or proof of production readiness.

## Artifacts and checkpoint

The adapter supports JSON, Markdown and HTML. Markdown reuses the canonical `buildConsolidatedReport`; the dashboard analytics and consolidated report semantics remain the source of truth. The checkpoint contains the report ID, assessment, bounded record/snapshot counts and a SHA-256 digest over the normalized certification summary.

No files are written. No external network requests, paid services or AI calls are made. Persistence, scheduling and report delivery remain host/dashboard responsibilities.

## Orchestration

`registerReportCertificationEngine(registry)` adds metadata only. When registered in a sealed registry and called through `createQaEngineOrchestrator()`, the normal exact-policy rule, `qa:engine-execute` permission and external approval receipt are still required.

## Verification

```bash
node --test tests/report-certification-adapter.test.js
node scripts/build-expert-qa-package.js
node --test packages/expert-qa/package-tests/complete-engine.spec.js
```
