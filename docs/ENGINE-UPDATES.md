# JB Expert QA — secure engine updates

The updater manages only the three direct engine dependencies:

- `@jb/expert-qa`
- `@jb/security-guard`
- `@jb/malware-engine`

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

The manifest is currently a contract/schema, not a live release feed. Engine npm packages have not been published by this change, and no signing key is generated or stored here. Until a publisher provisions the signing process and publishes packages, `update --check` cannot return live releases.

## Safety checks before installation

1. The manifest signature must verify and its validity window must not be expired.
2. The package name must be in the three-engine allowlist.
3. The tarball URL must use HTTPS and the npm registry host.
4. The current Node.js version must meet the signed minimum.
5. npm stages the exact package version with lifecycle scripts disabled.
6. The staged package version, package-lock integrity, declared entry points and JavaScript syntax are checked.
7. A patch may proceed under the hybrid policy. Minor and major releases need `--approve`.
8. The project must have a package-lock file. Before installing, the updater snapshots `package.json` and `package-lock.json`.
9. The project install runs with lifecycle scripts disabled. The installed version and integrity are checked again.
10. On failure, the updater restores the snapshots and runs `npm ci --ignore-scripts`.
11. Rollback verifies the restored installed version and package integrity against the saved metadata.

Rollback uses the saved lockfile and `npm ci --ignore-scripts`, then checks the installed version and integrity against the backup metadata. Do not delete the backup folder until the update has been validated in the consuming project.

## Limitations

- The updater currently targets npm projects with `package-lock.json`; pnpm and Yarn lockfiles are not modified.
- Local `workspace:`, `file:` and `link:` dependencies are blocked and are never replaced with registry packages.
- The release manifest and detached signature must be supplied by the publisher.
- Beta releases are not applied by the stable CLI path.
- The initial implementation does not schedule background updates. It performs work only when the project owner invokes the command.
- Automatic patch application is only available when `update --apply` is explicitly invoked; there is no silent background installation.
- npm lifecycle scripts are disabled during staging, installation and rollback.
