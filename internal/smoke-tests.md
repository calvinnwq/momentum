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

- the `doctor --json` milestone marker reads the M8 closeout string
  (NGX-302 flipped the marker from M5 to M6, NGX-319 from M6 to M7, and
  NGX-330 from M7 to M8 — see
  [internal/milestones/m7-openclaw-coding-workflow-backend.md](milestones/m7-openclaw-coding-workflow-backend.md)).
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
`api.linear.app` calls). The spawned `intent apply --external-apply` commands
set `MOMENTUM_LINEAR_EXTERNAL_UPDATE_ENDPOINT` for the external update client
and `MOMENTUM_LINEAR_REFRESH_ENDPOINT` for post-apply single-issue refreshes so
both clients stay pointed at the mock. The mock supports injectable GraphQL
errors on commentCreate and IssueRefresh, per-request commentCreate delay for
concurrency testing, and tracks all comments, issue state updates, and operation
request counts.

Coverage:

- the `doctor --json` milestone marker reads the M8 closeout string
  (NGX-302 flipped the marker from M5 to M6, NGX-319 from M6 to M7, then
  NGX-330 from M7 to M8).
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

## Milestone 7 workflow-import smoke coverage

The smoke exercises the M7 `workflow import` CLI envelope (NGX-314) end-to-end
through the spawned binary against fixture `.agent-workflows/<run-id>/`
directories built in a temp dir (see
[docs/workflow-commands.md](../docs/workflow-commands.md) for the envelope and
diagnostic taxonomy):

- happy-path import: a fresh `.agent-workflows/cwfp-<hex>/` fixture with
  `plan.json`, `ledger.jsonl`, and `approval-*.json` siblings is imported into
  the `workflow_runs`, `workflow_steps`, and `workflow_approvals` tables; the
  success envelope reports `inserted: true`, the run / step counts, and an
  empty diagnostics array.
- idempotent re-import: running `workflow import` against the same directory a
  second time produces no duplicate rows, surfaces `inserted: false` (upsert),
  and preserves `created_at` while bumping `updated_at`.
- terminal ledger wins over stale monitor: a stale `monitor.json` does not
  override completed ledger evidence; the imported step / run state is derived
  from `ledger.jsonl` and `plan.json`, and the advisory monitor snapshot is
  surfaced separately.
- lost managed-task markers: `managed-*.pid`, `managed-*.log`, and `locks/`
  sibling entries are ignored without diagnostics and do not force a failed
  step state.
- discharged and pending approvals: durable `workflow_approvals` rows are
  written with the artifact digest and discharge timestamp where applicable;
  pending approvals remain pending.
- malformed plan / ledger / approval tolerance: invalid artifacts surface
  stable `evidence_format_invalid` diagnostics (with the per-entry
  `code` / `path` / `reason` / `detail` shape) without dropping valid siblings.
- `runId` fallback: when the directory basename does not match the `cwfp-` /
  `cwfb-` / `overnight-` convention, `plan.json`'s `runId` is used; when
  neither source is present, the CLI refuses with `import_run_id_missing`.
- JSON envelopes: the success and failure envelopes match the shape pinned in
  [docs/workflow-commands.md](../docs/workflow-commands.md), including the
  conditional `dataDir` / `path` fields on failure payloads.
- refusal codes: `path_required` (missing `--path`) and
  `import_path_unreadable` (unreadable `--path` target) exit with code 1 and
  carry the documented refusal codes through both JSON and text outputs.

## Milestone 7 end-to-end coding workflow smoke coverage (NGX-318)

The smoke exercises a real end-to-end coding workflow against the M7
Momentum-owned substrate without invoking the live OpenClaw pipeline,
Discord, GitHub, Linear, or any external tracker writes. Steps are driven
through the deterministic fake executors exposed by
`dispatchWorkflowStepExecutor` (see [src/workflow-step-executor.ts](../src/workflow-step-executor.ts))
and the resulting outcomes are appended to `ledger.jsonl` and re-imported
through the spawned `workflow import` CLI between steps so the durable
`workflow_runs` / `workflow_steps` / `workflow_approvals` / `workflow_leases`
rows are populated exclusively via the public M7 surface.

Coverage:

