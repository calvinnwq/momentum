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
| 1 | Goal-first CLI compatibility (`goal start` / `status` / `logs` / `handoff` / `recovery clear`) | Deprecate-later; **read-back/recovery parity landed (NGX-486); read-back dedup narrowing landed (NGX-495)** | Workflow-first equivalents + migration coverage landed (NGX-486); the shared iteration-finalization primitive the `goal-loop` executor reused is now disentangled into the neutral `step-finalize.ts` seam (NGX-494); the duplicate goal-first read-back logic is now owned once by the shared `read-back.ts` seam (NGX-495); the domain-specific recovery guarded-clear dedup stays deferred and no goal-first command is removed | RC-1 (parity, NGX-486) / RC-1b (NGX-494) / RC-1c (narrowing, NGX-495) |
| 2 | Imported `.agent-workflows` / `cwfp-*` compatibility | Defer | `NGX-404` default-switch dogfood passes its `coding-workflow-ownership.md` gates | `NGX-404` (existing) |
| 3 | M9 live-wrapper direct `workflow_steps` advancement vs M10 executor-loop finalization | Keep (coexist); boundary seam landed | A single reconciliation seam now finalizes dispatched steps from durable executor evidence with a no-double-finalize proof; narrowing still waits on compatibility-lane migrations | RC-2 (seam landed, NGX-480) |
| 4 | Production dispatch phase-1 scaffold (no fabricated result evidence) | Keep | RC-2 replaced the seam-level terminal gap and RC-5b now feeds real terminal executor evidence from configured daemon profiles; narrowing the scaffold still waits on compatibility-lane migrations | RC-2 (seam landed, NGX-480), RC-5 |
| 5 | `external-apply` / `subworkflow` fail-closed executor families | `external-apply` narrowed; **`subworkflow` adapter mechanism + production flip landed (RC-4 NGX-497, RC-4b NGX-498)** | A landed daemon-dispatchable adapter per family, behind the existing safety contracts; RC-3 wires `external-apply` through the daemon dispatch lane, and RC-4 landed the `subworkflow` adapter mechanism (pure child-mirror mapping + async producer + daemon-lane entry-point factory) which RC-4b then flipped into production (child-definition config + bounded recursion safety, route-sourced launch plan, key-resolved start-or-attach child runner, daemon context deriver wired via `withSubworkflowDispatch`, `subworkflow` added to `PHASE1_DISPATCHABLE_EXECUTOR_FAMILIES`); the generic `unsupported_executor_family` fail-closed branch is retained defensively | RC-3 (`external-apply` wired, NGX-496), RC-4 (`subworkflow` adapter landed, NGX-497), RC-4b (`subworkflow` production flip, NGX-498) |
| 6 | Fake workflow-step executors shipped in `src/` | Deprecate-later; **fake demotion landed (NGX-485); daemon-default live profile wiring landed (NGX-492)** | Real adapters now back the production default, fakes are a test-only injected seam, and configured daemon profiles now feed live executor evidence through bounded `daemon start` | RC-5 (fake demotion landed, NGX-485; daemon wiring landed, NGX-492) |

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
`executor_rounds`, not goal-iteration job artifacts. The former load-bearing
cross-link has been resolved by NGX-494: `goal-loop-mechanism.ts` now reuses the
neutral `finalizeWorkflowStepFromResultFile` seam in
`src/core/executors/step-finalize.ts` instead of importing the M9
`live-step-finalize.ts` ownership surface. So "goal iteration paths back
`goal-loop`" is true only at the shared finalization-primitive layer, not the
`goal start` CLI layer.

**Decision: Deprecate-later.** Goal-first CLI stays a required compatibility
surface (the audit "Keep" list and `workflow-first-gap-matrix.md` both keep
`goal start` as a compatibility/shorthand entry point). It is a future
consolidation target only after the workflow-first runtime owns equivalent
operator read-back and recovery.

