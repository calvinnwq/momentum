# Built-binary smoke coverage

`pnpm test` includes a built-binary end-to-end smoke (`test/smoke.test.ts`)
that builds `dist/` via `pnpm build`, initializes disposable git repos under
the OS temp dir, and drives core CLI commands through the spawned `node
dist/index.js` binary. The smoke is the single highest-value integration
artifact in the repo — it pins public CLI behaviour against the real
SQLite-backed orchestrator without mocking the runner adapter, the daemon
loop, or the source / evidence / intent stores.

See also: [docs/walkthrough.md](walkthrough.md) for the operator-facing copy-paste
disposable smoke, [docs/daemon.md](daemon.md) for the managed-loop envelopes, and
[docs/worker-run.md](worker-run.md) for the single-job pipeline that the queued
paths below exercise.

## Milestone 1 / 2 coverage

- the default queued enqueue path: no runner execution; idempotent re-enqueue
  is observed; the queued job / event SQLite state matches the canonical
  `goal:<goal-id>:iteration:1` idempotency key.
- the foreground success path: exactly one Momentum commit on the Momentum
  branch with the verification log, handoff artifacts, and SQLite database in
  place.
- the foreground verification-failure reset path: the worktree is clean and
  HEAD is back at base after `false` verification.
- the queued logs inspection path: `momentum logs` against a freshly-claimed
  iteration surfaces the expected `runnerLog`, `verificationLog`, and
  `resultJson` blocks.
- the queued `worker run` success / verification-failure / runner-failure
  paths: including reducer event chains and artifact surfaces (`result_path`,
  `error_path`, `job.succeeded`, `job.failed`, `goal.reduced`,
  `goal.completed`, `goal.failed`).

## Milestone 3 daemon / recovery coverage

The smoke exercises the M3 daemon / recovery paths end-to-end through the
spawned binary:

- managed drain via `daemon start --max-idle-cycles`.
- graceful stop via `daemon stop` (the managed loop observes the request
  between cycles).
- stop-now cancellation via `daemon stop --now` (the managed loop finalizes
  the run as `canceled` rather than `stopped`).
- safe stale recovery: stale repo locks whose owning job is terminal are
  auto-released; orphaned stale claims with clean repo state are re-pended;
  idle stale `daemon_runs` rows are auto-finalized.
- manual recovery artifact visibility via `daemon status`, `status`, `logs`,
  `handoff`, and `recovery clear` (the `needs_manual_recovery` flag blocks
  future queue claims until an operator explicitly clears it).

## Milestone 4 real-runner coverage

The smoke exercises the M4 real-runner profile contract:

- `trusted-shell` happy path: `goal start --foreground` runs the configured
  executable plus argv, commits the verified diff, and surfaces the iteration
  through `status`, `logs`, and `handoff`.
- `trusted-shell` failure-and-reset path: a non-zero command exit produces
  `command_failed`, resets the worktree to base HEAD, and preserves the stable
  error code through `status` and `logs`.
- `MOMENTUM.md` policy precedence: the policy file's `runner` default is
  overridden by a CLI `--runner` flag while policy notes thread into the
  iteration prompt (see [docs/runners.md](runners.md) for the full precedence
  chain).
- `acp` `runtime_unavailable` path when the configured runtime is missing.

## Milestone 5 source / evidence / intent coverage

The smoke exercises the M5 source-adapter and evidence-sync surfaces against
mock Linear endpoints (no real `api.linear.app` calls — see
[docs/contracts/intent-apply.md](contracts/intent-apply.md) for the test
boundary that M6 inherits):

- the `doctor --json` M5 closeout milestone marker stays pinned to the M5
  string (the M6 milestone flip is reserved for NGX-302 — see
  [docs/milestones/m6-external-apply.md](milestones/m6-external-apply.md)).
- workflow evidence ingestion through `momentum evidence ingest` and
  `evidence list` (see [docs/evidence-commands.md](evidence-commands.md)).
- empty intent and project-status surfaces (`pendingUpdateIntents: []`,
  `mismatches: []`).
- Linear reconciliation through a mock endpoint: `source reconcile linear`
  paginates a mock Linear server and populates `source_items`,
  `source_snapshots`, and `source_reconciliation_runs`.
- source linking into `status`, `handoff`, and `doctor` surfaces.
- `source_satisfied` intent generation with external-apply refusal
  (`external_apply_unsupported` in M5) and manual apply through
  `momentum intent apply` (see [docs/intent-commands.md](intent-commands.md)).
- project rollup mismatch and pending-intent next-action reporting via
  `momentum project status` (see [docs/source-commands.md](source-commands.md)
  for the stable `mismatches[].kind`, `reconciliationWarnings[].reason`, and
  `nextAction.kind` taxonomies).

## Test boundary

The smoke must not make real `api.linear.app` calls — see
[docs/contracts/intent-apply.md](contracts/intent-apply.md) for the M6 test
guard that continues this rule into the policy-gated external apply slices.
All Linear interactions use the existing mock endpoint pattern.
