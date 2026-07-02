# Momentum Vision

This file captures the engineering opinions that shape Momentum. `SPEC.md`
defines the current runtime contract; this file explains the product direction
that future work should preserve. Long-form planning history, readiness notes,
and migration rationale live in Obsidian `/Workspaces/Momentum`.

## Core Direction

Momentum is a durable workflow runtime for repo work. It should make work
observable, resumable, auditable, and recoverable without depending on terminal
scrollback or repeated LLM summarization.

- Durable rows, compact JSON envelopes, fixtures, and evidence records are the
  source of truth.
- CLI text is for humans; structured JSON is for agents, GUI clients, monitors,
  and sidecars.
- External systems are observed or ingested before they are mutated.
- External writes are explicit, policy-gated, audited, and reconciled from
  read-back evidence.
- Approval, recovery, and operator-decision gates are first-class workflow
  state, not comments in logs.
- Compatibility paths remain readable while Momentum-native paths are proven by
  dogfood and tests.

## Runtime Opinions

### Durable State Beats Process State

Running processes, sockets, hooks, and file watchers are hints. They are never
the authority. A resumed workflow must be able to recover from durable workflow
rows, executor rounds, evidence records, events, and external read-back.

### Steps Are Resumable Units

A workflow step should be safe to retry. Before acting, it should inspect its
own durable state and any relevant external state, then choose exactly one of:

- no-op because the work is already complete
- reconcile from evidence
- perform the missing action once
- block with a precise operator action

Step results should record what was observed, what was attempted, what changed,
and what evidence proves completion.

### Tail Steps Own Their Side-Effect Preconditions

Side-effecting tail steps such as `merge-cleanup` and `linear-refresh` own their
own capability, auth, target-state, idempotency, apply, and reconcile checks.
Their internal shape is:

```text
preflight -> apply -> reconcile
```

For `merge-cleanup`, that means the step proves GitHub auth/config visibility,
pull request identity, expected head, and safe merge state before it mutates
GitHub. On retry it reads GitHub and git first, then reconciles or applies once.

For `linear-refresh`, that means the step proves Linear auth, source item,
pending intent, idempotency marker, and target state before it mutates Linear.
On retry it reads Linear and intent audit state first, then reconciles or
applies once.

These checks belong inside the step that owns the side effect so recovery stays
local, idempotent, and evidence-backed.

### Workflow-Level Preflight Is Structural

Workflow-level preflight should validate the shape of the run before runtime
work begins. It is not a substitute for per-step side-effect preflight.

Workflow-level structural preflight covers:

- workflow definition and built-in version resolution
- approval boundary and route configuration validity
- wrapper/profile/config schema validity
- canonical config key spelling and value shape
- generated artifact/result paths that can be validated without executing a
  side effect
- fail-closed setup errors with clear file/key/action metadata

Workflow-level structural preflight should not own:

- GitHub merge auth and pull request mergeability
- Linear external-apply auth, pending intent claim, or tracker mutation
- no-mistakes service result reconciliation
- any external mutation or effectful retry

Those belong to the step that performs or reconciles the side effect.

### Actions Should Be Explicit

Operators and clients should see one clear next move:

- approve the next gate
- fix config/auth
- retry safely
- reconcile from evidence
- stop or abort

Ambiguous runtime failures should be refined into structured setup, recovery,
or operator-decision states with precise machine-readable fields.

### Native Goal Loop Is The Core Flywheel

Momentum's `goal-loop` executor should be the native autonomous implementation
engine for repo work. It should keep looping through a task until the goal's
requirements are met, not stop merely because one agent attempt ended.

By default, a goal loop has no maximum iteration count and no token cap. The
goal's acceptance requirements are the stop condition. Operational safety still
matters: each round should have a bounded execution envelope, heartbeat/stale
lease detection, no-progress detection, manual stop/cancel semantics, and
operator recovery gates.

The durable loop shape is:

```text
read durable state -> run one verifiable round -> verify -> commit or reset -> record evidence -> decide complete or continue
```

Each successful round should commit its own coherent unit of work and record the
commit SHA, changed files, verification result, normalized result JSON,
artifacts, checkpoints, and learnings. Failed, invalid, or no-op rounds should
not create misleading commits, but they should still preserve useful learnings
and recovery evidence so the next round does not repeat the same mistake.

If a process dies halfway through, Momentum should resume from durable
invocation and round state: completed rounds, in-flight/stale round markers,
notes/learnings, commits, artifacts, leases, gates, and recovery evidence. A
resumed loop must not infer truth from terminal scrollback, duplicate completed
rounds, or create duplicate commits.

GNHF is valuable source material for this loop: its per-iteration prompt, notes,
structured JSON result, commit-per-successful-iteration behavior, stop condition,
and resume model are all directionally right. But Momentum owns the runtime
boundary. `.gnhf/runs` may be mirrored or used by a runner, but it must not be
the durable source of truth for Momentum-native workflows.

Do not add a first-class `gnhf` executor family merely to reuse that behavior.
The product shape is native `goal-loop`; GNHF can be a runner, compatibility
source, or extraction reference beneath it.

## Workflow-Level Preflight Contract

The first workflow-level hardening slice implements structural preflight for
native coding start and preview setup without moving tail-step side-effect
checks out of their owning steps.

### Goal

Validate Momentum-native coding workflow structure before execution reaches
runtime side effects, and emit compact structured evidence that tells an
operator exactly what setup must be fixed.

### Scope

- Reuse one structural preflight routine across preview/start validation where
  the same data is available.
- Validate `route.steps` as fail-closed structured config.
- Validate route profile and wrapper config shape before invalid setup reaches
  runtime work.
- Reject unknown keys and common casing drift with canonical snake_case
  guidance.
- Validate env allowlists, result-file fields, timeout fields, and per-step
  config ownership.
- Emit compact preflight evidence with check ids, status, offending path/key,
  and recommended fix.
- Keep side-effect capability checks inside `merge-cleanup`, `linear-refresh`,
  and other effectful steps.

### Non-Goals

- Do not switch Momentum-native workflow to the universal default.
- Do not broaden environment forwarding beyond explicit allowlists.
- Do not perform GitHub, Linear, or other external writes during workflow-level
  preflight.
- Do not require GUI or monitor clients to parse prose.

### Acceptance Criteria

- Invalid structural config fails before any downstream runtime side effect can
  start.
- Valid checked-in profiles and generated wrapper configs continue to pass.
- Error envelopes identify the failing file/key/check and a corrective action.
- Tests cover valid config, unknown keys, casing drift, malformed env allowlists,
  invalid route steps, and the separation between structural preflight and
  side-effect step preflight.
- `SPEC.md` remains the runtime contract; this file remains the product and
  engineering opinion anchor.

## Documentation Boundary

This is a compact repo anchor, not a long-form planning archive.
There are no standing exceptions for repo-local `internal/` docs; any future
exception must be explicit, reviewed, and protected by the docs-boundary tests.
Keep detailed roadmaps, milestone provenance, dogfood evidence, and migration
rationale in Obsidian `/Workspaces/Momentum`.
