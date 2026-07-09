# core/daemon

Daemon domain. This folder owns the daemon runtime: the daemon loop, daemon
run/status state, queue-job persistence over stored goal data, and
stale-lease/run recovery. It holds business/runtime behavior only — loop
control, persistence, and read-only status inspection — and does not parse CLI
arguments or format output.

These modules were regrouped from the former flat `src/*.ts` root siblings
(ARCH-05) with no behavior change. The redundant `daemon-` prefix was dropped
where the folder now carries the domain (`daemon-loop.ts` → `loop.ts`,
`daemon-runs.ts` → `runs.ts`, `daemon-status.ts` → `status.ts`);
`queue-jobs.ts` and `stale-recovery.ts` kept their names. The retired
goal-iteration drain entry point (`worker-run.ts`) is gone with its CLI lane;
the workflow scheduler lane is the daemon's only work lane.

The daemon stale-threshold defaults that the status inspector, CLI, and daemon
renderer all read were extracted to `src/config/daemon-defaults.ts` so the daemon
renderer no longer takes a runtime import on inspector internals.

## Local structure

| Concern | Modules |
| --- | --- |
| Daemon loop | `loop.ts` |
| Run / status state | `runs.ts`, `status.ts` |
| Queue jobs | `queue-jobs.ts` |
| Stale recovery | `stale-recovery.ts` |
| Workflow dispatch composition | `workflow-dispatch.ts` |

`workflow-dispatch.ts` composes the same production workflow dispatcher for bounded daemon cycles and for `workflow run watch --once` supervisor ticks.
