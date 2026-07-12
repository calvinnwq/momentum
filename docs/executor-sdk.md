# Executor SDK

Momentum executors run below workflow steps inside the same durable invocation and round envelope. The SDK contract is deliberately tick-shaped: one call observes durable state, performs at most one bounded turn, records evidence, and recommends an outcome. The daemon decides what happens next.

The source contract is `src/core/executors/sdk/types.ts`. Momentum's durable facade implementation is `src/core/executors/sdk/envelope.ts`. The current `one-shot` and `script` built-ins prove the contract through `src/core/executors/single-shot/sdk.ts`.

Module registration, discovery, declared-schema preflight, and daemon dispatch use this interface for both built-ins and third-party executors.

## Registration and discovery

Set `MOMENTUM_EXECUTOR_CONFIG` to a JSON file that maps durable executor names to npm module specifiers or local module paths:

```json
{
  "executors": {
    "review-supervisor": "@example/momentum-review-supervisor",
    "local-check": "./executors/local-check.mjs"
  }
}
```

Executor names must start with a lowercase letter or digit and may then use lowercase letters, digits, `.`, `_`, `/`, or `-`.
Relative and absolute paths resolve from the config file's directory.
Bare npm package and package-subpath specifiers resolve from `node_modules` at the config directory or one of its ancestors; Momentum does not install executor packages.
A module exports one executor as its default export or named `executor` export.
ESM and CommonJS modules are accepted.
Configured modules are trusted code imported into the Momentum process, not
sandboxed plugins; module initialization has the same Node.js capabilities as
the daemon or CLI process that loads it.
The export's `name` must exactly match the configured name and it must expose a valid strict object `configSchema` plus a callable `tick(context)` method.
An unreadable module or contract-invalid export produces an `executor_module_unavailable` or `executor_module_invalid` diagnostic; it is never silently skipped.

An explicitly configured module supersedes a same-named built-in. The selected
module still passes through the identical registration and schema guards, so
preflight and daemon dispatch resolve the same implementation.

Executor names are permanent durable identities.
Status, recovery, and historical-run reads use recorded rows and never import the module that originally produced them.
At dispatch, a missing registration settles the attempt as `manual_recovery_required` with `runtime_unavailable`.
Workflow reconciliation then parks the run behind its standard `manual_recovery_required` step gate.
After the executor is installed or repaired, `workflow run clear-recovery` prepares the same deterministic invocation for a new attempt; the next scheduler pass dispatches it without discarding the refused round.
If one configured module fails to load during daemon dispatch, that configured name receives the same honest refusal while unrelated registered executors remain available.

When executor config is present, `workflow run start`, `workflow run start-coding`, and `workflow run preview-coding` load the complete registry and validate third-party step config before any workflow-run rows are written.
An invalid registry file or any module load/contract diagnostic refuses these commands with `executor_config_invalid`.
The resulting `preflightEvidence` identifies an unregistered executor or the executor, step config path, and schema violation.
Built-in steps continue through their existing built-in structural checks unless that built-in name is explicitly supplied by the registry.

## The core interface

An executor declares a durable name, a strict config schema, and one `tick` method:

