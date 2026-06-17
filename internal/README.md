# Internal Documentation Map

This tree is the internal index for milestone, contract, architecture, and
future-plan context. It may name NGX / ARCH / RC sequencing; public operator
docs stay in [`../docs/`](../docs/index.md) and [`../README.md`](../README.md).

## Current Truth

- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — current repo architecture,
  import boundaries, source taxonomy, and compact links to deeper contracts.
- [`../AGENTS.md`](../AGENTS.md) — future-agent operating guide: where docs,
  code, and tests belong, plus required verification.
- [`../docs/index.md`](../docs/index.md) — public operator command index.
- [`roadmap.md`](roadmap.md) — milestone timeline and current sequencing.

## Active Contracts

Start with [`contracts/README.md`](contracts/README.md). Contracts describe
invariants that remain true after milestone closeout; milestone files preserve
provenance and shipped order.

## Historical Milestone Provenance

Use [`milestones/README.md`](milestones/README.md) to find milestone narratives.
Those files are historical unless they explicitly point to an active contract.

## Accepted Future Plans

Use [`plans/README.md`](plans/README.md) for accepted future plan queues. The
runtime consolidation RC-1..RC-5 sequence is defined by
[`contracts/runtime-consolidation-plan.md`](contracts/runtime-consolidation-plan.md);
the repo-architecture ARCH sequence is defined by
[`contracts/repo-architecture-standard.md`](contracts/repo-architecture-standard.md).

## Durable Audit / Evidence Docs

- [`runtime-test-audit.md`](runtime-test-audit.md) — runtime/test path audit and
  classifications that fed the runtime consolidation plan.
- [`smoke-tests.md`](smoke-tests.md) — smoke coverage map.
- [`regression-matrix.md`](regression-matrix.md) — closeout regression matrix.
- [`exclusions.md`](exclusions.md) — explicitly deferred or excluded scope.
