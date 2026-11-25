# Phase 6 — Block 6.4: Native Windows Storage Security Verifier

## Objective

Replace the manual Windows token/NTFS inspection callback from Block 6.3 with an optional, built-in, read-only verifier that can be wired directly into the autonomous host bootstrap.

The adapter is separate from the host core. It uses the Windows PowerShell 5.1 executable supplied by Windows, with a fixed encoded program, shell execution disabled, no profile loading, no arbitrary command parameter, and a bounded synchronous execution time.

## Package API

Root export:

    import {
      createPhase4AutonomousHostBootstrap,
      createWindowsPowerShellStorageSecurityVerifier
    } from "@jb/expert-qa";

    const host = createPhase4AutonomousHostBootstrap({
      enabled: true,
      storageDirectory: "C:\\ProgramData\\JB Expert QA",
      signalSource: process,
      apiAllowedOrigins: ["https://api.example.test"],
      policy: productionPolicy,
      approvalGate,
      expectedWindowsServiceSid: "S-1-5-19",
      windowsStorageSecurityVerifier: createWindowsPowerShellStorageSecurityVerifier({
        timeoutMs: 10000
      })
    });

Subpath export:

    import {
      createWindowsPowerShellStorageSecurityVerifier
    } from "@jb/expert-qa/windows-storage-security-powershell";

The expected SID must identify the actual configured service account:
- S-1-5-19: NT AUTHORITY\LOCAL SERVICE
- S-1-5-20: NT AUTHORITY\NETWORK SERVICE

## Native inspection

For each bootstrap preflight and readiness check, the adapter executes the fixed Windows PowerShell 5.1 program and reads:

1. The current process token user SID from WindowsIdentity.GetCurrent().
2. The state directory owner SID from the directory security descriptor.
3. The complete DACL, including explicit and inherited ACEs, with SID, allow/deny type, normalized rights and inheritance flag.
4. Whether the directory DACL is protected from parent inheritance.
5. Whether the target directory or any ancestor is a reparse point. The report is rejected when the ACL exceeds 64 ACEs rather than silently truncating it.

Only drive-letter local paths are accepted. UNC/network paths are rejected. The PowerShell program does not alter ACLs or directory metadata.

## Execution constraints

- Executable is resolved from the Windows SystemRoot directory; it is not searched through an attacker-controlled PATH.
- PowerShell is launched with argument-array invocation and shell: false.
- The script source is fixed and Base64-encoded as UTF-16LE for -EncodedCommand.
- Directory and expected SID are passed as environment values, not interpolated into script source or command text.
- Default timeout is 5 seconds; accepted configuration is 1–15 seconds.
- The inspector refuses to serialize more than 64 ACEs (it never truncates the DACL); captured output is capped at 64 KiB.
- Profiles are disabled and execution is non-interactive.
- Errors are mapped to bounded error codes; stderr and raw system messages are not surfaced in the host diagnostics.

The adapter is synchronous because the host bootstrap's verifier contract is synchronous. A timeout, missing PowerShell executable, failed ACL query, invalid JSON, unsupported path or non-zero process exit is a verification failure and therefore blocks startup.

## Validation remains separate

The adapter returns the observed operating-system report. It does not decide whether the report is acceptable. Block 6.3's validateWindowsStorageSecurityReport() remains the policy authority and rejects reports unless:
- Process identity and directory owner both equal the expected service SID.
- DACL protection is enabled.
- The service has one explicit allow ACE granting modify or full control.
- Only LocalSystem and local Administrators may appear as additional principals, with full control.
- No inherited ACEs, deny ACEs, broad principals, duplicate SIDs or unsupported rights are present.

The same report validator is used whether the evidence comes from the built-in adapter or an application-owned native verifier.

## Provisioning boundary

This block does not create accounts, set an owner, add ACEs, remove inherited permissions, install WinSW, register a service, or elevate privileges.

Before activation, an operator must provision:
- The LocalService or NetworkService service identity in the reviewed service profile.
- A pre-existing local state directory owned by that service SID.
- A protected DACL granting that service modify access and granting LocalSystem/Administrators full control only.

If the existing directory does not meet this policy, the adapter reports its actual state and the host fails closed. The adapter never repairs or weakens permissions automatically.

## Verification

- Unit tests cover platform gating, bounded timeout configuration, accessor rejection and request constraints.
- Windows package-distribution smoke tests invoke the real PowerShell verifier on a temporary directory, inspect its report twice and confirm repeated read-only inspection is stable.
- POSIX package tests confirm imports are side-effect free and that the Windows-only adapter refuses activation outside Windows.
- Existing Core, package, Windows/Linux integration and engine certification suites remain mandatory.

CI exercises the real PowerShell query on hosted Windows runners. It does not establish that a production service identity or production state directory has been provisioned. No production host or OS service is modified by this block.
