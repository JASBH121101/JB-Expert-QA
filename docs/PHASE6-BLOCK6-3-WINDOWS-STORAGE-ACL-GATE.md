# Phase 6 — Block 6.3: Windows Host Storage Identity and ACL Gate

## Objective

Make Windows autonomous-host startup fail closed unless the live process identity and persistent state-directory NTFS permissions are verified. The policy is enforced by the repository's report validator and is connected to the native inspector delivered in Block 6.4.

This block does not create Windows accounts, change ACLs, install services, elevate privileges or modify a host machine.

## Windows startup contract

When running on Windows, bootstrap requires:
- `expectedWindowsServiceSid`: `S-1-5-19` (LocalService) or `S-1-5-20` (NetworkService), matching the service profile.
- A pre-existing local state directory. Windows bootstrap deliberately does not create it.

When the embedding application does not provide a custom `windowsStorageSecurityVerifier`, the bootstrap uses the built-in `readWindowsStorageSecurityReport()` inspector from Block 6.4. A custom verifier remains possible but must be a trusted, separately reviewed native integration that returns the same report contract.

The built-in inspector reads the current process token SID, directory owner SID, DACL protection state and every explicit/inherited access entry. The validator independently decides whether the evidence satisfies policy.

## Validation policy

The report is accepted only when:
1. The inspected directory matches the configured storage directory.
2. The current process identity and directory owner both match the expected LocalService or NetworkService SID.
3. The DACL is protected from parent inheritance.
4. Every ACE is an explicit allow entry; deny and inherited ACEs are rejected.
5. The service identity has explicit Modify or Full Control.
6. The only additional principals are LocalSystem (`S-1-5-18`) and local Administrators (`S-1-5-32-544`), with Full Control only.
7. Every permitted ACE applies to both child files and child directories and is not inherit-only.
8. Broad principals, unknown/duplicate SIDs, unsupported rights, accessors, sparse arrays and extra report fields are rejected.

The validator returns sanitized boolean evidence only. Raw paths and ACL details are not copied into bootstrap diagnostics.

## Application wiring

For a LocalService deployment:

```js
import { createPhase4AutonomousHostBootstrap } from "@jb/expert-qa";

const host = createPhase4AutonomousHostBootstrap({
  enabled: true,
  storageDirectory: "C:\\ProgramData\\JB Expert QA",
  signalSource: process,
  apiAllowedOrigins: ["https://api.example.test"],
  policy: productionPolicy,
  approvalGate,
  expectedWindowsServiceSid: "S-1-5-19"
});
```

For NetworkService, use `expectedWindowsServiceSid: "S-1-5-20"`. The built-in inspector is selected automatically when the expected SID is supplied and no custom verifier is configured.

POSIX continues using the existing realpath, owner, mode and private write/fsync/delete probe checks.

## Failure behavior

- Missing expected SID or verifier: Windows storage preflight fails closed.
- Native PowerShell query failure or malformed report: startup is blocked.
- Mismatched identity/owner, unprotected DACL or unsupported ACE: `WINDOWS_STORAGE_SECURITY_INVALID`.
- Missing Windows state directory: `STORAGE_DIRECTORY_MISSING`; no directory is created.
- Failed preflight prevents host construction, lock acquisition, signal registration and runner startup.
- Storage security is rechecked during readiness.

## Verification scope

The validator unit tests cover identity/owner matching, protected DACL, explicit allow-only principals, rights, duplicate entries, inherited/deny ACEs, child file/directory inheritance, inherit-only rejection and accessor/hole rejection. Phase 6 Block 6.5 extends the disposable WinSW service-manager lab: the workflow runner provisions an isolated state directory, starts a temporary LocalService process, and that service process executes the real PowerShell inspector and report validator against its own token and the directory's NTFS DACL. This is CI evidence for the LocalService path only; it does not certify NetworkService or any production host.

The built-in native inspector is documented in `docs/PHASE6-BLOCK6-4-NATIVE-WINDOWS-ACL-INSPECTION.md`. Production still requires operator provisioning of the service identity and protected state-directory DACL, plus a reviewed service profile and operator-controlled installation. No machine or service is modified by these code blocks.