**Prerequisite before any narrowing.**

1. Workflow-first equivalents for status (`workflow status`), logs
   (`workflow run logs`), handoff (`workflow handoff`), and recovery clear
   (`workflow run clear-recovery`) exist and are wire-proven; this is now
   satisfied by NGX-486.
2. Migration coverage proves a goal-first operator command maps to its
   workflow-first equivalent without dropping a JSON field, refusal code, or
   text-routing contract — the same byte-equivalence discipline NGX-432 applied
   to broad-CLI dedup.
3. The shared iteration-finalization primitive is disentangled — **landed
   (NGX-494, RC-1b).** The verify/commit/reset transaction moved to the
   neutrally-named `src/core/executors/step-finalize.ts` seam
   (`finalizeWorkflowStep` / `finalizeWorkflowStepFromResultFile`), and the
   `goal-loop` executor family (`goal-loop-mechanism.ts`,
   `goal-loop-executor.ts`, `goal-loop-orchestrator.ts`) now depends on that
   shared home instead of the M9-named `live-step-finalize.ts` module.
   `live-step-finalize.ts` survives as a back-compat alias that re-exports the
   seam under the original `*LiveWorkflowStep*` names for the M9 live wrappers
   and the single-shot family, so narrowing goal-first no longer has to choose
   between keeping the M9 primitive and moving it — the primitive already lives
   in a shared, behavior-equivalent home (proven by `test/step-finalize.test.ts`,
   an import-boundary guard, and the unchanged goal-loop / live-step finalize
   suites).

**Landed (NGX-486): read-back / recovery parity + migration coverage.**
Prerequisites 1 and 2 are now satisfied. Every practical goal-first operator
read-back/recovery flow has a wire-proven workflow-first equivalent, and each is
backed by a non-vacuous contract-equivalent migration proof that runs *both*
commands in one data dir and asserts the workflow-first surface drops no
observable category, refusal code, or success/failure text-routing contract:

- **status read-back** — goal-first `status <goal-id>` ↔ workflow-first
  `workflow status <run-id>` (`test/rc1-status-migration-parity.test.ts`).
- **logs / evidence read-back** — goal-first `logs <goal-id>` ↔ workflow-first
  `workflow run logs <run-id>`, the one flow that previously had zero
  workflow-first coverage and was landed as a vertical slice with per-round
  child artifacts, checkpoints, findings, and decisions reattached
  (`src/core/workflow/logs.ts`; `test/rc1-logs-migration-parity.test.ts`).
- **handoff / restart context** — goal-first `handoff <goal-id>` ↔
  workflow-first `workflow handoff <run-id>`
  (`test/rc1-handoff-migration-parity.test.ts`).
- **recovery clear / recovery status** — goal-first `recovery clear <goal-id>` ↔
  workflow-first `workflow run clear-recovery <run-id>`, with the recovery-status
  read-back observable through `status` / `workflow status` /
  `workflow run monitor`; the proof includes the distinctive guarded-clear
  contract (both refuse-and-preserve the durable flag while a blocking condition
  persists) (`test/rc1-recovery-migration-parity.test.ts`).

Parity is **contract-equivalent**, not byte-equivalent: the two surfaces read
different durable domains (goal iteration/job rows vs workflow run/step/lease
rows), so the bar the proofs hold is "same observable categories, same refusal
*contract*, same text routing," which is the equivalence the ticket allows.

**Compatibility paths that remain.** RC-1 lands *parity and coverage only*; it
does **not** narrow or remove any goal-first command. Goal-first
`goal start` / `status` / `logs` / `handoff` / `recovery clear` stay fully in
force as the compatibility surface, the gap-matrix keeps `goal start` as a
compatibility/shorthand entry point, and the existing goal-first compatibility
tests remain green. Prerequisite 3 (disentangling the shared finalization
primitive from the `goal-loop` executor) has since **landed (NGX-494)**: the
transaction moved to the neutral `step-finalize.ts` seam and the `goal-loop`
executor now depends on that shared home, so the finalization disentanglement no
longer gates the goal-first read-back narrowing — the first slice of which has
since landed (below).

