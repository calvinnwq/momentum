# Built-binary smoke coverage

`pnpm test` includes a built-binary end-to-end smoke (`test/smoke.test.ts`)
that builds `dist/` via `pnpm build`, initializes disposable git repos under
the OS temp dir, and drives core CLI commands through the spawned `node
dist/index.js` binary. The smoke is the single highest-value integration
artifact in the repo — it pins public CLI behaviour against the real
SQLite-backed orchestrator without mocking the runner adapter, the daemon
loop, or the source / evidence / intent stores.

See also: [docs/walkthrough.md](../docs/walkthrough.md) for the operator-facing copy-paste
disposable smoke, [docs/daemon.md](../docs/daemon.md) for the managed-loop envelopes, and
[docs/worker-run.md](../docs/worker-run.md) for the single-job pipeline that the queued
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
  iteration prompt (see [docs/runners.md](../docs/runners.md) for the full precedence
  chain).
- `acp` `runtime_unavailable` path when the configured runtime is missing.

## Milestone 5 source / evidence / intent coverage

The smoke exercises the M5 source-adapter and evidence-sync surfaces against
mock Linear endpoints (no real `api.linear.app` calls — see
[internal/contracts/intent-apply.md](contracts/intent-apply.md) for the test
boundary that M6 inherits):

- the `doctor --json` M5 closeout milestone marker stays pinned to the M5
  string (the M6 milestone flip is reserved for NGX-302 — see
  [internal/milestones/m6-external-apply.md](milestones/m6-external-apply.md)).
- workflow evidence ingestion through `momentum evidence ingest` and
  `evidence list` (see [docs/evidence-commands.md](../docs/evidence-commands.md)).
- empty intent and project-status surfaces (`pendingUpdateIntents: []`,
  `mismatches: []`).
- Linear reconciliation through a mock endpoint: `source reconcile linear`
  paginates a mock Linear server and populates `source_items`,
  `source_snapshots`, and `source_reconciliation_runs`.
- source linking into `status`, `handoff`, and `doctor` surfaces.
- `source_satisfied` intent generation with external-apply policy refusal
  (`policy_denied` without `--repo` context), pending intent preservation, no
  external write, and manual apply through `momentum intent apply` (see
  [docs/intent-commands.md](../docs/intent-commands.md)).
- project rollup mismatch and pending-intent next-action reporting via
  `momentum project status` (see [docs/source-commands.md](../docs/source-commands.md)
  for the stable `mismatches[].kind`, `reconciliationWarnings[].reason`, and
  `nextAction.kind` taxonomies).

## Milestone 6 external apply safety smoke coverage

The smoke exercises the M6 policy-gated external apply path end-to-end through
the spawned binary against a stateful Linear mock dispatcher (no real
`api.linear.app` calls). The mock supports injectable GraphQL errors on
commentCreate and IssueRefresh, per-request commentCreate delay for concurrency
testing, and tracks all comments, issue state updates, and operation request
counts.

Coverage:

- the `doctor --json` M5 closeout milestone marker stays pinned to the M5
  string (the M6 milestone flip is reserved for NGX-302).
- happy-path external apply: a pending `source_satisfied` intent is applied
  through `intent apply --external-apply` against the mock, producing an
  `applied` intent, a deterministic idempotency marker matching
  `momentum-intent:linear:<intentId>:<digest>`, comment-only mutation (zero
  issue state updates), a single commentCreate, a successful post-apply
  single-issue reconcile, and idempotent replay (re-running against the
  now-applied intent refuses with `intent_already_terminal` without a second
  commentCreate).
- `policy_denied` refusal: `intent apply --external-apply` against a repo
  whose `MOMENTUM.md` sets `intent_apply_policy: create_intents_only` refuses
  with `policy_denied`, leaves the intent pending with no audit row, and never
  reaches any mock endpoint beyond the initial source reconcile.
- `auth_unavailable` refusal: `intent apply --external-apply` without
  `LINEAR_API_KEY` set refuses with `auth_unavailable`, leaves the intent
  pending, and never reaches the mock write endpoint.
- `write_rejected` adapter failure: the mock injects a GraphQL error on
  commentCreate; `intent apply --external-apply` exits with `write_rejected`,
  finalizes the audit row as `failed`, leaves the intent pending and
  retry-eligible, and records zero comments.
- `refresh_failed` post-apply reconcile: a successful external write whose
  post-apply IssueRefresh fails still marks the intent `applied` and surfaces
  `reconcile.status=refresh_failed` with a warning recorded on the audit ledger.
- `intent_apply_in_progress` concurrency guard: two parallel `intent apply
  --external-apply` invocations against the same intent produce exactly one
  external mutation (the winner completes with `applied`); the loser is
  refused with `intent_apply_in_progress` and never reaches the external write
  path.
- audit visibility: a `write_rejected` attempt leaves the intent pending and
  the same audit row is visible through `status --json` (top-level
  `externalApply` and per-intent rollup), `project status --json`, `doctor
  --json`, and the `handoff.json` artifact (snake_case `external_apply`) with
  matching `auditId`, `lifecycleState=failed`, and
  `resultCode=write_rejected`.
- blocked / audit-finalize failure: a tampered audit row forces post-write
  finalize into `audit_already_finalized`; the orchestrator marks the audit
  incomplete and blocks the intent, and a retry is refused with
  `intent_blocked` without a second external mutation.

## Test boundary

The smoke must not make real `api.linear.app` calls — see
[internal/contracts/intent-apply.md](contracts/intent-apply.md) for the M6 test
guard that continues this rule into the policy-gated external apply slices.
All Linear interactions use the existing mock endpoint pattern.
