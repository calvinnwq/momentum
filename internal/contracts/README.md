# Internal Contracts Index

Contracts are the active invariants. They outlive the milestone narratives that
created them. When a milestone doc and a contract appear to disagree, treat that
as an IA or product-decision conflict: do not rewrite behavior from the
milestone alone.

## Current Architecture And Runtime Contracts

| Need | Source |
| --- | --- |
| Repo architecture, source taxonomy, docs taxonomy, ARCH order | [`repo-architecture-standard.md`](repo-architecture-standard.md) plus root [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) |
| Runtime keep / deprecate-later / defer decisions and RC-1..RC-5 | [`runtime-consolidation-plan.md`](runtime-consolidation-plan.md) |
| Workflow-first runtime product model | [`workflow-first-runtime.md`](workflow-first-runtime.md) |
| Executor invocation / round model | [`executor-loop.md`](executor-loop.md) |
| Current-to-target workflow-first migration bridge | [`workflow-first-gap-matrix.md`](workflow-first-gap-matrix.md) |
| Momentum-native coding workflow ownership migration | [`coding-workflow-ownership.md`](coding-workflow-ownership.md) |
| Live workflow execution foundation | [`live-workflow-execution.md`](live-workflow-execution.md) |
| WorkflowRun substrate invariants | [`workflow-runs.md`](workflow-runs.md) |
| Workflow run operator controls | [`workflow-operator-controls.md`](workflow-operator-controls.md) |
| Source adapter read/reconcile boundary | [`source-adapters.md`](source-adapters.md) |
| Policy-gated external apply boundary | [`intent-apply.md`](intent-apply.md) |
| Adapter coverage layers and opt-in real-smoke policy | [`adapter-test-coverage.md`](adapter-test-coverage.md) |

## Reading Order

1. For source layout, start with [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md),
   then use [`repo-architecture-standard.md`](repo-architecture-standard.md) only
   for detailed placement rules.
2. For runtime narrowing or future work, start with
   [`runtime-consolidation-plan.md`](runtime-consolidation-plan.md). It lists
   future RC work but authorizes no production deletion by itself.
3. For a behavior invariant introduced by an older milestone, read the active
   contract first and then the matching milestone narrative for provenance.
