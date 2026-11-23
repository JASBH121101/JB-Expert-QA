# Visual QA Engine Adapter — Phase 4 Block 10

## Purpose

Expose the canonical visual/layout browser audit through the versioned JB QA engine registry and the policy-bounded execution orchestrator. The adapter reuses `auditViewports`, the existing responsive/UI/UX/accessibility/theme context and PNG comparison implementation. It does not create a parallel visual rule engine.

## Execution modes

- `matrix: "default"` uses the canonical mobile, tablet and desktop viewport matrix.
- `matrix: "full"` uses the canonical nine-viewport matrix.
- `themes: ["light"]` is the default; `["light", "dark"]` compares both themes. The matrix is capped at 18 captures.
- Each browser navigation is capped at 30 seconds and each viewport uses the canonical 32-megapixel viewport ceiling.
- Screenshots are written to an ephemeral temporary directory and removed after the result has been summarized.
- Full-page screenshots, interaction exploration, axe scans and AI-provider calls are disabled by this adapter.

## Baseline policy

An optional absolute `baselineDir` enables read-only PNG comparisons. Missing baselines, pixel mismatches or incomplete comparison evidence cannot be reported as a passing visual result. Baseline writes are explicitly rejected; the adapter always passes `updateBaselines: false`. Diff-image output is disabled, and the public result omits actual/baseline/diff file paths.

This engine does not create approved baselines. Baseline creation or promotion must remain a separate, reviewed workflow outside routine certification.

## Output and privacy

The report contains bounded viewport summaries, pixel-difference metrics and up to 100 sanitized findings. It omits target URLs, CSS selectors, raw evidence objects, screenshot paths and baseline paths. A report is marked inconclusive when the canonical viewport matrix, screenshots or rule execution evidence are incomplete.

AI screenshot review remains a separate optional capability in the existing visual-review module. This adapter does not call an AI provider and does not imply that AI review or human sign-off has occurred.

## Orchestration

`registerVisualQaEngine(registry)` adds metadata only and performs no navigation or screenshot capture. The adapter uses the existing `jb.qa-engine-adapter/v1` contract. When the registry is sealed and connected to `createQaEngineOrchestrator()`, execution still requires the exact action policy, `qa:engine-execute` permission and an external approval receipt.

## Verification

Focused tests:

```bash
node --test tests/visual-qa-adapter.test.js
```

Standalone package validation:

```bash
node scripts/build-expert-qa-package.js
node --test packages/expert-qa/package-tests/complete-engine.spec.js
```
