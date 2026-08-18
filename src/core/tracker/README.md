# core/tracker

Tracker domain. This folder owns tracker-adapter-facing read/reconcile behavior:
tracker item persistence, reconciliation and its run records, and tracker-backed
intent generation.

- `items.ts` - durable tracker items, snapshots, and goal links.
- `reconciliation.ts` - Linear reconciliation over the tracker tables.
- `reconciliation-runs.ts` - durable reconciliation run records.
- `intent-generator.ts` - `source_satisfied` intent generation
  from goal completion plus verification evidence.

Tracker adapters are read-only with respect to external systems: they write
only Momentum tracker tables, tracker snapshots, reconciliation runs, evidence,
and local intents (durable `intents` rows).
