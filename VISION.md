# Momentum Vision

This file is the compact product opinion anchor.
[`SPEC.md`](SPEC.md) holds runtime contracts; [`ARCHITECTURE.md`](ARCHITECTURE.md) holds source structure.
Long-form planning, milestone history, and rationale live in the personal wiki `/Workspaces/Momentum`.

## What Momentum Is

Momentum is a local-first runtime that makes agent-driven repo work durable.
You wrap the agent CLIs you already use in workflow steps; Momentum owns what they cannot: resumable state, verification gates, commit boundaries, recovery, human approvals, and an auditable record of what happened.

The core promise: if a process dies, a laptop sleeps, or an agent goes sideways, no work and no truth is lost.
A workflow resumes from durable rows and evidence, never from terminal scrollback or a summarizer's memory.

Momentum is not an agent and never will be.
It does not prompt, reason, or write code.
It is the layer underneath: the thing that makes whichever agent you use this month safe to run unattended.

### Who It Is For

Developers who run coding agents on real repositories and have been burned: lost sessions, unverified commits, silent failures, no record of what an overnight run actually did.

### The Test

Within 12 months, ten or more external users run Momentum weekly on their own repositories, evidenced by issues and adapter requests we did not seed.
Until then, every design choice optimizes for reaching that test, not for protecting existing surfaces.

## The Model

Momentum's system of record is a five-level hierarchy.

- A **workflow definition** is a versioned, reusable recipe: ordered step definitions with executors, gates, and agent config.
- A **workflow run** is one durable instance of a definition against a repository.
- A **step** pairs the same way: a step definition in the recipe becomes a resumable **step run** inside the workflow run.
  Before acting, a step run inspects its own durable state and chooses exactly one of: no-op, reconcile from evidence, act once, or block with a precise operator action.
  Side-effecting steps own their full `preflight -> apply -> reconcile` lifecycle.
- An **attempt** is one executor's go at a step; a retry after terminal recovery creates a new attempt, never a rewrite.
- A **round** is one durable iteration inside an attempt: it does bounded work, verifies, then commits or resets, and records evidence.
  Terminal rounds are immutable; a resumed run never replays or re-commits them.

Around that hierarchy sit four supporting concepts.

- **Gates** are durable human decision points: approval, operator decision, manual recovery.
  They are first-class rows, never comments in logs.
- **Leases, checkpoints, and heartbeats** are how in-flight work proves liveness and how staleness is detected without trusting process handles.
- **Evidence** covers artifacts, events, verification results, and recovery codes.
  Evidence outranks every process signal; it is what a resumed run and a human reviewer both read.
- **Executors** are pluggable ways to run a step; they get their own section below.

One sentence holds it together: a definition is instantiated as a run; a run advances through steps; a step dispatches attempts; an attempt accumulates rounds; every round verifies, then commits or resets, and leaves evidence.

## Core Opinions

**Durable state beats process state.**
Processes, sockets, hooks, and watchers are hints.
Authority lives in durable rows, evidence records, and external read-back.
Anything that matters survives a crash.

**Local-first, forever.**
The operator's machine is the source of truth: SQLite plus local artifacts.
Anything remote is sync or export, never authority.
This is a permanent identity, not a staging phase.

**Verification is the commit boundary.**
A round commits only after verification evidence is captured.
Failed, stale, or no-op rounds never manufacture commits to make progress look cleaner, but they still preserve learnings and recovery evidence so the next round does not repeat the mistake.

**Observe before mutating.**
External systems are read and ingested before they are written.
External writes are explicit, policy-gated, audited, and reconciled from read-back evidence, never fire-and-forget.

**Fail closed, honestly.**
A missing capability is a structured refusal, not a fake success.
Ambiguous failures are refined into precise setup, recovery, or operator-decision states with machine-readable fields.

**One clear next move.**
At any moment, an operator or client can see exactly one recommended action: approve, fix config, retry, reconcile, or stop.
Surfaces that cannot say this are incomplete.

**Text is for humans; JSON is for machines.**
Every surface a GUI, supervisor, or agent consumes is a structured envelope.
Nothing downstream ever parses prose.

## Executors

Momentum never does the work.
Every step names an **executor**, the kind of thing that does:

- `agent-once` runs an agent CLI, captures its result, and stops.
- `agent-loop` runs an agent in rounds until the objective's acceptance requirements are met.
- `script` runs a deterministic command with no agent.
- `delegate-supervisor` hands the work to an autonomous external tool, then supervises it to completion: mirroring its progress into rounds, detecting stalls, and guiding it when it needs answers.
  The tool owns its own loop; Momentum owns the evidence.
  Which tool - a validation pipeline, an autonomous coding harness, a CI run - is step config, never a schema name.
- `external-apply` performs a policy-gated mutation of another system - create, edit, or delete: preflight, apply once, reconcile from read-back.
- `subworkflow` runs the step as a nested workflow.

