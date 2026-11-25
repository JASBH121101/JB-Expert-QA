# Phase 6 — Block 6.4: Native Windows Storage Security Verification

## Purpose

Provide a built-in, read-only Windows verifier so the Phase 4 autonomous-host bootstrap no longer requires an application-supplied ACL inspection callback for the standard Windows service identities.

## Runtime behavior

- The verifier runs only on Windows and queries the active process SID, directory owner SID, DACL protection state, and complete explicit/inherited NTFS access entries.
- It uses Windows PowerShell and .NET access-control APIs through `execFileSync` with no shell, a fixed script, a base64-encoded path argument, a five-second timeout, and a bounded output buffer.
- It does not create directories, change owners, alter ACLs, enable inheritance, or grant permissions.
- The process identity and directory owner must match the configured LocalService (`S-1-5-19`) or NetworkService (`S-1-5-20`) identity.
- The DACL must be protected from parent inheritance and contain only explicit allow entries for the service identity (Modify), LocalSystem (Full Control), and built-in Administrators (Full Control).
- Each allowed entry must apply to both child files and child directories, and must not be inherit-only.
- Broad principals, deny entries, unknown SIDs, duplicate entries, inherited entries, missing child inheritance, or incomplete rights cause preflight to fail closed.
- A private write/fsync/delete probe still runs after the ACL inspection.

## Application wiring

For a host configured to run as LocalService, supply `expectedWindowsServiceSid: "S-1-5-19"` to `createPhase4AutonomousHostBootstrap`. For NetworkService, use `"S-1-5-20"`. `windowsStorageSecurityVerifier` may still be supplied to replace the built-in inspector with a separately reviewed native integration; it is no longer mandatory when the expected SID is supplied.

The service must actually run under the configured Windows identity, and the operator must provision the state directory with the matching owner and protected DACL before startup. Bootstrap intentionally refuses to create a Windows state directory because doing so without a pre-provisioned ACL could inherit unsafe permissions.

## Verification limits

The query confirms the current process SID and directory DACL at preflight/readiness time. It does not verify the service manager configuration, prove the executable path is trusted, change the DACL, or provision a Windows service. The service profile remains a pure configuration generator. Installation and activation remain separate operator-controlled steps.

## Tests

- Existing report-contract tests validate owner, identity, protected DACL, explicit allow-only principals, access levels, and accessor/hole rejection.
- This block adds validation that ACEs cover child files and directories and are not inherit-only.
- The native PowerShell query is only executed by Windows under the configured LocalService or NetworkService identity; ordinary Windows CI runners do not satisfy that deployment identity and must not weaken the test contract to pass.

## Status

Implementation is submitted for CI and review. A passing test suite does not mean a service has been installed or activated.