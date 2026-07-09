# core/goal

Goal-first compatibility domain. This folder owns the goal-loop compatibility
state and read models behind the `goal` and read-only `status` command families:
goal initialization, the goal state reducer, status/log projections, recovery
compatibility behavior, and the per-iteration job and prompt helpers. It holds
business/runtime behavior only — reducers, state, and persistence policies — and
does not parse CLI arguments or format output.

These modules were regrouped from the former flat `src/*.ts` root siblings
(ARCH-05) with no behavior change. The redundant `goal-` prefix was dropped where
the folder now carries the domain (`goal-init.ts` → `init.ts`, `goal-logs.ts` →
`logs.ts`, `goal-recovery.ts` → `recovery.ts`, `goal-reducer.ts` → `reducer.ts`,
`goal-status.ts` → `status.ts`); already-unprefixed modules kept their names.

## Local structure

| Concern | Modules |
| --- | --- |
| Goal init / state | `init.ts`, `reducer.ts` |
| Status / logs read models | `status.ts`, `logs.ts`, `read-back.ts` |
| Recovery compatibility | `recovery.ts`, `recovery-artifact.ts` |
| Iteration helpers | `iteration-job.ts`, `iteration-prompt.ts` |
| Goal spec parsing / types | `spec.ts`, `types.ts` |

Goal specification parsing (`spec.ts`) and its exported `GoalSpec*` shapes
(`types.ts`) moved here from the former flat `src/goal-spec.ts` root module under
the type-placement slice, dropping the redundant `goal-` prefix. The
parser keeps its private YAML helpers and types local and imports the public
shapes from `./types.js`.
