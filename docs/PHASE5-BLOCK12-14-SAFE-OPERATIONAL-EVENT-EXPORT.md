# Phase 5 — Block 12.14: Safe Operational Event Export

## Gap

Block 12.13 made the Phase 5 operational timeline inspectable in the Control Center, but operators could not save the currently filtered, already-loaded sanitized records for offline review.

## Scope

- Add JSON and CSV export actions for the timeline's currently loaded event page(s).
- Export only the bounded event records already returned by the read-only journal API; exporting never triggers a new audit, execution or job operation.
- Project records onto an explicit field allowlist, including only approved non-negative numeric resource counters.
- CSV cells are quoted and text values beginning with spreadsheet formula/control prefixes are neutralized.
- Export is limited to events loaded in the current UI session/page state; no unbounded journal export or hidden server endpoint is introduced.
- Disable export when the journal is unavailable or no records are loaded.
- Use client-side Blob download and no third-party dependency.

## Validation

- Projection excludes PID, raw payload, arbitrary nested data and unknown fields.
- Resource metric projection accepts only allowlisted non-negative safe integers.
- CSV quoting handles commas, quotes and line breaks.
- Formula-prefix neutralization covers =, +, -, @, tab and carriage return.
- Empty event exports are valid; invalid input arrays are rejected.
- Dashboard existing security and timeline tests, Core Validation, Security QA, Security Guard, JB Engines Certification and native containment labs.
- All post-merge checks must pass on the same main SHA.

**Block 12.14 is complete only after safe export projection, formula-injection defenses, UI integration and post-merge certification pass.**
