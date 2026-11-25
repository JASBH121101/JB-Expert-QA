# Phase 5 — Block 13.3: Service Manager Deployment Profiles

## Objective

Generate reviewable, platform-native service definitions for the existing autonomous host lifecycle. The host entrypoint remains application-owned because it constructs the trusted QA orchestrator, policy, engine registrations and approval integrations. The profile builder only renders deployment text; it does not install, register, start, stop, enable or modify an operating-system service.

## Public API

The builders are available from the package root and the standalone `@jb/expert-qa/autonomous-execution-service-deployment` subpath:

- `createSystemdHostServiceProfile(options)` returns a systemd unit profile.
- `createWindowsHostServiceProfile(options)` returns a WinSW v3 XML profile for Windows SCM.
- Both return immutable metadata and a `content` string. The caller decides where to write the content and when an operator may apply it.

## Linux — systemd

Example:

```js
import { createSystemdHostServiceProfile } from "@jb/expert-qa";

const profile = createSystemdHostServiceProfile({
  unitName: "jb-expert-qa.service",
  nodeExecutable: "/usr/bin/node",
  entryPoint: "/opt/jb-expert-qa/host-service.mjs",
  workingDirectory: "/opt/jb-expert-qa",
  storageDirectory: "/var/lib/jb-expert-qa",
  serviceUser: "jbexpertqa",
  serviceGroup: "jbexpertqa",
  restartPolicy: "on-failure",
  restartDelaySeconds: 10,
  startLimitBurst: 3,
  startLimitIntervalSeconds: 300,
  stopTimeoutSeconds: 90
});

console.log(profile.content);
```

The generated unit uses a dedicated non-root `User` and `Group`, a fixed absolute `ExecStart`, a single writable state directory, `UMask=0077`, `NoNewPrivileges=true`, `PrivateTmp=true`, `ProtectSystem=strict` and `ProtectHome=true`. It sends `SIGTERM` for normal shutdown and gives the host up to `TimeoutStopSec` to finish before systemd applies its final-kill policy.

The default restart policy is `on-failure`, with a 10-second delay and a limit of three starts in five minutes. When the start limit is exhausted, systemd stops trying; an operator must inspect the cause and deliberately clear the failed state before starting again. Set `restartPolicy: "no"` to disable automatic restarts. The generator intentionally does not offer unlimited restart loops.

### Operator-controlled Linux rollout

1. Provision the service account and group using the host's normal identity-management process. Do not use root as the service identity.
2. Install the application under a read-only deployment directory such as `/opt/jb-expert-qa`; ensure the configured Node executable and entrypoint exist and are readable.
3. Create the state directory at the exact `storageDirectory` path. Make it writable only by the service account/group. Keep secrets outside the unit file and source repository.
4. Review the rendered unit, then write it to `/etc/systemd/system/<unitName>` with administrator approval.
5. Run `systemd-analyze verify` against the unit. After review, an operator may reload systemd, enable/start the unit and inspect its active state and journal.
6. If the restart limit is reached, inspect logs and durable job state first. Do not automatically replay interrupted jobs; use the host's explicit operator recovery API after reviewing each job.

## Windows — Service Control Manager with WinSW v3

The Windows profile emits an XML configuration for the external WinSW v3 service wrapper. The wrapper binary is not bundled, downloaded or installed by this package. Obtain it separately from a trusted release channel, verify its provenance/signature and keep it in a controlled installation directory.

Example:

```js
import { createWindowsHostServiceProfile } from "@jb/expert-qa";

const profile = createWindowsHostServiceProfile({
  serviceId: "JBExpertQA",
  displayName: "JB Expert QA Autonomous Host",
  description: "Local autonomous QA execution host",
  nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
  entryPoint: "C:\\Program Files\\JB Expert QA\\host-service.mjs",
  workingDirectory: "C:\\Program Files\\JB Expert QA",
  storageDirectory: "C:\\ProgramData\\JB Expert QA",
  startMode: "Automatic",
  delayedAutoStart: true,
  restartDelaysSeconds: [10, 30],
  stopTimeoutSeconds: 90
});

console.log(profile.content);
```

Place the verified WinSW executable and the generated XML beside one another using the same base name (for example, `JBExpertQA.exe` and `JBExpertQA.xml`). The XML launches the configured Node executable and the quoted host entrypoint. It sets the storage directory as an environment variable, keeps logs under the configured log path and hides the child console window.

