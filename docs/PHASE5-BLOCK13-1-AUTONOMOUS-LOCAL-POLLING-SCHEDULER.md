# Phase 5 — Block 13.1: Autonomous Local Polling Scheduler

## Goal

Remove the requirement for a host to manually call runNext() or drain() for every queue batch. Add an opt-in local polling loop around the existing execution lifecycle supervisor.

## Public API

```js
import {
  createAutonomousExecutionPollingScheduler,
  createExecutionLifecycleSupervisor,
  createExecutionJobQueue,
  createExecutionWorker,
  createAutonomousExecutionRuntime
} from "@jb/expert-qa";

const runtime = createAutonomousExecutionRuntime({
  orchestrator,
  enabled: true
});
const queue = createExecutionJobQueue();
const worker = createExecutionWorker({ queue, runtime });
const supervisor = createExecutionLifecycleSupervisor({ queue, worker, runtime });

const scheduler = createAutonomousExecutionPollingScheduler({
  supervisor,
  intervalMs: 2000,
  maxJobsPerTick: 5
});

// Explicit opt-in. The first bounded queue drain starts immediately.
scheduler.start();

// Stop polling but leave the supervisor available for operator control.
await scheduler.stop();

// Or stop polling and close worker/runtime/queue through the supervisor.
await scheduler.close();
```

The standalone module is available as @jb/expert-qa/execution-polling-scheduler.

## Safety and lifecycle contract

- Construction is inert. No timers, queue claims or engine executions start until the host calls start().
- start() delegates to the existing supervisor, preserving the requirement for an explicitly enabled and ready runtime.
- Polling only consumes jobs already submitted to the existing queue. This block does not generate recurring audit plans or add a new submission endpoint.
- Every polling cycle calls the supervisor's existing bounded drain({ maxJobs }). The default batch size is five; the supported range is 1–50.
- The default polling interval is 1,000 ms; the supported range is 10–60,000 ms.
- The first drain occurs immediately after explicit start. Subsequent cycles wait until the previous drain has settled and then wait the configured interval. Ticks never overlap.
- A scheduler tick failure is recorded as a sanitized error code and does not expose exception messages or payloads. Later polling cycles may continue.
- Failed and cancelled jobs are not retried. Retry and interrupted-job recovery remain explicit operator actions on the queue/supervisor.
- stop() clears the next timer and waits for an active batch to settle; it does not close the supervisor.
- close() stops polling and then delegates ordered shutdown to the supervisor.
- No GitHub Actions, hosted scheduler, cron service, cloud queue, database, paid service or external dependency is required by the scheduler.
- The scheduler is a local Node.js process component, not a process manager. To restart it after host reboot or process failure, an operator must run it under the host's service manager and decide how interrupted jobs are reviewed/recovered.

## Delivery semantics and limitations

The queue's existing persistent-store option can retain jobs across process restarts, but it does not provide exactly-once execution. Interrupted jobs remain subject to explicit recovery. A scheduler does not make a stopped Node.js process run again, provide distributed high availability, or remove GitHub Actions from repository CI/certification.

## Validation

```sh
node --test tests/execution-polling-scheduler.test.js tests/execution-supervisor.test.js tests/execution-worker.test.js tests/execution-job-queue.test.js tests/execution-job-persistence.test.js
npm run test:package-distributions
```

Block 13.1 is complete only when the scheduler regression tests, package export/distribution checks, Core Validation, Security QA and JB Engines Certification pass for the same PR head.
