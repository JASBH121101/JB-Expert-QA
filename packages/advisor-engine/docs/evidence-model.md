# JBAE Evidence Model

## Record lifecycle

Evidence is append-only. A correction is a new record with a new ID; existing records are not silently overwritten or deleted. Each claim is scoped to a domain, subject, and field and records its source, observation timestamp, status, and confidence. Values are cloned and deeply frozen as JSON-compatible data when a record is created, preventing callers from mutating historical evidence after insertion.

## Status semantics

- `verified`: supported by an authoritative source for the stated claim.
- `cross_checked`: corroborated by more than one suitable source.
- `reported`: attributed to a source but not independently confirmed.
- `unconfirmed`: candidate claim requiring validation.
- `not_found`: a search was performed but no suitable evidence was located.
- `unavailable`: the information could not be accessed or checked.

A status is not inferred from confidence. The caller must set both explicitly.

## Performance evidence

Customer-facing fragrance duration estimates are intervals, not promises. Longevity and projection-duration intervals require independently tested, field-matched evidence for both the minimum and maximum endpoints. A product-level interval without evidence IDs for both bounds is not eligible for display. Performance claims from community sources remain reported; they require explicit opt-in and must retain a reported-observation disclaimer. Manufacturer marketing statements do not qualify as independent wear-test evidence.

`confidence` remains a source-assessment value, not a probability that a customer will experience the stated result. The performance profile reports evidence strength and provenance separately from the interval itself.

## Conflict handling

The ledger detects differing values for the same domain, subject, and field. It does not automatically choose a winner. Resolution requires source assessment and, where appropriate, a new evidence record documenting the resolution. Conflicting claims remain available for audit.

## Storage boundary

`EvidenceStore` is the in-memory reference ledger and provides versioned JSON export/import. Persistent application state is managed by `KnowledgeStore`, which stores both the evidence ledger and domain-separated product catalog in a validated, versioned snapshot. The current SQLite adapter persists that snapshot transactionally through an already opened Capacitor `SQLiteDBConnection`.

The repository does not yet install the native Capacitor SQLite plugin or provide the Android shell that opens and manages the connection. Node tests use a fake SQLite connection; native persistence and process-restart recovery still require emulator/physical-device validation.
