# Capacitor SQLite adapter

## Status

The engine contains a durable adapter for an already opened `SQLiteDBConnection` from `@capacitor-community/sqlite`. It is exported through the public engine entry point and implements the KnowledgeStore storage contract without importing Capacitor directly.

The Android application shell has not yet been created, so the plugin is not installed in this repository and there is no physical-device persistence claim.

## Plugin contract

The adapter targets `query`, `execute`, `run`, `beginTransaction`, `isTransactionActive`, `commitTransaction` and `rollbackTransaction`. Manual transaction methods were introduced in plugin version 5.0.7. Explicit transaction blocks call `execute` and `run` with the per-statement transaction argument set to `false`, and check that the transaction actually became active.

The application shell should:
1. Install a Capacitor-compatible release of `@capacitor-community/sqlite` with manual transaction support (5.0.7 or later).
2. Create and open the database through the plugin's SQLiteConnection wrapper.
3. Pass its opened `SQLiteDBConnection` to `new CapacitorSQLiteKnowledgeAdapter({ db })`.
4. Pass that adapter to `KnowledgeStore.open({ adapter })`.
5. Manage the connection lifecycle from the application shell, including close/release when appropriate.

The plugin documentation assigns DDL to `execute`, parameterized writes to `run`, SELECT statements to `query`, and documents manual transaction control.

## Durable schema

SQLite `PRAGMA user_version` is independent of the JSON KnowledgeStore schema version. Physical SQLite schema version 1 creates a singleton table. This physical SQLite schema version is independent of the JSON KnowledgeStore snapshot schema, currently version 2:

- `singleton`: primary key constrained to 1.
- `snapshot_json`: complete validated KnowledgeStore snapshot.
- `updated_at`: snapshot update timestamp.

The adapter refuses a database version newer than supported and refuses a current-version database missing the expected state table. Physical schema migrations must increment the SQLite schema version and preserve existing user data.

## Atomic writes and recovery

Snapshot writes use bound parameters inside an explicit SQLite transaction:
- begin transaction and verify it is active;
- validate the snapshot;
- upsert the complete JSON snapshot;
- commit;
- roll back on any failure.

Schema initialization is also transactional. The adapter does not publish a new in-memory KnowledgeStore snapshot until the adapter confirms the durable write. Writes are serialized per adapter instance.

Malformed JSON, unsupported database versions, a missing state table, inactive transactions, plugin error results and missing connection methods fail closed.

## Test boundary

Node tests use a fake SQLite connection to model transaction snapshots, rollback, schema version PRAGMA, table creation, bound writes and query results. These tests validate adapter behavior and SQL contract handling, not the native SQLite plugin binary. Device validation still requires an Android Capacitor shell, native plugin installation, emulator/device execution, and a process-kill/restart recovery test.