- happy-path end-to-end run: a fresh `.agent-workflows/cwfp-<hex>/` fixture
  with `plan.json`, `ledger.jsonl`, and an `approval-through-merge-cleanup.json`
  sibling is driven through the current imported workflow artifact chain
  (preflight → implementation → postflight:1 → no-mistakes → merge-cleanup)
  with `outcome: success`; after the final
  re-import the run terminates with `state: succeeded`, zero leases, the
  approval row persisted, no entries in either the active or blocked buckets,
  `workflow handoff` reports `nextAction.code: no_action`, and `monitor.recovery`
  is `null`.
- evidence linkage through handoff: after a `momentum evidence ingest --path`
  pass over the run directory, the `workflow handoff` envelope's
  `detail.evidence` array surfaces the workflow evidence types
  (`plan_created`, `merge_complete`) through typed `runId` / `stepId` linkage,
  with artifact-path prefix matching retained only as a legacy fallback for
  older null-linked rows.
- failure path with no ghost active run: preflight succeeds, implementation is
  driven through `outcome: fail_retry` (default `errorCode: command_failed`);
  after re-import the run terminates with `state: failed`, the
  `workflow status --filter active` and `--filter blocked` filters both report
  zero matches (the failed run only shows up under `--state completed`),
  zero leases remain, `workflow handoff` reports
  `nextAction.code: rerun_failed_step` with `stepId: implementation`, and
  `monitor.recovery` is `{ code: "failed_required_step", stepId: "implementation" }`.

Run locally via the targeted vitest filter:

```
pnpm vitest run test/smoke.test.ts -t "end-to-end coding workflow"
```

## Milestone 8 operator-control end-to-end smoke coverage (NGX-330)

The smoke extends the built-CLI workflow fixture coverage across the M8
operator-control envelopes without invoking live executors, Discord, GitHub,
Linear, or external tracker writes. It reuses the M7 fake-executor fixture and
imports through the public `workflow import` CLI between durable state changes.

Coverage:

- operator-control happy path: a fresh `.agent-workflows/cwfp-<hex>/` fixture is
  imported, discovered through `workflow run list`, approved through
  `workflow run approve`, driven to terminal success through the fake executors,
  and inspected through `workflow run monitor`; after `evidence ingest`, both
  monitor and status detail evidence carry typed `runId` linkage, with ledger
  entries also carrying `stepId` linkage.
- ghost-active recovery path: a started implementation step with no terminal
  ledger evidence or lease imports as `needsManualRecovery: true`, renders
  per-run `recovery.md`, reports `ghost_active_no_lease` through
  `workflow run monitor`, refuses `workflow run clear-recovery` while the
  blocking condition persists, resolves via `workflow run update-step`, and then
  clears recovery explicitly while preserving the audit artifact.

Run locally via the targeted vitest filter:

```
pnpm vitest run test/smoke.test.ts -t "operator-control end-to-end smoke"
```

## Milestone 9 live-execution unit coverage (NGX-334)

The M9-03 verification / commit transaction slice is covered by deterministic
unit tests rather than a built-binary smoke because live workflow execution is
still opt-in and the M9 dogfood smoke is deferred to the closeout slice. The
tests use disposable git repositories and file-backed workflow DB fixtures so
finalization can verify the second-connection repo-lock heartbeat behavior, with
fake live executors standing in for OpenClaw wrappers.

Coverage:

- live-step finalization commits only after configured verification passes and
  the repo HEAD still matches the recorded base.
- runner-reported failure and verification failure reset the worktree back to
  base HEAD through the existing failure-reset path.
- live wrapper-created commits / moved HEADs enter `head_mismatch` manual
  recovery and are preserved rather than reset.
- missing, invalid, oversized, or symlinked result documents return
  `result_missing` / `result_invalid` without committing or resetting
  ambiguous work.
- run-level recovery sets `needs_manual_recovery` first and renders the
  run-scoped `recovery.md` artifact as best-effort guidance for live
  `head_mismatch`, `result_missing`,
  `result_invalid`, `reset_failed`, `repo_lock_lost`, `git_failed`,
  `invalid_input`, and unsafe `commit_failed` outcomes; clean
  `nothing_to_commit` or successfully reset commit failures stay normal step
  failures without the recovery flag, and artifact write failures return
  `artifact_write_failed` while leaving the durable flag authoritative.
- repo-lock and managed-step leases stay fresh through finalization; ownership
  loss before mutation prevents commit/reset, while ownership loss after a git
  commit rejects the terminal success and enters `repo_lock_lost` recovery for
  operator inspection.
- normalized live steps stay running and leased until commit, reset, dispatch
  failure, or recovery reconciliation is durable.
- process-level live dispatch failures preserve their precise live recovery code
  including `executor_threw`, and do not run the git transaction.