```ts
import type {
  Executor,
  ExecutorTickContext
} from "../src/core/executors/sdk/types.js";

type Config = { tool: string; pollIntervalMs?: number };
type HostBindings = Record<string, never>;

export const executor: Executor<Config, HostBindings> = {
  name: "review-supervisor",
  configSchema: {
    type: "object",
    properties: {
      tool: { type: "string", minLength: 1 },
      pollIntervalMs: { type: "integer", minimum: 1 }
    },
    required: ["tool"],
    additionalProperties: false
  },

  tick(
    context: ExecutorTickContext<Config, HostBindings>
  ) {
    context.signal.throwIfAborted();
    const invocation = context.state.invocation;
    const roundIndex = context.state.rounds.length;
    const round = context.envelope.startRound({
      roundId: `${invocation.invocationId}::round-${roundIndex + 1}`,
      invocationId: invocation.invocationId,
      workflowRunId: invocation.workflowRunId,
      stepRunId: invocation.stepRunId,
      stepKey: invocation.stepKey,
      executorFamily: invocation.executorFamily,
      attempt: invocation.attempt,
      roundIndex,
      state: "capturing_result",
      agentProvider: null,
      model: null,
      effort: null,
      inputDigest: null,
      resultDigest: null,
      artifactRoot: null,
      logPaths: [],
      summary: `Completed one ${context.config.tool} poll.`,
      keyChanges: [],
      keyLearnings: [],
      remainingWork: [],
      changedFiles: [],
      verificationStatus: "passed",
      commitSha: null
    });
    return {
      roundId: round.roundId,
      recommendation: "complete",
      recommendedRoundState: "succeeded",
      recommendedInvocationState: "succeeded",
      recoveryCode: null,
      humanGate: null,
      reason: "The bounded review poll completed."
    };
  }
};
```

`ExecutorTickContext` contains:

- `state`: a read-only invocation plus ordered round/evidence snapshots captured before the tick;
- `config`: machine-portable workflow intent described by `configSchema`;
- `hostBindings`: machine-local executable, environment, credential, and client resolution;
- `envelope`: the only durable-state API available to executor code;
- `signal`: the daemon's cancellation signal for the bounded turn.

The tick may be synchronous or asynchronous.
It returns a recommendation, suggested round and invocation states, a recovery code or gate when applicable, and a reason.
Those fields remain advisory until the daemon accepts, refines, or refuses the recommendation and applies its decision.
The shipped single-shot compatibility host currently accepts a validated recommendation; the decision seam allows stricter policy without granting that authority to the executor.

Third-party modules loaded only through `MOMENTUM_EXECUTOR_CONFIG` currently receive an empty `hostBindings` object.
The public registration surface does not inject machine-local commands, credentials, or clients into those modules.
Profile-backed built-ins use Momentum's internal host-binding resolver for live-wrapper execution.

## Registered dispatch lifecycle

The managed daemon drives at most one registered-executor tick per scheduler pass.
The tick must return the id of the current non-terminal round for the current invocation attempt.
A `continue` recommendation terminalizes that round as `succeeded` or `failed`, keeps the invocation `running`, and makes the invocation eligible for another scheduler pass.
The executor starts the next sequential round when its next tick observes no current non-terminal round.

Retries keep the deterministic invocation id, increment the invocation attempt, and preserve every earlier attempt's rounds as immutable evidence.
A tick cannot settle a round from an earlier attempt or any round other than the current one.
This prevents a delayed result from an old attempt from completing the active retry.

Dispatch lease heartbeats run independently of the executor tick, including while synchronous executor code blocks the main event loop.
Every durable envelope write is fenced against the current lease identity and freshness.
Lease loss aborts the tick signal and prevents later writes from the former owner.

An executor throw settles the active round and invocation for `manual_recovery_required` with `executor_threw`.
A malformed or internally inconsistent tick result uses `executor_contract_invalid` instead.
These failures remain durable and do not escape as an unclassified scheduler result.

The daemon controller rejects a decision atomically unless its classification, invocation state, round state, recovery code, and human gate form a supported combination:

| Classification | Required invocation state | Allowed round states | Recovery code | Human gate |
| --- | --- | --- | --- | --- |
| `complete` | `succeeded` | `succeeded` | `null` | `null` |
| `continue` | `running` | `succeeded`, `failed` | `null` | `null` |
| `approval_required` | `waiting_operator` | `waiting_operator`, `succeeded`, `failed` | `null` | `approval_required`, `policy_boundary_exceeded`, `scope_boundary_exceeded`, or `destructive_action_requested` |
| `operator_decision_required` | `waiting_operator` | `waiting_operator`, `succeeded`, `failed` | `null` | `operator_decision_required`, `quota_exhausted`, `policy_boundary_exceeded`, `scope_boundary_exceeded`, `credential_required`, `external_state_required`, or `destructive_action_requested` |
| `manual_recovery_required` | `manual_recovery_required` | `manual_recovery_required` | Non-empty | `manual_recovery_required` |
| `blocked` | `blocked` | `blocked` | Non-empty | `null`, `credential_required`, or `external_state_required` |
| `failed` | `failed` | `failed` | Non-empty | `null` |
| `cancelled` | `cancelled` | `cancelled` | `null` | `null` |

