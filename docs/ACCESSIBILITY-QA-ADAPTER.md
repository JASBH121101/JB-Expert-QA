# JB Expert QA — Accessibility QA Adapter (Phase 4, Block 7)

## Purpose

Block 7 connects the existing canonical Playwright accessibility specialist to the central engine registry and Phase 4 orchestrator. It reuses `auditUrl`, `accessibilityRules` and the bundled axe-core runtime; it does not introduce a second browser scanner or duplicate accessibility rules.

Adapter ID: `jb.accessibility-qa-engine`.

## Checks performed

The adapter runs the existing `accessibility` specialist and axe-core. The canonical rules cover axe-core violations, missing image alternative text, form controls without programmatic labels, missing document language and skipped heading levels.

A new additive field, `evidence.axeScanCompleted`, records whether axe-core completed successfully. The adapter marks a report inconclusive when axe-core did not complete, the specialist scope differs from exactly `accessibility`, or any specialist rule execution reports an error. An incomplete scan cannot be returned as passed.

## Browser and network boundaries

The adapter always forces `headless: true`, `runAxe: true`, `allowPrivateNetworks: false`, `sameOriginOnly: true`, and `interactionExploration: false`. Only `url` and a bounded `timeout` (1,000–30,000 ms) are accepted in the command. No browser options, private-network opt-ins, screenshot paths, session state, theme manipulation or interaction controls are exposed.

The existing URL guard allows HTTP(S) only, rejects embedded credentials, blocks private/reserved IP addresses and local/reserved hostnames, and revalidates DNS before intercepted requests. The browser may navigate the specified page and make same-origin requests needed to render it. Third-party requests and cross-origin redirects are blocked; submit the canonical same-origin URL to avoid redirect-based scan failures.

The audit does not authenticate, crawl other routes, submit forms, or click/type through controls. Normal page scripts run during navigation, so this is not a sandbox for hostile page code. Browser connection-time DNS is not pinned by the existing Playwright guard and complete DNS-rebinding/TOCTOU prevention cannot be claimed.

## Result privacy and bounds

The adapter returns at most 30 finding summaries. It omits selectors, locations, evidence, recommendations, page titles, target URLs, query values and raw browser error messages. Finding text is passed through the existing sensitive-text redactor and bounded. The output contains aggregate counts, severities, score data, axe completion/violation counts, and network-policy metadata.

The underlying audit supports only a pre-start AbortSignal check; it cannot cancel an already launched Playwright scan.

## Registry and orchestrator

```js
import {
  createQaEngineRegistry,
  registerAccessibilityQaEngine,
  createQaEngineOrchestrator,
  getQaEngineActionType,
  QA_ENGINE_EXECUTION_PERMISSION
} from "@jb/expert-qa";

const registry = createQaEngineRegistry();
registerAccessibilityQaEngine(registry);
registry.seal();

const actionType = getQaEngineActionType("jb.accessibility-qa-engine");
const orchestrator = createQaEngineOrchestrator({
  registry,
  policy: {
    id: "accessibility-qa-v1",
    grantedPermissions: [QA_ENGINE_EXECUTION_PERMISSION],
    rules: [{ type: actionType, maxRisk: "high" }]
  },
  requestApproval: async (request) => hostApprovalService.request(request)
});

const result = await orchestrator.execute({
  id: "accessibility-page-audit",
  actions: [{
    id: "inspect-page-accessibility",
    type: actionType,
    input: { url: "https://example.org/", timeout: 20000 }
  }]
});
```

The host must provide an independent external approval boundary. The existing orchestrator continues to require an exact policy allowlist, the preauthorized `qa:engine-execute` permission and an explicit approval receipt.

## Verification

```sh
node --test tests/accessibility-qa-adapter.test.js
node --test tests/integration/playwright-audit.test.js
npm run test:package-distributions
```

Automated axe-core checks are not a complete WCAG conformance certification. Keyboard-only operation, screen-reader behavior, content quality, focus order and other human evaluation criteria still require manual review.