Every executor runs inside the same durable envelope: bounded turns, structured observations and evidence, explicit classification, recovery, and operator gates.
Result documents, verification, and commit-or-reset boundaries are narrower mechanism contracts for agent, script, and profile-backed handoff work rather than requirements imposed on every external-state read.
That envelope is Momentum's identity; executors are interchangeable ways of filling it.
Which agent an `agent-*` executor runs is the step's **agent config** - harness, model, effort - not a new executor.
What role a step plays in a recipe - implement, validate, merge - is the step's kind, not its executor.
Purpose and executor are separate axes, always.

An executor obeys one contract: inspect durable state first, act at most once per round, record what was observed, attempted, and proven, and recommend - never decide - the outcome.
The daemon owns decisions.

The `agent-loop` executor keeps looping through rounds until the objective's requirements are met: no default iteration cap, requirements as the stop condition, one verified commit per successful round.
It is a powerful executor, and it is only an executor: Momentum's identity is the durable envelope, not any single way of filling it.

Executors are the primary SDK surface.
A third party adds an executor against documented interfaces, and the proof of the SDK is that the built-in executors use it themselves.
If Momentum's own tracker adapter or agent wrapper needs private hooks, the SDK is not done.

The current schema calls this concept an "executor family"; the pre-1.0 nomenclature sweep drops the suffix and renames the values (`one-shot` to `agent-once`, `goal-loop` to `agent-loop`, `no-mistakes` to `delegate-supervisor` with the tool as step config).
How steps bind to real commands on a given machine is that host's **bindings**, selected by environment; the words "route" and "profile" are retired rather than redefined.

## Stability And 1.0

Momentum is pre-1.0, and it behaves like it.
Until 1.0, any surface may change between releases: command names, flags, JSON envelope fields, executor names, environment variables.
The changelog is the contract.
Pre-1.0 is also when the vocabulary gets one full cleaning pass: legacy and personal-history names are swept from schema enums, CLI flags, and env vars so external users never onboard into them.

One thing never breaks, even pre-1.0: durable state.
A product whose promise is durability does not strand its own data.
Database and artifact-layout changes always ship with in-place migration; a data directory written by any earlier version keeps working.
Interfaces are fluid, evidence is forever.

1.0 is an event with a definition, not a milestone with a date.
It is declared when external users are running Momentum weekly on their own repositories and the surfaces they depend on have stopped needing to change.
At 1.0, the stable set freezes explicitly: the machine-facing JSON envelopes, the data-directory layout, exit codes, and the executor SDK interfaces.
Everything not in the stable set stays honestly labeled as fluid.

Until then, the bias is deletion and consolidation over compatibility.
Keeping a legacy surface alive costs the project more than it costs any current user, because there are none yet.

## Reference Deployment

Momentum's first production user is its own author.
The maintainer's agent stack - an OpenClaw-based supervisor for delivery and wake-ups, a personal validation pipeline behind a `delegate-supervisor` step, Linear as the tracker - runs real coding workflows through Momentum end to end: implementation, verification, merge cleanup, tracker refresh.

That deployment is proof, not product.
It exists in this document for exactly two reasons.
First, dogfood: Momentum's own changes ship through Momentum-orchestrated workflows, so the maintainer feels every rough edge before any external user does.
Second, honesty about shape: it demonstrates that the integrations are plugins on public boundaries - a delivery wrapper over the watch envelope, a supervised delegation over an external tool, a tracker adapter behind the tracker-ingestion and external-apply interfaces.
If the reference deployment ever needs a private hook, the boundary it bypassed is a bug in the product.

Linear is the reference tracker adapter: the worked example of read-only ingestion, policy-gated writes, and audited reconciliation that other tracker adapters copy.
Nothing in the core schema, CLI, or envelopes may name the maintainer's tools; that vocabulary lives at the plugin edge, where every user's stack lives.

## Non-Goals

- **Not an agent.**
  Momentum never prompts, reasons, or writes code, and the runtime never calls an LLM, not even for diagnosis.
  Intelligence lives in the executors' agents and tools; judgment lives with the operator.
- **Not a hosted service.**
  No server, no tenant, no account.
  Remote is sync or export, never authority.
  If a future adds sharing, it is built on exported evidence, not on moving the source of truth.
- **Not CI.**
  Momentum runs a repo's own verification commands at commit boundaries; it does not replace test infrastructure, and it treats CI results as external state to observe.
- **Not a tracker bot.**
  External systems are never mutated autonomously.
  Every write is an explicit, policy-gated, audited intent with reconciliation, or it does not happen.
- **Not a general workflow platform.**
  The scope is repo work: code, commits, verification, review, delivery.
  Durable-execution ideas are borrowed gratefully, but Momentum is not competing to run arbitrary distributed jobs.

## Documentation Boundary

This file is the compact product opinion anchor, not a planning archive.
[`SPEC.md`](SPEC.md) holds runtime contracts; [`ARCHITECTURE.md`](ARCHITECTURE.md) holds source structure; public docs describe shipped behavior only.
Long-form planning, milestone history, dogfood evidence, and migration rationale live in the personal wiki `/Workspaces/Momentum`.
There are no standing exceptions for repo-local `internal/` docs; any future exception must be explicit, reviewed, and protected by the docs-boundary tests.
