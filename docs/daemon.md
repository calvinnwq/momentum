# Daemon commands

This page is the canonical reference for the `daemon start`, `daemon stop`, and
`daemon status` commands and their JSON envelope shapes.

See also:

- [`docs/recovery.md`](recovery.md) for stale-lease auto-recovery and the
  manual-recovery artifact / `needs_manual_recovery` flag.
- [`docs/walkthrough.md`](walkthrough.md) for the end-to-end workflow smoke
  that composes a bounded daemon cycle.
- [`docs/failure-reset.md`](failure-reset.md) for the retired goal lane's
  per-iteration outcome semantics preserved in stored artifacts.

## `daemon start`

```text
momentum daemon start [--max-loop-iterations <n>] [--max-idle-cycles <n>] [--poll-interval-ms <ms>] [--data-dir <path>] [--json]
```

Records a new orchestrator run in `daemon_runs` (state `running`) with `pid`,
`host`, `started_at`, and `heartbeat_at` populated from the invoking process.
Refuses to record a second concurrent run while one is still active (states
`starting`, `running`, `stop_requested`) and exits with
`code: "daemon_already_active"` (exit 1); the failure payload surfaces the
existing `runId`, `state`, `pid`, `host`, `startedAt`, `heartbeatAt`,
`heartbeatAgeMs`, and a `stale` flag (90s default heartbeat cutoff, or 930s
default while an active job is recorded) so operators can decide whether to
wait or recover the prior record. In managed-loop mode, a stale existing active
run is first passed through the startup-recovery primitives; if it is an idle
stale daemon row or a stale row whose only owner pointer is a
workflow-dispatch marker with no fresh dispatch lease, the new start proceeds
and the managed loop still reports its own pre-loop `loop.startupRecovery`
summary.
After a terminal record (`stopped` / `canceled` / `error`), a fresh start is
allowed.

### Register-only mode

Without any loop-bound flag, `daemon start` returns immediately after
registering the run.

JSON envelope shape (register-only):

```json
{
  "ok": true,
  "command": "daemon start",
  "dataDir": "/path/to/data-dir",
  "runId": "<uuid>",
  "pid": 12345,
  "host": "hostname",
  "state": "running",
  "startedAt": 1731500000000,
  "heartbeatAt": 1731500000000
}
```

### Managed loop mode

Passing `--max-loop-iterations` or `--max-idle-cycles` opts into the managed
loop: the process keeps running and runs one workflow scheduler tick per cycle
to recover stale workflow leases, claim one runnable approved workflow step,
and hand it to the production workflow-step dispatcher. The workflow scheduler
lane is the daemon's only work lane; the retired goal-first lane's
`goal_iteration` queue is no longer drained. The loop refreshes
`daemon_runs.heartbeat_at` / `active_job_id` / `reconcile_count` per cycle,
applies deterministic idle backoff between idle cycles,
and exits cleanly when one of the bounds is reached, `daemon stop` records a
stop request, `daemon stop --now` records an immediate-stop request, or a
terminal daemon-run state is observed. `--poll-interval-ms` only tunes the
bounded loop, defaults to 500ms, accepts non-negative integer millisecond values
(`0` allowed), and is rejected unless `--max-loop-iterations` or
`--max-idle-cycles` is also present.

The top-level `ok` field reports loop/process health, and managed-loop mode
exits non-zero when either `ok` or `workSucceeded` is false. The opt-in
surfaces a `loop` summary on the response with `exitReason` (`stop_requested` /
`stop_now_requested` / `run_terminated` / `run_missing` /
`max_loop_iterations` / `max_idle_cycles` / `internal_error`),
`terminalState`, `cancelOutcome`, `workSucceeded`, `iterations`, `jobsRun`,
`jobsFailed`, `jobsNotExecuted`, `idleCycles`, `workflowStepsDispatched`,
`lastWorkflowCode`, `lastObservedState`, `lastWorkerCode`, `startupRecovery`,
and `error`. The `workSucceeded`, `jobsRun`, `jobsFailed`, `jobsNotExecuted`,
and `lastWorkerCode` fields remain in the frozen envelope from the retired
goal-iteration drain lane; with that lane retired no queued goal jobs are
claimed, so they report an empty work lane (`jobsRun: 0`,
`lastWorkerCode: "no_work"`). All loop bounds must be
non-negative integers; a `--max-idle-cycles 0` or `--max-loop-iterations 0`
invocation exits before claiming any work, which is useful as a one-shot
readiness probe.