Run locally via the targeted vitest command:

```
pnpm vitest run test/live-step-finalize.test.ts test/live-step-run-recovery.test.ts test/live-step-advance.test.ts test/workflow-recovery-artifact.test.ts
```

## Milestone 10 workflow-first runtime coverage (NGX-345 through NGX-353)

M10-01 through M10-08 are covered by focused unit, migration, CLI, and daemon
loop tests. M10-09a adds the first workflow-first built-binary CLI smoke through
the shipped `workflow run start` -> `workflow run approve` -> bounded
`daemon start` path. NGX-353 closes the milestone with a real `ngx353-m10-closeout`
dogfood run through the same workflow-first start / approval / bounded dispatch
surface, plus the regression fix that keeps `workflow_runs` state and monitor
advisory state aligned after dispatch.

Coverage:

- `WorkflowDefinition` / `StepDefinition` validation and the built-in coding
  workflow definition in `test/workflow-definition.test.ts`.
- durable `workflow_definitions` / `step_definitions` upsert, re-persist,
  pruning, loading, and built-in seeding in
  `test/workflow-definition-persist.test.ts`.
- migration coverage for the new definition tables in `test/migrations.test.ts`.
- pure workflow run-start materialization in `test/workflow-run-start.test.ts`.
- durable run-start persistence, definition provenance, approval-boundary
  materialization, and duplicate-run refusal in
  `test/workflow-run-start-persist.test.ts`.
- `workflow run start` CLI coverage for built-in definition seeding, persisted
  definitions, refusal envelopes, repo policy loading, and public docs in
  `test/cli-workflow-run-start.test.ts`.
- executor-loop record validation and persistence in
  `test/executor-loop-reducer.test.ts` and `test/executor-loop-persist.test.ts`.
- scheduler-lane scan, stale-lease recovery, dispatch-lease claim, and one-tick
  dispatch behavior in `test/workflow-scheduler.test.ts`.
- daemon-loop opt-in scheduler-lane wiring and goal-iteration compatibility in
  `test/daemon-loop.test.ts`.
- goal-loop executor adapter round decision, invocation-state classification,
  recommendation, finalize-evidence derivation, and round-persistence planning
  in `test/goal-loop-executor.test.ts`.
- goal-loop orchestrator round execution, multi-round invocation, repo-safety
  boundaries, and `runGoalLoopStep` invocation / round materialization in
  `test/goal-loop-orchestrator.test.ts`.
- goal-loop round mechanism derivation from result files in
  `test/goal-loop-mechanism.test.ts`.
- durable goal-loop round persistence round-trip and manual-recovery boundary in
  `test/goal-loop-executor-persistence.test.ts`.
- `listCommittedChangedFiles` committed change-set derivation and deterministic
  ordering in `test/git-transaction.test.ts`.
- single-shot executor adapter recovery taxonomy, classification, invocation /
  round identity, selection resolution, round-start / artifacts / checkpoints /
  persistence projections, and `isSingleShotExecutorFamily` guard in
  `test/single-shot-executor.test.ts`.
- durable single-shot round persistence round-trip through the real
  executor-loop transition graph (including bare-capture `script` success and
  `one-shot` result-bearing success) in
  `test/single-shot-executor-persistence.test.ts`.
- `runSingleShotRound` and `runSingleShotStep` end-to-end through the real
  persistence layer with injected mechanism, covering `one-shot`, `script`,
  blocked, failed, and manual-recovery outcomes in
  `test/single-shot-orchestrator.test.ts`.
- concrete single-shot mechanisms for live-wrapper `one-shot` execution and
  deterministic `script` command execution in `test/single-shot-mechanism.test.ts`.
- no-mistakes executor mirror brain — external-state classification (running /
  human-gate / completion-vs-evidence / failure / blockage), untrusted-evidence
  routing to manual recovery, findings / decisions / invocation / round-start /
  round-persistence projections, the decision → patch and read-failure helpers,
  and the `isNoMistakesExecutorFamily` guard in
  `test/no-mistakes-executor.test.ts`.
- no-mistakes external-state reader (pure parser + file IO) turning untrusted raw
  state into a typed snapshot with a raw-bytes content digest, owning JSON-type
  validation while deferring semantics to the brain, in
  `test/no-mistakes-mechanism.test.ts`.