An inconsistent daemon decision writes no round settlement, invocation transition, or classification checkpoint.
An `approval_required` or `operator_decision_required` recommendation must also name a current round with an unresolved durable executor decision and a non-empty allowed-action set.
The dispatcher mirrors that decision into a round-scoped workflow gate, releases its dispatch lease, and leaves the invocation paused at `waiting_operator`.
Resolving the gate with `workflow run decide` records the chosen action on both durable records, reopens the same round and invocation, and lets a later scheduler pass reacquire the lease and resume the executor from its envelope snapshot.

The durable envelope, not executor input, stamps round start and heartbeat timestamps from its own clock.
The host reads that clock again after awaited runner work when recording observations and terminal settlement, so an asynchronous round cannot be stamped as finished before its bounded work completes.

Cancellation is cooperative and cleanup-bearing: a runner that observes `signal` must stop and clean up before propagating the signal's reason. If a runner returns normally, completion wins even when the signal flips immediately afterward; the host does not manufacture a cancellation that the runner did not acknowledge.
The built-in asynchronous process adapters preserve stdout and stderr captured before and during cancellation in the executor log, and decode streaming UTF-8 without corrupting characters split across pipe chunks.

The shipped agent-once and script process adapters supervise their spawned process trees asynchronously on Linux and macOS.
Native Windows process execution fails closed with `unsupported_platform` before the supervised command is spawned.
The single-shot lifecycle classifies that refusal as `blocked`; the dispatched live-wrapper lane records manual recovery so the workflow can move to a supported host, clear recovery, and retry the same step in a new attempt and round.
On supported hosts, a separate process-group anchor remains alive until cleanup and treats loss of its parent-liveness pipe as a daemon crash.
Every launched process inherits a cryptographically random per-run ownership token; cleanup freshly discovers and re-verifies that token before signalling any individual PID, so PID reuse cannot turn a retained number into authority over an unrelated process.
Aborting `signal`, timing out, normal leader exit, or losing the daemon terminates the owned tree under a bounded cleanup deadline and, after a host-provided repo-ownership proof succeeds, resets repository mutations to the captured base before the host atomically records the cancelled round, invocation, and classification checkpoint.
Cleanup verifies tracked/untracked status and a recursive metadata snapshot of ignored paths.
Missing ownership proof, failed process-tree termination, cleanup residue, or failed repository cleanup preserves the durable in-flight state for recovery instead of recording a false terminal cancellation.
Custom runner adapters must stop and safely clean up their own in-flight work before rejecting with the signal's abort reason.
Both read-only and finalizing built-ins require clean tracked/untracked status plus a captured ignored-path baseline before launch.
If the anchor does not confirm cleanup, Momentum gives the ownership-checked POSIX fallback its own bounded cleanup budget.
A POSIX fallback starts that budget only after its blocking ownership and escaped-descendant preflight completes.
Async and sync POSIX fallback report success only after two consecutive snapshots find neither a token-owned process nor a live member of the retained process group; an empty token scan alone is not cleanup proof.
If the POSIX anchor has already exited, fallback cleanup may preserve the known outcome only when the anchor first reported that it had entered cleanup; an abrupt exit without that report fails closed.
The synchronous helper retains command status and signal for diagnostics when cleanup proof fails without treating that command outcome as settled.
A fallback that proves cleanup preserves the already-known timeout, cancellation, or command-exit outcome; any fallback that cannot prove cleanup changes the result to `SUPERVISOR_FAILED`.
Repo-local log and result paths owned by the host are excluded from the ignored-path baseline so writing durable evidence does not look like runner residue.
Ignored-path comparison is intentionally strict: entry additions, removals, and metadata changes are treated as runner residue.
For each non-excluded entry, the digest hashes its relative path, mode, size, nanosecond modification and change times, inode, and symlink target when applicable.
A non-empty ignored directory's own metadata is hashed before all descendants are traversed recursively, so directory-only mode or timestamp changes cannot hide behind unchanged children.
When a host-owned descendant is excluded, its ignored ancestors remain represented by mode and inode so ancestor mode changes or replacement are still detected.
Very large ignored trees can make snapshotting expensive, and concurrent cache churn can cause a conservative cleanup refusal; operators should keep mutable caches outside the supervised worktree when practical.