**Landed (NGX-495, RC-1c): goal-first read-back dedup narrowing.** The first
narrowing slice removes the duplicate read-back logic the goal-first surface
*owned* — the form of narrowing the parity proofs make safe without changing
user-visible behavior, since the two domains (goal iteration/job rows vs workflow
run/step/lease rows) read different durable substrate and so cannot be
byte-collapsed into one command path. Before the slice `loadGoalStatus`
(`src/core/goal/status.ts`) and `loadGoalLogs` (`src/core/goal/logs.ts`) each
carried a private, byte-for-byte identical copy of the read-back input preamble
(optional goal-id validation, then data-directory resolution), the latest-goal
lookup, the resolve-the-goal-or-refuse decision (`goal_not_found` / `no_goals`),
and the `EvidenceRecord` → summary projection. Those now live once in the shared
`src/core/goal/read-back.ts` seam (`validateGoalReadBackInput`,
`resolveReadBackDataDir`, `findLatestGoal`, `resolveGoalForReadBack`,
`toGoalEvidenceSummary`), which both loaders compose — mirroring how the
workflow-first read-back surfaces compose the one proven `loadWorkflowRunDetail`
foundation. The preamble stays two composable steps so `loadGoalLogs` keeps its
exact `goalId → iteration → dataDir` refusal precedence. `goal handoff` already
composed `loadGoalStatus` (`src/core/evidence/handoff.ts:121`), so it inherits the
narrowing transitively. All refusal codes, messages, and success/failure text
routing are reproduced verbatim, so the goal-first envelopes stay wire-stable:
`test/goal-read-back.test.ts` unit-tests the extracted seam and the
`test/goal-status.test.ts` / `test/goal-logs.test.ts` / `test/goal-recovery.test.ts`
compatibility suites stay green.

**Deferred from RC-1c (recorded, not narrowed).** Two further consolidations stay
out of this slice on purpose:

1. **Goal-first commands themselves are not removed.** `goal start` / `status` /
   `logs` / `handoff` / `recovery clear` remain the full compatibility surface
   (ticket out-of-scope; the gap-matrix keeps `goal start`). RC-1c removed
   *duplicate internal logic*, not any command or envelope.
2. **The recovery guarded-clear stays domain-specific.**
   `clearGoalManualRecoveryGuarded` (`src/core/goal/recovery.ts`) and
   `clearWorkflowRunManualRecoveryGuarded` (`src/core/workflow/run-recovery.ts`)
   share a structural skeleton (`BEGIN IMMEDIATE` → not-found → not-flagged →
   blocking-condition refusal → clear → commit) but read different durable rows
   and refuse on different blocking semantics: the goal path queries active
   `goal_iteration` job rows and refuses with `job_active` (+ `activeJobIds`),
   while the workflow path reads the run monitor's recovery code and refuses with
   `recovery_clear_refused` (+ `recoveryCode` / `blockingStepId`). Their
   failure-reason vocabularies and result payloads differ, so a forced shared
   helper would obscure the distinct domain semantics rather than remove proven
   duplication. RC-1's `test/rc1-recovery-migration-parity.test.ts` already pins
   the two as *contract-equivalent* (both refuse-and-preserve the durable flag
   while a blocking condition persists); the implementations stay separate.

