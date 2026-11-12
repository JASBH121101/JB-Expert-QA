# JBAE Knowledge Store

## Responsibility

The Knowledge Store provides a versioned persistence boundary for the local product catalog and the append-only evidence ledger. It is independent of Supabase, Neon and paid infrastructure.

## Snapshot schema

Current JSON snapshot schema: `2`.

- `schemaVersion`: KnowledgeStore snapshot version.
- `metadata.createdAt` / `metadata.updatedAt`: canonical ISO 8601 timestamps.
- `evidence`: versioned EvidenceStore export.
- `catalog`: catalog schema version 1 and normalized fragrance/technology products.

Migrations run in ascending version order and validate before writing. v0 migrates to v1 and then v2; v1 gains an empty catalog. Unknown future versions, missing migration steps, malformed products, duplicate product/evidence IDs and dangling product evidence references fail closed.

## Product records

Products are normalized by their dedicated domain adapter and persisted in the same snapshot as evidence. Product IDs are unique across both domains. Each product may reference evidence IDs already present in the evidence ledger; missing references are rejected. The initial store is append-only: duplicate product IDs cannot silently replace records. Possible identity duplicates are surfaced by the local catalog index for human review.

`KnowledgeStore.searchProducts()` rebuilds a deterministic in-memory index from the persisted catalog. The index is derived, local and disposable; the catalog records remain the source of truth. It supports exact and token search, case/diacritic normalization, brand/domain/type filters and bounded result sizes.

## Storage adapter contract

An adapter implements:

- `readSnapshot()`: return the stored JSON snapshot or `null`.
- `writeSnapshot(snapshot)`: atomically replace the snapshot; on failure, the previous committed snapshot must remain intact.

`MemoryKnowledgeAdapter` is the test/reference adapter. `CapacitorSQLiteKnowledgeAdapter` implements durable snapshot reads and writes for an already opened `SQLiteDBConnection`, using a transactional singleton snapshot table. It does not import Capacitor directly; see [Capacitor SQLite adapter](./capacitor-sqlite.md) for integration details and remaining device validation.

## Backup and restore

Exports use the `jbae-knowledge-backup` format and include a backup version, export timestamp and complete knowledge snapshot. Import defaults to a non-destructive merge:

- New evidence and product IDs are appended.
- Identical existing IDs are treated as idempotent duplicates.
- An existing ID with different content is a collision and blocks the entire import.
- Existing records are never silently overwritten or deleted.
- Invalid backups are rejected before storage is changed.

This is a logical JSON backup, not yet a ZIP archive or encrypted backup. Encryption, ZIP packaging and user-controlled file access belong to the Android application layer.

## Concurrency and failure behavior

Writes within one KnowledgeStore instance are serialized. The in-memory committed snapshot changes only after the adapter confirms its write. The Capacitor adapter uses an explicit SQLite transaction and a bound upsert. Node tests exercise rollback using a connection double; native plugin and process-restart behavior still require Android emulator/device validation.
