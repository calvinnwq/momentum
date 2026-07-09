# core/source

Source domain. This folder owns source-adapter-facing read/reconcile behavior:
source item persistence, reconciliation and its run records, and source-backed
update-intent generation. It holds business/runtime behavior only -
persistence, reconciliation logic, and state - and does not parse CLI arguments
or format output. Concrete adapters (Linear, etc.) stay under `src/adapters/`.

These modules were regrouped from the former flat `src/*.ts` root siblings
(ARCH-05) with no behavior change. The redundant `source-` prefix was dropped
where the folder now carries the domain (`source-items.ts` to `items.ts`,
`source-reconciliation.ts` to `reconciliation.ts`,
`source-reconciliation-runs.ts` to `reconciliation-runs.ts`).
The retired `source-context.ts` read model was removed with the legacy
goal-first lane; `update-intent-generator.ts` kept its name.

## Local structure

| Concern | Modules |
| --- | --- |
| Source items | `items.ts` |
| Reconciliation | `reconciliation.ts`, `reconciliation-runs.ts` |
| Update-intent generation | `update-intent-generator.ts` |