- durable no-mistakes mirror round persistence round-trip through the real
  executor-loop transition graph (continue heartbeat, direct-to-succeeded
  completion, non-terminal operator/approval gates, failure / blockage, and
  untrusted-evidence manual recovery) plus findings / decisions round-trip in
  `test/no-mistakes-executor-persistence.test.ts`.
- `runNoMistakesMirrorRound` and `runNoMistakesMirrorStep` end-to-end through the
  real persistence layer with an injected reader, covering the long-lived
  multi-poll lifecycle, idempotent findings / decisions mirroring, reader-failure
  manual recovery, and the real `readNoMistakesExternalState` reader in
  `test/no-mistakes-orchestrator.test.ts`.
- the pure workflow-gate decision domain — the nine durable human-gate types,
  the four target scopes (workflow -> step -> invocation -> round), the decision
  modes / refusal codes, and the `evaluateGateDecision` operator / delegated
  brain (allowed-action resolution, delegated-envelope enforcement, note / trim
  handling, and refusals) in `test/workflow-gate.test.ts`.
- durable `workflow_gates` insert / load / list / open-list and race-safe
  `resolveWorkflowGate`, with gate-type / target-scope / scope-ancestry /
  blank-reason / foreign-key validation and duplicate refusal in
  `test/workflow-gate-persist.test.ts`.
- `workflow run decide` CLI coverage for required-argument and invalid-mode
  usage refusals, unknown / already-resolved / action-not-allowed /
  out-of-envelope refusals, operator and delegated-policy success, and the
  JSON / text envelopes in `test/cli-workflow-run-decide.test.ts`.
- durable gate visibility (gate list plus open / total counts) in the
  `workflow status` / `workflow handoff` / `workflow run monitor` envelopes in
  `test/cli-workflow-status.test.ts`, `test/cli-workflow-handoff.test.ts`,
  `test/cli-workflow-run-monitor.test.ts`, and
  `test/workflow-monitor-envelope.test.ts`.
- the pure workflow-dispatch decision domain in `test/workflow-dispatch.test.ts`:
  the phase-1 dispatchable allowlist (`goal-loop`, `one-shot`, `script`,
  `no-mistakes`), unsupported `external-apply` / `subworkflow` fail-closed
  routing, resolution-failure code mapping, and totality.
- durable dispatch resolution in `test/workflow-dispatch-persist.test.ts`:
  run -> definition-link -> step-definition -> executor-family resolution,
  unknown or unlinked state failures, and composed dispatch-plan decisions.
- production dispatch effects in `test/workflow-dispatch-execute.test.ts`:
  supported-family executor invocation / first-round scaffold creation,
  approved -> running step advancement, dispatch-lease ownership, idempotent
  re-entry, unsupported / unresolvable fail-closed manual-recovery gates where a
  run can carry them, vanished-run lease release without a dangling gate, and
  lease release on no-op safety paths.
- shipped bounded `daemon start` workflow-lane wiring in
  `test/cli-daemon-workflow-dispatch.test.ts`: the managed loop dispatches an
  approved workflow step with no test-only injection, surfaces
  `workflowStepsDispatched` / `lastWorkflowCode`, persists executor rows, and
  keeps register-only `daemon start` inert.
- built-binary smoke coverage in `test/smoke.test.ts`: `workflow run start`,
  `workflow run approve`, bounded `daemon start`, durable executor rows, and
  process-loss observability through `workflow status`, `workflow handoff`, and
  `workflow run monitor`.

Run locally via the targeted vitest command:

```
pnpm vitest run test/workflow-definition.test.ts test/workflow-definition-persist.test.ts test/migrations.test.ts test/workflow-run-start.test.ts test/workflow-run-start-persist.test.ts test/cli-workflow-run-start.test.ts test/executor-loop-reducer.test.ts test/executor-loop-persist.test.ts test/workflow-scheduler.test.ts test/daemon-loop.test.ts test/goal-loop-executor.test.ts test/goal-loop-orchestrator.test.ts test/goal-loop-mechanism.test.ts test/goal-loop-executor-persistence.test.ts test/git-transaction.test.ts test/single-shot-executor.test.ts test/single-shot-executor-persistence.test.ts test/single-shot-orchestrator.test.ts test/single-shot-mechanism.test.ts test/no-mistakes-executor.test.ts test/no-mistakes-mechanism.test.ts test/no-mistakes-executor-persistence.test.ts test/no-mistakes-orchestrator.test.ts test/workflow-gate.test.ts test/workflow-gate-persist.test.ts test/cli-workflow-run-decide.test.ts test/workflow-dispatch.test.ts test/workflow-dispatch-persist.test.ts test/workflow-dispatch-execute.test.ts test/cli-daemon-workflow-dispatch.test.ts
```

