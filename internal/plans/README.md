# Internal Plans

Accepted future implementation plans live here when a contract names a sequence
that is not ready to execute immediately. Plans here may reference milestones,
NGX / ARCH / RC issue IDs, and internal sequencing because this tree is not
public operator documentation.

Use this directory for plan artifacts such as RC-1 through RC-5 after their
owning contract has defined the scope and prerequisites. Do not put public CLI
usage docs here; those belong under `docs/`.

## Accepted Future Runtime Queue

The RC sequence is defined by
[`../contracts/runtime-consolidation-plan.md`](../contracts/runtime-consolidation-plan.md).
That contract authorizes no production deletion by itself; each RC item needs its
own implementation issue and proof.

| Item | Plan source | What it unlocks |
| --- | --- | --- |
| RC-1 — landed (NGX-486); RC-1b finalization disentangle landed (NGX-494) | [`runtime-consolidation-plan.md`](../contracts/runtime-consolidation-plan.md#follow-up-issue-sequence) | Goal-first status / logs / handoff / recovery parity now has workflow-first equivalents and migration proofs; the shared finalization primitive the goal-loop executor reused is now disentangled into the neutral `step-finalize.ts` seam (NGX-494), leaving the goal-first CLI narrowing itself as the remaining Path 1 work. |
| RC-2 — landed (NGX-480) | [`runtime-consolidation-plan.md`](../contracts/runtime-consolidation-plan.md#follow-up-issue-sequence) | Single M9/M10 step-finalization reconciliation seam and no-double-write proof — seam shipped as `reconcileDispatchedWorkflowStep`; narrowing Paths 3/4 still gated on compatibility-lane migration. |
| RC-3 | [`runtime-consolidation-plan.md`](../contracts/runtime-consolidation-plan.md#follow-up-issue-sequence) | Daemon-dispatchable `external-apply` adapter behind M6 safety gates. |
| RC-4 | [`runtime-consolidation-plan.md`](../contracts/runtime-consolidation-plan.md#follow-up-issue-sequence) | Daemon-dispatchable `subworkflow` adapter after workflow start is stable. |
| RC-5 — fake demotion landed (NGX-485); RC-5b seams + daemon-start wiring landed (NGX-492) | [`runtime-consolidation-plan.md`](../contracts/runtime-consolidation-plan.md#follow-up-issue-sequence) | Production default now uses real `WorkflowStepExecutor` adapters and the fakes are test-only. RC-5b landed the reusable execution seams (terminalize bridge, execution-path producer, profile source resolver, live-wrapper dispatch composition, exec-context deriver) plus bounded `daemon start` wiring for configured daemon-default profiles. |

## Repo Architecture Queue

The ARCH sequence is defined by
[`../contracts/repo-architecture-standard.md`](../contracts/repo-architecture-standard.md#migration-sequence).
ARCH-07 / NGX-451 completed the docs IA cleanup. **ARCH-08 / NGX-452** added
`src/core/workflow/runtime-state.ts` as the smallest useful workflow-owned seam
around mechanical finalization/status/monitor refresh coordination: callers that
already mutated durable step / lease rows can re-read reducer rows and refresh
cached `workflow_runs` state / monitor columns without duplicating SQL. The full
RC-2 single-finalization owner has since landed separately (NGX-480; see the
runtime-consolidation plan), as has RC-5's fake demotion (NGX-485: real adapters
back the production executor default, fakes are a test-only injected seam).
RC-5b's reusable execution seams have since landed (NGX-492: terminalize bridge,
execution-path producer, profile source resolver, live-wrapper dispatch
composition, exec-context deriver) and the bounded `daemon start` workflow lane
now wires them for configured daemon-default profiles. RC-1b (NGX-494) has since
disentangled the shared finalization primitive the goal-loop executor reused into
the neutral `step-finalize.ts` seam, leaving the goal-first CLI narrowing itself
as the next Path 1 item.
