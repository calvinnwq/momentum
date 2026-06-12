# Contract: Momentum-Owned Coding Workflow

**Status:** Accepted migration contract for NGX-397. This contract does not
start a new execution path by itself. It defines the ownership boundary that
future slices must preserve while the existing OpenClaw `coding-workflow-pipeline`
skill remains the stable production path.

## Decision

Momentum owns the durable runtime for the future coding workflow product.
OpenClaw may expose that runtime through a skill, but OpenClaw must not remain
the source of truth for new Momentum-native coding workflow orchestration.

The target ownership split is:

```text
Momentum: WorkflowDefinition, WorkflowRun, StepRun, gates, leases, executor state, evidence, recovery
OpenClaw: user-facing skill, Discord delivery, rendering, compatibility, and client commands
CWFP: stable legacy production path until Momentum-native dogfood proves the replacement
```

This keeps two truths separate:

- Existing `cwfp-*` runs stay readable and usable through the current
  `coding-workflow-pipeline` skill.
- New Momentum-native coding workflow runs must be opt-in until they complete a
  real dogfood from start through Linear refresh.

## Source Of Truth

For the Momentum-native path, Momentum owns:

- Run identity and lifecycle.
- Step ordering and state.
- Approval boundaries and operator decisions.
- Human gates and delegated-policy decisions.
- Leases, heartbeats, stale-work classification, and reattach behavior.
- Executor invocation and round records.
- Evidence pointers, result summaries, findings, PR / CI state, verification
  outcomes, merge evidence, and Linear refresh evidence.
- Recovery taxonomy and next-action classification.

OpenClaw does not own those records for the Momentum-native path. It may render
them, deliver them, and call Momentum commands, but it should not synthesize a
parallel plan / ledger / monitor as the primary state store.

## OpenClaw Skill Boundary

An OpenClaw skill for Momentum-owned coding workflows may:

- Ask Momentum to start an opt-in coding workflow run.
- Render Momentum status, monitor, handoff, and approval surfaces.
- Deliver Discord approval controls from Momentum gate state.
- Record operator responses by calling Momentum decision commands.
- Import or read historical `cwfp-*` state for compatibility.
- Fall back to the existing `coding-workflow-pipeline` for normal work until
  the Momentum-native path is proven.

It must not:

- Treat a `cwfp-*` plan as the primary state for a new Momentum-native run.
- Infer execution approval from casual prose.
- Start implementation, postflight, no-mistakes, merge cleanup, or Linear
  refresh outside Momentum's durable gate / decision state.
- Replace Momentum leases, recovery, or next-action classification with an
  in-memory shell session or chat transcript.
- Change the current `coding-workflow-pipeline` default behavior before the
  migration gates below pass.

## Start Routes

The stable production route remains the current explicit CWFP approval flow:

```text
approve pipeline cwfp-... through merge cleanup
```

The future opt-in Momentum-native route should start in Momentum first. The
exact CLI / skill wording may evolve, but the intent is:

```text
momentum workflow run start --definition coding-workflow ...
```

or a skill-facing equivalent that calls that Momentum start path rather than
constructing a `cwfp-*` plan as the owner.

Momentum-native run ids must be distinct from `cwfp-*` run ids so operators can
tell which system owns a run at a glance. Historical `cwfp-*` identifiers remain
compatibility identifiers.

## Compatibility Rules

Historical `cwfp-*` artifacts remain valid compatibility state:

- `plan.json`
- `ledger.jsonl`
- `approval-*.json`
- `monitor.json`
- step artifacts under `.gnhf/`, `.no-mistakes/`, and related workflow-owned
  directories

Momentum may import, mirror, or link those artifacts, but imported `cwfp-*`
state is not proof that Momentum owns future orchestration for that run.

The existing `coding-workflow-pipeline` skill remains available for real work
until the Momentum-native path proves:

1. opt-in run start from Momentum state,
2. durable approval / gate handling,
3. implementation execution under Momentum step ownership,
4. postflight execution under Momentum step ownership,
5. no-mistakes adapter / mirror evidence and decisions,
6. merge cleanup and verification evidence,
7. Linear Done / comment / project update evidence,
8. compatibility visibility for old `cwfp-*` runs.

## Migration Gates

Momentum-native coding workflow can become the default only after a real dogfood
PR proves:

- start -> implementation -> postflight -> no-mistakes -> merge cleanup ->
  Linear refresh,
- no skipped or chat-only approval boundaries,
- no duplicate primary state between Momentum and CWFP,
- status, monitor, and handoff recover correctly after process or chat loss,
- historical `cwfp-*` runs remain readable,
- rollback is clear: route new work back to CWFP and leave existing Momentum
  rows inspectable.

Until those gates pass, the default remains CWFP.

## Issue Sequence

The active replacement track is:

1. `NGX-397` — this contract and OpenClaw skill boundary.
2. `NGX-398` — opt-in Momentum-started coding workflow runs via skill shim.
3. `NGX-399` — approvals and gates in Momentum.
4. `NGX-400` — implementation executor adapter.
5. `NGX-401` — postflight executor adapter.
6. `NGX-402` — no-mistakes executor adapter and gate mirror.
7. `NGX-403` — merge cleanup and Linear refresh adapters.
8. `NGX-404` — default switch / CWFP retirement for new runs after dogfood.

`NGX-404` is intentionally deferred. It is not permission to remove or break
the current `coding-workflow-pipeline` path.

## Relationship To Native No-Mistakes Decomposition

The no-mistakes native decomposition track remains a separate, later goal.
`NGX-402` mirrors and drives no-mistakes as an adapter so Momentum-owned coding
workflow can ship without reimplementing no-mistakes internals.

The future `NGX-364` / `NGX-392` through `NGX-395` track may then absorb more
of the no-mistakes pipeline into Momentum-native workflow state so Momentum is
not permanently dependent on no-mistakes.

Do not collapse these tracks:

- `NGX-402` is the near-term adapter / mirror.
- `NGX-392` through `NGX-395` are the later replacement / decomposition path.

## Non-Goals

This contract does not:

- Implement the Momentum-native coding workflow start path.
- Change default CWFP behavior.
- Rewrite GNHF, postflight, no-mistakes, merge cleanup, or Linear refresh
  internals.
- Authorize autonomous external writes.
- Retire or delete historical `cwfp-*` artifacts.
- Require native no-mistakes decomposition before the adapter / mirror path
  works.