On stop, WinSW v3 attempts to send Ctrl+C to the console application and waits up to `stoptimeout`; if the process does not exit in time, the wrapper can terminate it. The host service lifecycle already handles `SIGINT`, so allow enough time for the worker's configured execution timeout, queue/journal flush and graceful close. A forced termination can leave a job marked interrupted; the host deliberately requires operator review rather than automatic replay.

The default failure sequence restarts after 10 seconds, restarts once more after 30 seconds, then uses `none` so further failures leave the service stopped for operator investigation. The generator never emits a reboot action or unbounded restart loop. Set `startMode: "Manual"` to require an operator to start the service; delayed auto-start is then disabled by default.

### Operator-controlled Windows rollout

1. Provision a dedicated, non-administrator service identity. Configure the service's Log On account through Windows service administration and grant only the required “Log on as a service” right.
2. Grant read/execute access to the application and Node installation directories. Grant modify access only to the configured state and log directories. Do not run the service as LocalSystem simply to bypass permissions.
3. Place the separately verified WinSW binary and generated XML in a controlled directory. Review the executable, entrypoint, service ID, start mode, retry sequence, state path and stop timeout.
4. Install the service using the documented WinSW v3 operator command, then inspect its registered identity and configuration before starting it.
5. Start the service only after confirming the service account can read the application and write the configured state/log paths. Verify status and logs through the Windows service-management tools.
6. If the bounded restart sequence is exhausted, investigate the service logs and durable queue. Restarting the process does not authorize automatic recovery of interrupted jobs.

## Shared lifecycle contract

The configured `entryPoint` is an application-owned Node.js module. It must construct the trusted orchestrator and explicitly bind the host to the generated storage-directory environment variable:

```js
import {
  createAutonomousExecutionHost,
  createAutonomousExecutionHostService
} from "@jb/expert-qa";

const orchestrator = await createTrustedApplicationOrchestrator();
const storageDirectory = process.env.JB_EXPERT_QA_STORAGE_DIRECTORY;
if (!storageDirectory) throw new Error("Host storage directory is not configured");

const host = createAutonomousExecutionHost({
  orchestrator,
  storageDirectory,
  enabled: true
});
const service = createAutonomousExecutionHostService({
  host,
  signalSource: process,
  onError: error => logger.error({ code: error.code }, "host shutdown failed")
});

service.start();
```

`createTrustedApplicationOrchestrator()` is supplied by the embedding application; it is intentionally not invented or created by the deployment-profile package. The host remains disabled unless the entrypoint explicitly opts in.

- The entrypoint must construct the trusted orchestrator and policy, create the autonomous host with `enabled: true`, create `createAutonomousExecutionHostService({ host, signalSource: process })` and explicitly call `service.start()`.
- Construction remains inert; the operating-system service manager owns boot activation and process-level restart policy.
- Linux systemd delivers `SIGTERM`; WinSW's console stop path delivers Ctrl+C to the Node process, which is handled through `SIGINT`.
- The service adapter awaits the host's existing graceful close. The profile timeout must exceed the longest legitimate in-flight job/worker timeout plus shutdown/flush overhead.
- Jobs found running after process interruption remain quarantined as interrupted. The service manager may restart the process; it must not replay those jobs.
- The Orchestrator remains the only policy, permission, approval and engine-dispatch authority.
- No GitHub Actions polling, hosted scheduler, cloud queue, paid service, shell-based installer or automatic privilege elevation is introduced.

## Validation

Focused tests cover safe path/identity validation, strict option allowlists, accessor rejection, XML escaping, Node argument quoting, non-root Linux identities, bounded restart policy, graceful-stop timeouts and both package export paths.

The Windows profile requires a separately verified WinSW v3 binary at deployment time. This block certifies generated configuration and package behavior; it does not certify a customer host, provision OS identities, install a service, validate production ACLs or authorize production activation.

References:
- [systemd.service — service restart and stop-timeout behavior](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)
- [WinSW v3 — XML configuration, stop timeout and failure actions](https://winsw.github.io/documentation/v3/docs/xml-config-file/)
- [WinSW v3 — service command-line operations](https://winsw.github.io/documentation/v3/docs/cli-commands/)