**Equivalent-behavior proof to preserve:** `test/cli.test.ts` (goal-first CLI
envelopes), `test/goal-init.test.ts`, `test/goal-reducer.test.ts`,
`test/goal-status.test.ts`, `test/goal-logs.test.ts`, `test/goal-recovery.test.ts`,
`test/goal-read-back.test.ts` (the RC-1c shared read-back seam),
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
executor family and `linear-refresh` to the RC-3 daemon-dispatchable
`external-apply` family (`src/core/workflow/definition.ts:306-355`). Therefore the
boundary is by *execution lane*, not by step-name vocabulary: a `merge-cleanup`
step in an imported/manual live-wrapper run can direct-finalize through M9, while
`merge-cleanup` (`script`) and `linear-refresh` (`external-apply`) steps resolved
from the built-in workflow definition enter the M10/RC dispatch lane and are
finalized by the RC-2 reconciliation seam from terminal executor evidence.
Historically this same boundary was documented as mapping `linear-refresh` to the non-dispatchable, fail-closed
`external-apply` family; RC-3 replaced that
family-level closed branch with the safety-gated daemon adapter without changing
the lane-based ownership rule.

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
(`src/core/workflow/dispatch.ts:58` = `goal-loop`, `one-shot`, `script`,
`no-mistakes`, `external-apply`) take the executor-loop path. `subworkflow` fails
closed before executor rows are created, while `external-apply` now enters the
dispatch scaffold and is terminalized by the RC-3 M6-safety-gated adapter. Legacy
live-wrapper execution enters through the
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
above. RC-5's fake demotion has landed (NGX-485): production dispatch no longer
resolves to shipped fake successes by default. RC-5b has also landed (NGX-492):
configured daemon-default live-wrapper profiles now run dispatched steps through
real commands, terminalize executor evidence, and feed that evidence to the RC-2
reconciliation seam. Unconfigured adapters still refuse honestly with
`runtime_unavailable`. Narrowing the coexistence (Path 3) and dispatch scaffold
(Path 4) is now gated on the remaining compatibility-lane migrations rather than
on a missing production evidence producer.

**Equivalent-behavior proof to preserve:** shared finalization —
`test/step-finalize.test.ts`; M9 — `test/live-step-orchestrator.test.ts`,
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

**Prerequisite before any narrowing.** The RC-2 terminal owner has landed, and
RC-5b now feeds that seam terminal evidence from configured daemon-default
live-wrapper profiles. The scaffold still remains until compatibility-lane
migrations prove which dispatcher-owned start rows can be narrowed without
fabricating evidence or stranding work.

**Equivalent-behavior proof to preserve:** `test/workflow-dispatch-execute.test.ts`
(the "creates the scaffold round with no fabricated evidence", stable-id, and
idempotency cases).

### 5. `external-apply` and `subworkflow` fail-closed families

**Current shape.** Both are valid members of `WORKFLOW_EXECUTOR_FAMILIES`
(`src/core/workflow/definition.ts:44`) and both are now included in
`PHASE1_DISPATCHABLE_EXECUTOR_FAMILIES`. `external-apply` (RC-3) composes the M6
`executeExternalApply` path through `createExternalApplyWorkflowDispatch`;
`subworkflow` (RC-4b/NGX-498) composes the child-run producer through
`createSubworkflowWorkflowDispatch`, with the daemon context deriver sourcing the
child-definition config + bounded recursion lineage from the parent run's
`route`. Each producer verifies the recorded scaffold family before acting, and
both layer terminal executor evidence + RC-2 reconciliation. A claimed step
resolving to a family with no landed adapter still fails closed with
`code: "unsupported_executor_family"` → `manual_recovery_required`, and
`failClosedDispatch` (`src/core/workflow/dispatch-execute.ts`) sets
`needs_manual_recovery`, opens a `workflow_gates` row, releases the dispatch
lease, and creates no executor rows.

