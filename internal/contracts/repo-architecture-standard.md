# Contract: Repo Architecture Standard

**Status:** Accepted post-M11 repository architecture standard. `ARCH-02` /
`NGX-446` enforces the first source-layout guardrails from this contract;
`ARCH-03` / `NGX-447` has mechanically regrouped workflow runtime modules under
`src/core/workflow/`; `ARCH-04` / `NGX-448` has mechanically regrouped executor
runtime modules under `src/core/executors/`; `ARCH-05` / `NGX-449` has
mechanically regrouped the remaining pseudo-domain modules under
`src/core/{goal,source,intent,daemon,repo,evidence}/`, `src/config/`, and
`src/adapters/db/`; `ARCH-06` through `ARCH-08` execute the remaining type
placement and information architecture cleanup. This contract does not authorize
runtime behavior changes, public CLI behavior changes, compatibility-lane
deletion, or weakening any NGX-434 runtime-consolidation decision.

Root [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) remains the entry point.
This file holds the longer placement rules so the root contract stays compact.

## Reference Patterns

Momentum keeps its own CLI/runtime shape, but the target layout borrows proven
patterns from nearby repositories:

- Artshelf uses thin command modules with owned `src/commands/`, concrete
  integrations in `src/adapters/`, environment/path helpers in `src/config/`,
  reusable output in `src/renderers/`, and small CLI helpers in `src/shared/`.
- Skill Suitcase keeps the same CLI support layers and adds `src/core/<domain>`
  so behavior can move out of flat root files without hiding it behind CLI
  names.
- ShakedownKit is the ownership reference: domain code is grouped by product
  concept. Momentum should copy that domain-oriented habit, not its app-specific
  frontend folders.

## Target Source Taxonomy

The target source tree is:

```text
src/index.ts             process entrypoint only
src/cli.ts               parser, top-level dispatch, compatibility surfaces
src/commands/            command-family parsing and orchestration
src/renderers/           JSON/text/help/diagnostic output contracts
src/adapters/            concrete external integrations and runtime adapters
src/config/              env, package metadata, path, and default resolution
src/shared/              small cross-cutting utilities with no domain ownership
src/core/<domain>/       business/runtime behavior, state, policies, reducers
```

The initial Momentum core domains are:

- `workflow` — workflow definitions, runs, steps, gates, leases, monitor state,
  recovery, dispatch planning, and workflow handoff.
- `executors` — executor-loop persistence/reducers plus goal-loop, one-shot,
  script, no-mistakes, and future executor-family runtime behavior.
- `goal` — goal-first compatibility state, logs, status, recovery, iteration
  prompts, iteration jobs, and goal-loop compatibility helpers.
- `source` — source items, reconciliation, source context, source-backed update
  intent generation, and source-run records.
- `intent` — update intent state, apply audit, apply execution, policy-gated
  external apply orchestration, and post-apply reconciliation.
- `daemon` — daemon loop, daemon run/status state, stale recovery, worker run,
  queue jobs, and daemon compatibility logic.
- `repo` — repo guards, repo locks, branch management, verification, and
  iteration finalization primitives.
- `evidence` — evidence records, workflow evidence linkage, handoff data, and
  evidence-facing reducers or policies.

Documented exceptions:

- `src/index.ts` and `src/cli.ts` stay at root by contract.
- Root compatibility files may remain until their ARCH slice moves them.
- Node shims and generated declaration helpers may stay where TypeScript or the
  package entrypoint requires them.
- Compatibility paths named by
  [`runtime-consolidation-plan.md`](runtime-consolidation-plan.md) stay live
  until their prerequisite proof lands.

## Allowed Root `src/*.ts` Policy

`ARCH-02` encodes an allowlist for root `src/*.ts` files before broad moves
begin. The durable allowlist is intentionally small:

- `src/index.ts`
- `src/cli.ts`
- `src/suppress-sqlite-experimental-warning.ts`
- `src/node-shims.d.ts`

During migration, the guard may include named transitional files with an owner
issue, target home, and removal reason. New production modules should not be
added at root unless a contract update names the exception.

