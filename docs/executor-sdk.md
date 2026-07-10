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

The host reads its durable clock after awaited runner work when recording observations and terminal settlement; an asynchronous round cannot be stamped as finished before its bounded work completes.

Cancellation is cooperative and cleanup-bearing: a runner that observes `signal` must stop and clean up before propagating the signal's reason. If a runner returns normally, completion wins even when the signal flips immediately afterward; the host does not manufacture a cancellation that the runner did not acknowledge.

The shipped agent-once and script process adapters supervise their spawned process trees asynchronously. A separate process-group anchor remains alive until cleanup and treats loss of its parent-liveness pipe as a daemon crash. Every launched process inherits a cryptographically random per-run ownership token; POSIX cleanup freshly discovers and re-verifies that token before signalling any individual PID, so PID reuse cannot turn a retained number into authority over an unrelated process. Windows cleanup discovers descendants from the still-live anchor even after the command leader exits. Aborting `signal`, timing out, normal leader exit, or losing the daemon terminates the owned tree under a bounded cleanup deadline and, after a host-provided repo-ownership proof succeeds, resets repository mutations to the captured base before the host atomically records the cancelled round, invocation, and classification checkpoint. Cleanup verifies tracked/untracked status and the captured ignored-path metadata baseline. Missing ownership proof, failed process-tree termination, cleanup residue, or failed repository cleanup preserves the durable in-flight state for recovery instead of recording a false terminal cancellation. Custom runner adapters must stop and safely clean up their own in-flight work before rejecting with the signal's abort reason.

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

It does not expose SQLite or terminal-classification methods. The daemon controller and frozen executor facade are separate runtime objects, not merely different TypeScript views of one object. The facade rejects evidence for another invocation, overlapping or gapped rounds, writes after either the round or invocation is terminal, and terminal states submitted through JavaScript or casted observation inputs. Observation updates use an explicit runtime field whitelist rather than spreading caller objects. State-dependent checks and writes are transactional; daemon-allocated checkpoint identity, terminal classification, and invocation settlement share one write transaction.

If `mechanism_completed` evidence is durable but daemon classification is not, the single-shot daemon entrypoint reattaches the matching non-terminal deterministic invocation, reconstructs the outcome from that checkpoint, and returns the same recommendation without rerunning the mechanism.
Result-capture observations and their completion checkpoints commit together, so a restart cannot see a torn completion proof.
Reattach requires a durable round plus unchanged invocation identity, selection, input digest, artifact root, log paths, portable config, and host round-start inputs.
An invocation without that round binding, or an incomplete round without a durable mechanism outcome, remains recovery work rather than being replayed blindly.

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
The runner still receives portable config and must reject any mismatch with the captured host resolution.
The shipped adapters cross-check script command/argv/timeout/policy and agent-once agent/timeout/policy identity before launching a process.
For scripts, an explicit host `commandIdentity` is authoritative; otherwise the absolute executable's basename is the expected portable command identity.

The agent-once and script built-ins publish strict schemas with `additionalProperties: false`. Schema validation is fail-closed once registration/preflight wiring selects the executor, and the shipped compatibility host repeats family-specific validation before durable round creation. Script config cannot carry agent fields; agent-once config cannot carry command fields. The SDK declaration itself never turns an unknown field into ambient runtime behavior.

## Lifecycle extension points

There are three extension levels:

1. Use a built-in lifecycle with config only.
2. Supply the shipped single-shot lifecycle's narrower runner adapter for agent-once or script.
3. Implement `Executor` directly for a new lifecycle.

The planned agent-loop runner adapter and delegate-supervisor tool adapter will add narrower extension points without changing the core interface. Agent-loop has no default iteration cap: requirements are the stop condition, and an explicit `maxRounds` value may stop continuation with a durable `quota_exhausted` gate. A looping executor must never add an implicit cap in its own adapter.

## RunnerResult SDK surface

`RunnerResult`, `CommitIntent`, their related types, and the parser/normalizers under `src/core/executors/runner/` are official SDK contract surface. Runner and process adapters may import them at runtime. They are dependency-free result-contract modules, not persistence or daemon hooks.
