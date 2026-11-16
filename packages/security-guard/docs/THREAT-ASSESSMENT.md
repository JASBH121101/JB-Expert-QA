# JB Security Guard Core v1 — Threat Assessment

## Purpose and boundary

The Node.js `createThreatAssessmentEngine()` consumes existing `jb.security.threat-signal/v1` records and emits the existing `jb.security.threat-assessment/v1` contract under an immutable server-owned policy. It reuses the Core v1 signal and assessment validators; it does not introduce a second request inspector or an alternate assessment schema.

The engine is an assessment component, not an enforcement component. It does not block an HTTP request, issue a challenge, write to a database, publish telemetry, or load policy from an untrusted caller. A `block` assessment is a policy classification only. The application that consumes the result must make a separate, explicit enforcement decision.

## Policy contract

The new `jb.security.policy.threat-assessment/v1` contract is stored at `contracts/threat-detection/v1/assessment-policy.schema.json`. It requires:

- tenant and application scope, version, enabled state, aggregation window, maximum signals and minimum accepted confidence;
- explicit integer weights for all Core v1 severity and threat-type values;
- ordered challenge, review and block thresholds;
- minimum strong-signal, distinct-rule, distinct-type and confidence requirements before a block classification is possible.

The policy is validated once when the engine is constructed and recursively frozen. There are no implicit weights or browser-controlled thresholds. The policy must be supplied by trusted server configuration.

## Aggregation semantics

1. Every input must conform to `threat-signal/v1` and match the configured tenant and application. Duplicate signal IDs are rejected.
2. Correlation uses opaque `subjectKey` and `subjectKeyId` values. Signals without an opaque subject are excluded; identified signals from different subjects or key IDs cannot be combined.
3. Future, stale, and below-floor confidence signals are excluded. The aggregation window and maximum selected signal count are policy-bounded.
4. Each signal contributes `round(severityWeight × typeWeight × confidence / 100)`. Confidence is treated as a producer-supplied heuristic weight, not a calibrated probability.
5. A rule contributes only its strongest selected signal. Repeated samples from one rule cannot inflate the score. The sum is capped at 100.
6. `observe`, `challenge`, and `review` follow the configured ordered thresholds. `block` additionally requires the configured minimum number of high-confidence signals, distinct rules and distinct threat types.
7. Signal references are returned in deterministic time/ID order and the final object is validated against the existing Core v1 assessment contract.

The score is a deterministic policy index, not a probability of compromise. This implementation does not claim statistical precision, recall, or false-positive performance.

## Usage

Import from the explicit Node package subpath:

```js
import { createThreatAssessmentEngine } from "@jb/security-guard/threat-assessment";

const assessor = createThreatAssessmentEngine({
  policy: serverOwnedThreatPolicy
});

// Feed only validated signals for the same configured tenant, application,
// and pseudonymous subject. The returned assessment is advisory, not a block.
const assessment = assessor.assess(signals);
```

The `policy` object must satisfy `jb.security.policy.threat-assessment/v1`. The public `@jb/security-guard` middleware API remains unchanged, and the engine is opt-in.

## Explicit non-goals and remaining work

- No PHP, Laravel, Python, or FastAPI runtime adapter is included.
- No central policy database, telemetry sink, queue, shared store, or network API is included.
- No automatic enforcement or challenge workflow is included.
- Existing request inspector confidence weights are not calibrated. A future calibration stage must use labeled benign and adversarial corpora, independently measure false positives/negatives, and test evasion and tenant isolation before any enforcement integration.
- The legacy `jb.security.assessment/v1` double-filter protocol remains separate and must not be converted into Core threat assessments by inventing risk scores or signal references.

## Tests

The laboratory suite covers policy validation, threshold ordering, disabled policy, confidence and time filtering, rule deduplication, independent block gates, pseudonymous subject isolation, tenant/application isolation, duplicate IDs, deterministic signal limits, invalid clocks/IDs, Core schema-fixture conformance, and clean package distribution.