## Adding Source Modules During ARCH Migration

Do not add new root `src/*.ts` modules. Put new behavior in the narrowest
existing owner first: command orchestration in `src/commands/`, output-only JSON
or text helpers in `src/renderers/`, external integrations in `src/adapters/`,
configuration helpers in `src/config/`, cross-cutting utilities in `src/shared/`,
and business/runtime behavior in `src/core/<domain>` once that domain home
exists.

If a future slice must keep migration debt at root temporarily, add a
transitional exception to the ARCH-02 guard with the owner issue, target home,
and removal reason. The guard should fail stale exceptions after their root file
moves. Do not create placeholder directories or generic dumping grounds just to
satisfy the taxonomy; absent pending homes are better than empty or misleading
ones.

## Import Direction

The high-level import direction is:

```text
index -> cli -> commands -> core -> adapters
                   |          |
                   v          v
              renderers    shared/config
```

Commands orchestrate: they parse command-family arguments, call core behavior or
adapter-backed seams, and pass computed results to renderers. Renderers output
only: they format stable JSON/text/help/diagnostics and do not mutate state,
open databases, read repos, call adapters, or inspect argv. Renderers may keep
explicit type-only imports from core modules for stable result shapes and may
read configuration constants from `src/config/`; runtime imports from commands,
adapters, persistence, or mutation modules are not allowed. Core owns
business/runtime behavior: reducers, state machines, persistence policies,
runtime decisions, and compatibility behavior. Adapters own external concrete
integrations: databases, git, Linear, runners, shells, probes, and remote or
process IO. `shared` and `config` are support layers, not domain escape hatches.

Domain modules must not import commands or renderers. Adapters should not import
commands; they may import core-owned types only where the adapter boundary needs
them. Cross-domain imports are allowed when the dependency is part of a documented
contract, but new cycles should be treated as a design smell and resolved before
movement.

## Type Placement

There is no generic `src/types.ts` or `src/types/` dumping ground in the target
shape. Existing generic type files should be drained into owned homes as their
domains move.

- Exported domain types live beside their behavior in
  `src/core/<domain>/types.ts`.
- Adapter-owned external request/response shapes live with the adapter that
  normalizes them, using `src/adapters/<adapter>/types.ts` when the shapes are
  exported or reused beyond one adapter file.
- Command input parsing details stay near the command family.
- Renderer JSON/text envelope types stay with the renderer seam that emits them.
- Private implementation types stay local to the file or submodule that uses
  them.
- Shared utility types are allowed in `src/shared/` only when they have no
  domain semantics.
- Use `import type` / `export type` for type-only edges when moving modules, so
  structural guardrails can reason about runtime dependencies.

## Docs Taxonomy

- `ARCHITECTURE.md` is the current repo-level truth and the first file agents
  read before CLI/source-structure changes.
- `AGENTS.md` is the operating contract for agents: workflow commands, stable
  CLI expectations, verification, and where planning context lives.
- `docs/` is public human/operator documentation. Do not add roadmap, milestone,
  Linear/NGX, sequencing, or internal migration detail there.
- `internal/contracts/` contains active cross-cutting contracts, including this
  standard and the runtime-consolidation decisions.
- `internal/milestones/` contains historical milestone narratives and shipped
  implementation order.
- [`../plans/README.md`](../plans/README.md) defines the home for accepted
  future implementation plans such as RC-1 through RC-5 when those plans are
  written. Plans can reference NGX/ARCH/RC sequencing because they are
  internal-only.
- `internal/runtime-test-audit.md`, `internal/smoke-tests.md`,
  `internal/exclusions.md`, and `internal/regression-matrix.md` remain durable
  audit and closeout evidence.

## Test Placement

Tests should follow the behavior owner rather than the historical filename:

- CLI parser, command-family, JSON/text envelope, and stdout/stderr contract
  tests stay in `test/cli-*`, `test/commands-*`, or renderer-specific files.
- Core behavior tests should be named for the domain behavior they cover, even
  while they remain under the current flat `test/` tree.
- Adapter tests stay adapter-specific and should not depend on real external
  services unless they are explicitly opt-in smoke tests.