**Decision: external-apply narrowed; subworkflow adapter mechanism + production
flip landed (RC-4b/NGX-498).** The former `external-apply` and `subworkflow`
fail-closed branches have both been replaced by safety-gated adapter wiring. For
`external-apply`, M6 policy gating, audit-before-write, idempotency, and adapter
refusals remain the safety contract; unsafe/unconfigured outcomes terminalize to
manual recovery. For `subworkflow`, the child-definition config + bounded
recursion-safety decider, the route-sourced launch plan, the key-resolved
start-or-attach child runner, and the daemon context deriver compose the RC-4
producer behind the base dispatch under a `subworkflow`-family gate, mapping a
started/attached child run into durable terminal executor evidence without
weakening the parent/child ownership boundary. Missing child config, unsafe
recursion (self-reference / ancestry cycle / depth bound), an unresolved child
definition, an invalid child state, or an ambiguous child terminal all
terminalize to manual recovery.

**Prerequisite before removal of the fail-closed branch.** The generic
`unsupported_executor_family` fail-closed branch is retained as a defensive guard
for any future not-yet-landed family even though both currently-defined families
(`external-apply`, `subworkflow`) now dispatch; it is removed only when no family
can reach it, never as a bare deletion.

**Equivalent-behavior proof to preserve:** `test/workflow-dispatch.test.ts`
(`external-apply` / `subworkflow` dispatchability and the defensive
unsupported-family fail-closed),
`test/workflow-dispatch-subworkflow-flip.test.ts` (a configured `subworkflow`
step dispatches through bounded `daemon start`; the terminal child mirrors back
to the parent while a non-terminal child defers),
`test/workflow-dispatch-execute.test.ts` (durable manual-recovery gate, lease
released, zero invocations, vanished-run safety),
`test/workflow-dispatch-external-apply-run.test.ts` /
`test/workflow-dispatch-external-apply-m6.test.ts` (family guard, daemon wrapper,
M6 write-path reuse, and fail-closed M6 refusals), and
`test/workflow-dispatch-subworkflow.test.ts` /
`test/workflow-dispatch-subworkflow-run.test.ts` /
`test/workflow-subworkflow-dispatch.test.ts` /
`test/workflow-dispatch-subworkflow-child-run.test.ts` (child mirror mapping,
producer deferral / terminal mirroring, daemon wrapper fail-closed derivation,
and real child-run start-or-attach integration).

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
The later RC-5b slice wired daemon-default live profiles into bounded
`daemon start`, so configured dispatched steps now execute a live command in
production and feed real terminal executor evidence to RC-2.

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

1. **RC-1 — Goal-first read-back / recovery parity + migration coverage. ✅
   Landed (NGX-486).** Workflow-first `status` / `logs` / `handoff` /
   `clear-recovery` equivalents exist and are each backed by a non-vacuous
   contract-equivalent migration proof (`test/rc1-status-migration-parity.test.ts`,
   `test/rc1-logs-migration-parity.test.ts`,
   `test/rc1-handoff-migration-parity.test.ts`,
   `test/rc1-recovery-migration-parity.test.ts`). This lands parity + coverage
   only; goal-first CLI stays the compatibility surface and is **not** narrowed
   here — and the shared iteration-finalization primitive it reused has since
   been disentangled (NGX-494; Path 1, prerequisite 3). **RC-1c (NGX-495) has
   since landed the first narrowing slice:** the duplicate goal-first read-back
   logic owned by `goal/status.ts` and `goal/logs.ts` (input preamble,
   latest-goal lookup, resolve-or-refuse, evidence projection) now lives once in
   the shared `src/core/goal/read-back.ts` seam with all envelopes wire-stable
   (`test/goal-read-back.test.ts`); the domain-specific recovery guarded-clear
   dedup stays deferred and no goal-first command is removed. (Path 1)
