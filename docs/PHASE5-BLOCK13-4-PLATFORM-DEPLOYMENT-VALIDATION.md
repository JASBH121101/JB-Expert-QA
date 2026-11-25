# Phase 5 — Block 13.4: Platform Deployment Profile Validation

## Purpose

Validate the generated Expert QA service profiles through the actual operating-system service managers on disposable GitHub-hosted runners. This closes the gap between generating reviewable configuration text (Block 13.3) and demonstrating that the exact generated profile can be parsed, installed, started, stopped and removed on the target platform.

This is CI-only platform evidence. It is not a customer-host or production deployment certification.

## Linux — generated systemd unit

The Ubuntu 24.04 lab:

1. Creates a unique temporary system user and matching group with no login shell and no home directory.
2. Creates a root-owned, read-only application directory and a state directory writable only by the generated service identity.
3. Installs a minimal Node.js host fixture that records its effective UID, PID and configured state path. It handles SIGTERM and SIGINT by writing a shutdown marker before exiting.
4. Generates the systemd unit using `createSystemdHostServiceProfile()`.
5. Runs `systemd-analyze verify` against the generated unit and `systemd-analyze security` against the loaded unit.
6. Installs the generated unit under `/etc/systemd/system`, reloads systemd, enables it, starts it and verifies that the fixture runs with a non-root UID.
7. Restarts it through systemd and verifies that the original process wrote its SIGTERM shutdown marker and a new PID was started.
8. Stops the unit and verifies its graceful shutdown marker.
9. Resets the start-rate counter, deliberately makes the fixture exit non-zero, and verifies that `StartLimitBurst=3` is enforced at exactly three starts within the configured interval.
10. Disables and removes the disposable unit, reloads systemd, removes its state/application directories and deletes the temporary user/group.

The unit and all files use a run-specific service identity and path. The lab never writes to an existing service unit or existing application state.

## Windows — generated WinSW v2 profile and Service Control Manager

The Windows Server 2022 lab:

1. Downloads the official WinSW v2.14.0 x64 release asset and verifies its pinned SHA-256 before executing it.
2. Creates a unique disposable application, state and log directory under `C:\\ProgramData`.
3. Grants `NT AUTHORITY\\LOCAL SERVICE` read/execute access to the application tree and modify access to logs. The state directory is more restrictive: inherited ACEs are removed, the owner is set to LocalService, and the protected DACL contains only LocalService (Modify), LocalSystem (Full Control), and built-in Administrators (Full Control), with object/container inheritance enabled.
4. Generates the Windows profile using `createWindowsHostServiceProfile()`. The profile explicitly uses WinSW v2's `<serviceaccount><domain>NT AUTHORITY</domain><user>LocalService</user></serviceaccount>` format.
5. Places the verified WinSW executable beside the generated XML, installs the service and starts it.
6. The Node fixture runs as LocalService, loads the native Windows storage inspector and ACL report validator from the isolated app directory, and queries its live process token plus the protected state-directory DACL. It must validate the expected service SID, owner, explicit ACE allowlist and child file/directory inheritance before writing its startup record. The lab fails if any native verification flag is false.
7. Stops and restarts the service through `sc.exe`, verifies Ctrl+C graceful shutdown markers, a new Node PID and a new SCM service-process PID.
8. Stops the service gracefully again.
9. Makes the fixture exit non-zero and verifies the generated WinSW failure sequence (one-second retry, two-second retry, then `none`) results in exactly three failing starts and a stopped service.
10. Uninstalls the service and removes the disposable files/directories.

The pinned WinSW asset is:

- Release: `v2.14.0`
- Asset: `WinSW-x64.exe`
- SHA-256: `4ebd9dc3e817f80b2bd8c18f5bfe0d550241c1d08b57bd9694777a6e56a7b24f`

The official WinSW release page identifies v2.14.0 as the stable 2.x release; the 3.x documentation line remains a pre-release. The lab deliberately validates against the stable v2 XML schema. In particular, the service-account element uses `domain` and `user`, and delayed automatic startup is represented by the empty `<delayedAutoStart />` element.

## Evidence

Each successful platform job emits one JSON artifact using schema:

`jb.expert-qa.host-service-deployment-lab/v1`

The report binds:
- source commit SHA and workflow run ID;
- generation time and runtime/platform/architecture;
- OS service identifier, service identity and profile SHA-256;
- exact wrapper version and verified digest on Windows;
- pre/post process identifiers and graceful signal result;
- restart-limit attempt count and enforcement result;
- final state and successful cleanup;
- explicit scope flags that no production host/customer service was tested and interrupted jobs were not replayed.

The workflow retains each platform artifact for 30 days. Evidence is valid only for the exact commit and disposable runner recorded in the report.

## Validation gate

The Block 13.4 PR must pass the focused profile tests, Core Validation, Security QA, Language QA, Security Guard multi-runtime, PostgreSQL integration, package distribution, JB Engines Integration Certification and JB Engines Certification on one identical PR head.

A passing CI lab proves only the generated profile worked on that runner with that OS/runtime and pinned wrapper. It does not provision production service accounts, validate a customer's ACL baseline, authorize deployment, or guarantee an application's readiness. Production installation remains an operator-controlled release activity.