- Source-layout and import-boundary tests belong to the ARCH migration slices,
  with `ARCH-02` owning the first enforceable source-layout guard.

## Migration Sequence

The ARCH sequence must land before RC-2 so the step-finalization reconciliation
work has stable homes for workflow, executor, repo, adapter, and evidence code.

1. **ARCH-02 / NGX-446 — Source-layout guardrails.** Enforce the allowed-root
   `src/*.ts` policy, named transitional root exceptions, placeholder-free
   target directory checks, and import-direction guardrails for `core`,
   `config`, `shared`, renderers, and transitional root modules. This issue
   enforces, but does not broadly move, the standard.
2. **ARCH-03 / NGX-447 — Workflow core domain.** Moved workflow definitions,
   run/start, import, status, monitor, recovery, gates, leases, dispatch
   planning, and workflow handoff behavior under `src/core/workflow/`, leaving
   command and renderer seams in place. The local module map lives in
   [`../../src/core/workflow/README.md`](../../src/core/workflow/README.md).
3. **ARCH-04 / NGX-448 — Executor core domain.** Moved executor-loop reducers/
   persistence and goal-loop, single-shot, live-step, no-mistakes mechanism,
   runner-profile, foreground iteration, and runner-smoke behavior under
   `src/core/executors/`, leaving the no-mistakes external integration
   (`no-mistakes-executor`, `no-mistakes-orchestrator`) in `src/adapters/`. The
   M9 direct-finalize path was kept as separate modules from the M10
   executor-loop path. The local module map lives in
   [`../../src/core/executors/README.md`](../../src/core/executors/README.md).
4. **ARCH-05 / NGX-449 — Remaining pseudo-domains.** Moved goal-first
   compatibility, source reconciliation/items/context, update intents/apply
   audit/apply execution, daemon/worker/queue/stale-recovery, repo guard/lock/
   branch/verification, project rollup, and evidence behavior into
   `src/core/{goal,source,intent,daemon,repo,evidence}/`, with `data-dir` and the
   daemon/lease default constants under `src/config/` and SQLite migrations under
   `src/adapters/db/`, preserving the compatibility surfaces in `src/cli.ts`. The
   daemon stale-threshold defaults moved to `src/config/daemon-defaults.ts` so the
   daemon renderer no longer takes a runtime import on inspector internals. Local
   module maps live in the per-domain `README.md` files under `src/core/`.
5. **ARCH-06 / NGX-450 — Type placement normalization.** Drain generic or misplaced
   exported types into owned domain, adapter, command, renderer, shared, or local
   homes according to the type placement rules above. Do not introduce a generic
   `src/types/` dumping ground.
6. **ARCH-07 / NGX-451 — Human and agent docs information architecture.** Reconcile
   `ARCHITECTURE.md`, `AGENTS.md`, `docs/`, `internal/contracts/`,
   `internal/milestones/`, `internal/roadmap.md`, and `internal/plans/` so
   current truth, operator docs, active contracts, history, and accepted future
   plans are easy to find.
7. **ARCH-08 / NGX-452 — Workflow runtime deepening.** After mechanical regrouping,
   deepen the smallest useful `core/workflow` seam, preferably around
   finalization/status/recovery coordination, without implementing the full RC-2
   reconciliation unless that issue is explicitly re-scoped.

Only after ARCH-02 through ARCH-08 have created stable ownership homes should
RC-2 implement the M9/M10 step-finalization reconciliation seam. RC-2 still
follows [`runtime-consolidation-plan.md`](runtime-consolidation-plan.md): it must
prove a single idempotent finalization owner and no double-write path before any
runtime narrowing.

## Non-Goals

- No broad source module moves in ARCH-02.
- No runtime behavior changes or public CLI output changes.
- No placeholder-only `src/core/`, `src/config/`, or `src/shared/` directories.
- No compatibility-path deletion, default switch, or runtime narrowing.
- No contradiction of the keep / deprecate-later / defer decisions in
  [`runtime-consolidation-plan.md`](runtime-consolidation-plan.md).