`workflowStepsDispatched` counts workflow scheduler ticks whose top-level code
is `dispatched`. `lastWorkflowCode` is the last scheduler-lane tick code
(`idle`, `claim_contended`, `dispatched`, or `null` when the lane never ran).
A continuation-only registered-executor tick still counts as `dispatched`, but it also increments `idleCycles` and waits the configured poll interval before the next external-state read.
For a valid executor identity, dispatch advances the step to `running` and
creates durable executor invocation / round scaffold rows with deterministic
dispatcher ids. The built-in `linear-refresh` step uses the `external-apply`
family as a tail-owned preflight -> apply -> reconcile lifecycle. Bounded
`daemon start` proves the run's issue scope, `LINEAR_API_KEY`, repo
`intent_apply_policy: external_apply_allowed`, a matching Linear source item, and
either one pending Linear `status_update` intent or enough unique issue-scope /
source evidence to seed the expected pending `status_update` intent with a `Done` payload
deterministically. The resulting intent must have a valid one-of `state` /
`stateId` payload and the stable idempotency marker before it reuses the same
policy-gated external-apply write path as `intent apply --external-apply`.
Successful apply writes `external-apply.log` / `external-apply.json` evidence
under the run directory and reconciles the step from that terminal evidence.
If durable external-apply audit evidence already proves the intended write landed and post-apply reconcile succeeded, the step records already-applied terminal evidence without another Linear mutation.
Missing issue scope, missing or ambiguous source evidence, duplicate intents, stale or mismatched applied evidence, missing credentials, policy denial, audit-incomplete, blocked, or other unsafe apply outcomes park the step for manual recovery rather than fabricating success.
Configured `subworkflow` steps are also handled by the
managed daemon: the parent run's `route.subworkflow.child` config selects the
child workflow definition, bounded lineage in `route.subworkflow.lineage` prevents
unsafe recursion, and the parent step mirrors terminal child-run evidence only
after the child reaches a terminal state. Missing child config, unsafe recursion,
unresolved child definitions, unsupported child attachments, invalid child state,
or ambiguous child terminals park the parent run for manual recovery. When
`MOMENTUM_LIVE_WRAPPER_PROFILE` points at a valid workflow step wrapper profile,
the managed loop also runs genuinely dispatched profile-backed step wrappers in
the same tick.
For ordinary live-wrapper executors, it records terminal executor evidence on
the dispatch scaffold and lets the reconciliation seam finalize the step or park
it for manual recovery.
For successful ordinary wrapper results, the daemon first captures the current
repo HEAD as the step base, parses the normalized runner result, runs the
configured verification commands, commits verified changes, resets failed or
unverifiable changes when safe, and records `verification.log` as round evidence
before the dispatch scaffold is terminalized.
For a delegate-supervisor handoff, the daemon runs the same safe finalization but
stores the wrapper result as durable handoff and terminal-candidate evidence.
For no-mistakes, a successful result that leaves a verified clean worktree with no changes to commit is valid handoff evidence; failed verification still rejects the handoff.
The invocation and step do not terminalize or reconcile until a later external-state read receives a daemon-accepted terminal classification.
The verification commands and timeout resolve per the repo policy precedence:
the linked goal's stored verification when the run carries a legacy goal, then
the repo's `MOMENTUM.md` `verification` frontmatter, then no commands, in which
case `verification.log` records that verification was skipped; a missing run
row, malformed stored goal verification, or present-but-malformed `MOMENTUM.md`
parks the step for manual recovery instead of committing unverified work.
If the base HEAD cannot be read, the result file is missing or invalid, HEAD
moves unexpectedly, the dispatch lease is lost before git mutation, or git
cannot safely commit or reset, the run is parked for manual recovery with the
precise live recovery code and best-effort `<run-dir>/recovery.md` guidance.
If the live-wrapper run directory resolves inside the repo, it must be ignored
by git before the wrapper starts; otherwise the daemon parks the step with
`invalid_input` so result, log, verification, or recovery artifacts cannot be
committed as work.
Process-backed live-wrapper dispatch is supported on Linux and macOS.
On native Windows, the wrapper launches no supervised command, parks the run
with `unsupported_platform`, and preserves the refused round for recovery.
When the variable is unset or blank, supported live-wrapper-owned steps
get the durable start scaffold only, while unconfigured wrapper kinds fail
honestly with `runtime_unavailable` if a profile is configured but omits that
step kind. If a claimed step cannot be resolved or carries an invalid executor
identity, the dispatcher parks the run behind a
`manual_recovery_required` workflow gate instead of silently dropping the claim;
if the run row vanished before that gate can be written, it still releases the
dispatch lease so no claim is stranded. Register-only `daemon start` exits before
the managed loop and never runs the workflow scheduler lane, reads
`MOMENTUM_LIVE_WRAPPER_PROFILE` or `MOMENTUM_EXECUTOR_CONFIG`, attempts external
apply, or dispatches subworkflow children.

