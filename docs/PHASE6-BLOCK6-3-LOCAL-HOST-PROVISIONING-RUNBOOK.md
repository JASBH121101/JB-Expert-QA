# Phase 6 — Block 6.3: Local Host Provisioning Runbook

## Scope

This block prepares the operator to provision a dedicated local JB Expert QA autonomous host. It is documentation-only and does **not** create accounts, change ACLs, install service managers, install dependencies, start the host, or modify any machine.

## Deployment guardrails

- Use a dedicated, non-administrator/non-root identity for runtime.
- Do not run the QA host as root, Administrator, or an interactive personal account.
- Provision only on a machine owned or explicitly administered by the operator.
- Keep host runtime, working directory, and persistent state separate.
- Store the state directory outside the repository and outside user profile downloads.
- No secrets or API keys in the repository, profile files, logs, or approval queue.
- Use explicit allowlists, least-privilege permissions, and human approval for sensitive actions.
- Start in disabled/offline mode; activation must be a separate, reviewed operation.
- Never enable auto-recovery of interrupted jobs until recovery semantics are separately certified.

## Linux (systemd) preparation

1. Select a dedicated service account and group (not root), and record the account name in the deployment worksheet.
2. Install Node.js using the operator-approved system package source. Confirm the Node version is supported by this repository metadata.
3. Check out a reviewed commit into a root-owned, read-only application directory. The runtime identity must not modify source files or package dependencies.
4. Create a separate persistent state directory for the service identity. It must be absolute, non-root, owned by the service identity, and mode `0700`.
5. Validate the path contains no symlink traversal. Confirm bootstrap storage preflight and private write probe pass.
6. Generate the systemd profile with `createSystemdHostServiceProfile`; inspect generated text before manual installation.
7. Verify the unit has a non-root identity, restrictive `UMask=0077`, `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, and a single state-directory write exception.
8. Do not install, enable, or start the service until the PR and host readiness checklist are approved.

## Windows preparation

1. Use a dedicated standard service identity; do not use an interactive personal account or LocalSystem.
2. Keep application files in an administrator-managed directory outside user profiles. Runtime identity has read/execute only.
3. Create a separate state directory and configure NTFS ACLs so only the service identity and administrators have access. Verify inherited broad permissions are removed.
4. Configure `expectedWindowsServiceSid` to match the service identity (`S-1-5-19` for LocalService or `S-1-5-20` for NetworkService). Block 6.4 adds a read-only PowerShell verifier that checks the active process SID, directory owner, protected DACL, approved explicit principals, required Modify/Full Control grants, and inheritance to child files/directories. The verifier does not change ACLs; the operator must provision the protected DACL before startup. Query or policy failures block preflight.
5. If using WinSW, obtain the wrapper from an official source and verify its signature/hash against the vendor release. Review XML and account settings before installation.
6. Do not install, enable, or start a Windows service until the PR and host readiness checklist are approved.

## Deployment worksheet

Record locally (do not commit private paths, usernames, secrets, or hostnames):

- Host OS/version and architecture
- Node runtime version
- Reviewed JB Expert QA commit SHA
- Dedicated service identity
- Application directory (read-only to runtime identity)
- Persistent state directory (private and writable only by service identity/admins)
- Dashboard bind address (loopback only)
- External access status (disabled)
- Human approval gate status (enabled; no auto-approve)
- Execution permissions and engine allowlist (least privilege)
- Storage preflight and lock/ledger readiness results
- Operator and approval date

## Activation gates (all required)

- [ ] Reviewed commit is pinned and reproducible.
- [ ] Runtime identity is dedicated, non-admin, and verified.
- [ ] Application files are read-only to runtime identity.
- [ ] State path is private, non-symlink, and write-probe verified.
- [ ] On Windows, the state directory is pre-provisioned with a protected DACL for the configured service SID, SYSTEM, and Administrators; host preflight confirms the identity, owner, access grants, and child inheritance.
- [ ] Dashboard is loopback-only; no public network binding.
- [ ] Human approval gate wired and tested; approvals never automatic.
- [ ] Engine allowlist and policy limits reviewed.
- [ ] No external-network permissions unless separately approved and scoped.
- [ ] No interrupted-job auto-recovery enabled.
- [ ] Shutdown and signal handling tested.
- [ ] Smoke tests run in a disposable state directory.
- [ ] Activation approved by operator.

## Rollback / stop

Stop service using the service manager graceful-stop operation. Confirm host reports closed and persistent locks are released. Preserve the ledger for review. Do not delete state or resume interrupted work automatically. Disable startup only through operator service-manager controls.

## Status

This runbook is a preparation artifact. It does not certify an installed host or imply that provisioning or activation has occurred.