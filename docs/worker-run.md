# `worker run`

This page is the canonical reference for the `worker run` command — the
queued execution path that drains pending `goal_iteration` jobs in
single-job batches.

See also:

- [`docs/daemon.md`](daemon.md) for the managed-loop `daemon start` mode that
  composes `worker run` semantics into a bounded in-process drain.
- [`docs/recovery.md`](recovery.md) for the stale-lease pre-check and the
  manual-recovery artifact / `needs_manual_recovery` flag.
- [`docs/failure-reset.md`](failure-reset.md) for the per-iteration outcome
  taxonomy that `finalizeIteration` produces.
- [`docs/runners.md`](runners.md) for the `RunnerAdapter` boundary and the
  built-in `fake` / `trusted-shell` / `acp` profiles.

## CLI shape

```text
momentum worker run [--worker-id <id>] [--data-dir <path>] [--json]
```

`--worker-id` is optional; default is `worker-<pid>`. `worker run` is a
foreground one-shot command — it claims at most one `goal_iteration` job,
finalizes the iteration through the same transaction as the foreground path,
runs the completion reducer, releases the repo lock, and exits. For continuous
queued drain, see the managed `daemon start` mode in
[`docs/daemon.md`](daemon.md).

## Single-job pipeline

1. Run the stale-lease pre-check (see below) and surface stale records
   without auto-releasing them.
2. Claim the oldest pending `goal_iteration` job, stamping `worker` / `lease`
   metadata.
3. Acquire a repo lock for the goal repo before launching the iteration; refuse
   the claim if the lock cannot be acquired.
4. Refresh lease metadata with a heartbeat before execution.
5. Execute the claimed `goal_iteration` through `finalizeIteration` — the same
   transaction the foreground path uses. The transaction captures `baseHead`,
   runs the configured runner profile through the `RunnerAdapter` boundary,
   runs Momentum-owned verification, then either commits the full repo diff as
   one Momentum commit on verified success or hard-resets the worktree back to
   `baseHead` on runner / verification / commit failure when HEAD is still at
   the expected base. If a runner or finalization step moves HEAD outside
   Momentum's transaction, the iteration is classified as `manual_recovery`,
   `recovery.md` is written, and the goal is flagged `needs_manual_recovery`.
6. Persist `jobs.result_path` to the runner-reported result JSON path on
   success (`iterations/<n>/result.json` by default; `trusted-shell` and `acp`
   may use another `trusted_shell.result_file` / `acp.result_file` inside the
   iteration directory) and `jobs.error_path` to `iterations/<n>/verification.log`
   (or `runner.log` for pre-runner failures) on failure.
7. Emit the terminal job event (see below).
8. Run the completion reducer (see below).
9. Release the repo lock with the appropriate `recovery_status` (or mark it
   `needs_manual_recovery` if the iteration produced manual-recovery metadata).
10. Emit a deterministic CLI JSON result for automation.

## Job lifecycle events

On the success path, the worker emits `job.succeeded` with commit and artifact
pointers:

- `commit_sha`
- `commit_message`
- `branch`
- `branch_created`
- `base_head`
- `goal_complete`
- `result_path`
- `artifacts.iteration_dir`
- `artifacts.prompt`
- `artifacts.runner_log`
- `artifacts.verification_log`
- `artifacts.result_json`

On the failure path, the worker emits `job.failed` with the summarized error
plus a narrower artifacts block (`iteration_dir`, `runner_log`,
`verification_log`).

## Completion reducer

After the job completes, the worker runs `reduceGoalIteration`, which classifies
the terminal job as one of:

- `continue` — enqueues one next `goal_iteration` job with idempotency key
  `goal:<id>:iteration:<n>`, bumps the goal to state `queued`, and emits
  `goal.reduced`.
- `goal_complete` — sets the goal to `completed` and emits `goal.reduced` +
  `goal.completed`.