Portable POSIX supervision is userland containment, not a sandbox.
It can prove cleanup for the anchored process group and for descendants observed through ancestry sampling that retain the ownership token.
A hostile descendant that changes session and strips the token between samples can require cgroups or another OS-backed containment primitive; that case is outside this portable implementation.
When Momentum observes an unowned escaped descendant, loses ownership visibility, or cannot prove the owned tree is gone, the supervisor fails with `SUPERVISOR_FAILED` and the durable invocation remains in flight for recovery.

## Envelope facade

`ExecutorEnvelope` is bound to one invocation. It supports:

- `snapshot()` to re-read the durable invocation, rounds, artifacts, checkpoints, findings, and decisions;
- `startRound()` for the next sequential round;
- `observeRound()` for non-terminal phase and result/verification/commit evidence;
- `recordRoundProgress()` to commit an observation and its supporting checkpoint batch atomically;
- `heartbeat()` for liveness;
- `recordArtifact()`, `recordCheckpoint()`, `recordFinding()`, and `recordDecision()` for append-only evidence.

It does not expose SQLite or terminal-classification methods. The daemon controller and frozen executor facade are separate runtime objects, not merely different TypeScript views of one object. The facade rejects evidence for another invocation, overlapping or gapped rounds, writes after either the round or invocation is terminal, and terminal states submitted through JavaScript or casted observation inputs. Every public write validates its complete payload at runtime, including round starts and observations, progress checkpoint batches, artifacts, checkpoints, findings, decisions, and daemon settlement. Observation updates use an explicit runtime field whitelist rather than spreading caller objects. State-dependent checks and writes are transactional; daemon-allocated checkpoint identity, terminal classification, and invocation settlement share one write transaction.
Executor writes are available only while the invocation is `running`; a daemon transition to `waiting_operator` or any other non-running state revokes every facade write, including heartbeat, until daemon policy moves the invocation again.

If `mechanism_completed` evidence is durable but daemon classification is not, the single-shot daemon entrypoint reattaches the matching non-terminal deterministic invocation, reconstructs the outcome from that checkpoint, and returns the same recommendation without rerunning the mechanism.
Result-capture observations and their completion checkpoints commit together, so a restart cannot see a torn completion proof.
For a new single-shot dispatch, the invocation, its initial running round, and the hashed `round_started` dispatch-binding checkpoint are materialized in one transaction after runtime inputs resolve, so a crash cannot leave a newly created invocation without its complete durable reattach binding.
Reattach requires the durable `round_started` binding plus unchanged invocation identity, selection, input digest, artifact root, log paths, portable config, and host round-start inputs.
An invocation without that complete binding, or an incomplete round without a durable mechanism outcome, remains recovery work rather than being replayed blindly.

## Config and host bindings

Apply the portability test: a workflow definition should move to another machine verbatim.

Portable step config is lifecycle-specific.
The shipped schemas accept these shapes:

`one-shot`:

```json
{
  "agent": {
    "harness": "codex",
    "model": "gpt-5",
    "effort": "high"
  },
  "timeoutMs": 900000,
  "policyEnvelope": "repo-write"
}
```

`script`:

```json
{
  "command": "repo-cleanup",
  "args": ["--prune"],
  "timeoutMs": 60000,
  "policyEnvelope": "cleanup-only"
}
```

