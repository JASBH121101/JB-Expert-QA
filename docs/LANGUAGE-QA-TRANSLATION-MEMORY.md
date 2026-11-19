# Translation Memory snapshot contract

`TranslationMemory` remains an in-memory API and does not create a database, file or network connection.

- `exportSnapshot()` returns a deterministic, versioned JSON-compatible snapshot (`schemaVersion: 1`).
- `importSnapshot(snapshot)` validates the schema, plain-data shape, locale pair, status and SHA-256 content fingerprints before mutating the destination memory.
- Approved records are restored only when reviewer metadata and fingerprints match the exact text, locale pair and context.
- Stale records remain stale after import. Pending records cannot smuggle approval metadata.
- Import is atomic. Invalid or tampered data leaves the destination unchanged.
- Existing-key conflicts are rejected by default. `{ replace: true }` is an explicit replacement operation.

Exporting a snapshot does not itself persist it. A caller must decide where to store the JSON and apply its own access control, encryption, retention and backup policy. Do not place confidential translations in public repositories.
