# Phase 6 — Block 6.3: Windows Host Storage Identity and ACL Gate

## Objective

Make Windows host startup fail closed when the process identity and state-directory NTFS permissions cannot be verified. The gate closes the gap identified in the Phase 5 independence certificate: POSIX owner/mode checks were performed by the bootstrap, while Windows ACLs were left to manual operator verification.

This block does not install an operating-system service, create a Windows account, change NTFS permissions or elevate privileges.

## Windows startup contract

On Windows, the bootstrap now requires both:

- `expectedWindowsServiceSid`: exactly `S-1-5-19` (LocalService) or `S-1-5-20` (NetworkService), matching the selected service profile.
- `windowsStorageSecurityVerifier`: a synchronous, trusted application/deployment callback that inspects the actual process token and the complete effective DACL for the configured state directory.

The state directory must already exist. The bootstrap does not create a Windows directory using inherited/default ACLs and then assume it is private.

The callback receives a frozen object:

```js
{
  directory: "C:\\ProgramData\\JB Expert QA",
  expectedServiceSid: "S-1-5-19"
}
```

It must return a plain data object with this exact schema:

```js
{
  directory: "C:\\ProgramData\\JB Expert QA",
  processIdentitySid: "S-1-5-19",
  ownerSid: "S-1-5-19",
  daclProtected: true,
  accessEntries: [
    {
      sid: "S-1-5-19",
      type: "allow",
      access: "modify",
      inherited: false
    },
    {
      sid: "S-1-5-18",
      type: "allow",
      access: "full-control",
      inherited: false
    }
  ]
}
```

The example is a schema illustration, not a report to hardcode in production. The callback must obtain the current process token SID and directory owner from Windows security APIs, enumerate the complete DACL, and report every effective ACE. It must not infer permissions from the directory's existence or from a successful write test.

## Validation policy

The package validator rejects the report unless all of these conditions hold:

1. The reported path exactly matches the normalized configured state directory.
2. The actual process identity and directory owner both match the expected LocalService or NetworkService SID.
3. The directory DACL is protected from parent inheritance.
4. Every reported ACE is an explicit allow entry; inherited entries and deny entries are rejected.
5. The service identity has explicit `modify` or `full-control` access.
6. The only other permitted principals are LocalSystem (`S-1-5-18`) and local Administrators (`S-1-5-32-544)); these may have `full-control` only.
7. Broad principals such as Everyone, Authenticated Users and built-in Users, unknown SIDs, duplicate entries, accessors, sparse arrays and extra report fields are rejected.

The validation helper returns only sanitized boolean evidence. Raw paths and ACL details are not copied into the bootstrap diagnostics.

## Application wiring

```js
import {
  createPhase4AutonomousHostBootstrap,
  validateWindowsStorageSecurityReport
} from "@jb/expert-qa";

// Implement this callback with a trusted native Windows security adapter.
// The adapter must inspect the live process token and full effective NTFS DACL.
function windowsStorageSecurityVerifier({ directory, expectedServiceSid }) {
  const nativeReport = readActualWindowsSecurityState(directory);
  return nativeReport;
}

const host = createPhase4AutonomousHostBootstrap({
  enabled: true,
  storageDirectory: "C:\\ProgramData\\JB Expert QA",
  signalSource: process,
  apiAllowedOrigins: ["https://api.example.test"],
  policy: productionPolicy,
  approvalGate,
  expectedWindowsServiceSid: "S-1-5-19",
  windowsStorageSecurityVerifier
});
```

`readActualWindowsSecurityState()` above is intentionally an application-owned placeholder, not an exported package function. The application must implement and independently review it against the host's real token and NTFS ACL. The package's `validateWindowsStorageSecurityReport()` validates the returned contract; it does not itself query Windows or make an untrusted callback trustworthy.

The same options pass through the Phase 4 integration factory into the autonomous host bootstrap. POSIX startup continues to use the existing realpath, owner, mode and private write-probe checks.

## Failure behavior

- Missing verifier or expected SID: `WINDOWS_STORAGE_SECURITY_REQUIRED`.
- Verifier execution failure: `WINDOWS_STORAGE_SECURITY_VERIFICATION_FAILED`.
- Malformed, mismatched or overbroad ACL attestation: `WINDOWS_STORAGE_SECURITY_INVALID`.
- Missing Windows state directory: `STORAGE_DIRECTORY_MISSING`; the bootstrap does not create it.
- Any failed preflight prevents host construction, lock acquisition, signal registration and runner startup.
- The same verification is repeated by readiness checks while the host is running.

## Verification scope

Unit tests cover exact report shape, service SID and owner matching, protected DACL, explicit allow-only ACEs, allowed principals, rights, duplicate entries, inherited/deny ACEs and accessor rejection. The Windows CI host fixtures use a synthetic verifier to exercise the fail-closed integration contract; they do not constitute evidence of ACL correctness on a production machine.

Production activation still requires an independently implemented native Windows verifier, operator-provisioned service identity and directory ACL, a reviewed WinSW profile, and an operator-controlled installation. No host machine or service is modified by this block.