2. **RC-2 — M9/M10 step-finalization reconciliation seam. ✅ Landed (NGX-480).**
   The single idempotent seam that finalizes dispatched steps from terminal
   executor evidence now ships as `reconcileDispatchedWorkflowStep`
   (`src/core/workflow/dispatch-reconcile-execute.ts`) over the pure decider
   `planWorkflowStepReconciliation` (`src/core/workflow/dispatch-reconcile.ts`),
   with a bidirectional no-double-finalize proof
   (`test/workflow-dispatch-reconcile-execute.test.ts`). The
   `src/core/workflow/dogfood-dispatch.ts` stand-in (formerly
   `src/workflow-dogfood-dispatch.ts`) is retained as an explicit
   test/dogfood-only opt-in fixture rather than deleted; configured daemon
   profiles now provide the real production executor evidence the seam consumes,
   so the fixture hides no production terminal gap behind it. RC-2 unblocks
   narrowing of both the coexistence (Path 3) and the dispatch scaffold (Path 4),
   each still gated on the remaining compatibility-lane migrations.
3. **RC-3 — `external-apply` daemon-dispatchable adapter. ✅ Adapter wired
   (NGX-496).** The pure mapping from an M6 `ExecuteExternalApplyResult` into the
   `WorkflowStepExecutorDispatchResult` evidence the terminalize bridge consumes
   now ships as `mapExternalApplyResultToExecutorResult`
   (`src/core/workflow/dispatch-external-apply.ts`): a clean `applied` outcome
   (including an idempotent already-applied replay) becomes a `succeeded`
   executor result, and every M6 failure (`policy_denied`, `auth_unavailable`,
   `unsupported_adapter`, `intent_apply_in_progress`, `intent_blocked`,
   `audit_incomplete`, `write_rejected`, …) becomes a fail-closed
   `manual_recovery_required` result with the precise M6 cause preserved in the
   operator-facing error text. The async daemon-dispatchable producer
   `executeAndReconcileDispatchedExternalApplyStep`
   (`src/core/workflow/dispatch-external-apply-run.ts`) runs the injected M6
   `executeExternalApply` write path outside any database transaction, maps the
   result through the pure mapping, records terminal executor evidence on the
   `<run>::<step>::dispatch` scaffold, and lets RC-2 finalize the owning step
   exactly once — with an idempotent-re-entry guard that never re-runs the
   external write once the dispatch invocation is terminal, and the M9
   direct-finalize lane refused without ever running the write. The M6 write
   path is taken by injection (`DispatchedExternalApplyRunner`) so the daemon
   lane owns building the apply input and wiring `executeExternalApply` with its
   policy / adapter / audit dependencies; this module never reaches a real
   `api.linear.app` endpoint itself. The M6 safety model (policy gating,
   audit-before-write, comment-only default, idempotency markers, CAS/in-flight
   refusal, blocked/audit-incomplete behavior) runs verbatim — RC-3 reuses the
   single M6 write path rather than inventing a second one. Coverage:
   `test/workflow-dispatch-external-apply.test.ts` (pure mapping, including
   composition with `planDispatchedExecutorTerminalization`),
   `test/workflow-dispatch-external-apply-run.test.ts` (producer contract:
   clean applied, fail-closed on every M6 refusal, idempotent re-entry,
   reconcile deferral, M9 lane boundary), and
   `test/workflow-dispatch-external-apply-m6.test.ts` (integration proof
   binding the producer to the real `executeExternalApply` through a mock
   Linear write/refresh client: applied → succeeded + RC-2 finalize, idempotent
   re-entry never re-writes, real `policy_denied` refusal → manual recovery
   with no write attempted). The production dispatch lane now includes
   `external-apply` in `PHASE1_DISPATCHABLE_EXECUTOR_FAMILIES` and composes the
   landed adapter through bounded `daemon start`; `subworkflow`'s production flip
   followed in RC-4b (NGX-498). (Path 5)
