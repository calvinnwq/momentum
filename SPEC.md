# Momentum Spec

This file is the compact repo anchor for current runtime, workflow, and
documentation contracts. Long-form planning history, milestone provenance,
readiness notes, dogfood evidence, and migration rationale live in Obsidian
`/Workspaces/Momentum`.

## Runtime Model

Momentum is a workflow-first runtime for durable repo-work orchestration.

- `WorkflowDefinition` and `StepDefinition` define reusable workflow shape.
- `WorkflowRun` and `StepRun` track run and step lifecycle.
- `ExecutorInvocation` and `ExecutorRound` sit below a step and store executor
  attempts, artifacts, result summaries, verification status, commit metadata,
  recovery codes, findings, decisions, and checkpoints.
- `Goal` remains a compatibility surface and `goal-loop` executor family.

Executor families currently include `goal-loop`, `one-shot`, `script`,
`no-mistakes`, `external-apply`, and `subworkflow`.

The daemon owns scheduling, leases, recovery rechecks, gate enforcement, and
bounded progress. Executors own bounded work and may recommend `continue`,
`approval_required`, `operator_decision_required`, `manual_recovery_required`,
`blocked`, `failed`, `cancelled`, or `complete`. The daemon decides state
transitions from durable evidence.

## Workflow Safety

Human gates are first-class durable rows. Approval, operator decision, and manual
recovery boundaries must be visible through status, handoff, monitor, recovery,
and logs surfaces. Autonomy is allowed only inside the approved envelope.

Every dispatched step must produce normalized result evidence or mirrored
external state before final classification. Process handles, hook events,
sockets, and file watchers are fast-path hints, not authoritative state.

## External Apply

External tracker writes are policy-gated and two-phase:

1. claim one pending update intent
2. audit before write
3. perform the external write only when repo policy allows it
4. finalize and reconcile the touched issue

The default policy is local intent creation only. The Linear path is
comment-only unless explicitly configured otherwise, carries a stable
idempotency marker, and must fail closed without losing the M6 refusal reason.

## Source And Adapter Boundaries

Source adapters are read-only with respect to external systems. They write only
Momentum source tables, source snapshots, reconciliation runs, evidence, and
local update intents. They must not mutate Goal, Iteration, Job, workflow,
executor, git, or external-write state.

Adapter testing stays layered:

- isolated contract tests
- stubbed integration tests
- opt-in real smoke tests
- full end-to-end composition proofs

Default CI must not call real `api.linear.app`.

## Coding Workflow Ownership

Momentum owns the future durable coding workflow runtime: workflow definitions,
workflow runs, step runs, gates, leases, executor state, evidence, recovery,
status, monitor, handoff, and logs.

OpenClaw remains the user-facing skill, Discord delivery layer, renderer,
compatibility surface, and fallback route while replacement behavior is proven.
Historical `cwfp-*` runs remain readable/importable compatibility state. They
must not become the primary source of truth for new Momentum-owned runs.

The NGX-499 opt-in dogfood proved a Momentum-owned coding workflow through
implementation, postflight, no-mistakes, merge cleanup, and Linear refresh.
NGX-404/default switching remains separate and must preserve rollback.

`workflow run start-coding` (NGX-508) is the explicit Momentum-native start
door: a named opt-in selector over `workflow run start` that always materializes
the built-in `coding-workflow` definition, refuses reserved `cwfp-*` / `cwfb-*` /
`overnight-*` run ids, and records the run with the `momentum-native-coding`
source so durable status/handoff/monitor/logs show it as Momentum-owned. It
captures the run's isolation inputs in durable state: repo, objective, issue
scope, approval boundary, skill revision, and the selected runtime/profile
(`route.profile`); the daemon still resolves the executing live-wrapper profile
from `MOMENTUM_LIVE_WRAPPER_PROFILE` at run time. CWFP remains the default
coding-workflow start and rollback route; the default switch stays NGX-404.

## Runtime Consolidation

Runtime consolidation uses explicit decisions:

- **Keep**: current production paths still required for compatibility or safety.
- **Deprecate-later**: paths that narrow only after their named proof lands.
- **Defer**: paths outside the current issue scope.

No consolidation plan authorizes production deletion by itself. RC-1, RC-1b,
RC-1c, RC-2, RC-3, RC-4, RC-4b, RC-5, and RC-5b have landed. The RC-2
reconciliation seam is the single production owner for finalizing M10-dispatched
workflow steps from durable terminal executor evidence and must prevent
double-finalize and double-write behavior.

## Architecture Contract

The current source layout is:

```text
src/index.ts              process entrypoint only
src/cli.ts                parser, top-level dispatch, compatibility surfaces
src/commands/             command-family modules
src/renderers/            text / JSON envelope rendering helpers
src/adapters/             infrastructure-facing clients and runtime adapters
src/config/               env, path, and default-resolution support
src/shared/               cross-cutting helpers with no narrower domain owner
src/core/<domain>/        workflow, executors, goal, source, intent, daemon, repo, evidence
```

Import direction is fixed:

```text
index -> cli -> commands -> renderers
                   |
                   v
            domain modules -> adapters / persistence
```

Domain modules must not import command modules or renderers. Renderers must not
mutate state. External adapters stay behind domain or command boundaries with
explicit policy checks.

## Milestone Provenance Anchor

The current source architecture baseline is Milestone 11: CLI Architecture
Refactor, closed through NGX-411, NGX-412, NGX-413, NGX-414, NGX-415, NGX-416,
NGX-417, NGX-418, and NGX-419.

Earlier milestone issue ranges preserved in Obsidian:

- M3: NGX-272 through NGX-278
- M4: NGX-279 through NGX-286
- M5: NGX-287 through NGX-294
- M6: NGX-295 through NGX-302
- M7: NGX-312 through NGX-319
- M8: NGX-323 through NGX-330
- M9: NGX-331 through NGX-338
- M10: NGX-344 through NGX-353, with NGX-367 inserted as M10-09a

M10 issue sequence: NGX-344, NGX-345, NGX-346, NGX-347, NGX-348, NGX-349,
NGX-350, NGX-351, NGX-352, NGX-367, NGX-353.

Current behavior belongs in source, tests, `README.md`, `ARCHITECTURE.md`,
`AGENTS.md`, `SPEC.md`, and public/operator docs. Historical milestone detail
belongs in Obsidian.

## Documentation Boundary

The repository must not contain an `internal/` documentation tree. Durable
internal docs live in Obsidian `/Workspaces/Momentum`; repo anchors stay short
and live only in `README.md`, `AGENTS.md`, `ARCHITECTURE.md`, `SPEC.md`, or
narrowly scoped operator docs under `docs/`.

There are no standing exceptions for repo-local `internal/` docs.
If a future exception is ever needed, it must be explicit, reviewed, and protected by the docs-boundary tests.

If a future note grows into planning, contract narrative, milestone provenance,
readiness evidence, dogfood evidence, or migration rationale, move it to
Obsidian and keep at most a compact repo anchor.
