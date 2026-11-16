# Cloudflare Pages integration for JB Security Guard

## Purpose

Cloudflare Pages Functions do not expose the Workers Rate Limiting binding directly. This integration keeps the runtime boundaries explicit:

- Cloudflare Edge filters abusive traffic before it reaches the Pages project.
- Pages Functions resolve the application identity and call a private Worker through a Service Binding.
- The private Worker owns the Workers Rate Limiting binding and delegates to the Worker-native Security Guard adapter.
- Pages applies the decision returned by the Service Binding.

The Node.js entry point \`@jb/security-guard\` must not be imported by Pages Functions.

## Request path

\`\`\`text
Visitor
  |
  v
Cloudflare Edge
  |-- DDoS protection
  |-- WAF managed/custom rules
  |-- Edge rate limiting
  |
  v
Cloudflare Pages
  |
  | Pages Function / middleware
  |-- resolve trusted account/session identity
  |-- call JB_SECURITY_LIMITER Service Binding
  |
  v
Private JB Security Guard Worker
  |-- Workers Rate Limiting binding
  |-- opaque key hashing
  |-- 429 / 503 decision
  |
  v
Pages applies decision or continues request
\`\`\`

Use Edge controls for volumetric and broad request abuse. Use the Pages integration for application-specific scopes such as login, catalog API, checkout, or expensive database-backed routes.

## 1. Configure Edge protection first

In the Cloudflare dashboard for the Pages hostname:

1. Confirm the hostname is proxied through Cloudflare.
2. Keep Cloudflare DDoS protection enabled.
3. Enable the available WAF managed protections.
4. Create a rate-limiting rule for sensitive API paths, starting with login and other expensive endpoints.
5. Review Security Events and tune thresholds to avoid blocking legitimate clients, shared networks, monitoring probes, or search crawlers.

On the Free plan, the number of configurable rate-limiting rules and available counting characteristics is limited. Treat the dashboard as the source of truth for the account's current plan and available rule options. Do not assume that one rule can represent every route-specific application policy.

For a static catalog, prioritize Edge controls on dynamic API routes. Static assets served from cache should not invoke a Pages Function just to check a counter.

## 2. Deploy the private rate-limit Worker

Install the Security Guard package in the Worker project:

\`\`\`bash
npm install @jb/security-guard
\`\`\`

Create \`src/index.js\`:

\`\`\`js
import {
  createCloudflareWorkerRateLimit,
  createCloudflareWorkerRateLimitService
} from "@jb/security-guard/cloudflare-worker-rate-limit";

export default {
  fetch(request, env) {
    const limiter = createCloudflareWorkerRateLimit({
      binding: env.API_RATE_LIMIT,
      namespace: "jb-security-guard-pages",
      mode: "enforce",
      periodSeconds: 60
    });

    const service = createCloudflareWorkerRateLimitService({
      limiter,
      path: "/__jb/security-guard/rate-limit",
      maxBodyBytes: 4096
    });

    return service.fetch(request);
  }
};
\`\`\`

Example \`wrangler.toml\`:

\`\`\`toml
name = "jb-security-guard-rate-limiter"
main = "src/index.js"
compatibility_date = "2026-11-15"
workers_dev = false

[[ratelimits]]
name = "API_RATE_LIMIT"
namespace_id = "1001"
simple = { limit = 60, period = 60 }
\`\`\`

Choose a unique numeric namespace ID for this binding within the Cloudflare account. The example threshold is only a starting point; tune it from observed traffic and application capacity. Add separate bindings and policies only when separate thresholds are necessary.

Deploy this Worker without a public \`workers.dev\` endpoint and without a public route. It should be reachable from the Pages project only through its Service Binding. Verify that the Worker has no unintended public hostname or route after deployment.

## 3. Add the Service Binding to Pages

In the Pages project dashboard:

1. Open **Settings → Functions → Service bindings** (the dashboard label may vary).
2. Add a binding named \`JB_SECURITY_LIMITER\`.
3. Select the private Worker \`jb-security-guard-rate-limiter\`.
4. Configure the binding for the Production environment and separately for Preview if previews need the same capability.
5. Redeploy the Pages project after changing bindings.

The binding name must match the Pages Function code. Do not add a public URL or secret token as a substitute for a Service Binding.

## 4. Call the Pages adapter from server-side Functions

Example Pages Function middleware:

\`\`\`js
import {
  createCloudflarePagesRateLimit
} from "@jb/security-guard/cloudflare-pages-rate-limit";

export const onRequest = async (context) => {
  // Resolve the identity from trusted server-side authentication/session state.
  // Never trust an account ID supplied directly by the browser.
  const identity = context.data?.authenticatedUser?.id;

  if (!identity) {
    return new Response("Unauthorized", { status: 401 });
  }

  const limiter = createCloudflarePagesRateLimit({
    serviceBinding: context.env.JB_SECURITY_LIMITER,
    failureMode: "closed"
  });

  const decision = await limiter.check({
    identity,
    scope: "catalog-api"
  });

  if (decision.response) return decision.response;
  return context.next();
};
\`\`\`

Use narrower scopes for sensitive routes, for example \`login\`, \`password-reset\`, \`catalog-write\`, or \`checkout\`. A shared Worker binding can apply multiple policies when the Pages Function passes a configured policy name.

Do not use an identity value from query parameters, request JSON, local storage, or arbitrary headers. For anonymous requests, use a deliberate client-identification policy at the Edge; if an IP address is used, account for NAT and shared networks. Turnstile can add a challenge to high-abuse public forms, but it does not replace authorization or rate limiting.

## 5. Failure behavior

The Pages adapter defaults to \`failureMode: "closed"\`:

- The private Worker is unavailable, returns an invalid response, or times out: Pages returns a generic 503.
- The rate limit is exceeded in enforce mode: Pages returns 429 with \`Retry-After\`.
- The rate limit is not exceeded: Pages continues to the route.

Fail-closed behavior protects the backend but can make an API unavailable if the private Worker or its binding is misconfigured. Keep health checks and telemetry, alert on repeated 503 responses, and test a deliberate service outage in Preview before production rollout.

Only choose \`failureMode: "open"\` for a route after explicitly accepting that service failure permits requests through. Do not use fail-open for login, account recovery, payment, or other high-risk endpoints without a separate compensating control.

## 6. Important limits and threat model

Workers Rate Limiting counters are approximate and local to Cloudflare locations. This integration is not a globally exact counter and cannot guarantee that no request will exceed a configured threshold during a distributed burst.

For strict globally coordinated quotas, evaluate a Durable Object-backed limiter. That changes the consistency and cost profile and should be tested against the real traffic model before adoption.

This integration does not replace:

- Cloudflare DDoS protection and WAF controls.
- Authentication, authorization, CSRF validation, input validation, or database query safety.
- Application capacity planning, caching, queueing, or origin protection.
- Malware scanning of uploaded files.

A Pages Function can only make a rate-limit decision for requests that invoke it. Edge controls must remain the first line of defense so abusive traffic is filtered before consuming Function execution or origin/database capacity.

## 7. Verification checklist

Before enabling enforcement in Production:

- [ ] The private Worker has no public \`workers.dev\` endpoint or public route.
- [ ] The Pages Service Binding points to the intended Worker in each environment.
- [ ] No Node.js-only Security Guard entry point is imported by Pages.
- [ ] Identity is resolved server-side and is never accepted from browser-controlled fields.
- [ ] Limits are scoped by route and measured against legitimate traffic.
- [ ] An exceeded limit returns 429 and a useful \`Retry-After\`.
- [ ] A Worker/binding outage returns 503 under the default fail-closed policy.
- [ ] The static catalog and static assets continue to work without invoking Functions unnecessarily.
- [ ] WAF/DDoS controls are enabled and their Security Events are reviewed.
- [ ] Preview tests pass before Production bindings or enforcement are changed.

## Official Cloudflare references

- [Pages Functions bindings](https://developers.cloudflare.com/pages/functions/bindings/)
- [Service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
- [Workers Rate Limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [WAF rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/)
- [DDoS protection](https://developers.cloudflare.com/ddos-protection/)
