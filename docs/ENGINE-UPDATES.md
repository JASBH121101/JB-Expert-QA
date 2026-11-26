# JB Expert QA — secure engine updates

The updater can manage these direct engine dependencies when a signed release is actually published:

- `@jb/expert-qa`
- `@jb/security-guard`
- `@jb/malware-engine`
- `@jb/resilience-engine`
- `@jb/advisor-engine` (JBAE)

It does not modify application source files, deploy applications, publish packages, or contact an AI provider. Visual QA remains deterministic and local-first.

## Current operating model

The updater is deliberately fail-closed. The project owner supplies a signed release manifest and a trusted Ed25519 public key. No publisher key, release URL, package publication, or paid service is configured by this repository.

Check available updates without changing project files:

```bash
jb-qa update --check --manifest ./engine-manifest.json --public-key ./trusted-update-key.pem
```

Apply a verified patch release:

```bash
jb-qa update --apply @jb/expert-qa --manifest ./engine-manifest.json --public-key ./trusted-update-key.pem
```

Minor and major releases require explicit approval:

```bash
jb-qa update --apply @jb/security-guard --manifest ./engine-manifest.json --public-key ./trusted-update-key.pem --approve
```

Restore a previous installation:

```bash
jb-qa update --rollback 20261114004522-a1b2c3d4
```

The backup ID is printed after a successful installation. Backups are stored under `.jb-expert-qa/update-backups/`.

## Manifest format

The manifest is JSON and is accompanied by a detached Base64 Ed25519 signature at `<manifest-path>.sig` (or `<manifest-URL>.sig`). The signature covers the exact UTF-8 bytes of the manifest.

```json
{
  "schemaVersion": 1,
  "channel": "stable",
  "issuedAt": "2026-11-14T00:00:00.000Z",
  "expiresAt": "2026-11-21T00:00:00.000Z",
  "packages": {
    "@jb/expert-qa": {
      "version": "0.2.1",
      "nodeMinMajor": 22,
      "dist": {
        "tarball": "https://registry.npmjs.org/@jb%2fexpert-qa/-/expert-qa-0.2.1.tgz",
        "integrity": "sha512-BASE64_SHA512_DIGEST"
      }
    }
  }
}
```

A manifest must be signed by a trusted Ed25519 private key held by the publisher. The matching public key may be distributed to consumers; the private key must never be committed to this repository or embedded in an installed package. Configure it locally with `--public-key` or the `JB_QA_UPDATE_PUBLIC_KEY` environment variable.

The updater manifest contract is implemented, and JBAE is included in the engine allowlist. The repository now prepares JBAE version 0.1.1 as a patch-release candidate and contains a guarded manifest-signing pipeline. This is not a published npm package or a live update feed. Public distribution remains blocked while the package license is UNLICENSED, the repository approval variable is unset, and the authorized signing/publishing configuration is incomplete. The release workflow deliberately fails closed until all gates are satisfied.

## Safety checks before installation

1. The manifest signature must verify and its validity window must not be expired.
2. The package name must be in the five-engine allowlist.
3. The tarball URL must use HTTPS and the npm registry host.
4. The current Node.js version must meet the signed minimum.
5. npm stages the exact package version with lifecycle scripts disabled.
6. The staged package version, package-lock integrity, declared entry points and JavaScript syntax are checked.
7. A patch may proceed under the hybrid policy. Minor and major releases need `--approve`.
8. The project must have a `package-lock.json` and a working `npm test` script. Before installing, the updater snapshots `package.json` and `package-lock.json`.
9. The project install runs with lifecycle scripts disabled.
10. The updater runs the project's `npm test` script after installation. This project-defined code runs only because the owner explicitly invoked `update --apply`.
11. The installed package version, lockfile integrity, entry points and JavaScript syntax are checked again after the test command.
12. If installation, project tests or post-install verification fail, the updater restores the snapshots and runs `npm ci --ignore-scripts`.
13. Rollback verifies the restored installed version and package integrity against the saved metadata.

The updater does not treat package syntax checks as a substitute for the consuming project's tests. A missing or failing `npm test` script blocks the update and triggers rollback. Rollback uses the saved lockfile and `npm ci --ignore-scripts`, then checks the installed version and integrity against the backup metadata. Do not delete the backup folder until the update has been validated in the consuming project.

## Limitations

- The updater currently targets npm projects with `package-lock.json`; pnpm and Yarn lockfiles are not modified.
- Local `workspace:`, `file:` and `link:` dependencies are blocked and are never replaced with registry packages.
- The release manifest and detached signature must be supplied by the publisher.
- Beta releases are not applied by the stable CLI path.
- The initial implementation does not schedule background updates. It performs work only when the project owner invokes the command.
- Automatic patch application is only available when `update --apply` is explicitly invoked; there is no silent background installation.
- npm lifecycle scripts are disabled during staging, installation and rollback.



## JBAE stable release feed

The stable JBAE manifest is served directly from the repository's raw-content endpoint after a successful authorized npm publication:

    https://raw.githubusercontent.com/JASBH121101/JB-Expert-QA/main/releases/stable/jbae-update-manifest.json

Its detached Ed25519 signature is available by appending .sig to that URL. The pinned public verification key is stored at:

    releases/stable/jbae-update-public-key.pem

Copy that public key into the consuming host application through its trusted-key configuration. Do not download a new key automatically from the same manifest origin and treat it as trusted. The host must already trust this pinned public key.

Check for a JBAE update:

    jb-qa update --check --manifest https://raw.githubusercontent.com/JASBH121101/JB-Expert-QA/main/releases/stable/jbae-update-manifest.json --public-key ./trusted-jbae-update-key.pem

Apply an approved patch update:

    jb-qa update --apply @jb/advisor-engine --manifest https://raw.githubusercontent.com/JASBH121101/JB-Expert-QA/main/releases/stable/jbae-update-manifest.json --public-key ./trusted-jbae-update-key.pem

The release workflow is triggered by a tag named npm-advisor-engine-v followed by the exact package version (for the current candidate, npm-advisor-engine-v0.1.1). Before that tag can publish anything, the package must have an explicitly approved non-UNLICENSED license, the repository Actions variable JBAE_DISTRIBUTION_APPROVED must be set to true, npm Trusted Publishing must be configured for this repository/workflow, and the Actions secret JBAE_UPDATE_SIGNING_PRIVATE_KEY must contain the private PEM matching the pinned public key.

The publisher private key is never committed to this repository. The workflow builds and tests the package, computes the npm tarball integrity, creates a seven-day stable manifest, verifies its Ed25519 signature, publishes the package through npm OIDC Trusted Publishing, confirms that npm serves the exact tarball/integrity described by the manifest, and only then commits the manifest and detached signature to main. If any preflight, test, signing, publication, integrity, or feed-commit step fails, no new manifest is served.

The pinned public key fingerprint (SHA-256 of the PEM file) is b3e5a5d6d99150da2760984997ad40b4ed5e3985c07aba7d4b2925991dd07c4f. Keep the private key confidential and retain an offline backup.
