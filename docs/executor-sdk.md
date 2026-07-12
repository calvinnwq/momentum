# Executor SDK

Momentum executors run below workflow steps inside the same durable invocation and round envelope. The SDK contract is deliberately tick-shaped: one call observes durable state, performs at most one bounded turn, records evidence, and recommends an outcome. The daemon decides what happens next.

The source contract is `src/core/executors/sdk/types.ts`. Momentum's durable facade implementation is `src/core/executors/sdk/envelope.ts`. The current `one-shot` and `script` built-ins prove the contract through `src/core/executors/single-shot/sdk.ts`.

Module registration, discovery, and structural-preflight validation are not exposed by the CLI yet. This page documents the shipped implementation interface so built-ins and future registered modules converge on one boundary rather than accumulating private hooks.

## The core interface

An executor declares a durable name, a strict config schema, and one `tick` method:

```ts
import type {
  Executor,
  ExecutorTickContext,
  ExecutorTickResult
} from "../src/core/executors/sdk/types.js";

type Config = { tool: string; pollIntervalMs?: number };
type HostBindings = { client: { poll(): unknown } };

export class ReviewSupervisor implements Executor<Config, HostBindings> {
  readonly name = "review-supervisor";
  readonly configSchema = {
    type: "object",
    properties: {
      tool: { type: "string", minLength: 1 },
      pollIntervalMs: { type: "integer", minimum: 1 }
    },
    required: ["tool"],
    additionalProperties: false
  } as const;

  tick(
    context: ExecutorTickContext<Config, HostBindings>
  ): ExecutorTickResult {
    // Inspect context.state, perform one bounded poll, and persist evidence
    // only through context.envelope.
    throw new Error("example");
  }
}
```

`ExecutorTickContext` contains:

- `state`: a read-only invocation plus ordered round/evidence snapshots captured before the tick;
- `config`: machine-portable workflow intent described by `configSchema`;
- `hostBindings`: machine-local executable, environment, credential, and client resolution;
- `envelope`: the only durable-state API available to executor code;
- `signal`: the daemon's cancellation signal for the bounded turn.

The tick may be synchronous or asynchronous. It returns a recommendation, suggested round and invocation states, a recovery code or gate when applicable, and a reason. Those fields remain advisory until the daemon accepts, refines, or refuses the recommendation and applies its decision. The shipped single-shot compatibility host currently accepts a validated recommendation; the decision seam allows stricter policy without granting that authority to the executor.

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

The durable envelope, not executor input, stamps round start and heartbeat timestamps from its own clock.
The host reads that clock again after awaited runner work when recording observations and terminal settlement, so an asynchronous round cannot be stamped as finished before its bounded work completes.

Cancellation is cooperative and cleanup-bearing: a runner that observes `signal` must stop and clean up before propagating the signal's reason. If a runner returns normally, completion wins even when the signal flips immediately afterward; the host does not manufacture a cancellation that the runner did not acknowledge.
The built-in asynchronous process adapters preserve stdout and stderr captured before and during cancellation in the executor log, and decode streaming UTF-8 without corrupting characters split across pipe chunks.

The shipped agent-once and script process adapters supervise their spawned process trees asynchronously. A separate process-group anchor remains alive until cleanup and treats loss of its parent-liveness pipe as a daemon crash. Every launched process inherits a cryptographically random per-run ownership token; POSIX cleanup freshly discovers and re-verifies that token before signalling any individual PID, so PID reuse cannot turn a retained number into authority over an unrelated process. Windows cleanup discovers descendants from the still-live anchor and retained command start/exit identity even after the command leader exits. In the asynchronous anchor, synchronous helper, and fallback cleanup paths, a direct child of an exited command is eligible only when its creation time falls between that command's retained creation and exit times. Aborting `signal`, timing out, normal leader exit, or losing the daemon terminates the owned tree under a bounded cleanup deadline and, after a host-provided repo-ownership proof succeeds, resets repository mutations to the captured base before the host atomically records the cancelled round, invocation, and classification checkpoint. Cleanup verifies tracked/untracked status and a recursive metadata snapshot of ignored paths. Missing ownership proof, failed process-tree termination, cleanup residue, or failed repository cleanup preserves the durable in-flight state for recovery instead of recording a false terminal cancellation. Custom runner adapters must stop and safely clean up their own in-flight work before rejecting with the signal's abort reason.
Both read-only and finalizing built-ins require clean tracked/untracked status plus a captured ignored-path baseline before launch.
If the anchor does not confirm cleanup, Momentum gives the ownership-checked POSIX or Windows fallback its own bounded cleanup budget.
A POSIX fallback starts that budget only after its blocking ownership and escaped-descendant preflight completes.
Async and sync POSIX fallback report success only after two consecutive snapshots find neither a token-owned process nor a live member of the retained process group; an empty token scan alone is not cleanup proof.
If the POSIX anchor has already exited, fallback cleanup may preserve the known outcome only when the anchor first reported that it had entered cleanup; an abrupt exit without that report fails closed.
Windows fallback binds descendant discovery to retained process identities and creation times, and the synchronous helper retains the command status and signal for diagnostics when cleanup proof fails without treating that command outcome as settled.
Momentum does not substitute an unverified broad `taskkill` when ownership-checked Windows cleanup fails.
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
Module registration and structural preflight are responsible for applying the declaration before a tick.

Looping lifecycle schemas may add an opt-in round cap when they ship.
Machine-local executable paths, cwd, allowed environment, credentials, stdin policy, repo-lock hooks, and instantiated clients are host bindings.
Generic executors receive their resolved bindings through `ExecutorTickContext.hostBindings`.
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
