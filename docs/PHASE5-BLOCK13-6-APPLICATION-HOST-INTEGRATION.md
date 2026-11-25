# Phase 5 — Block 13.6: Application Host Integration & Operational Control

## Objective

Connect an application-owned autonomous host bootstrap to the existing local JB Expert QA Control Center. The dashboard provides a narrow operational view and explicit start/stop requests; it does not construct an orchestrator, create policy, grant permissions, approve work or recover interrupted jobs.

## Integration contract

`createDashboardServer(...)` and `startDashboard(...)` accept an optional `phase5HostBootstrap` controller. Supply the controller returned by `createAutonomousExecutionHostBootstrap(...)` from the embedding application:

```js
import {
  createAutonomousExecutionHostBootstrap,
  startDashboard
} from "@jb/expert-qa";

// The embedding application owns this trusted object. Its registry, policy,
// approval provider and execution ledger must already be configured.
const bootstrap = createAutonomousExecutionHostBootstrap({
  orchestrator: trustedApplicationOrchestrator,
  storageDirectory: "/var/lib/jb-expert-qa",
  enabled: true,
  signalSource: process,
  hostOptions: {
    pollIntervalMs: 1000,
    maxJobsPerTick: 2,
    maxConsecutiveErrors: 5
  }
});

const dashboard = await startDashboard({
  port: 4173,
  phase5HostBootstrap: bootstrap
});

// The local Control Center can now request start/stop explicitly.
// During application shutdown, close the dashboard and stop the bootstrap
// if it is still running.
```

The `enabled: true` option is an explicit bootstrap capability opt-in, not an automatic start. Creating the bootstrap controller is inert. The host starts only after the dashboard operator requests Start or the embedding application calls `bootstrap.start()` directly.

The default `dashboard-cli` does not create or inject a bootstrap controller. Without explicit application injection, the host panel reports `NOT CONNECTED`, the Start/Stop buttons remain disabled and the default dashboard continues to perform its existing QA audit functions only.

## Local operational endpoints

- `GET /api/phase5/host/status` returns the bounded host lifecycle, liveness, readiness, preflight, queue counts and sanitized recent diagnostics.
- `POST /api/phase5/host/start` runs the bootstrap only when its state is `idle`.
- `POST /api/phase5/host/stop` performs graceful shutdown only when its state is `running`.

Lifecycle POST requests require the exact local dashboard Origin, an empty JSON object, no query parameters and the host-operation rate limit. The server binds to loopback by default. These endpoints are not a remote administration interface; do not expose the dashboard on a public interface or through an unauthenticated reverse proxy.

The API projects only allowlisted state and count fields. It omits storage paths, policy identifiers, job/engine/execution identifiers, raw event messages, payloads, tokens, exception messages and stack traces. The dashboard renders all returned values with text APIs rather than HTML interpolation.

## Lifecycle and recovery boundaries

- The dashboard cannot alter registry contents, policy limits, permissions or allowlists.
- The dashboard cannot submit arbitrary jobs or engine payloads through the host-control endpoints.
- Start invokes the bootstrap's complete preflight and persistence-lock checks before the runner is started.
- Stop awaits the bootstrap's ordered graceful close.
- A bootstrap that has stopped or failed is terminal. The dashboard does not restart it; the application must construct a new controller through its own supervisor after reviewing the prior failure.
- Interrupted jobs remain quarantined. There is no automatic replay, retry, recovery or disposition endpoint in this integration.
- The application retains ownership of its trusted orchestrator, approval provider, external ledger lifecycle, service-manager policy and shutdown ordering.

## Cost and runtime independence

This integration adds no remote queue, paid scheduler, paid API, cloud worker or GitHub Actions runtime dependency. The execution host continues to run locally in the embedding process. GitHub Actions is used for repository validation only; it does not start, poll or execute the autonomous host.

The deployment model remains one process on one host with local persistent stores. This block does not claim distributed execution, high availability, or a production approval provider.

## Validation gate

The dashboard tests cover:

- No host controller connected by default and no implicit startup.
- Rejection of inherited/untrusted controller method surfaces.
- Same-origin enforcement, empty-body validation and rate-limited lifecycle controls.
- Explicit start from `idle`, graceful stop from `running`, and rejection of duplicate/terminal transitions.
- Sanitized status projection that excludes job IDs, payloads, tokens and raw diagnostic messages.
- Local UI integration and disabled controls when the application has not injected a host.

The host bootstrap's own preflight, durable lock, ledger and service lifecycle contracts remain independently covered by Block 13.5 tests. A green dashboard integration suite proves the wiring contract; it does not provision an application's real policy or approval provider, start a production host, or certify a customer's host identity and storage permissions.