Run the built-binary production workflow-lane smoke locally via:

```
pnpm vitest run test/smoke.test.ts -t "production workflow-lane dispatch"
```

## Opt-in real adapter smoke (NGX-372)

NGX-372 adds the first adapter test layer allowed to touch a real external
system, behind an explicit opt-in switch. It is **not** part of default
`pnpm test`: the gated suite skips unless the operator opts in, so CI never
reaches `api.linear.app`. CI-safe vs opt-in separation:

- **CI-safe (always runs):** `test/real-smoke.test.ts` pins the pure gating
  decision (`planLinearReadSmoke`) and the failure-mode taxonomy
  (`classifyRealSmokeReadOutcome`) with no network. The gated file also carries
  one always-on guard test proving it stays opt-in.
- **Opt-in (manual / flagged):** `test/real-linear-read-smoke.test.ts` performs a
  bounded, read-only real Linear `issues` reconcile. It is skipped via
  `describe.skipIf` unless `MOMENTUM_REAL_SMOKE_LINEAR` is truthy **and**
  `LINEAR_API_KEY` is set.

Read-only by construction: the smoke composes only the read-side
`LinearReconciliationClient` (`buildLinearHttpReconciliationClient`) — no
external-write adapter is reachable, so no comment/status mutation can occur.
Real external **writes** stay a separate, policy-gated adapter (see the M6 row in
[contracts/adapter-test-coverage.md](contracts/adapter-test-coverage.md)) and are
out of scope for this read smoke.

Manual run:

```
MOMENTUM_REAL_SMOKE_LINEAR=1 LINEAR_API_KEY=lin_api_... \
  pnpm vitest run test/real-linear-read-smoke.test.ts
```

Optional read-only scoping / safety knobs (all default-off):

- `MOMENTUM_REAL_SMOKE_DRY_RUN=1` — perform the real read but persist nothing
  locally (no-op mode; the run row is still recorded).
- `MOMENTUM_REAL_SMOKE_LINEAR_PROJECT=...` — UUID maps to `projectId`, else
  `projectName`.
- `MOMENTUM_REAL_SMOKE_LINEAR_MILESTONE=...` — UUID maps to `milestoneId`, else
  `milestoneName`.
- `MOMENTUM_REAL_SMOKE_LINEAR_MAX_PAGES=2` — bound the drain (default 1 page);
  a non-positive / non-integer value fails closed (skip, `config_invalid`).
- `MOMENTUM_REAL_SMOKE_LINEAR_ENDPOINT=...` — override the GraphQL endpoint, e.g.
  to point a dry-run at a local mock.
- `MOMENTUM_REAL_SMOKE_EVIDENCE_DIR=...` — override the evidence directory.

Evidence: the smoke writes a `linear-read-<ts>.json` record (filters, endpoint,
run state, counts, pagination stop, classified outcome, items persisted) under
`.agent-runs/real-smoke/` by default and logs the path to stdout.

Documented failure modes (surfaced by `classifyRealSmokeReadOutcome`):

- `missing_credentials` — opted in without `LINEAR_API_KEY` (skip; not a run).
- `auth_failure` — 401/403 or auth-shaped GraphQL error from Linear.
- `rate_limited` — HTTP 429 / rate-limit message.
- `network_failure` — transport timeout / DNS / connection-reset failure.
- `tool_unavailable` — no global `fetch` available in the runtime.
- `config_invalid` — bad page-size / endpoint / other config rejection.
- `adapter_error` — any other unrecognized read failure (response shape, etc.).

Cleanup / rollback: the smoke uses a disposable OS-temp data dir that is removed
in `afterEach`, initializes no git repo, and writes only the SQLite database
there, so it leaves the working tree clean. The only durable footprint is the
gitignored `.agent-runs/real-smoke/` evidence file, which the operator may delete
once captured in the Linear closeout. Real external state is never mutated.

## Full adapter E2E proof (NGX-372)

`test/full-adapter-e2e.test.ts` is the **CI-safe** capstone of the layered
adapter-test strategy (see
[contracts/adapter-test-coverage.md](contracts/adapter-test-coverage.md)): after
the isolated contracts (NGX-369 / NGX-370) and the stubbed integration smoke
(NGX-371) are green, it composes the *real* adapter layers through the intended
operator flow in one proof and records evidence of the composition. Every
external system is a fake or a local temp dir — no `api.linear.app` call, no real
agent / runner, no git remote, no external write — so it runs in default
`pnpm test`. It is the test that should never be the first to discover an
adapter-contract bug, since every layer it touches is already individually
pinned.

