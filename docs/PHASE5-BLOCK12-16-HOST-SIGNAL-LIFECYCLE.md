# Phase 5 — Block 12.16: Host Signal Lifecycle Adapter

## Objective

Provide an explicit, framework-neutral adapter for embedding the durable autonomous host in a long-lived Node.js process. It supports graceful SIGINT/SIGTERM shutdown without implicit global signal listeners or forced process exit.

## API

```js
import { attachHostSignalLifecycle } from "@jb/expert-qa";

const lifecycle = attachHostSignalLifecycle({
  host,
  signalSource: process, // injectable process-like emitter
  signals: ["SIGINT", "SIGTERM"],
  onError: (error, signal) => logger.error({ code: error.code, signal }, "host shutdown failed")
});

// Embedding process owns installation and detachment.
await lifecycle.shutdown();
lifecycle.detach();
```

## Safety boundaries

- Import and host construction do not register process listeners.
- Installation is explicit and accepts an injected signal source.
- Signal requests converge on one close promise; repeated signals cannot close the host twice.
- Close failures are surfaced in sanitized lifecycle status and optionally passed to the caller's error handler.
- Detach removes only this adapter's listeners; it does not close the host.
- The adapter never calls process.exit(), starts the host, installs OS service registration, or force-kills active work.
- The embedding process remains responsible for signal ownership, logging, exit code policy, service-manager configuration and restart policy.

## Validation

Focused tests cover explicit installation, single shutdown under duplicate signals, detach behavior, observable close failures, strict option/signal validation and rollback after partial listener attachment. Full Core Validation, Security QA, package distribution and JB Engines Certification are required before merge.
