# Milestone 3: Operational Safety

**Status:** Complete (NGX-272 through NGX-278).

Milestone 3 is **orchestrator lifecycle / operational safety**, not merely daemon process plumbing. It landed durable daemon / orchestrator state, stop-request visibility, stale-lease recovery, manual-recovery artifacts, and closeout smoke / docs while preserving Momentum's durable Goal / Iteration / Job / Handoff model and SQLite-backed queue. The work is informed by OpenAI Symphony's orchestration model ([SPEC.md](https://github.com/openai/symphony/blob/main/SPEC.md)) but Momentum is a durable local-first engine, not an issue-tracker poller / Codex app-server clone.

## M3 durable primitives

Momentum's product model is centered on these durable concepts; M3 did not break or rename any of them, and later milestones (M4 runner profiles, M5 source adapters and evidence, M6 external apply) build on this vocabulary verbatim:

- **Goal** — the core product primitive. A Markdown spec plus acceptance criteria, durably tracked in SQLite with its own state machine.
- **Source** — an external system that can seed Goals or reconcile context (Linear, GitHub, Jira, etc.).
- **Source Item** — a durable intake record under a Goal, drawn from a Source. Not the completion authority.
- **Iteration** — one verified attempt at the Goal, with prompt, runner log, verification log, and result artifacts.
- **Job** — a queued unit of work (today: `goal_iteration`) with idempotency key, lease, and result / error pointers.
- **RunnerAdapter** — the boundary for invoking an agent runner. M3 documented the boundary; M4 landed real adapters (`fake`, `trusted-shell`, `acp`) and the runtime `MOMENTUM.md` policy loader.
- **Workflow / Policy** — repo-owned configuration and prompt contract; `MOMENTUM.md` is the canonical file (runtime loader shipped in M4 via NGX-284; M3 documented the contract only).
- **Workspace / Repo Lease** — the shared per-Goal repo lock that protects the working tree during an iteration.
- **Event** — append-only record on the durable event log (`job.enqueued`, `job.claimed`, `job.heartbeat`, `iteration_*`, `job.succeeded` / `job.failed`, `repo_lock.recovered`, `job.recovered`, `goal.reduced`, `goal.completed` / `goal.failed`, `goal.reduce_failed`, `goal.recovery_cleared`).
- **Handoff** — the `handoff.md` + `handoff.json` artifacts that snapshot state for continuity.

## M3 locked decisions

- Momentum's core product primitive is `Goal`, not `Issue`. A Goal may be seeded from one or more source items; Linear projects / issues are one source shape, not the source of truth.
- Goal completion is decided by the Goal Markdown acceptance criteria plus runner, verification, and handoff evidence, not by source-item count or external tracker state alone.
- Tracker writes are **adapter-mediated and policy-gated**. Momentum core records durable facts and emits external update intents; Linear / GitHub / Jira / etc. adapters or approved workflow steps perform the external writes. M6 lands the first concrete policy-gated external apply path on the Linear adapter.
- Source adapters were scoped as **pull / reconcile first** in M3 alignment; active source-adapter implementation belongs to M5. No inbound webhook infrastructure in the operational-safety milestone.
- A Goal uses **one shared repo / workspace lease** for now. Per-source-item worktrees or workspaces are deferred until daemon, stop, and recovery behavior are solid.
- `MOMENTUM.md` is the canonical repo policy file. M3 documented it as a contract only and did not add a runtime loader, parser, or precedence rules; M4's NGX-284 later added the runtime loader once a milestone justified it.

## Planned M3 issue order

The Linear milestone "Milestone 3: Operational Safety" sequenced the work as (all closed):

1. **NGX-272 — M3-01 Orchestrator state model and daemon CLI contract** *(done)*: durable `daemon_runs` schema and storage primitives with idempotency and stale-heartbeat detection; `daemon start` records a new orchestrator run and refuses while an active one exists; `daemon stop` records an idempotent stop request without killing runners; `daemon status` and `doctor --json` surface no-daemon, active, stop-requested, error-terminal, stale, and malformed-CLI states; the active-run contract is hardened so concurrent `daemon start` invocations cannot race.
2. **NGX-273 — M3-02 Managed daemon loop for queued jobs** *(done)*: `runDaemonLoop` composes `runWorkerOnce` via optional hooks, applies deterministic idle backoff via `pollIntervalMs`, refreshes `daemon_runs` heartbeat / active_job / reconcile_count per cycle, observes `stop_requested` between cycles, transitions to `error` on internal failure, and exits with explicit `exitReason` values; `daemon start --max-loop-iterations` / `--max-idle-cycles` opts the loop into bounded managed mode while `--poll-interval-ms` only tunes an already-bounded loop and the no-flag invocation keeps the NGX-272 register-only contract.
3. **NGX-274 — M3-03 Graceful daemon stop visibility** *(done)*: `status --json` / text and `handoff` JSON / markdown surface daemon stop-request state via a `daemon` summary field (`runId`, `state`, `isActive`, `isTerminal`, `startedAt`, `heartbeatAt`, `finishedAt`, `activeJob`, `stopRequest`) so operators can see why work is not draining without running `daemon status` separately; the daemon loop includes a focused stop-between-jobs test asserting that a stop requested after a reducer-enqueued follow-up iteration does not claim it.
4. **NGX-275 — M3-04 Immediate daemon stop-now cancellation** *(done)*: `daemon stop --now` records an idempotent immediate-stop request via a new `stop_now_requested_at` column on `daemon_runs`; the managed loop observes it between cycles and finalizes to a new `canceled` terminal state with `cancel_outcome` of `idle` or `active_job_completed`; iteration atomicity keeps the repo state clean on cancellation; `status`, `handoff`, and `daemon status` surface `stopNowRequest`, `cancelOutcome`, and the new `canceled` terminal.
5. **NGX-276 — M3-05 Stale-lease detection and safe auto-recovery** *(done)*: `listStaleRepoLocks` / `listStaleClaimedGoalIterationJobs` / `listStaleDaemonRuns` give deterministic stale-state visibility; `recoverStaleRepoLocksForTerminalJobs` / `recoverStaleClaimedGoalIterationJobs` / `recoverStaleDaemonRuns` auto-release / re-pend / finalize known-safe cases while refusing dirty / active / ambiguous states with a stable skip taxonomy (`job_pending` / `job_claimed` / `job_running` / `job_missing` for locks; `job_running` / `daemon_active` / `lock_active` / `job_state_changed` / `repo_dirty` / `repo_unknown_commit` / `repo_unavailable` for claims; `active_job_present` / `active_lock_present` / `self` / `run_state_changed` for daemons); `runStartupRecovery` composes the three primitives behind the daemon loop's pre-loop pass; `repo_lock.recovered` and `job.recovered` queue events plus `recovery_status` columns on `repo_locks` and `daemon_runs` carry the audit trail.
6. **NGX-277 — M3-06 Manual recovery artifacts, durable goal-level needs_manual_recovery flag, blocked-claim guard, recovery clear CLI, and cross-CLI visibility** *(done)*: `recovery-artifact.ts` renders and writes a goal-scoped `recovery.md` with schema version, reason code / message, commit pointers, iteration artifact paths, and safe next steps; `maybeWriteRecoveryArtifact` writes the artifact and marks the durable flag for `repo_dirty` / `repo_unknown_commit` / `repo_unavailable` / `job_running` skip reasons when `dataDir` is provided; `markGoalNeedsManualRecovery` / `clearGoalManualRecovery` / `getGoalManualRecoveryState` manage `needs_manual_recovery` / `manual_recovery_reason` / `manual_recovery_at` columns on `goals`; `claimPendingGoalIterationJob` filters out flagged rows; `clearGoalManualRecoveryGuarded` refuses when the goal is missing, not flagged, or still has active claimed / running jobs, then clears the flag, releases repo locks in `needs_manual_recovery` state, and appends a `goal.recovery_cleared` event; `momentum recovery clear <goal-id>` wires the guarded clear into the CLI.
7. **NGX-278 — M3-07 Milestone closeout** *(done)*: built-CLI smoke coverage for daemon drain, graceful stop, stop-now cancellation, safe stale recovery, and manual recovery artifact visibility paths; `doctor`, README, and AGENTS marker alignment naming M3 complete; explicit list of cross-milestone deferrals so the operational-safety surface is pinned.

NGX-278 introduced the M3 closeout marker on `doctor --json` / text. NGX-286 later flipped it to the M4 closeout marker, and NGX-294 flipped it again to the M5 closeout marker.

## M3 non-goals (explicit)

The following remained **explicitly out of scope** for Milestone 3 and were deferred to future milestones (some have since landed in M4 or M5, others remain deferred):

- **Background runner supervision** — forking, daemonization, restart-on-crash; the single-process managed loop on `daemon start` is the supervision contract.
- **Cooperative mid-job cancellation / signal handling** — `daemon stop` and `daemon stop --now` are observation-only between cycles; they do not signal, kill, or otherwise terminate any running runner, worker, or external process.
- **Per-source-item worktrees** / parallel same-repo Goals — a Goal still uses one shared repo lease.
- **Inbound webhooks** — adapters stay pull / reconcile first; Momentum does not expose an HTTP listener in M3 (or in M4 / M5).
- **Dashboard or UI surface** — CLI JSON / text remains the only interface.
- **Strong sandboxing** (container / VM / seccomp isolation) — runners trust the local operator environment; later milestones may revisit isolation.
- **Remote git operations** — no `fetch` / `pull` / `push` / `rebase` driven from Momentum.
- **External tracker writes** — Linear / GitHub / Jira / etc. issue / PR creation, comments, status changes, label edits driven automatically from Momentum. Tracker writes stay adapter-mediated and policy-gated; M6 lands the first concrete external apply path on the Linear adapter.

## Symphony to Momentum mapping

Symphony is an orchestration **reference**, not a blueprint to clone. M3 adopted the parts that align with Momentum's durable, local-first posture and explicitly avoided the parts that do not.

| Symphony concept | Momentum equivalent |
|---|---|
| `WORKFLOW.md` | Repo policy contract documented in M3, runtime-loaded in M4 (`MOMENTUM.md`). |
| Issue | Source item / intake record under a Momentum Goal. |
| Orchestrator state (in-memory) | Momentum daemon / orchestrator state plus durable queue / job records in SQLite. |
| Per-issue workspace | Current Goal repo-lease boundary; future worktree support deferred. |
| Agent runner | Momentum `RunnerAdapter` boundary (`fake`, `trusted-shell`, `acp`, and later Codex / Claude / OpenCode / other ACP backends). |
| Status / log snapshots | Momentum events, `status --json`, `logs`, and `handoff` artifacts. |

### Adopt from Symphony

- Repo-owned workflow config and prompt contract (`MOMENTUM.md`), with typed config loading and dynamic reload semantics added only when justified (M4 added the runtime loader once a milestone needed it).
- Single-authority scheduling and explicit reconciliation passes.
- Retry / backoff taxonomy on jobs and runner calls.
- Workspace safety invariants (clean tree, captured base HEAD, deterministic reset).
- A runner event taxonomy that makes runner progress observable without coupling to one vendor.
- Token / rate-limit observability and an explicit trust / sandbox posture for runners.

### Avoid from Symphony

- In-memory-only scheduler state; Momentum's queue stays durable in SQLite.
- A Codex-only runner protocol; keep the `RunnerAdapter` boundary multi-backend.
- An issue-tracker-only product model; Goal remains the durable primitive.
- High-trust auto-approval as an implicit default; every external / destructive action must be policy-gated.
- Inbound webhooks in M3; adapters stay pull / reconcile first.
- Per-issue workspace cleanup that risks losing audit artifacts.
- Core-owned tracker writes; adapters or approved workflow steps own external writes.
- A runtime `MOMENTUM.md` loader before a future milestone proves it is needed.

## M2 contracts preserved

M3 did not break or rename any M2 surfaces. The SQLite-backed queue (`jobs` / `events` / `repo_locks`), idempotent enqueue keys, `worker run` as a single-shot consumer, the completion reducer (`reduceGoalIteration` classifying `continue` / `goal_complete` / `max_iterations_reached` / `iteration_failed`), and the iteration artifact layout (`prompt.md`, `runner.log`, `verification.log`, `result.json`) all remain wire-stable. M3 added durable `daemon_runs` rows, the manual-recovery flag on `goals`, the `recovery.md` artifact, and recovery / heartbeat columns on `repo_locks` and `daemon_runs` additively, without changing existing M2 row shapes or CLI JSON schemas.