Coverage:

- **happy-path composition**: a fake Linear read reconciles into the `source_*`
  tables, a built-in coding-workflow run starts with an objective threaded from
  the reconciled issue key, the shipped `executeWorkflowStepDispatch` production
  seam (driven from a real `claimRunnableWorkflowStep` claim) creates the
  phase-1 one-shot start scaffold (invocation `running`, round `pending`, no
  fabricated evidence), and the landed `runSingleShotStep` adapter drives a
  one-shot step to a terminal `succeeded` with a passing verification gate and a
  recorded commit. The proof asserts the durable composition across
  `source_items` / `source_snapshots` / `source_reconciliation_runs`,
  `workflow_runs` / `workflow_steps`, and `executor_invocations` /
  `executor_rounds` / `executor_artifacts` / `executor_checkpoints` (including
  the `result_captured` checkpoint and the `verification_output` artifact).
- **goal-loop terminal composition**: on top of the same real source read →
  reconciliation → workflow run start, the real `implementation` step (the
  goal-loop family in `CODING_WORKFLOW_DEFINITION`) is driven through
  `runGoalLoopStep` to a bounded multi-round invocation that terminalizes
  `succeeded` (round 0 commits but is incomplete → `continue`; round 1 commits
  and recommends completion → `complete`), each round gated by a passing
  verification finalize. The proof asserts the durable, reattachable goal-loop
  invocation id (distinct from the one-shot scaffold's `...::dispatch` id and the
  one-shot adapter id, so it mints no second owner), the ordered `succeeded`
  rounds, and the terminal round's `result_captured` checkpoint stream, and
  records goal-loop composition evidence.
- **no-mistakes mirror terminal composition**: on top of the same real source
  read → reconciliation → workflow run start, the real `no-mistakes` step (the
  no-mistakes family in `CODING_WORKFLOW_DEFINITION`) is driven through
  `runNoMistakesMirrorStep`. Unlike the result-bearing adapters, the mirror
  reflects an external review gate's state as untrusted evidence to classify
  rather than driving an agent Momentum chose: the adapter materializes the
  durable invocation + the single long-lived mirror round (born in
  `mirroring_external_state`), pins the expected external identity, and runs the
  first poll. A corroborated `completed` snapshot with `ciState: passed` (identity
  matching the pinned expected identity) settles the round straight to terminal
  `succeeded` from the mirror phase — the mirror's equivalent of the
  result-bearing adapters' passing verification gate. The proof asserts the
  durable, reattachable no-mistakes invocation id (distinct from the one-shot
  scaffold's `...::dispatch` id, the one-shot adapter id, and the goal-loop
  adapter id, so it mints no second owner), the single `succeeded` mirror round,
  the round's re-fingerprinted `inputDigest`, the pinned-then-mirrored checkpoint
  stream (`expected_external_identity` → `external_state_mirrored`), and records
  mirror composition evidence.
- **M9 live-wrapper managed-step terminal composition**: on top of the same real
  source read → reconciliation → workflow run start (opened `approved` through
  `merge-cleanup` via the real approval-boundary persistence path, then made
  repo-backed with an active worker-held repo lock), the real `merge-cleanup` step
  (a live-wrapper family step) is driven through `runLiveWorkflowStep`. This is the
  managed-step layer the executor-loop adapters never touch: it acquires the
  `managed-step` lease, transitions the durable `workflow_steps` row approved →
  running → succeeded, runs the live wrapper, and persists the terminal state
  *before* releasing the lease. The proof asserts the terminal step state, the
  start/finish stamps, the live result digest, the untouched M8 operator-override
  gate, and the lease released exactly at finalization, and proves the layer is
  distinct by asserting it mints **no** `executor_invocations` / `executor_rounds`
  rows. It records live-wrapper composition evidence.
- **external-write policy gate held closed**: the real `linear-refresh`
  (`external-apply`) step is claimed through the scheduler and dispatched; the
  external-write family is not a phase-1 dispatchable family, so the dispatch
  fails closed — zero executor rows, an operator-visible
  `manual_recovery_required` gate hung from the step, the run flagged
  `needs_manual_recovery`, and the dispatch lease released (not stranded). This
  is the composed proof that real external **reads** stay separated from real
  external **writes**, which remain disabled unless the separate M6 write policy
  gate explicitly allows them.

