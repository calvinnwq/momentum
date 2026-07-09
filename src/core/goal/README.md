# core/goal

Goal-first compatibility domain over durable stored data. The goal-first CLI
lane (`goal start`, top-level `status` / `logs` / `handoff`, `worker run`) is
retired; this folder now owns only the goal state and recovery behavior that
kept surfaces still read: `recovery clear`, daemon startup recovery, daemon
status, and doctor recovery counters. It holds business/runtime behavior only —
state and persistence policies — and does not parse CLI arguments or format
output.

## Local structure

| Concern | Modules |
| --- | --- |
| Goal init / state | `init.ts`, `reducer.ts` |
| Recovery compatibility | `recovery.ts`, `recovery-artifact.ts` |
| Iteration helpers | `iteration-job.ts`, `iteration-prompt.ts` |
| Goal spec parsing / types | `spec.ts`, `types.ts` |

Goal specification parsing (`spec.ts`) and its exported `GoalSpec*` shapes
(`types.ts`) moved here from the former flat `src/goal-spec.ts` root module under
the type-placement slice, dropping the redundant `goal-` prefix. The
parser keeps its private YAML helpers and types local and imports the public
shapes from `./types.js`.
