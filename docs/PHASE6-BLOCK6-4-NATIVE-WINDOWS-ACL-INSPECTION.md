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
- Phase 6 Block 6.5 invokes the native PowerShell query inside a disposable WinSW process running as LocalService. The enclosing CI runner is not used as the service identity; it only provisions and removes the isolated test service and state directory. NetworkService and production hosts remain outside this lab's evidence.

## Status

**Merged into `main` through PR #299** at commit `cdfc56a66a5202c12359c84f9f0abc6aa9f0c563` on 2026-11-25. The required Core, Security, Security Guard, package-distribution and JB Engines certification workflows completed successfully for the merged PR head. The native query is restricted to the configured LocalService/NetworkService runtime identity; ordinary hosted Windows CI does not run it as either service account. This merge does not provision a production account or DACL and does not install or activate an OS service.