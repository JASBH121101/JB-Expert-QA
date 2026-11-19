# Resilience Engine A2/A3 scope decision

**Decision date:** 2026-11-19  
**Decision:** A2 and A3 are excluded from the engine closeout and will not be implemented.

## Retained scope
- A0 observation: retained for verification/certification.
- A1 controlled restart: retained for laboratory verification/certification.

## Excluded scope
- A2 containment/reconciliation: excluded. Not implemented, not certified, and not enabled.
- A3 distributed failover: excluded. Not implemented, not certified, and not enabled.

SCCM inventory nodes for these capabilities remain `inScope: false`. New ledger entries record the approved scope decision only; they are **not technical certification** of A2 or A3. They must not be presented as available, deployable, or pending implementation.

This scope reconciliation does not authorize production deployment or change any runtime policy.
