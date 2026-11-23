# JB Expert QA — Runtime Security QA Adapter (Phase 4, Block 6)

## Purpose

Block 6 connects the existing canonical Runtime Security Auditor to the central engine registry and Phase 4 orchestrator. It reuses `auditSecurityUrl`; no second browser scanner, header parser, cookie parser or runtime security rule set is introduced.

Adapter ID: `jb.runtime-security-qa-engine`.

## What it observes

The existing auditor performs a normal, headless page load and inspects the main-document response for HTTPS transport, HSTS, CSP, content-type and framing controls, referrer and permissions policy, CORS, authentication-cookie attributes and mixed content. It does not submit forms, crawl links, authenticate or send exploit payloads.

## Network safety boundaries

The adapter always invokes the canonical auditor with `allowPrivateNetworks: false` and `headless: true`. These controls are not user-overridable through the adapter command. The canonical URL safety guard accepts only HTTP(S), rejects embedded credentials, blocks local/reserved hostnames and private/reserved IPv4/IPv6 destinations, and revalidates DNS before intercepted HTTP requests. HTTP(S) and WebSocket requests are checked by the existing browser routes.

The current canonical auditor explicitly reports two limitations that this adapter preserves in every result:

- Chromium's connection-time DNS resolution is not pinned to the address checked by the guard; complete DNS-rebinding/TOCTOU prevention cannot be claimed.
- Playwright routes a request and its redirect chain as one unit; the auditor cannot independently validate every intermediate redirect hop.

The engine therefore performs a bounded passive browser observation, not a hardened egress proxy or penetration test. Browser subresources can contact public hosts referenced by the supplied page. Use a separate egress proxy for stronger redirect-hop isolation where required.

## Privacy and output contract

The adapter's command accepts only `url` and `timeout`. Execution options accept only an `AbortSignal`; a pre-aborted signal prevents browser startup. The underlying browser audit does not support cancellation once started.

The adapter does not return target URLs, query strings, blocked-request URLs/reasons, cookie values, diagnostic IDs (which may embed cookie names), evidence, recommendations or arbitrary diagnostic metadata. It returns HTTP status, booleans, bounded counters and at most 25 finding summaries. URL, DNS and browser errors are converted to a generic error so submitted query values cannot leak through exception messages.

## Registry and orchestrator

```js
import {
  createQaEngineRegistry,
  registerRuntimeSecurityQaEngine,
  createQaEngineOrchestrator,
  getQaEngineActionType,
  QA_ENGINE_EXECUTION_PERMISSION
} from "@jb/expert-qa";

const registry = createQaEngineRegistry();
registerRuntimeSecurityQaEngine(registry);
registry.seal();

const actionType = getQaEngineActionType("jb.runtime-security-qa-engine");
const orchestrator = createQaEngineOrchestrator({
  registry,
  policy: {
    id: "runtime-security-qa-v1",
    grantedPermissions: [QA_ENGINE_EXECUTION_PERMISSION],
    rules: [{ type: actionType, maxRisk: "high" }]
  },
  requestApproval: async (request) => hostApprovalService.request(request)
});

const result = await orchestrator.execute({
  id: "runtime-header-audit",
  actions: [{
    id: "inspect-site-response",
    type: actionType,
    input: { url: "https://example.org/", timeout: 30000 }
  }]
});
```

The host must provide a real external approval boundary. The existing orchestrator retains the exact action allowlist, preauthorized `qa:engine-execute` permission and explicit approval receipt requirements.

## Verification

```sh
node --test tests/runtime-security-qa-adapter.test.js
node --test tests/security-url.browser.test.js
npm run test:package-distributions
```

A successful report is not proof that a site is secure. It is limited to the main-document response and passive browser-visible controls; authenticated testing, all API endpoints, deployment configuration and external services require separate validation.
