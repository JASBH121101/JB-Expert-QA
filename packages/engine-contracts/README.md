# JB Engine Contracts

Internal, dependency-free integration primitives for the JB Engines monorepo.

## Scope

This package establishes the common integration boundary. It does not introduce a message broker, network listener, database, scheduler, service installer or production connection. Engines remain independently versioned and independently deployable.

## Public API

- `validateEngineManifest` / `assertEngineManifest`: validate a strict engine descriptor.
- `validateMessageEnvelope` / `assertMessageEnvelope`: validate bounded, JSON-only, advisory messages.
- `evaluateEngineCompatibility`: check engine dependencies, consumed contracts, missing providers and dependency cycles.
- `parseStableVersion` / `compareStableVersions`: stable semantic-version primitives.

## Contract rules

1. Every engine declares an immutable identity and a stable `MAJOR.MINOR.PATCH` version.
2. Every dependency is explicit; no wildcard engine IDs or implicit dependency discovery.
3. Every consumed contract declares a minimum version and maximum compatible major version.
4. Breaking contract changes require a new major version. Additive compatible changes use minor; fixes use patch.
5. Messages are advisory evidence only. A message cannot grant permissions, authorize recovery, select arbitrary commands or bypass the owner-controlled policy gate.
6. Unknown fields, malformed values, unsafe object keys, oversized payloads and unsupported versions are rejected.
7. Engines must not import another engine's private implementation. Communication goes through versioned contracts and host-selected adapters.
8. Missing required dependencies or incompatible contracts block integration. Optional dependencies produce a warning.

## Run tests

```sh
npm --workspace @jb/engine-contracts test
```

Node.js 22 or newer is required. No external services or credentials are used.