Phase-1 boundary (honest scope): `executeWorkflowStepDispatch` stops at the start
*scaffold*; the landed `runSingleShotStep` / `runGoalLoopStep` /
`runNoMistakesMirrorStep` executor-loop adapters and the M9 managed-step
`runLiveWorkflowStep` adapter own terminal finalization, and the executor-loop
adapters' seam-level reconciliation with the scaffold is the documented
real-adapter follow-up. The proof therefore exercises the scaffold (via the
production seam) on the `preflight` one-shot step and terminal finalization (via
the landed adapters) on distinct steps: the one-shot adapter on `postflight`, the
goal-loop adapter on `implementation`, the no-mistakes mirror adapter on
`no-mistakes`, and the M9 live-wrapper managed-step adapter on `merge-cleanup`.
The first three settle the `executor_invocations` / `executor_rounds` layer; the
M9 live wrapper instead advances the durable `workflow_steps` row itself under a
`managed-step` lease (a genuinely distinct layer that mints no executor-loop
rows). Each executor-loop adapter carries a deliberately distinct invocation id
(`...::dispatch` for the scaffold vs each landed adapter's own reattachable id),
so scaffold + one-shot terminal + goal-loop terminal + no-mistakes-mirror
terminal + live-wrapper managed-step terminal compose without minting two owners
for one step. With all four terminal families composed, the NGX-372
terminal-composition follow-ups are complete.

Evidence: each test assembles a structured composition-evidence record (per-layer
states / counts / verification status / gate type) and writes it as a
`full-adapter-e2e-<label>.json` artifact. By default this lands in the disposable
temp data dir (removed in `afterEach`, so default `pnpm test` leaves no durable
footprint); set `MOMENTUM_E2E_EVIDENCE_DIR` (e.g. to gitignored
`.agent-runs/full-adapter-e2e/`) to capture durable closeout evidence, mirroring
the opt-in real read smoke's `MOMENTUM_REAL_SMOKE_EVIDENCE_DIR` knob.

Run locally via the targeted vitest filter:

```
pnpm vitest run test/full-adapter-e2e.test.ts
```

## Opt-in real coding-workflow harness smoke (NGX-372)

The opt-in real Linear *read* smoke above touches a real external **read**. The
coding-workflow harness smoke is the other in-scope opt-in real path: invoking a
live OpenClaw wrapper (preflight / implementation (GNHF) / postflight /
no-mistakes / merge-cleanup / linear-refresh) against a real harness. Spawning
the full engines is expensive and side-effectful, and full agent execution stays
owned by the
`coding-workflow-pipeline` skill and the M9 live step wrapper / orchestrator
layers (explicitly approved by run id / boundary). NGX-372's deliverable here is
the **CI-safe decision core** plus a bounded, opt-in **pre-flight probe** smoke —
never a CI full-agent spawn:

- **CI-safe (always runs):** `test/real-workflow-smoke.test.ts` pins the pure
  gating decision (`planWorkflowHarnessSmoke`), the pure spawn-result mapping
  (`classifyProbeSpawnResult`), and the failure-mode taxonomy
  (`classifyWorkflowHarnessOutcome`) from `src/real-workflow-smoke.ts`, with no
  process spawned. It composes the existing M9 `LiveWrapperProfile` registry
  (`parseLiveWrapperProfile` / `resolveLiveWrapper`) to resolve the harness
  command, so the planner reuses the validated wrapper config rather than minting
  a new command surface.
- **CI-safe (always runs):** `test/real-workflow-probe-smoke.test.ts` covers the
  execution helpers in `src/real-workflow-probe.ts` — `runHarnessProbe` (a
  bounded `spawnSync` over the resolved probe, same discipline as
  `src/acp-runner.ts`) and `loadRawWorkflowProfileFromEnv` — by spawning only a
  cheap local `process.execPath` (node) child (clean exit, non-zero exit, missing
  binary, timeout) and reading a temp profile file. No external system is reached.
- **Opt-in (skipped by default):** the same file's
  `describe.skipIf`-guarded *real probe smoke* actually runs the resolved
  wrapper's pre-flight probe when an operator opts in, classifies the outcome,
  and records evidence under gitignored `.agent-runs/real-smoke/`. It spawns only
  the cheap availability probe (the safe probe-only dry-run), never the full
  agent.

`planWorkflowHarnessSmoke(env, rawProfile)` is read-only and pure (the caller
passes the parsed profile value so the planner never touches the filesystem). It
fails closed to a documented skip reason unless every gate is satisfied:

- `not_opted_in` — the master opt-in flag is unset (the default).
- `profile_unavailable` — no valid live-wrapper profile to resolve the command.
- `kind_missing` / `unsupported_kind` — no / non-`WorkflowStepKind` requested.
- `not_configured` — the kind has no wrapper in the profile.
- `write_policy_closed` — the kind resolves to the external-write family
  (`linear-refresh` -> `external-apply`) and the *separate* write opt-in is unset.
  This keeps real external **reads** separated from real external **writes**:
  a read-family harness smoke can never reach an external write.
- `probe_unavailable` — the default probe-only dry-run was requested but the
  wrapper configures no pre-flight `probe`.

Opt-in switches (all default-off):

- `MOMENTUM_REAL_SMOKE_WORKFLOW=1` — master opt-in.
- `MOMENTUM_REAL_SMOKE_WORKFLOW_KIND=...` — which step kind's wrapper to smoke
  (e.g. `no-mistakes`, `postflight`).
- `MOMENTUM_REAL_SMOKE_WORKFLOW_PROFILE=/abs/path/to/live-wrappers.json` — the
  live-wrapper profile JSON the gated probe smoke loads to resolve the real
  wrapper command (`loadRawWorkflowProfileFromEnv`; fails closed to a
  `profile_unavailable` skip if missing / unreadable / invalid JSON).
- `MOMENTUM_REAL_SMOKE_WORKFLOW_FULL=1` — opt into spawning the full harness;
  default is the safe **probe-only dry-run** (runs only the wrapper's cheap
  pre-flight probe / availability check, never the agent — the no-op mode for an
  otherwise-expensive harness).
- `MOMENTUM_REAL_SMOKE_WORKFLOW_ALLOW_WRITE=1` — the separate write-policy gate
  that must be explicitly opened to smoke an external-write wrapper.

Documented failure modes (surfaced by `classifyWorkflowHarnessOutcome`):

- `tool_unavailable` — the wrapper command is missing (`ENOENT` spawn error).
- `timeout` — the harness exceeded its configured timeout.
- `command_failed` — the harness ran but exited non-zero / was killed by signal.
- `result_missing` / `result_invalid` — the harness produced no / a malformed
  result document.
- `harness_error` — any other unrecognized harness failure.

Cleanup / rollback: the planner is pure and spawns nothing. The gated probe
smoke runs only the cheap pre-flight availability probe and records evidence
under gitignored `.agent-runs/real-smoke/`, so it leaves the repo clean. A full
live harness run (operator-driven via `MOMENTUM_REAL_SMOKE_WORKFLOW_FULL=1`,
outside default CI) inherits the M9 live step transaction's clean-up posture —
verify-before-commit and failure-reset-to-base — documented under *Milestone 9
live-execution unit coverage* above; any durable evidence is registered per the
artifact policy.

The NGX-372 terminal-composition follow-ups are complete: the one-shot,
goal-loop, no-mistakes-mirror, and M9 live-wrapper managed-step terminals are all
composed into `test/full-adapter-e2e.test.ts`. A full real-agent harness run
(`MOMENTUM_REAL_SMOKE_WORKFLOW_FULL=1`) stays operator-driven and
`coding-workflow-pipeline`-owned, not a CI spawn.

Run the CI-safe decision core and probe-execution coverage locally via the
targeted vitest filters:

```
pnpm vitest run test/real-workflow-smoke.test.ts test/real-workflow-probe-smoke.test.ts
```

Manual run of the opt-in real probe smoke (probe-only dry-run):

```
MOMENTUM_REAL_SMOKE_WORKFLOW=1 \
MOMENTUM_REAL_SMOKE_WORKFLOW_KIND=no-mistakes \
MOMENTUM_REAL_SMOKE_WORKFLOW_PROFILE=/abs/path/to/live-wrappers.json \
  pnpm vitest run test/real-workflow-probe-smoke.test.ts
```

## Test boundary

The default smoke must not make real `api.linear.app` calls — see
[internal/contracts/intent-apply.md](contracts/intent-apply.md) for the M6 test
guard that continues this rule into the policy-gated external apply slices.
All Linear interactions in the default suite use the existing mock endpoint
pattern; the opt-in real read smoke above is the sole, explicitly gated
exception and never runs in default CI.