Every shown field is optional for the `one-shot` family.
The `script` family requires `command` and forbids `agent`; `one-shot` forbids `command` and `args`.
Agent and policy strings must be non-empty, `timeoutMs` is a positive whole number of seconds expressed in milliseconds (a multiple of 1,000) no greater than 2,147,453,000, and every `args` item is a string.
A script command is a portable identity, not a path or shell fragment: it starts with an alphanumeric character or `@`, then uses only alphanumerics plus `.`, `_`, `:`, `@`, `+`, and `-`; `.` and `..` and Windows drive prefixes are rejected.
Both top-level schemas and the nested `agent` object reject unknown properties.

`ExecutorConfigSchema` is a JSON-Schema-shaped declaration subset rather than a general JSON Schema dialect.
It supports string schemas with `enum`, `minLength`, and `pattern`; integer or number schemas with `minimum`, `maximum`, and `multipleOf`; boolean schemas; array schemas with `items` and `minItems`; and strict nested object schemas with `properties`, `required`, and `additionalProperties: false`.
Registration and structural preflight apply the declaration before a tick.

Looping lifecycle schemas may add an opt-in round cap when they ship.
Machine-local executable paths, cwd, allowed environment, credentials, stdin policy, repo-lock hooks, and instantiated clients are host bindings.
Executors receive any host-provided bindings through `ExecutorTickContext.hostBindings`; config-only third-party registration currently provides the empty object described above.
The shipped single-shot lifecycle keeps round-start identity in that field and captures its resolved live-wrapper or script runtime when the runner adapter is constructed.
Before invoking that adapter, the built-in lifecycle clones and freezes its portable config and host round-start bindings so runner mutation cannot change the durable dispatch identity.
The runner still receives portable config and must reject any mismatch with the captured host resolution.
The shipped adapters cross-check script command/argv/timeout/policy and agent-once agent/timeout/policy identity before launching a process.
For scripts, an explicit host `commandIdentity` is authoritative; otherwise the absolute executable's basename is the expected portable command identity.
The deterministic script host also requires `timeoutSec` to be a positive integer no greater than 2,147,453 seconds.
An invalid or oversized host timeout returns `invalid_input` before either the synchronous compatibility path or the asynchronous SDK path launches the command.

The agent-once and script built-ins publish strict schemas with `additionalProperties: false`. Schema validation is fail-closed once registration/preflight wiring selects the executor, and the shipped compatibility host repeats family-specific validation before durable round creation. Script config cannot carry agent fields; agent-once config cannot carry command fields. The SDK declaration itself never turns an unknown field into ambient runtime behavior.

The lifecycle runtime-normalizes the complete runner-adapter return before writing artifacts, result observations, or completion checkpoints.
Malformed JavaScript or casted returns are rejected at that boundary, leaving only the already-materialized invocation, running round, and dispatch-binding checkpoint for recovery.
A successful `one-shot` turn requires a successful normalized `RunnerResult`; a `script` turn is exit-code based and must not return a result document or result-document artifact.
A result digest is valid only when its result document is present.
Successful turns pass through `capturing_result`, but only a captured document produces `result_captured`; failures do not invent a capture checkpoint.

## Lifecycle extension points

There are three extension levels:

1. Use a built-in lifecycle with config only.
2. Supply the shipped single-shot lifecycle's narrower runner adapter for agent-once or script.
3. Implement `Executor` directly for a new lifecycle.

The planned agent-loop runner adapter and delegate-supervisor tool adapter will add narrower extension points without changing the core interface. Agent-loop has no default iteration cap: requirements are the stop condition, and an explicit `maxRounds` value may stop continuation with a durable `quota_exhausted` gate. A looping executor must never add an implicit cap in its own adapter.

## RunnerResult SDK surface

`RunnerResult`, `CommitIntent`, their related types, and the parser/normalizers under `src/core/executors/runner/` are official SDK contract surface. Runner and process adapters may import them at runtime. They are dependency-free result-contract modules, not persistence or daemon hooks.
