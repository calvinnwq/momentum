# Contract: Runtime Consolidation Plan

**Status:** Accepted planning contract for `NGX-434`, the planning capstone of the
Runtime/Test Weight Audit Cleanup milestone. This contract records explicit
keep / deprecate-later / defer decisions for the runtime paths the audit flagged
as "historical or transitional but still required," names the prerequisite proof
or migration path each narrowing needs, decides the future boundary between the
M9 live-wrapper and M10 executor-loop step-finalization mechanisms, and lists the
follow-up deletion / migration issues. It authorizes **no** production code
deletion, no coverage removal, and no default switch by itself.

It refines the runtime classification in
[`../runtime-test-audit.md`](../runtime-test-audit.md) ("Runtime Path
Classification") and stays consistent with the accepted runtime contracts:

- [`workflow-first-runtime.md`](workflow-first-runtime.md) — the workflow-first product shape.
- [`executor-loop.md`](executor-loop.md) — executor invocations / rounds, the phase-1 dispatch scaffold, and the fail-closed family rule.
- [`workflow-first-gap-matrix.md`](workflow-first-gap-matrix.md) — what survives from M7/M8/M9 and what changes.
- [`coding-workflow-ownership.md`](coding-workflow-ownership.md) — the `cwfp-*` → Momentum-native ownership migration (the `NGX-397`..`NGX-404` track).
- [`live-workflow-execution.md`](live-workflow-execution.md) — the M9 live-wrapper lease / result-file / finalization / recovery primitives.

## Decision Vocabulary

Each runtime path is assigned exactly one decision:

- **Keep** — a current required path with no near-term narrowing. Removal is not
  on the table until the runtime acquires a capability it does not yet have.
- **Deprecate-later** — a legitimate future consolidation target. It stays in
  force today; a *named prerequisite proof* must land before any narrowing, and
  the narrowing is its own follow-up issue, not this one.
- **Defer** — removal is blocked on a new contract or a landed replacement.
  Listed so a future issue can pick it up, but it is explicitly not actionable
  now.

No path in this plan is classified "remove now": the milestone non-goals forbid
broad production-logic deletion, coverage removal, and default switches, and the
unreachable-branch audit below finds nothing safe to delete within scope.

## Decision Summary

| # | Runtime path | Decision | Prerequisite before any narrowing | Follow-up |
|---|---|---|---|---|
| 1 | Goal-first CLI compatibility (`goal start` / `status` / `logs` / `handoff` / `recovery clear`) | Deprecate-later | Workflow-first equivalents for status/logs/handoff/recover + migration coverage; disentangle the shared iteration-finalization primitive the `goal-loop` executor reuses | RC-1 |
| 2 | Imported `.agent-workflows` / `cwfp-*` compatibility | Defer | `NGX-404` default-switch dogfood passes its `coding-workflow-ownership.md` gates | `NGX-404` (existing) |
| 3 | M9 live-wrapper direct `workflow_steps` advancement vs M10 executor-loop finalization | Keep (coexist); boundary seam landed | A single reconciliation seam now finalizes dispatched steps from durable executor evidence with a no-double-finalize proof; narrowing still waits on compatibility-lane migrations | RC-2 (seam landed, NGX-480) |
| 4 | Production dispatch phase-1 scaffold (no fabricated result evidence) | Keep | RC-2 replaced the seam-level terminal gap; narrowing the scaffold still waits for real terminal executor evidence / adapter migration | RC-2 (seam landed, NGX-480), RC-5 |
| 5 | `external-apply` / `subworkflow` fail-closed executor families | Defer | A landed daemon-dispatchable adapter per family, behind the existing safety contracts | RC-3 (`external-apply`), RC-4 (`subworkflow`) |
| 6 | Fake workflow-step executors shipped in `src/` | Deprecate-later; **fake demotion landed (NGX-485)** | Real adapters now back the production default and the fakes are a test-only injected seam; remaining narrowing (daemon-default live profile) is gated on Paths 3/4 | RC-5 (fake demotion landed, NGX-485) |

## Path-By-Path Decisions

### 1. Goal-first CLI compatibility and the `goal-loop` executor family

**Current shape.** `goal start` is a dedicated top-level branch
(`src/cli.ts:241-243` → `src/commands/goal/index.ts:19-57`) that initializes a
goal and either queues a job or runs `executeIterationJob` inline under
`--foreground`. `status` / `logs` / `handoff` are goal-first read-back surfaces
registered through `createMomentumCommandRegistry` (`src/commands/index.ts:17-50`);
`recovery clear` (`src/cli.ts:257,288`) is the goal-scoped recovery path. This is
the legacy "Goal loop" compatibility runtime, distinct from the workflow-first
runtime.

The `goal-loop` *executor family* is a different thing that shares a name. It is
the workflow-first executor for bounded autonomous implementation rounds
(`src/core/executors/goal-loop-executor.ts`, `src/core/executors/goal-loop-mechanism.ts`,
`src/core/executors/goal-loop-orchestrator.ts`) and writes `executor_invocations` /
`executor_rounds`, not goal-iteration job artifacts. The load-bearing cross-link:
`src/core/executors/goal-loop-mechanism.ts:83` **reuses the M9
`finalizeLiveWorkflowStepFromResultFile`** verify/commit/reset transaction. So
"goal iteration paths back `goal-loop`" is true only at the
*finalization-primitive* layer, not the `goal start` CLI layer.

**Decision: Deprecate-later.** Goal-first CLI stays a required compatibility
surface (the audit "Keep" list and `workflow-first-gap-matrix.md` both keep
`goal start` as a compatibility/shorthand entry point). It is a future
consolidation target only after the workflow-first runtime owns equivalent
operator read-back and recovery.

**Prerequisite before any narrowing.**

1. Workflow-first equivalents for `workflow run status` / `logs` / `handoff` /
   `recover` exist and are wire-proven (the gap matrix lists these as *future*
   product surface, not yet shipped).
2. Migration coverage proves a goal-first operator command maps to its
   workflow-first equivalent without dropping a JSON field, refusal code, or
   text-routing contract — the same byte-equivalence discipline NGX-432 applied
   to broad-CLI dedup.
3. The shared iteration-finalization primitive is disentangled: narrowing
   goal-first must not delete `finalizeLiveWorkflowStepFromResultFile` or its
   verify/commit/reset helpers while the `goal-loop` executor
   (`src/core/executors/goal-loop-mechanism.ts:83`) still depends on them. Either the executor keeps
   the primitive or the primitive moves to a shared home first.

**Equivalent-behavior proof to preserve:** `test/cli.test.ts` (goal-first CLI
envelopes), `test/goal-init.test.ts`, `test/goal-reducer.test.ts`,
`test/goal-status.test.ts`, `test/goal-logs.test.ts`, `test/goal-recovery.test.ts`,
and the `goal-loop` adapter suite (`test/goal-loop-executor.test.ts`,
`test/goal-loop-mechanism.test.ts`, `test/goal-loop-orchestrator.test.ts`,
`test/goal-loop-executor-persistence.test.ts`).

### 2. Imported `.agent-workflows` / `cwfp-*` compatibility

**Current shape.** `src/core/workflow/run-import.ts` normalizes a
`.agent-workflows/<run-id>/` directory (`plan.json`, `ledger.jsonl`,
`approval-*.json`, advisory `monitor.json`) into the M7 substrate, stamping
`source = "agent-workflow"` (`src/core/workflow/run-import.ts:44`). Legacy run IDs match
`/^(cwfp|cwfb|overnight)-[A-Za-z0-9]+$/` (`src/core/workflow/run-import.ts:155`, mirrored
in `src/core/evidence/workflow.ts:670`). `workflow import`
(`src/commands/workflow/index.ts:375-441`) drives parse → persist → reconcile.

**Decision: Defer.** This is governed by an existing accepted contract, not by a
new one here. `coding-workflow-ownership.md` keeps `cwfp-*` as the **stable
production path** and requires historical `cwfp-*` runs to remain readable; the
default switch is `NGX-404`, which is explicitly deferred and "is not permission
to remove or break the current `coding-workflow-pipeline` path." Momentum-native
run IDs must stay distinct from `cwfp-*` IDs.

**Prerequisite before any narrowing.** The `NGX-404` default-switch dogfood
passes every migration gate in `coding-workflow-ownership.md` (start →
implementation → postflight → no-mistakes → merge cleanup → Linear refresh; no
chat-only approvals; no duplicate primary state; recovery after process/chat
loss; historical `cwfp-*` runs still readable; clear rollback). Even after the
default switch, the **import/read path stays** for historical run visibility; the
narrowing target is the *default route*, not the importer.

**Equivalent-behavior proof to preserve:** `test/workflow-run-import.test.ts`,
`test/cli-workflow-import.test.ts`, `test/cli-workflow-import-recovery.test.ts`,
`test/m7-import-smoke.test.ts`, `test/m7-contract.test.ts`,
`test/coding-workflow-ownership-contract.test.ts`.

### 3. The M9 / M10 step-finalization boundary

This is the central boundary decision the ticket asks for. Two mechanisms
finalize a workflow step today, and they must never both own the same step.

**M9 live wrappers (direct).** `runLiveWorkflowStep`
(`src/core/executors/live-step-orchestrator.ts`) and `advanceLiveWorkflowStep`
(`src/core/executors/live-step-advance.ts`) own the full `workflow_steps` lifecycle for legacy /
imported live-step runs: `startWorkflowStep` → executor → `finishWorkflowStep`
(`src/core/workflow/step-transitions.ts`) inside the `managed-step` lease. They never write
`executor_invocations` / `executor_rounds`. This is the M7/M9 substrate path that
imported `.agent-workflows` / `cwfp-*` runs and manual live-wrapper advancement
still depend on; it must stay readable and recoverable while those compatibility
paths remain.

The workflow-first built-in coding definition is not identical to that legacy
live-wrapper partition. It maps `merge-cleanup` to the dispatchable `script`
executor family and `linear-refresh` to the non-dispatchable, fail-closed
`external-apply` family (`src/core/workflow/definition.ts:306-355`). Therefore the
boundary is by *execution lane*, not by step-name vocabulary: a `merge-cleanup`
step in an imported/manual live-wrapper run can direct-finalize through M9, while
a `merge-cleanup` step resolved from the built-in workflow definition enters the
M10 dispatch lane as `script` and must be finalized by the future reconciliation
seam.

**M10 executor-loop adapters (nested evidence).** The scheduler-lane dispatcher
`executeWorkflowStepDispatch` (`src/core/workflow/dispatch-execute.ts`) advances the
step `approved → running` once via `startWorkflowStep`, then creates the executor
invocation / round scaffold and **holds** the `dispatch` lease. The adapter
orchestrators (`runGoalLoopStep`, `runSingleShotStep`, `runNoMistakesMirrorStep`)
advance only their `executor_invocations` / `executor_rounds` sub-rows; they never
call `finishWorkflowStep`.

**Why they cannot collide today.** Dispatch is partitioned by executor family in
the pure decider `planWorkflowStepDispatch` (`src/core/workflow/dispatch.ts:186-210`):
only `PHASE1_DISPATCHABLE_EXECUTOR_FAMILIES`
(`src/core/workflow/dispatch.ts:58` = `goal-loop`, `one-shot`, `script`, `no-mistakes`) take
the executor-loop path. `external-apply` and `subworkflow` fail closed before
executor rows are created. Legacy live-wrapper execution enters through the
`managed-step` lane instead, and the `managed-step` and `dispatch` leases are both
in the scheduler's non-monitor blocking set, so a run holding either lease is not
re-scanned. Mutual exclusion on the same step is structural by lease/lane, not by
assuming every step name belongs to exactly one family. `test/full-adapter-e2e.test.ts`
(≈1053-1113) pins that a live-wrapper `merge-cleanup` finishes with
`workflow_steps.state = 'succeeded'` and **zero** executor rows; the built-in
definition's `script`-family `merge-cleanup` remains part of the M10 dispatch lane
and is covered by the RC-2 reconciliation requirement below.

**Pre-RC-2 gap.** In the M10 dispatch lane no production code finalized the
`workflow_steps` row after the scaffold — the step was left `running`. The only
code that called `finishWorkflowStep` on a dispatcher-started step was the
**dogfood stand-in** `src/core/workflow/dogfood-dispatch.ts`, not a production adapter
(`finishWorkflowStep` callers: `src/core/executors/live-step-advance.ts`,
`src/core/executors/live-step-orchestrator.ts`,
`src/core/workflow/dogfood-dispatch.ts` — formerly `src/workflow-dogfood-dispatch.ts` —
plus the definition in `src/core/workflow/step-transitions.ts`). The phase-1
scaffold ids are deliberately namespaced `<run>::<step>::dispatch` so a follow-up
owns reconciling the scaffold with the real adapter's reattachable ids
(`executor-loop.md` round-lifecycle note; `src/core/workflow/dispatch-execute.ts`
id derivation).

**Decision: Keep both, coexisting, behind the landed RC-2 boundary.** The
boundary is:

- **M10 executor-loop adapters own per-round evidence** (`executor_invocations` /
  `executor_rounds`) and emit a terminal round classification. They remain
  forbidden from writing `workflow_steps` transitions directly — the daemon, not
  the executor, decides step progress (`executor-loop.md` Core Boundary).
- **Exactly one reconciliation seam** reads the terminal executor evidence for a
  dispatched step and calls `finishWorkflowStep`, replacing the dogfood stand-in.
  It must be single-owner and idempotent on the deterministic `::dispatch` ids so
  re-entry cannot double-finalize.
- **M9 live wrappers stay the direct-finalize path** for imported/manual live-step
  compatibility lanes until those lanes are migrated or retired. They are not
  collapsed into the executor-loop path by this milestone.

**Prerequisite before narrowing the coexistence (RC-2).** Now satisfied at the
seam level: a landed reconciliation adapter plus tests prove, end-to-end through
the production dispatch lane, that a dispatched step reaches a terminal
`workflow_steps.state` exactly once, with no path where both the M9 finalize and
the M10 reconciliation finalize the same step. Removing the dogfood fixture or
narrowing the scaffold still waits on the compatibility-lane migrations below,
especially RC-5 real executor evidence.

**Landed (NGX-480).** RC-2's reconciliation seam now ships in production:
`reconcileDispatchedWorkflowStep` (`src/core/workflow/dispatch-reconcile-execute.ts`),
built on the pure, total decider `planWorkflowStepReconciliation`
(`src/core/workflow/dispatch-reconcile.ts`). It reads the deterministic
`<run>::<step>::dispatch` executor invocation, asks the decider what the
invocation's terminal state means, and applies that inside one `BEGIN IMMEDIATE`
transaction: a clean terminal (`succeeded` / `failed` / `cancelled`) finalizes the
owning `workflow_steps` row via `finishWorkflowStep`, releases the held `dispatch`
lease, and refreshes cached run-state through the ARCH-08 `runtime-state.ts` seam;
an unclean terminal (`blocked` / `manual_recovery_required`) parks the run for
operator recovery with a step-scoped gate instead of fabricating a clean terminal;
a non-terminal invocation defers with no writes. It is structurally single-owner:
it acts only when a `::dispatch` invocation exists, so it refuses an M9
direct-finalized step that carries no executor rows, and it is idempotent on
re-entry (an already-terminal step preserves its immutable record and only
converges the lease / run-state, never changing terminal result semantics).
`test/workflow-dispatch-reconcile-execute.test.ts` proves both directions of the
no-double-finalize boundary — reconciliation refuses an M9-finalized step, and the
M9 live wrapper (`runLiveWorkflowStep`) refuses an M10-dispatched step at its
start-state gate before any durable mutation — so exactly one mechanism finalizes
any given step.

The `dogfood-dispatch.ts` stand-in is **not** deleted by RC-2; it is now an
explicit **test/dogfood-only** opt-in fixture
(`MOMENTUM_DOGFOOD_TERMINALIZE_DISPATCH`, off by default) that hides no production
terminal gap behind it — the production terminal owner is the reconciliation seam
above. Wiring that seam as the daemon default still needs real terminal executor
evidence in production. RC-5's fake demotion has landed (NGX-485): production
dispatch no longer resolves to shipped fake successes by default, but
unconfigured adapters honestly refuse with `runtime_unavailable` until a
daemon-default live-wrapper profile is wired. So narrowing the coexistence
(Path 3) and the dispatch scaffold (Path 4) is unblocked at the seam level but
still gated on the remaining compatibility-lane migrations.

**Equivalent-behavior proof to preserve:** M9 — `test/live-step-orchestrator.test.ts`,
`test/live-step-finalize.test.ts`, `test/live-step-run-recovery.test.ts`,
`test/live-step-executor.test.ts`, `test/full-adapter-e2e.test.ts`. M10 —
`test/executor-loop-contract.test.ts`, `test/single-shot-orchestrator.test.ts`,
`test/goal-loop-orchestrator.test.ts`, `test/m10-smoke.test.ts`,
`test/workflow-dogfood-multi-dispatch.test.ts`.

### 4. Production dispatch phase-1 scaffold

**Current shape.** `dispatchExecutorScaffold` / `buildRoundScaffold`
(`src/core/workflow/dispatch-execute.ts`) atomically advances the step to `running`,
inserts one `executor_invocations` row (`running`) and one `executor_rounds` row
(`pending`) with **every** evidence/payload field null or empty, under
deterministic `<run>::<step>::dispatch` ids, idempotently.

**Decision: Keep.** The scaffold's no-fabricated-evidence rule is a recovery
safety feature mandated by `executor-loop.md`: the dispatcher must carry no
digests, artifact root, logs, summary, verification, commit, recovery, or human
gate until executor work produces it. Deleting the scaffold before real executor
evidence is wired through the landed RC-2 reconciliation seam would weaken
recovery by either fabricating evidence or stranding the step.

**Prerequisite before any narrowing.** The RC-2 terminal owner has landed, but the
scaffold can only narrow once real executor adapters provide terminal evidence to
that seam in production.

**Equivalent-behavior proof to preserve:** `test/workflow-dispatch-execute.test.ts`
(the "creates the scaffold round with no fabricated evidence", stable-id, and
idempotency cases).

### 5. `external-apply` and `subworkflow` fail-closed families

**Current shape.** Both are valid members of `WORKFLOW_EXECUTOR_FAMILIES`
(`src/core/workflow/definition.ts:44`) but are absent from
`PHASE1_DISPATCHABLE_EXECUTOR_FAMILIES`. A claimed step resolving to either fails
closed: `planWorkflowStepDispatch` returns
`code: "unsupported_executor_family"` → `manual_recovery_required`, and
`failClosedDispatch` (`src/core/workflow/dispatch-execute.ts`) sets `needs_manual_recovery`,
opens a `workflow_gates` row, releases the dispatch lease, and creates no executor
rows (the step stays `approved`).

**Decision: Defer.** The fail-closed behavior is a product safety feature, not
dead code (`executor-loop.md`: "`external-apply` is operator-mediated external
writes and `subworkflow` recurses into another run — so they fail closed rather
than silently no-op or strand a lease"). `external-apply` must route through the
existing M6 external-apply safety contract; `subworkflow` is deferred until
first-class workflow start is stable (`workflow-first-gap-matrix.md`).

**Prerequisite before removal of the fail-closed branch.** A landed
daemon-dispatchable adapter for that family, behind its safety contract, plus a
test proving the family now dispatches durable evidence instead of gating. The
fail-closed branch is removed only when an adapter replaces it — never as a bare
deletion.

**Equivalent-behavior proof to preserve:** `test/workflow-dispatch.test.ts`
(parametrized `external-apply` / `subworkflow` fail-closed cases),
`test/workflow-dispatch-execute.test.ts` (durable manual-recovery gate, lease
released, zero invocations, vanished-run safety).

### 6. Fake workflow-step executors shipped in `src/`

**Pre-RC-5 shape.** `src/core/workflow/step-executor.ts` built the production
`ADAPTERS` map entirely from a `buildFakeExecutor` helper; `getWorkflowStepExecutor`
/ `dispatchWorkflowStepExecutor` therefore resolved to a fake for any
`WorkflowStepExecutorKind`. This is the M7 `WorkflowStepExecutor` substrate
(keyed by `WorkflowStepExecutorKind`), distinct from the M10 executor-loop
families. The fakes were shipped source, not test-only helpers, and backed the
deterministic substrate smoke.

**Decision: Deprecate-later.** The fakes are valuable deterministic substrate
coverage (audit "Keep But Consolidate Later"). They should not be confused with
production executor support, but deleting them removes cheap regression coverage,
so they stay until real adapters exist.

**Prerequisite before narrowing.** Real `WorkflowStepExecutor` adapters land per
kind; the fakes are then demoted from the production `ADAPTERS` map to an
explicit test-only seam (e.g. injected by `test/helpers/workflow-smoke-harness.ts`)
so the M7/M8/M10 substrate smoke keeps a deterministic executor without shipping
a fake as the production default. `listExecutingWorkflowStepExecutorKinds` must
then reflect real executors, not fakes.

**Landed (NGX-485).** The fake demotion shipped. The default `WorkflowStepExecutor`
registry is now built from real adapters: with no live-wrapper profile wired, each
canonical kind resolves to the honest `createUnconfiguredWorkflowStepExecutor`
(`step-executor.ts`) that refuses with `runtime_unavailable` rather than
fabricating a success, and `step-executor-real-adapters.ts`'s
`buildRealWorkflowStepExecutorRegistry` wires configured kinds to real M9 live
executors. The three entrypoints (`getWorkflowStepExecutor` /
`dispatchWorkflowStepExecutor` / `listExecutingWorkflowStepExecutorKinds`) take an
optional `registry` parameter that defaults to that real registry; the
deterministic fake moved to a test-only seam
(`test/helpers/fake-workflow-step-executor.ts`) that the substrate smoke
(`test/helpers/workflow-smoke-harness.ts`) and the boundary contract inject
explicitly. No fake ships in `dist/` (the build compiles `src/**` only).
`listExecutingWorkflowStepExecutorKinds` now reflects the real default adapters.
Remaining RC-5 narrowing — wiring a daemon-default live profile so dispatched
steps actually execute a live command in production (the real terminal executor
evidence Paths 3/4 still wait on) — is unchanged future work and is **not** part
of this fake-demotion slice.

**Equivalent-behavior proof to preserve:** `test/workflow-step-executor.test.ts`
(now split into real-default / injected-fake-seam / registry-agnostic-validation
sections), `test/workflow-step-executor-fakes.test.ts` (the test-only seam +
opt-in proof), `test/workflow-step-executor-real-adapters.test.ts` (the real
profile-backed registry), `test/live-step-executor.test.ts`,
`test/full-adapter-e2e.test.ts`, and the smoke files that drive
`driveStepWithFakeExecutor`
(`test/m7-e2e-smoke.test.ts`, `test/m8-smoke.test.ts`, `test/m10-smoke.test.ts`).

## No Production Code Deleted In This Issue

This planning issue deletes no production code by itself. RC-5's later fake demotion
intentionally removed the fake production default from `src/` and moved that
deterministic behavior behind `test/helpers/fake-workflow-step-executor.ts`; the
remaining fail-closed branches, dispatch scaffold, goal-first paths, and
`cwfp-*` import lanes are still reachable safety / compatibility surfaces. The
milestone non-goal ("no broad production logic deletion") and the audit's defer
list both hold.

## Follow-Up Issue Sequence

Actual deletion / migration work is **listed, not created** here, so the host can
schedule it without speculative Linear churn from a runtime worker. Items reuse
the existing `coding-workflow-ownership.md` track where one already owns the work,
and add `RC-*` placeholders for the genuinely new consolidation work.

1. **RC-1 — Goal-first read-back / recovery parity + migration coverage.** Land
   workflow-first `status` / `logs` / `handoff` / `recover` equivalents and prove
   byte-equivalent migration from the goal-first commands before narrowing
   goal-first CLI. Blocks on the gap-matrix "future product surface." (Path 1)
2. **RC-2 — M9/M10 step-finalization reconciliation seam. ✅ Landed (NGX-480).**
   The single idempotent seam that finalizes dispatched steps from terminal
   executor evidence now ships as `reconcileDispatchedWorkflowStep`
   (`src/core/workflow/dispatch-reconcile-execute.ts`) over the pure decider
   `planWorkflowStepReconciliation` (`src/core/workflow/dispatch-reconcile.ts`),
   with a bidirectional no-double-finalize proof
   (`test/workflow-dispatch-reconcile-execute.test.ts`). The
   `src/core/workflow/dogfood-dispatch.ts` stand-in (formerly
   `src/workflow-dogfood-dispatch.ts`) is retained as an explicit
   test/dogfood-only opt-in fixture rather than deleted, because making the seam
   the daemon default needs real production executor evidence (RC-5); it now hides
   no production terminal gap behind it. RC-2 unblocks narrowing of both the
   coexistence (Path 3) and the dispatch scaffold (Path 4), each still gated on the
   remaining compatibility-lane migrations.
3. **RC-3 — `external-apply` daemon-dispatchable adapter** behind the M6
   external-apply safety contract, replacing the fail-closed branch with durable
   dispatch. (Path 5)
4. **RC-4 — `subworkflow` daemon-dispatchable adapter**, after first-class
   workflow start is stable, replacing its fail-closed branch. (Path 5)
5. **RC-5 — Real `WorkflowStepExecutor` adapters + fake demotion. ✅ Fake demotion
   landed (NGX-485).** The shipped fake `ADAPTERS` map is replaced: the production
   default registry is now real adapters (honest `runtime_unavailable` when
   unconfigured), the deterministic fake moved to a test-only injection seam
   (`test/helpers/fake-workflow-step-executor.ts`) injected through the entrypoints'
   `registry` parameter, and substrate smoke is preserved. The remaining RC-5
   narrowing — wiring a daemon-default live-wrapper profile so dispatched steps run
   a real command and feed real terminal evidence to the RC-2 reconciliation seam —
   stays future work gated on Paths 3/4. (Path 6)
6. **`NGX-404` (existing, deferred) — coding-workflow default switch.** Owns the
   `cwfp-*` default-route narrowing under `coding-workflow-ownership.md`; the
   import/read path survives regardless. (Path 2)

Ordering note: RC-2 is the prerequisite for the most consolidation (Paths 3 and
4) and led — its reconciliation seam has now **landed** (NGX-480). RC-5's fake
demotion has since **landed** (NGX-485): the production executor default is real
adapters and the fakes are a test-only injected seam. The next remaining runtime
consolidation items are RC-1 (goal-first read-back / recovery parity) and the
remaining RC-5 narrowing (wiring a daemon-default live-wrapper profile so
dispatched steps feed real terminal evidence, which is what fully unblocks wiring
the RC-2 reconciliation seam as the daemon default). RC-3 / RC-4 and `NGX-404`
remain capability-gated and stay deferred until their adapters / dogfood land.

## Non-Goals

- No broad production logic deletion and no coverage removal (milestone non-goals).
- No default switch away from goal-first, `cwfp-*` import, or the fake substrate.
- No new migrations, CLI commands, or daemon scheduling changes — this is a plan.
- No external writes, remote git operations, or Linear updates from runtime code.
- No collapsing of the M9 direct-finalize path into the M10 executor-loop path
  within this milestone; RC-2 proved the reconciliation boundary, while
  compatibility-lane narrowing remains future work.