4. **RC-4 — `subworkflow` daemon-dispatchable adapter. ✅ Adapter mechanism
   landed (NGX-497).** The pure, total mapping from a child workflow run's
   observed `WorkflowRunState` into the `WorkflowStepExecutorDispatchResult`
   evidence the terminalize bridge consumes now ships as
   `planSubworkflowChildMirror` (`src/core/workflow/dispatch-subworkflow.ts`): a
   non-terminal child (`pending` / `approved` / `running`) defers with no terminal
   evidence; a clean child terminal mirrors the child's classification
   (`succeeded` → clean `succeeded`, `failed` → clean `failed` — a child failure
   is a legitimate mirrored terminal, not a process-level executor failure); and
   an ambiguous `canceled` / stuck `blocked` / unexpected child state fails closed
   to a `manual_recovery_required` result. The async daemon-dispatchable producer
   `executeAndReconcileDispatchedSubworkflowStep`
   (`src/core/workflow/dispatch-subworkflow-run.ts`) observes the child run
   through an injected start-or-attach runner (no parallel ad hoc child runtime —
   the parent step owns dispatch evidence; the child run owns its own steps /
   gates / recovery / terminal state), maps the observation through the pure
   mapping, mirrors a terminal child onto the `<run>::<step>::dispatch` scaffold
   for RC-2 to finalize exactly once, and defers a non-terminal child (new shared
   `childDeferred` status) without finalizing the parent — with an
   idempotent-re-entry guard that never re-starts the child run once the dispatch
   invocation is terminal. The daemon-lane entry-point factory
   `createSubworkflowWorkflowDispatch`
   (`src/core/workflow/subworkflow-dispatch.ts`) composes that producer behind the
   base dispatch under a `subworkflow`-family gate, injecting the child-run
   start/attach derivation and routing a refused or thrown derivation to manual
   recovery rather than stranding the dispatch lease over a `running` step.
   Coverage: `test/workflow-dispatch-subworkflow.test.ts` (pure mapping +
   terminalize composition), `test/workflow-dispatch-subworkflow-run.test.ts`
   (producer contract: defer, clean mirror, fail-closed, idempotent re-entry, M9
   lane boundary), `test/workflow-subworkflow-dispatch.test.ts` (entry-point
   factory composition + fail-closed-on-refusal), and
   `test/workflow-dispatch-subworkflow-child-run.test.ts` (the producer bound to a
   real child workflow run through the existing run-start / status seams). (Path 5)
4b. **RC-4b — `subworkflow` production dispatch-lane flip. ✅ Landed (NGX-498).**
   The open child-definition config / recursion decision is resolved: a pure,
   total child-config shape + bounded recursion-safety decider
   (`subworkflow-child-config.ts`), route-sourced config + durable recursion
   lineage (`subworkflow-route.ts`), a key-resolved start-or-attach child runner
   (`subworkflow-child-runner.ts`), and the daemon context deriver
   (`subworkflow-dispatch-context.ts`) compose the RC-4 producer. The daemon lane
   wires that deriver through `withSubworkflowDispatch` in `cli.ts`, and
   `subworkflow` is added to `PHASE1_DISPATCHABLE_EXECUTOR_FAMILIES`, so a
   configured `subworkflow` step now dispatches through bounded `daemon start`.
   Fail-closed/manual-recovery is preserved for missing child config, unsafe
   recursion (self-reference / ancestry cycle / depth bound), an unresolved child
   definition, an invalid child state, and an ambiguous child terminal. Coverage:
   `test/workflow-subworkflow-child-config.test.ts`,
   `test/workflow-subworkflow-route.test.ts`,
   `test/workflow-subworkflow-child-runner.test.ts`,
   `test/workflow-subworkflow-dispatch-context.test.ts`, and the bounded
   dogfood/smoke proof `test/workflow-dispatch-subworkflow-flip.test.ts`. (Path 5)
