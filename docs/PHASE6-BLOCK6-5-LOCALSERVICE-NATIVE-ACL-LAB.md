# Phase 6 — Block 6.5: Native Windows ACL Verification Under LocalService

## Objective

Exercise the real Windows PowerShell/.NET storage inspector from Block 6.4 while the inspected Node.js process is actually running as NT AUTHORITY\\LocalService. This closes the gap between testing the report validator with fixtures and proving that the native inspector can read a correctly provisioned service-owned NTFS directory.

The work extends the existing disposable WinSW/Windows Service Control Manager lab. It does not add a production installer or change any customer machine.

## Disposable state-directory provisioning

The Windows lab creates a unique root below C:\\ProgramData for each run. It then provisions the state directory with the exact DACL accepted by the production validator:

- Owner: S-1-5-19 (LocalService).
- Protected DACL: inheritance from the parent is disabled and inherited ACEs are removed.
- LocalService: explicit Modify, applying to child files and directories (OI, CI).
- LocalSystem (S-1-5-18): explicit Full Control, applying to child files and directories.
- Built-in Administrators (S-1-5-32-544): explicit Full Control, applying to child files and directories.
- No other principals or inherited ACEs are retained.

The directory ACL is created inside the disposable lab only. The lab does not modify an existing state directory.

## Native verification executed by the service

The lab copies the production windows-storage-security-native.js and windows-storage-security.js modules into the read-only application fixture. The temporary WinSW service is configured as LocalService and launches a Node fixture that:

1. Reads the live process token and state-directory DACL with readWindowsStorageSecurityReport({ directory, expectedServiceSid: S-1-5-19 }).
2. Passes the returned report through validateWindowsStorageSecurityReport() using the same configured directory and service SID.
3. Writes a startup record only after both operations succeed.
4. Records only boolean verification outcomes (identityVerified, ownerVerified, permissionsVerified, daclProtected); it does not store the raw ACL report.

The lab asserts the whoami identity and all three native verification outcomes. After an SCM restart, it requires the same checks to pass again. It also verifies the checks pass before every deliberate failure-action retry, so a restart cannot bypass storage preflight.

## Existing service lifecycle coverage retained

The lab still verifies the pinned WinSW v2.14.0 executable hash, service installation, first start, graceful stop, restart with a new Node PID and SCM wrapper PID, configured failure-action exhaustion, uninstall, and deletion of all run-specific files/directories.

The Linux systemd lab remains unchanged.

## Evidence

The deployment-lab evidence schema is upgraded to:

jb.expert-qa.host-service-deployment-lab/v2

The Windows result includes:

- nativeStorageVerifier: readWindowsStorageSecurityReport
- nativeStorageAclInspection: passed
- storageOwnerVerified: true
- storageIdentityVerified: true
- storageAclVerified: true

The report still binds the commit SHA, workflow run, platform, runtime, temporary service identifier, profile digest and cleanup scope. It explicitly states that no production host/customer service was touched and no interrupted job was replayed.

## Acceptance criteria

- Windows CI service process reports NT AUTHORITY\\LocalService.
- The live Windows inspector returns a report accepted by the production ACL validator.
- Process identity, owner, DACL protection and approved ACE inheritance are all verified.
- The same native verification passes on SCM restart and every configured restart retry.
- The temporary WinSW service is uninstalled and all run-specific directories are removed.
- CI evidence records the native verifier result for the exact tested commit.

## Boundaries

This is evidence for the LocalService path on a disposable Windows runner. It does not test NetworkService, certify a production device, provision a customer's identity/ACL, authorize service activation, or install any permanent service. Production provisioning and service installation remain operator-controlled.