### Registered SDK executors

Third-party SDK executors are registered through the JSON file named by
`MOMENTUM_EXECUTOR_CONFIG`.
Its `executors` object maps each durable executor name to an npm package or local
module path.
Local relative paths resolve from the config file's directory.
See [Executor SDK](executor-sdk.md#registration-and-discovery) for the file,
module-export, name, and schema contracts.

Managed-loop startup refuses an unreadable or structurally invalid registry
file.
Module imports are lazy until workflow dispatch.
A configured module that cannot be loaded or validated becomes an honest
`runtime_unavailable` refusal for that executor name without disabling unrelated
registered executors.
The daemon retries failed module discovery on a later scheduler pass, so an
operator can repair the executor entry module and clear recovery without
restarting the daemon. If the repair changes only a transitive dependency that
Node already attempted to load or evaluate, restart the daemon before clearing recovery;
the in-process ESM dependency graph cannot be unloaded safely.
Registered executors are normally driven one bounded tick per daemon scheduler
pass, and a `continue` recommendation leaves the invocation resumable for the
next pass after the configured poll interval.
Only the first completed profile-backed delegate handoff in an invocation may receive a second bounded tick in the same pass so fresh external state corroborates that first handoff immediately.
Later passes and retry attempts use one tick, including a retry that launches a fresh external run after a conclusively failed or cancelled prior run.
The dispatch lease is heartbeated independently while a tick runs and every
executor evidence write remains fenced by the live lease identity.
The profile-backed repo lock is leased for at least the longest configured wrapper/probe window plus the full verification-command budget, so a bounded handoff retains repository ownership until clean finalization or durable handoff evidence releases it.
For an unresolved handoff intent, the next dispatcher may take over the matching active lock after it expires or immediately after the scheduler proves and releases the same stale dispatch owner.
Repository, run, job, previous-holder, attempt, and deadline compare-and-swap checks prevent a concurrent or newer owner from being displaced.
Heartbeat and settlement then require the replacement holder and attempt, preventing the former owner from mutating the lock.
If a crash instead leaves an invocation at `waiting_operator` before gate parking finishes, stale dispatch recovery reuses or recreates that gate from the persisted decision selector and unresolved decision before releasing the exact stale lease.

### Workflow live-wrapper profile

Managed-loop `daemon start` can execute workflow steps through local commands by
setting `MOMENTUM_LIVE_WRAPPER_PROFILE` to a readable JSON file:

```sh
MOMENTUM_LIVE_WRAPPER_PROFILE=/path/to/live-wrapper-profile.json \
  momentum daemon start --max-idle-cycles 1 --json
```

The profile has a non-empty `name` and a `wrappers` object keyed by
non-`external-apply` workflow step kind (`preflight`, `implementation`,
`postflight`, `no-mistakes`, or `merge-cleanup`). The built-in `linear-refresh`
step is handled by the daemon's policy-gated `external-apply` adapter, not a
live-wrapper command. Each wrapper requires:

- `command` — absolute executable path.
- `args` — array of strings or numbers; use `[]` when no arguments are needed.
- `cwd` — `repo` or `iteration`.
- `timeout_sec` — positive integer seconds no greater than 2,147,453.
- `env_allow` — environment variable names copied from the daemon process;
  include `PATH` explicitly if the wrapper or its child processes need it.
- `result_file` — relative path inside the workflow run directory where the
  wrapper writes the normalized runner result JSON.
- `probe` — optional pre-flight check with an absolute `command`, optional
  string/number `args`, and optional `timeout_sec`; its timeout defaults to 30
  seconds and uses the same 2,147,453-second maximum.

Example:

```json
{
  "name": "local-workflow",
  "wrappers": {
    "preflight": {
      "command": "/usr/local/bin/momentum-preflight",
      "args": [],
      "cwd": "repo",
      "timeout_sec": 900,
      "env_allow": ["PATH", "HOME"],
      "result_file": "result.json",
      "probe": {
        "command": "/usr/local/bin/momentum-preflight",
        "args": ["--version"],
        "timeout_sec": 30
      }
    }
  }
}
```

Momentum injects `MOMENTUM_RUN_ID`, `MOMENTUM_STEP_ID`,
`MOMENTUM_STEP_KIND`, `MOMENTUM_ATTEMPT`, `MOMENTUM_REPO_PATH`,
`MOMENTUM_ITERATION_DIR`, `MOMENTUM_PROMPT_PATH` when available, and
`MOMENTUM_RESULT_PATH` for every wrapper.
For native workflow runs, ordinary live-wrapper steps use the repo-local
`.agent-workflows/<run-id>/` directory and scope attempts after the first under
`attempt-<n>/`.
Delegate-supervisor steps use `.agent-workflows/<run-id>/delegate/<step-id>/`
and scope their later attempts beneath that step directory.
When a dispatched executor round has selected values, Momentum also injects
`MOMENTUM_AGENT_PROVIDER`, `MOMENTUM_MODEL`, and `MOMENTUM_EFFORT`; for native
coding runs those values come from persisted `route.steps` overrides when the
operator supplied `--steps-json`, otherwise they are omitted.
Provider-aware alias normalization happens before persistence, so a native coding step supplied as `harness=claude` with `model=sonnet` injects `MOMENTUM_MODEL=claude-sonnet-4-6`; a `codex` step supplied as `model=openai/gpt-5.5` injects `MOMENTUM_MODEL=gpt-5.5`; and an `opencode` step supplied as `model=glm-5.2` injects `MOMENTUM_MODEL=opencode-go/glm-5.2`.
Unknown or non-agent harness/model values still pass through unchanged after structural validation.
The wrapper must write the same
normalized runner result JSON documented in [`runners.md`](runners.md) at
`$MOMENTUM_RESULT_PATH`. A valid profile may configure only the
live-wrapper-owned step kinds it can run; a dispatched live-wrapper-owned kind
missing from the profile routes to manual recovery rather than fake success. An
unreadable, invalid JSON, or schema-invalid profile causes `daemon start`
managed-loop mode to fail before registering a daemon run with
`code: "daemon_live_wrapper_profile_invalid"`.

The `--profile <name>` option on `workflow run start` and `workflow run start-coding` only records the trimmed operator-selected profile name in the run's durable `route.profile`; a blank profile is refused before durable writes.
`workflow run preview-coding --profile <name>` reports that same projected `route.profile` in its frozen read-only plan but does not persist a run.
The `--implementation-engine <engine>` option on `workflow run start-coding` records the selected coding implementation path in `route.implementationEngine`; when omitted, coding starts persist `gnhf`.
`workflow run preview-coding --implementation-engine <engine>` reports that same selected path without persisting a run.
Accepted values are `gnhf`, legacy `native-goal-loop`, and `current-gnhf-cwfp`.
Native dispatch executes `gnhf` and legacy `native-goal-loop` through the same kind-keyed live-wrapper path; a persisted `current-gnhf-cwfp` selection fails closed before the implementation executor starts instead of being silently translated to another route.
The `--steps-json <json>` option on `workflow run start-coding` records per-step harness/model/effort selections in `route.steps`, and `workflow run preview-coding --steps-json <json>` reports the same selection in its frozen read-only plan without persisting it.
Provider-aware model aliases are normalized in both paths when the step supplies a known mapped harness (`claude`, `codex`, or `opencode`), so the previewed value is the same command-ready value later stored and injected.
The command-line profile selector does not load or select the executable wrapper profile for the daemon.
Managed-loop execution still uses the JSON profile file pointed to by `MOMENTUM_LIVE_WRAPPER_PROFILE`.
`workflow run watch --once` resolves the same profile for its bounded run-scoped dispatcher tick when it is eligible to dispatch a non-tail step, so an invalid profile can also fail that supervisor command with `daemon_live_wrapper_profile_invalid`.
The checked-in coding-workflow live-wrapper profile runs the shared coding
workflow wrapper for `preflight`, `implementation`, `postflight`,
`no-mistakes`, and `merge-cleanup`. That wrapper also requires
`MOMENTUM_CODING_WORKFLOW_WRAPPER_CONFIG` to point at the run-local command
configuration. If the profile is present but that run-local config is missing,
unreadable, invalid, or lacks the current step, the wrapper exits as an operator
setup failure without writing normalized runner evidence; the daemon then parks
the dispatched step for recovery instead of finalizing it as an ordinary failed
workflow step.
The config file must use canonical snake_case keys.
The top-level object may only contain `steps`, and each step only accepts `command`, `args`, `cwd`, `timeout_sec`, `env_allow`, `result_file`, `success_summary`, `failure_summary`, `key_changes_made`, `key_learnings`, `remaining_work`, `commit`, the no-mistakes-only `runner_profile` block, and the merge-cleanup-only `merge_cleanup` target block.
Unknown top-level or step keys are setup failures before any child command is spawned.
`env_allow`, `timeout_sec`, and `result_file` use those names when present.
When present, `timeout_sec` must be an integer between 1 and 2,147,453 seconds.
When present, `result_file` must be a safe relative path that resolves to the same file as the live-wrapper profile's `result_file` injected through `MOMENTUM_RESULT_PATH`.
`envAllow`, `timeoutSec`, `resultFile`, or `runnerProfile` are rejected with setup guidance that
points to the config path and key to fix.
For example, this command block is valid:

```json
{
  "steps": {
    "implementation": {
      "command": "/usr/bin/env",
      "args": ["sh", "-c", "echo hello"],
      "cwd": "repo",
      "timeout_sec": 900,
      "env_allow": ["PATH", "HOME"],
      "result_file": "result.json"
    }
  }
}
```

For `no-mistakes`, include an explicit runner profile so the wrapper does not depend on ambient daemon environment.
The runner profile requires the `axi` interface, `stdin: "closed"`, and the environment variables that the configured no-mistakes agent needs.
Momentum supports the no-mistakes agent choices `claude`, `codex`, `opencode`, and `rovodev`; `agent=auto` is rejected in the native wrapper because it cannot be validated deterministically.
Before spawning no-mistakes, the wrapper reads `HOME/.no-mistakes/config.yaml` with strict YAML parsing and requires the top-level `agent` plus the top-level `agent_path_override.<agent>` entry to match the runner profile.
Duplicate keys, malformed YAML, tab indentation, missing YAML key separators, nested-only `agent_path_override` entries, non-mapping overrides, or non-absolute override paths fail closed before no-mistakes starts.
YAML aliases and either order of the top-level `agent` and `agent_path_override` entries are accepted because validation follows YAML semantics instead of line-scanner order.
For Codex, the checked-in live-wrapper profile allows `CODEX_HOME` into the wrapper process, and the run-local `env_allow` must forward it to the child process before no-mistakes starts:

```json
{
  "steps": {
    "no-mistakes": {
      "command": "/usr/bin/env",
      "args": ["no-mistakes", "axi", "run", "--intent", "verify this branch"],
      "cwd": "repo",
      "env_allow": ["PATH", "HOME", "CODEX_HOME"],
      "runner_profile": {
        "interface": "axi",
        "stdin": "closed",
        "agent": "codex",
        "required_env": ["HOME", "CODEX_HOME", "PATH"],
        "agent_path": "<absolute-codex-wrapper-path>"
      }
    }
  }
}
```

If the no-mistakes runner profile is missing, malformed, lacks the selected agent's required environment (`HOME` and `PATH`, plus `CODEX_HOME` for Codex), the filtered child environment does not contain one of its required variables, the selected agent path is missing/non-executable, `HOME/.no-mistakes/config.yaml` is unreadable or invalid, the no-mistakes `agent` setting is `auto` or does not match the profile, or the no-mistakes `agent_path_override.<agent>` setting is missing, non-absolute, or does not match the runner profile, the wrapper fails closed before spawning the no-mistakes command and writes no runner evidence.

For current coding definitions, the implementation and no-mistakes steps run through `delegate-supervisor` with `tool: "gnhf"` and `tool: "no-mistakes"` respectively.
The implementation adapter performs the configured live-wrapper handoff once, records a normalized terminal external-state artifact, and lets a later bounded tick corroborate it.
The no-mistakes adapter uses the configured wrapper command for the initial `axi run` handoff, then invokes that validated executable as `axi status --run <external-run-id>` with the same filtered child environment on later ticks.
Status read-back must match the pinned run id and branch.
The reported head is normalized to a full commit id when locally resolvable, otherwise its valid abbreviation is preserved; head changes are supervised progress only when Git proves they descend from the launch commit because no-mistakes may commit fixes during the same run.
Only canonical current AXI sections and a validated steps table contribute status; duplicate or conflicting scalar fields, malformed or duplicate step rows, unknown step statuses, and CI evidence outside that table fail closed.
Pending or running table rows count as an active step and block terminal monitoring success.
Unreadable status, identity drift, pending CI behind a terminal claim, an active step, active findings, or unresolved decisions fail closed instead of settling success.
The daemon stores step-scoped `delegate-external-state.json` plus an atomic `delegate-handoff.json` receipt so interrupted handoffs and later scheduler ticks reattach the same external run.
For no-mistakes, the receipt records `launching` before the wrapper starts, `resetting` or `finalizing` before repository mutation, `failed` after an unsuccessful finalization, and `launched` only after successful wrapper finalization and external identity capture.
After the wrapper returns, the receipt also records the exact bounded result digest.
The selected reset or commit and every later local-finalization retry or prepared-commit recovery revalidate that digest, so missing or changed result bytes fail closed before the selected reset or commit.
An interrupted `launching` receipt reads its original executor log only to corroborate exactly one canonical current run id; historical or duplicate identities provide no authority, and even with a clean unchanged repository the missing wrapper-finalization proof fails closed without reattaching or launching no-mistakes again.
Generic live-wrapper receipts bind the wrapper outcome, result digest, worktree tree, base commit, and the exact reset or commit intent written before repository mutation.
A retry can therefore recognize a completed reset or reconstruct an exact parent/tree/message commit without launching the tool again only when the current bounded regular result file has the receipt's exact digest; symbolic links and branch, result, worktree, receipt, or current repository `HEAD` drift fail closed and preserve the worktree for inspection.
When the initial no-mistakes handoff already proves checks passed, that terminal candidate is stored with a full 40-character SHA for the post-finalization repository `HEAD`.
It settles only after a fresh status read corroborates the same run, branch, and exact head with passed or absent CI, no active findings, and no unresolved decisions; pending CI or another head fails closed.
Approval boundaries use a supervisor-owned `approve` / `reject` decision that external state cannot forge; only the latest resolved `approve` permits later completion.
The daemon checkpoints that supervisor decision id before gate classification so recovery cannot accidentally park a different mirrored external decision.
On upgrade, correlated legacy run-root delegate state or no-mistakes receipts migrate into the step-scoped delegate root only after invocation and branch checks plus current-head validation for finalized state.

For `merge-cleanup`, include the target block that the wrapper will verify against GitHub before it runs the merge command:

```json
{
  "steps": {
    "merge-cleanup": {
      "command": "/usr/bin/env",
      "args": ["sh", "-c", "merge-and-cleanup"],
      "cwd": "repo",
      "env_allow": ["PATH", "GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR"],
      "merge_cleanup": {
        "pull_request_id": "123",
        "expected_head_sha": "0123456789abcdef0123456789abcdef01234567",
        "cleanup_branch": "feat/example"
      }
    }
  }
}
```

If the config has `envAllow`, `timeoutSec`, or `resultFile`, the wrapper returns a
setup failure in the form `Unknown key "..." in steps.<step>; replace with "..."
to use the required snake_case schema`, and no child process is spawned.
External-side-effect tail steps also run a local auth/capability preflight before
contacting their external tools. `merge-cleanup` is a tail-owned preflight ->
apply -> reconcile lifecycle: before spawning the merge command, the same worker
must prove explicit GitHub auth in the live-wrapper environment (`GH_TOKEN`,
`GITHUB_TOKEN`, or `GH_CONFIG_DIR`), a configured `merge_cleanup` block with
`pull_request_id`, `expected_head_sha`, and `cleanup_branch`, and live GitHub PR
state showing the target is open, non-draft, mergeable, and still at the expected
head. If GitHub shows the PR is already merged or the cleanup branch is already
deleted, the wrapper stops before mutation and routes operators to evidence-backed
reconciliation instead of a blind rerun. The built-in `linear-refresh` step requires the run issue scope, a matching source item, one pending Linear `status_update` intent or deterministic seed evidence for the expected `Done` intent, a valid one-of `state` / `stateId` payload, `intent_apply_policy: external_apply_allowed`, and `LINEAR_API_KEY` in the daemon/supervisor process environment.
Missing auth, issue scope, target, source evidence, deterministic intent evidence, or missing valid payload fails closed with operator-actionable recovery evidence;
Momentum does not store these credentials.

On retried dispatch attempts, `MOMENTUM_ATTEMPT` is incremented and attempt
evidence is kept separate.
Ordinary live-wrapper attempt 1 uses the configured run directory paths and
later attempts use `attempt-<n>/`; delegate-supervisor steps apply the same
attempt layout beneath their step-scoped `delegate/<step-id>/` directory.
If a wrapper command is `node` (or `/usr/bin/env node`) and the configured
script entrypoint itself is missing, the failure is classified as
`runtime_unavailable`; module failures from inside an existing wrapper script
remain ordinary command failures. For retryable `no-mistakes` and
`merge-cleanup` setup failures, `workflow run clear-recovery` can prepare a
new scheduler attempt after the operator repairs the wrapper path or external
runner state.
Delegate-supervisor adapter, handoff, unreadable or inconsistent external-state failures are likewise retryable after the operator repairs the correlated evidence, and an externally blocked invocation is retryable after its blocker clears.
The retry keeps the deterministic invocation identity, preserves a valid non-terminal handoff and prior decisions, and starts a fresh semantic-stall window.
It sends a prior handoff through adapter recovery before reuse.
For a locally failed no-mistakes receipt, a correlated failed or cancelled run permits one fresh launch; every other status reruns local finalization before the same run is reattached for supervision.
For profile-backed no-mistakes, a conclusively failed or cancelled prior external run remains evidence but permits one fresh launch on the newer attempt.
An `unsupported_platform` refusal is separately retryable for every dispatched
step after the workflow moves to Linux or macOS and recovery is cleared there.
The coding-workflow wrapper also treats known no-mistakes runner lifecycle
failures as recovery setup failures rather than ordinary failed runner evidence:
missing external branch-start state, current no-mistakes run status or outcome
evidence that the run was cancelled before a reliable result, and similarly
concrete no-result runner lifecycle failures.
Those cases leave no normalized runner result, so the daemon parks the step for
operator repair and a guarded retry instead of terminalizing the workflow as if
verification itself failed.
When upstream no-mistakes reports `checks-passed`, or keeps reporting a running monitor state while the pull request evidence is clean and checks are green or explicitly absent, the adapter normalizes a completed external state and the delegate supervisor records successful executor evidence while upstream no-mistakes may continue its own PR-lifecycle monitoring.
If the wrapper is interrupted before writing that evidence but the external no-mistakes run later proves success, `workflow run clear-recovery` can reconcile only that failed required `no-mistakes` step and re-derive the run for downstream work from either legacy `--evidence-pointer no-mistakes:<run-id>#checks-passed` proof or a readable structured deterministic evidence JSON file.
Structured no-mistakes recovery evidence must match the current workflow run id, issue scope, branch and head SHA, pull request identity and checks when present, no-mistakes run id, zero unresolved findings or decisions, and explicit review, test, docs, lint, format, push, PR, and CI phase statuses.
Current blocking outcomes, active findings, unresolved gates, dirty / draft pull requests, and failed, pending, running, or otherwise non-successful checks suppress that successful classification; explicitly skipped checks are treated as absent checks.

JSON envelope shape (managed loop):

```json
{
  "ok": true,
  "workSucceeded": true,
  "command": "daemon start",
  "dataDir": "/path/to/data-dir",
  "runId": "<uuid>",
  "pid": 12345,
  "host": "hostname",
  "state": "stopped",
  "startedAt": 1731500000000,
  "workerId": "daemon-12345",
  "loop": {
    "exitReason": "max_idle_cycles",
    "terminalState": "stopped",
    "cancelOutcome": null,
    "workSucceeded": true,
    "iterations": 1,
    "jobsRun": 0,
    "jobsFailed": 0,
    "jobsNotExecuted": 0,
    "idleCycles": 1,
    "workflowStepsDispatched": 0,
    "lastWorkflowCode": "idle",
    "lastObservedState": "running",
    "lastWorkerCode": "no_work",
    "startupRecovery": {
      "observedAt": 1731500000000,
      "graceMs": 5000,
      "recoveredRepoLockCount": 0,
      "recoveredClaimedJobCount": 0,
      "recoveredDaemonRunCount": 0,
      "skippedRepoLocks": [],
      "skippedClaimedJobs": [],
      "skippedDaemonRuns": []
    }
  }
}
```

## `daemon stop`

```text
momentum daemon stop [--now] [--reason <text>] [--data-dir <path>] [--json]
```

Records a graceful stop request against the active daemon run
(`stop_requested_at` and `stop_reason`); the underlying state transitions to
`stop_requested` if it was not already. Default reason is `operator-requested`.
Idempotent: re-running on a record that is already `stop_requested` keeps the
original `stopRequestedAt`, refreshes `stopReason`, and sets
`alreadyStopRequested: true` unless a stop-now request has already been
recorded. Passing `--now` records an immediate stop-now request
(`stop_now_requested_at`) with default reason `operator-requested-immediate`;
repeat stop-now calls keep the original stop-now timestamp/reason and set
`alreadyStopNow: true`. After stop-now is recorded, later graceful
`daemon stop --reason ...` calls preserve the existing stop-now reason and
timestamp. Exits with `code: "no_active_daemon"` (exit 1) when no active record
exists; if the latest record is terminal, the failure payload includes a
`latest` summary so operators can see what was already stopped, canceled, or
failed.

The managed loop observes graceful and immediate stop requests between
cycles. Graceful stop exits as `stopped`; stop-now exits as `canceled`
and records `cancelOutcome: "idle"`. The retired goal-iteration drain was the
only lane that could report an active job completing before cancellation was
observed; with that lane removed, immediate stop is always an idle cancellation.
The command does not signal, kill, or otherwise terminate any running workflow
step or external process; process signaling, forced termination, and mid-step
cancellation are intentionally out of scope — stop semantics are
observation-only.

JSON envelope shape:

```json
{
  "ok": true,
  "command": "daemon stop",
  "dataDir": "/path/to/data-dir",
  "runId": "<uuid>",
  "previousState": "running",
  "state": "stop_requested",
  "pid": 12345,
  "host": "hostname",
  "startedAt": 1731500000000,
  "stopRequestedAt": 1731500010000,
  "stopReason": "operator-requested",
  "alreadyStopRequested": false,
  "immediate": false,
  "alreadyStopNow": false,
  "stopNowRequestedAt": null,
  "heartbeatAt": 1731500000000,
  "heartbeatAgeMs": 10000,
  "stale": false
}
```

## `daemon status`

```text
momentum daemon status [--data-dir <path>] [--json]
```

Read-only inspector for `daemon_runs`. Selects the active record if one exists;
otherwise falls back to the most recently started run so operators can see
terminal/error state. When no daemon has ever started, exits 0 with
`hasRun: false` (text mode: `Daemon: never started`). The summary surfaces
`runId`, `pid`, `host`, `state`, `isActive`, `isTerminal`, `startedAt`,
`heartbeatAt`, `lastStateChangeAt`, `finishedAt`, `ageMs`, `heartbeatAgeMs`,
`stale`, `staleAfterMs` (90s default heartbeat cutoff, or
`activeJobStaleAfterMs` while an active job is recorded),
`activeJobStaleAfterMs` (930s default), `activeJob` (`{jobId, lockId}`),
`stopRequest` (`{requestedAt, reason}` or `null`), `stopNowRequest`
(`{requestedAt, reason}` or `null`), `cancelOutcome` (`{outcome}` or `null`),
`reconciliation` (`{count, lastReconciledAt}`), `error` (`{message, at}` or
`null`), and `updatedAt`. The envelope also lists `staleRepoLocks` (active repo
locks whose `lease_expires_at` is in the past) and `staleClaimedJobs`
(stored claimed/running `goal_iteration` jobs from the retired goal lane whose
lease has lapsed), tolerating up
to `staleLeaseGraceMs` (5s default) of clock skew, plus `goalsNeedingRecovery`
listing goals whose durable `needs_manual_recovery` flag is set (each entry
includes `goalId`, `title`, `goalState`, `recoveryMdPath`, and
`recoveryMdExists`). `daemon status` itself is read-only — running it triggers
no recovery action. Automatic recovery for known-safe stale leases is performed
by the startup-recovery pass when a managed `daemon start` boots; rows
surfaced by `daemon status` are the current stale snapshot and may still need
manual recovery if a startup-recovery pass skips them.

JSON envelope shape (active run with no stop request or error):

```json
{
  "ok": true,
  "command": "daemon status",
  "dataDir": "/path/to/data-dir",
  "hasRun": true,
  "daemonRun": {
    "runId": "<uuid>",
    "pid": 12345,
    "host": "hostname",
    "state": "running",
    "isActive": true,
    "isTerminal": false,
    "startedAt": 1731500000000,
    "heartbeatAt": 1731500000000,
    "lastStateChangeAt": 1731500000000,
    "finishedAt": null,
    "ageMs": 0,
    "heartbeatAgeMs": 0,
    "stale": false,
    "staleAfterMs": 90000,
    "activeJobStaleAfterMs": 930000,
    "activeJob": { "jobId": null, "lockId": null },
    "stopRequest": null,
    "stopNowRequest": null,
    "cancelOutcome": null,
    "reconciliation": { "count": 0, "lastReconciledAt": null },
    "error": null,
    "updatedAt": 1731500000000
  },
  "staleAfterMs": 90000,
  "activeJobStaleAfterMs": 930000,
  "staleLeaseGraceMs": 5000,
  "staleRuns": [],
  "staleRepoLocks": [],
  "staleClaimedJobs": [],
  "goalsNeedingRecovery": [],
  "observedAt": 1731500000000
}
```
