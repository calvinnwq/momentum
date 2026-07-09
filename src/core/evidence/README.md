# core/evidence

Evidence domain. This folder owns evidence-facing compatibility data: artifact
helpers, evidence record persistence, and workflow evidence linkage (typed
`runId` / `stepId` pointers). It holds business/runtime behavior only —
artifact writing, record persistence, and evidence linkage — and does not
parse CLI arguments or format output.

These modules were regrouped from the former flat `src/*.ts` root siblings
(ARCH-05) with no behavior change. The redundant `evidence-` prefix was dropped
where the folder now carries the domain (`evidence-records.ts` → `records.ts`,
`evidence-workflow.ts` → `workflow.ts`); `artifacts.ts` kept its name.

## Local structure

| Concern | Modules |
| --- | --- |
| Artifacts | `artifacts.ts` |
| Evidence records | `records.ts` |
| Workflow evidence linkage | `workflow.ts` |

The retired goal-first `handoff.ts` module is gone with its CLI lane;
workflow-run handoff lives in `src/core/workflow/run/handoff.ts`.