- `max_iterations_reached` — sets the goal to the corresponding terminal state
  and emits `goal.reduced` + `goal.failed`.
- `iteration_failed` — sets the goal to the corresponding terminal state and
  emits `goal.reduced` + `goal.failed`.

The reducer is idempotent: re-invoking it on the same terminal job short-circuits
to `already_reduced` without duplicating events or enqueueing duplicate work.

If the reducer throws, the worker emits a defensive `goal.reduce_failed` event
with the error message and surfaces `reducerError` on the `worker run` CLI
result so the job's commit / reset is preserved for inspection and manual
recovery.

## CLI JSON result codes

`worker run` exits with a stable deterministic JSON envelope keyed by `code`:

- `no_work` — no pending `goal_iteration` job was available to claim.
- `not_executed` — the worker observed pending work but did not execute it
  (e.g. lock contention or pre-claim refusal).
- `ran_job` — the worker claimed and finalized one job (success or failure
  detail lives on the job result, not the CLI code).

The same envelope carries `stalePreCheck` (see below), `job` (the claimed job
summary), `reducer` (decision + downstream effects), `reducerError` (when the
reducer throws), and lock release metadata.

## Runner profile dispatch

Queued jobs execute the runner profile stored on the Goal row. Both foreground
and queued paths dispatch through the `RunnerAdapter` boundary; only runners
with `executes: true` in the adapter registry can be invoked. `fake`,
`trusted-shell`, and `acp` are all executing runners:

- `trusted-shell` runs an operator-trusted executable plus argv in the target
  repo by default (or the iteration artifact directory with
  `trusted_shell.cwd: iteration`) with no sandbox.
- `acp` runs an ACP / acpx-style external agent runtime via the same boundary
  with an optional pre-flight probe that maps missing runtime / auth to
  `runtime_unavailable`.

Both report a normalized `RunnerResult` via a configured result file; see
[`docs/runners.md`](runners.md) for the full schema and failure-code taxonomy.

## stalePreCheck

The stale-lease pre-check runs before any claim attempt. It surfaces a
`stalePreCheck` block on the JSON response (and a one-line notice on text mode)
listing any active repo locks and claimed / running `goal_iteration` jobs whose
lease has expired beyond `staleLeaseGraceMs` (5s default skew tolerance), so
operators see what needs manual recovery before launching another worker.

`worker run` itself stays read-only on stale records — it never auto-releases
locks or re-pends stale claims. The startup-recovery pass that the managed
`daemon start` loop runs is the path that automatically releases known-safe
stale leases (see [`docs/recovery.md`](recovery.md)).

## Local interrupt policy

`worker run` is a foreground one-shot command. If the process is interrupted
mid-run, jobs and locks may remain `claimed` or `active` until lock expiry;
re-running the command is the supported local recovery path. The pre-check
will surface the stale records on the next invocation so the operator
can drive manual recovery deliberately.

On lock release, the worker stamps `recovery_status` on the lock so the
post-mortem state of every iteration is durable. If the iteration returned
manual-recovery metadata (`runner_changed_head` / `head_mismatch`), the lock is
marked `needs_manual_recovery` and continues blocking claims until
`momentum recovery clear` releases it (see [`docs/recovery.md`](recovery.md)).

## status / handoff cross-reference

`status --json` and `handoff --json` surface the same `latestJob.resultPath` /
`latestJob.errorPath` pointers, plus `reducer` (decision, iteration, goal state,
completion reason, commit SHA, next job), `nextJob` (the queued next-iteration
job, if any), `nextAction` (a human-readable hint), and `daemon` (run ID, state,
active / terminal flags, heartbeat, active job, stop request, stop-now request,
and cancel outcome) so downstream tooling can locate the per-iteration
artifacts, decide what to do next, and observe daemon stop / cancel state
without running `daemon status` separately. The written `handoff.json` artifact
keeps snake_case `result_path` / `error_path` fields.