5. **RC-5 — Real `WorkflowStepExecutor` adapters + fake demotion. ✅ Fake demotion
   landed (NGX-485).** The shipped fake `ADAPTERS` map is replaced: the production
   default registry is now real adapters (honest `runtime_unavailable` when
   unconfigured), the deterministic fake moved to a test-only injection seam
   (`test/helpers/fake-workflow-step-executor.ts`) injected through the entrypoints'
   `registry` parameter, and substrate smoke is preserved. RC-5b's reusable
   execution seams have since **landed** (NGX-492): the dispatched-step
   terminalization bridge (`dispatch-executor-terminalize.ts`), the
   run→terminalize→reconcile execution path producer
   (`dispatch-executor-run.ts`), the daemon-default profile source resolver
   (`daemon-live-wrapper-profile.ts`), the live-wrapper dispatch composition
   (`live-wrapper-dispatch.ts`), and the daemon-lane exec-context deriver
   (`daemon-dispatch-exec-context.ts`) are all in place and individually
   unit-tested, and the bounded `daemon start` workflow lane now composes
   `createLiveWrapperWorkflowDispatch` for configured daemon-default profiles so
   dispatched steps run a live command in production and feed real terminal
   evidence to the RC-2 reconciliation seam. (Path 6)
6. **`NGX-404` (existing, deferred) — coding-workflow default switch.** Owns the
   `cwfp-*` default-route narrowing under `coding-workflow-ownership.md`; the
   import/read path survives regardless. (Path 2)

Ordering note: RC-2 is the prerequisite for the most consolidation (Paths 3 and
4) and led — its reconciliation seam has now **landed** (NGX-480). RC-5's fake
demotion has since **landed** (NGX-485): the production executor default is real
adapters and the fakes are a test-only injected seam. RC-1's goal-first
read-back / recovery parity + migration coverage has since **landed** (NGX-486):
all four operator flows (status / logs / handoff / recovery) have wire-proven
workflow-first equivalents and contract-equivalent migration proofs, while
goal-first CLI stays the compatibility surface (no narrowing). RC-5b's reusable
execution seams and bounded `daemon start` wiring have since **landed**
(NGX-492): the terminalization bridge, execution-path producer, profile source
resolver, live-wrapper dispatch composition, exec-context deriver, and
daemon-default profile wiring are all in place and tested. RC-1b's shared
finalization disentanglement has since **landed** (NGX-494): the
verify/commit/reset transaction moved to the neutral `step-finalize.ts` seam and
the goal-loop executor depends on that shared home. RC-1c's first goal-first
narrowing slice has since **landed** (NGX-495): the duplicate goal-first
read-back logic is now owned once by the shared `src/core/goal/read-back.ts`
seam, while the goal-first commands stay the compatibility surface and the
domain-specific recovery guarded-clear dedup stays deferred. With that slice
landed, the next remaining runtime consolidation item in Path 1 — the
domain-specific recovery guarded-clear dedup and the eventual goal-first
command-surface narrowing — stays deferred (no safe domain-neutral dedup today;
the commands stay the compatibility surface). RC-3's daemon-dispatchable
`external-apply` adapter has since **landed** (NGX-496): the pure M6 → executor
evidence mapping and the async run-path producer are in place and tested, reusing
the single M6 write path behind its full safety contract, and `external-apply` is
now wired through the daemon dispatch lane. RC-4's daemon-dispatchable
`subworkflow` adapter mechanism has since **landed** (NGX-497): the pure
child-mirror mapping, the async run-path producer, and the daemon-lane entry-point
factory are in place and tested behind the child-run ownership boundary, while the
production `subworkflow` branch stays fail-closed until a separate PHASE1
dispatch-lane flip lands (deferred pending a child-definition config decision).
The remaining capability-gated consolidation work is the `subworkflow` PHASE1
flip after RC-4 and `NGX-404`, which stay deferred until that child-config
decision / dogfood lands.

## Non-Goals

- No broad production logic deletion and no coverage removal (milestone non-goals).
- No default switch away from goal-first, `cwfp-*` import, or the fake substrate.
- No new migrations, CLI commands, or daemon scheduling changes — this is a plan.
- No external writes, remote git operations, or Linear updates from runtime code.
- No collapsing of the M9 direct-finalize path into the M10 executor-loop path
  within this milestone; RC-2 proved the reconciliation boundary, while
  compatibility-lane narrowing remains future work.
