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
| RC-1 | [`runtime-consolidation-plan.md`](../contracts/runtime-consolidation-plan.md#follow-up-issue-sequence) | Goal-first read-back / recovery parity before any goal-first narrowing. |
| RC-2 | [`runtime-consolidation-plan.md`](../contracts/runtime-consolidation-plan.md#follow-up-issue-sequence) | Single M9/M10 step-finalization reconciliation seam and no-double-write proof. |
| RC-3 | [`runtime-consolidation-plan.md`](../contracts/runtime-consolidation-plan.md#follow-up-issue-sequence) | Daemon-dispatchable `external-apply` adapter behind M6 safety gates. |
| RC-4 | [`runtime-consolidation-plan.md`](../contracts/runtime-consolidation-plan.md#follow-up-issue-sequence) | Daemon-dispatchable `subworkflow` adapter after workflow start is stable. |
| RC-5 | [`runtime-consolidation-plan.md`](../contracts/runtime-consolidation-plan.md#follow-up-issue-sequence) | Real `WorkflowStepExecutor` adapters and fake-executor demotion. |

## Repo Architecture Queue

The ARCH sequence is defined by
[`../contracts/repo-architecture-standard.md`](../contracts/repo-architecture-standard.md#migration-sequence).
ARCH-07 is this docs IA cleanup. The next repo-architecture step is
**ARCH-08 / NGX-452**, which should deepen the smallest useful
`src/core/workflow/` seam around finalization/status/recovery coordination
without implementing the full RC-2 reconciliation unless that issue is
explicitly re-scoped.
