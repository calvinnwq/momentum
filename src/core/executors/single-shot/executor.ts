/**
 * Single-shot executor adapter — decision brain and identity.
 *
 * The executor-loop contract (SPEC.md) pins two
 * single-invocation executor families that this module serves together:
 *
 *   - `one-shot` "runs a single result-bearing command or agent wrapper.
 *     It may retry under policy, but it does not own an open-ended loop, and
 *     success requires a normalized result document."
 *   - `script` "runs deterministic local commands with explicit argv/env/cwd and
 *     bounded logs."
 *
 * Both families share the same control shape: one {@link ExecutorInvocation} with
 * exactly one {@link ExecutorRound}, no continue-loop and no round budget (a
 * retry is a fresh `attempt`, never a `continue`). They differ only in their
 * *mechanism* — `one-shot` requires a normalized {@link RunnerResult} document
 * (an agent/review pass) while `script` is exit-code based (a deterministic local
 * command) — which the mechanism / orchestrator twins layer on top, the same way
 * `goal-loop/mechanism.ts` / `goal-loop/orchestrator.ts` layer on
 * `goal-loop/executor.ts`. This module owns the *pure* half both
 * families share: the recovery taxonomy, the daemon classification of a single
 * invocation, and the deterministic, reattachable invocation / round identity.
 *
 * It is a pure function of its inputs: no SQLite, no file system, no git, no
 * executor invocation — exactly the discipline `goal-loop/executor.ts` and
 * `loop/reducer.ts` follow.
 *
 * Classification, grounded in the contract's "Completion Classification"
 * definitions:
 *
 *   - A successful invocation is `complete`. A single shot has no further round,
 *     so success terminates the step toward success directly (subject to final
 *     workflow checks the daemon still owns).
 *   - `unsupported_platform` / `runtime_unavailable` / `auth_unavailable` are
 *     `blocked`: "a durable
 *     non-terminal blockage that may be resolved by changing input, policy,
 *     credentials, or external state." A missing runtime or failed credential
 *     check is fixed by changing the environment, not by failing the step; the
 *     workflow can recover by starting a fresh invocation once it clears or
 *     moves to a supported host.
 *     `auth_unavailable` additionally raises a durable `credential_required`
 *     gate so the operator surface names the blocker.
 *   - `command_failed` / `command_timed_out` / `output_overflow` /
 *     `result_missing` / `result_invalid` are `failed`: "the step should fail
 *     under the current policy." These are genuine execution failures of the
 *     bounded unit itself.
 *   - The unsafe repo-finalization / binding / invalid-input codes (`head_mismatch`,
 *     `repo_lock_lost`, `reset_failed`, `commit_failed`, `git_failed`,
 *     `host_binding_mismatch`, `invalid_input`) route to `manual_recovery_required` and preserve the
 *     precise code, mirroring how `decideGoalLoopRound` treats unsafe finalize
 *     ambiguity: Momentum cannot safely proceed without operator inspection.
 *     `invalid_input` also covers pre-launch mechanism/config precondition
 *     failures such as a malformed `baseHead`, wrong executor family, or
 *     non-absolute artifact / script paths.
 *
 * The recovery taxonomy reuses the existing vocabulary rather than inventing a
 * parallel one: the execution-time codes are exactly the live-wrapper
 * {@link LIVE_STEP_WRAPPER_RECOVERY_CODES}, and the unsafe-finalize codes are the
 * same strings `goal-loop/executor.ts` preserves for an unsafe finalize outcome,
 * plus `invalid_input` for rejected mechanism configuration or launch
 * preconditions.
 */

import type {
  ExecutorArtifactClass,
  ExecutorArtifactRecord,
  ExecutorCheckpointRecord,
  ExecutorCompletionClassification,
  ExecutorHumanGateType,
  ExecutorInvocationRecord,
  ExecutorInvocationState,
  ExecutorRoundRecord,
  ExecutorRoundState,
  WorkflowExecutorFamily,
} from "../loop/reducer.js";
import type { ExecutorRoundUpdate } from "../loop/persist.js";
import { LIVE_STEP_WRAPPER_RECOVERY_CODES } from "../../../adapters/live-step-wrapper.js";
import type { RunnerResult } from "../runner/types.js";

/**
 * The executor families this adapter serves: the single-invocation families from
 * the contract's "Executor Families" list. Pinned as the canonical set so the
 * mechanism / orchestrator twins and the family guard stay in sync.
 */
export const SINGLE_SHOT_EXECUTOR_FAMILIES = [
  "one-shot",
  "script",
] as const satisfies readonly WorkflowExecutorFamily[];

export type SingleShotExecutorFamily =
  (typeof SINGLE_SHOT_EXECUTOR_FAMILIES)[number];

const SINGLE_SHOT_FAMILY_SET: ReadonlySet<string> = new Set(
  SINGLE_SHOT_EXECUTOR_FAMILIES,
);

/**
 * Whether an executor family is one this adapter drives. Lets the daemon route a
 * `StepDefinition.executor` to the single-shot adapter without hard-coding the
 * two names at the call site.
 */
export function isSingleShotExecutorFamily(
  family: string,
): family is SingleShotExecutorFamily {
  return SINGLE_SHOT_FAMILY_SET.has(family);
}

/**
 * Recovery codes that mark a `blocked` outcome: a durable non-terminal blockage
 * resolvable by changing the environment, credentials, or external state. These
 * are the live-wrapper runtime/credential codes — the runtime is not the
 * step's fault, so the step blocks rather than fails.
 */
export const SINGLE_SHOT_BLOCKED_RECOVERY_CODES = [
  "unsupported_platform",
  "runtime_unavailable",
  "auth_unavailable",
] as const;

/**
 * Recovery codes that mark a `failed` outcome: a genuine execution failure of
 * the bounded unit itself. These are the live-wrapper execution codes minus
 * the runtime/credential codes above.
 */
export const SINGLE_SHOT_FAILED_RECOVERY_CODES = [
  "command_failed",
  "command_timed_out",
  "output_overflow",
  "result_missing",
  "result_invalid",
] as const;

/**
 * Recovery codes that route to `manual_recovery_required`: an unsafe or
 * ambiguous repo-finalization outcome, or an invalid mechanism/config input that
 * Momentum must not retry away. Most are the same strings
 * `goal-loop/executor.ts` preserves for an unsafe finalize; `invalid_input` also
 * covers pre-launch guards such as bad family, malformed `baseHead`, or relative
 * artifact / script paths.
 */
export const SINGLE_SHOT_MANUAL_RECOVERY_CODES = [
  "head_mismatch",
  "repo_lock_lost",
  "reset_failed",
  "commit_failed",
  "git_failed",
  "host_binding_mismatch",
  "invalid_input",
] as const;

/**
 * The full single-shot recovery taxonomy: every code a single invocation can
 * record, partitioned by classification bucket. The execution-time codes
 * (`blocked` + `failed` buckets) are exactly the live-wrapper
 * {@link LIVE_STEP_WRAPPER_RECOVERY_CODES}; the manual-recovery codes are the
 * unsafe-finalize vocabulary shared with the goal-loop adapter, plus
 * `invalid_input` for rejected single-shot mechanism configuration and launch
 * preconditions.
 */
export const SINGLE_SHOT_RECOVERY_CODES = [
  ...SINGLE_SHOT_BLOCKED_RECOVERY_CODES,
  ...SINGLE_SHOT_FAILED_RECOVERY_CODES,
  ...SINGLE_SHOT_MANUAL_RECOVERY_CODES,
] as const;

export type SingleShotRecoveryCode =
  (typeof SINGLE_SHOT_RECOVERY_CODES)[number];

const BLOCKED_SET: ReadonlySet<string> = new Set(
  SINGLE_SHOT_BLOCKED_RECOVERY_CODES,
);
const FAILED_SET: ReadonlySet<string> = new Set(
  SINGLE_SHOT_FAILED_RECOVERY_CODES,
);
const MANUAL_RECOVERY_SET: ReadonlySet<string> = new Set(
  SINGLE_SHOT_MANUAL_RECOVERY_CODES,
);

// The execution-time codes must stay a subset of the live-wrapper taxonomy so
// a wrapper failure always has a single-shot classification. This is a
// compile-time assertion: every live-wrapper code is a single-shot code. The
// tuple wrapping keeps the `extends` check non-distributive, so a *single*
// uncovered code collapses the whole assertion to `never` (a missing code would
// otherwise hide behind the union's other `true` members).
type LiveWrapperCode = (typeof LIVE_STEP_WRAPPER_RECOVERY_CODES)[number];
type _AssertWrapperCodesCovered = [LiveWrapperCode] extends [
  SingleShotRecoveryCode,
]
  ? true
  : never;
const _wrapperCodesCovered: _AssertWrapperCodesCovered = true;
void _wrapperCodesCovered;

/**
 * The outcome of one single-shot invocation, normalized for classification.
 * `ok: true` is a successful command/agent/script run (with any repo
 * finalization already proven safe by the mechanism); `ok: false` carries the
 * precise recovery code the mechanism reported.
 */
export type SingleShotInvocationOutcome =
  { ok: true } | { ok: false; recoveryCode: SingleShotRecoveryCode };

/**
 * The daemon's decision for one completed single-shot invocation. There is no
 * `continueLoop`: a single shot never recommends another round. `roundState` and
 * `invocationState` are equal in spirit — one round *is* the invocation — and
 * are always terminal.
 */
export type SingleShotDecision = {
  classification: ExecutorCompletionClassification;
  roundState: ExecutorRoundState;
  invocationState: ExecutorInvocationState;
  recoveryCode: string | null;
  humanGate: ExecutorHumanGateType | null;
  reason: string;
};

/**
 * Classify one completed single-shot invocation. See the module doc for the
 * classification boundaries. Pure: the same outcome always yields the same
 * decision.
 *
 * @throws {Error} if `outcome.recoveryCode` is not a known
 * {@link SingleShotRecoveryCode}; an unrecognized code is a programming error,
 * never a silent default to a guessed classification.
 */
export function decideSingleShotInvocation(
  outcome: SingleShotInvocationOutcome,
): SingleShotDecision {
  if (outcome.ok) {
    return {
      classification: "complete",
      roundState: "succeeded",
      invocationState: "succeeded",
      recoveryCode: null,
      humanGate: null,
      reason: "single-shot invocation succeeded",
    };
  }

  const { recoveryCode } = outcome;

  if (BLOCKED_SET.has(recoveryCode)) {
    // A missing runtime or failed credential check is recoverable by changing
    // the environment; the step blocks rather than fails. Auth failures name the
    // blocker with a durable credential gate.
    const humanGate: ExecutorHumanGateType | null =
      recoveryCode === "auth_unavailable" ? "credential_required" : null;
    return {
      classification: "blocked",
      roundState: "blocked",
      invocationState: "blocked",
      recoveryCode,
      humanGate,
      reason: `single-shot invocation blocked (${recoveryCode}); resolve the environment or credentials and re-run`,
    };
  }

  if (FAILED_SET.has(recoveryCode)) {
    return {
      classification: "failed",
      roundState: "failed",
      invocationState: "failed",
      recoveryCode,
      humanGate: null,
      reason: `single-shot invocation failed (${recoveryCode})`,
    };
  }

  if (MANUAL_RECOVERY_SET.has(recoveryCode)) {
    return {
      classification: "manual_recovery_required",
      roundState: "manual_recovery_required",
      invocationState: "manual_recovery_required",
      recoveryCode,
      humanGate: "manual_recovery_required",
      reason: `single-shot invocation finalize outcome ${recoveryCode} requires manual recovery before any retry`,
    };
  }

  throw new Error(
    `decideSingleShotInvocation: unknown recovery code ${String(recoveryCode)}`,
  );
}

/**
 * Mint the deterministic, reattachable executor-invocation id for a single-shot
 * step run. The id embeds the `(workflowRunId, stepRunId)` step-run identity, the
 * executor `family`, and the `attempt`, so it is globally unique (the
 * `executor_invocations` primary key) yet recomputable from durable state alone
 * (contract "Heartbeat And Reattach"). Embedding the family keeps `one-shot` and
 * `script` ids distinct; a re-run of the same step is a fresh `attempt`, so it
 * never collides with the prior invocation.
 */
export function singleShotInvocationId(
  workflowRunId: string,
  stepRunId: string,
  family: SingleShotExecutorFamily,
  attempt: number,
): string {
  return `${workflowRunId}::${stepRunId}::${family}::${attempt}`;
}

/**
 * Mint the deterministic, reattachable round id for the single round under a
 * single-shot invocation. A single shot has exactly one round (index 0), so the
 * id is fixed by the invocation id alone — consistent with the
 * `(invocation_id, round_index)` uniqueness the persistence layer enforces.
 */
export function singleShotRoundId(invocationId: string): string {
  return `${invocationId}::round::0`;
}

/**
 * The StepRun identity {@link planSingleShotInvocation} projects into a durable
 * single-shot {@link ExecutorInvocationRecord}: the `(workflowRunId, stepRunId)`
 * step run, the chosen single-shot `family`, the step key, the re-run `attempt`,
 * and the start clock the orchestrator owns.
 */
export type PlanSingleShotInvocationInput = {
  family: SingleShotExecutorFamily;
  workflowRunId: string;
  stepRunId: string;
  stepKey: string;
  attempt: number;
  /** Invocation start clock; stamped as `started_at` and the initial `heartbeat_at`. */
  startedAt: number;
};

/**
 * Project a `StepRun` identity into the durable single-shot
 * {@link ExecutorInvocationRecord} the orchestrator inserts before the round runs
 * (contract "State Model": `StepRun -> ExecutorInvocation -> ExecutorRound[]`).
 * One configured executor session for the step, materialized at `running` with a
 * deterministic id and the start clock copied in. Pure: no ids or clocks are
 * invented beyond the supplied `startedAt`.
 */
export function planSingleShotInvocation(
  input: PlanSingleShotInvocationInput,
): ExecutorInvocationRecord {
  return {
    invocationId: singleShotInvocationId(
      input.workflowRunId,
      input.stepRunId,
      input.family,
      input.attempt,
    ),
    workflowRunId: input.workflowRunId,
    stepRunId: input.stepRunId,
    stepKey: input.stepKey,
    executorFamily: input.family,
    state: "running",
    attempt: input.attempt,
    startedAt: input.startedAt,
    heartbeatAt: input.startedAt,
    finishedAt: null,
  };
}

/**
 * One precedence level's contribution to a single-shot round's resolved selection.
 * Every field is optional with a three-way meaning: `undefined` defers to the next
 * (lower) level, an explicit value (including `null`) is a deliberate choice at this
 * level. Mirrors {@link GoalLoopSelectionConfig} but without `maxRounds` — a single
 * shot owns no round budget — so the contract's "Agent And Model Selection"
 * precedence resolves the agent / model / effort / timeout / policy knobs only.
 */
export type SingleShotSelectionConfig = {
  agentProvider?: string | null;
  model?: string | null;
  effort?: string | null;
  timeoutMs?: number | null;
  policyEnvelope?: string | null;
};

/**
 * Which precedence level won a resolved selection field, in contract order
 * (highest first). Tracked per field so an already-started round's frozen selection
 * stays explainable, the same way `resolveGoalLoopRoundSelection` reports a
 * {@link GoalLoopSelectionSource}.
 */
export type SingleShotSelectionSource =
  | "step_definition"
  | "workflow_definition"
  | "repository_policy"
  | "executor_family_default"
  | "momentum_global_default";

/** The winning precedence source for each resolved single-shot selection field. */
export type SingleShotSelectionFieldSources = {
  agentProvider: SingleShotSelectionSource;
  model: SingleShotSelectionSource;
  effort: SingleShotSelectionSource;
  timeoutMs: SingleShotSelectionSource;
  policyEnvelope: SingleShotSelectionSource;
};

/**
 * The resolved agent / model / effort / timeout / policy a single-shot round runs
 * under (contract "Agent And Model Selection"), plus the precedence source that won
 * each field. A single shot owns no round budget, so — unlike
 * {@link GoalLoopRoundSelection} — there is no `maxRounds`. For the `script` family
 * every field is naturally `null` (a deterministic local command has no agent); for
 * `one-shot` they carry the resolved agent invocation. The round-start record
 * freezes `agentProvider` / `model` / `effort` before the shot runs; `timeoutMs` /
 * `policyEnvelope` configure the owning invocation and its gates and are carried for
 * the mechanism / orchestrator twins. {@link resolveSingleShotRoundSelection}
 * produces this selection; {@link planSingleShotRoundStart} consumes it, exactly as
 * `planGoalLoopRoundStart` consumes a resolved `GoalLoopRoundSelection`.
 */
export type SingleShotRoundSelection = {
  agentProvider: string | null;
  model: string | null;
  effort: string | null;
  timeoutMs: number | null;
  policyEnvelope: string | null;
  source: SingleShotSelectionFieldSources;
};

/**
 * The single-shot executor family default selection (precedence level 4). The
 * `one-shot` / `script` families hold no opinion of their own yet — agent / model /
 * effort / timeout / policy come from the higher-precedence step / workflow / repo
 * config or fall through to the global floor below — so this is empty. It is the
 * documented hook for a future family-specific default without disturbing the
 * resolver.
 */
export const SINGLE_SHOT_FAMILY_DEFAULT_SELECTION: SingleShotSelectionConfig =
  {};

/**
 * The Momentum global default selection (precedence level 5, the floor). Every
 * field is an explicit `null` so resolution always terminates with a value and a
 * source even when no higher level provides one — Momentum holds no built-in
 * agent / model / effort opinion, leaving the actual provider to repo / run config.
 */
export const SINGLE_SHOT_GLOBAL_DEFAULT_SELECTION: Required<SingleShotSelectionConfig> =
  {
    agentProvider: null,
    model: null,
    effort: null,
    timeoutMs: null,
    policyEnvelope: null,
  };

/**
 * The layered configuration {@link resolveSingleShotRoundSelection} resolves, one
 * optional config per contract precedence level. An omitted level is treated the
 * same as an all-`undefined` config (it contributes nothing); `familyDefault` and
 * `globalDefault` fall back to the built-in single-shot defaults when omitted.
 */
export type ResolveSingleShotRoundSelectionInput = {
  stepConfig?: SingleShotSelectionConfig;
  workflowConfig?: SingleShotSelectionConfig;
  repositoryPolicy?: SingleShotSelectionConfig;
  familyDefault?: SingleShotSelectionConfig;
  globalDefault?: SingleShotSelectionConfig;
};

/**
 * Resolve the deterministic selection a single-shot round runs under, per the
 * contract's "Agent And Model Selection" precedence (highest first):
 * step-definition > workflow-definition > repository-policy > executor-family
 * default > momentum global default. Each field resolves independently to the first
 * level that provides it, where "provides" means the field is present (an explicit
 * value, including `null`); an omitted (`undefined`) field defers to the next level.
 * The all-`null` global floor guarantees every field resolves with a source. There
 * is no round budget to resolve — a single shot owns exactly one round. Pure: the
 * same layered config always yields the same selection.
 */
export function resolveSingleShotRoundSelection(
  input: ResolveSingleShotRoundSelectionInput,
): SingleShotRoundSelection {
  // Highest precedence first. The caller's `globalDefault` overrides the built-in
  // floor at the same source level; the built-in floor is always all-defined so
  // resolution can never fall off the end.
  const levels: readonly SelectionLevel[] = [
    { config: input.stepConfig, source: "step_definition" },
    { config: input.workflowConfig, source: "workflow_definition" },
    { config: input.repositoryPolicy, source: "repository_policy" },
    {
      config: input.familyDefault ?? SINGLE_SHOT_FAMILY_DEFAULT_SELECTION,
      source: "executor_family_default",
    },
    { config: input.globalDefault, source: "momentum_global_default" },
    {
      config: SINGLE_SHOT_GLOBAL_DEFAULT_SELECTION,
      source: "momentum_global_default",
    },
  ];

  const agentProvider = resolveSelectionField(levels, (c) => c.agentProvider);
  const model = resolveSelectionField(levels, (c) => c.model);
  const effort = resolveSelectionField(levels, (c) => c.effort);
  const timeoutMs = resolveSelectionField(levels, (c) => c.timeoutMs);
  const policyEnvelope = resolveSelectionField(levels, (c) => c.policyEnvelope);

  return {
    agentProvider: agentProvider.value,
    model: model.value,
    effort: effort.value,
    timeoutMs: timeoutMs.value,
    policyEnvelope: policyEnvelope.value,
    source: {
      agentProvider: agentProvider.source,
      model: model.source,
      effort: effort.source,
      timeoutMs: timeoutMs.source,
      policyEnvelope: policyEnvelope.source,
    },
  };
}

/**
 * The inputs to {@link planSingleShotRoundStart}: the daemon-owned round identity,
 * the single-shot `family`, the resolved {@link SingleShotRoundSelection}, the
 * round's input digest / artifact root / optional log paths, and the start clock.
 * The orchestrator owns the ids / clock; this module owns projecting them into a
 * durable round record. A single attempt owns one round, while retry attempts use
 * a fresh global round index to preserve the prior attempt's evidence.
 */
export type PlanSingleShotRoundStartInput = {
  roundId: string;
  invocationId: string;
  workflowRunId: string;
  stepRunId: string;
  stepKey: string;
  family: SingleShotExecutorFamily;
  attempt: number;
  roundIndex?: number;
  selection: SingleShotRoundSelection;
  inputDigest: string | null;
  artifactRoot: string | null;
  logPaths?: string[];
  startedAt: number;
};

/**
 * Project a resolved selection and the daemon-owned round identity into the durable
 * round-start {@link ExecutorRoundRecord} the orchestrator inserts before invoking
 * external work (contract Round Lifecycle steps 2 and 4). The round starts `running`
 * at its daemon-owned global index (index 0 for a first attempt) with its agent / model / effort,
 * input digest, artifact root, and log paths copied in and empty result evidence;
 * the terminal projection fills the rest. The `family` is carried from the input —
 * unlike the goal-loop projection that hard-codes its one family — so a `one-shot`
 * and a `script` round are stamped distinctly. Pure: no ids or clock are invented
 * here — freezing the selection at start is the contract's "a later config edit must
 * not rewrite the historical record for an already-started round."
 */
export function planSingleShotRoundStart(
  input: PlanSingleShotRoundStartInput,
): ExecutorRoundRecord {
  return {
    roundId: input.roundId,
    invocationId: input.invocationId,
    workflowRunId: input.workflowRunId,
    stepRunId: input.stepRunId,
    stepKey: input.stepKey,
    executorFamily: input.family,
    attempt: input.attempt,
    roundIndex: input.roundIndex ?? 0,
    state: "running",
    classification: null,
    startedAt: input.startedAt,
    heartbeatAt: input.startedAt,
    finishedAt: null,
    agentProvider: input.selection.agentProvider,
    model: input.selection.model,
    effort: input.selection.effort,
    inputDigest: input.inputDigest,
    resultDigest: null,
    artifactRoot: input.artifactRoot,
    logPaths: input.logPaths ?? [],
    summary: null,
    keyChanges: [],
    keyLearnings: [],
    remainingWork: [],
    changedFiles: [],
    verificationStatus: null,
    commitSha: null,
    recoveryCode: null,
    humanGate: null,
  };
}

/**
 * The per-round runtime inputs the daemon provides for the single shot: the round's
 * input digest, its daemon-provided artifact directory, and its bounded log paths
 * (contract "Round Lifecycle" steps 4-5). These are the filesystem / content
 * concerns the pure adapter never invents — the caller resolves them and
 * {@link planSingleShotRoundStartForInvocation} freezes them into the round-start
 * record.
 */
export type SingleShotRoundRuntimeInputs = {
  inputDigest: string | null;
  artifactRoot: string | null;
  logPaths?: string[];
};

/**
 * The inputs to {@link planSingleShotRoundStartForInvocation}: the materialized
 * single-shot invocation (whose identity and family the round inherits), the
 * resolved selection frozen into the round, the per-round runtime inputs, and the
 * round start clock. There is no round index — the single round is always index 0.
 */
export type PlanSingleShotRoundStartForInvocationInput = {
  invocation: ExecutorInvocationRecord;
  selection: SingleShotRoundSelection;
  runtime: SingleShotRoundRuntimeInputs;
  startedAt: number;
};

/**
 * Project a materialized invocation + resolved selection + per-round runtime inputs
 * into the {@link PlanSingleShotRoundStartInput} for the single round. The round
 * inherits the invocation's `(workflowRunId, stepRunId, stepKey, attempt)` identity
 * and its single-shot family, takes the deterministic {@link singleShotRoundId}
 * (index 0), freezes the resolved selection, and copies in the round's input
 * digest / artifact root / log paths. Feed the result to
 * {@link planSingleShotRoundStart} to get the durable round-start record. Pure: the
 * caller owns the clock and the runtime inputs; this only wires identity. This is
 * the round-identity half of the adapter "below `StepRun`".
 *
 * @throws {Error} if the invocation's family is not a single-shot family — the round
 * must inherit a concrete `one-shot` / `script` family, never a foreign one (the
 * invariant {@link planSingleShotInvocation} establishes).
 */
export function planSingleShotRoundStartForInvocation(
  input: PlanSingleShotRoundStartForInvocationInput,
): PlanSingleShotRoundStartInput {
  const { invocation, runtime } = input;
  const family = invocation.executorFamily;
  if (!isSingleShotExecutorFamily(family)) {
    throw new Error(
      `planSingleShotRoundStartForInvocation: invocation ${invocation.invocationId} has non-single-shot family ${family}; the round must inherit a one-shot or script family`,
    );
  }
  return {
    roundId: singleShotRoundId(invocation.invocationId),
    invocationId: invocation.invocationId,
    workflowRunId: invocation.workflowRunId,
    stepRunId: invocation.stepRunId,
    stepKey: invocation.stepKey,
    family,
    attempt: invocation.attempt,
    selection: input.selection,
    inputDigest: runtime.inputDigest,
    artifactRoot: runtime.artifactRoot,
    ...(runtime.logPaths !== undefined ? { logPaths: runtime.logPaths } : {}),
    startedAt: input.startedAt,
  };
}

/**
 * One evidence pointer a finished single-shot round produced: the `path` the round
 * actually wrote (contract "Required Artifacts": "Artifact paths are evidence
 * pointers"), plus an optional content `digest` and human `description`. The durable
 * row — not the file — is the source of truth that the artifact exists for the round.
 */
export type SingleShotArtifactPointer = {
  path: string;
  digest?: string | null;
  description?: string | null;
};

/**
 * The evidence pointers a finished single-shot round produced, one optional slot per
 * contract artifact class *except* `logs` — the orchestrator derives those from the
 * round-start record's frozen `logPaths`, which it already owns. The two single-shot
 * families differ in which slots they populate but share this one shape: the
 * `one-shot` family captures a normalized result document (a {@link RunnerResult}
 * file), so it fills `resultDocument`; the `script` family is exit-code based with
 * bounded logs and no required result file, so it typically leaves `resultDocument`
 * (and `checkpointStream`) absent and carries its evidence in `logs` and
 * `commitOrResetEvidence`. A missing/`null` slot means the round wrote no such
 * artifact; {@link planSingleShotRoundArtifacts} then records no row for that class
 * rather than inventing a path, so the projection needs no family parameter.
 */
export type SingleShotRoundArtifacts = {
  resultDocument?: SingleShotArtifactPointer | null;
  checkpointStream?: SingleShotArtifactPointer | null;
  verificationOutput?: SingleShotArtifactPointer | null;
  commitOrResetEvidence?: SingleShotArtifactPointer | null;
  recoveryNote?: SingleShotArtifactPointer | null;
};

/**
 * The inputs to {@link planSingleShotRoundArtifacts}: the round id the artifacts hang
 * below, the round-start record's frozen `logPaths` (projected into `logs`
 * artifacts), and the evidence pointers the mechanism reported for the remaining
 * classes.
 */
export type PlanSingleShotRoundArtifactsInput = {
  roundId: string;
  logPaths: readonly string[];
  artifacts?: SingleShotRoundArtifacts;
};

/**
 * Project a finished single-shot round's evidence into the durable
 * {@link ExecutorArtifactRecord} rows the executor-loop persistence layer
 * (`insertExecutorArtifact`) writes — the contract "Required Artifacts" / ticket
 * "artifacts" + "bounded logs" half of the round's per-round evidence. `logs` rows
 * are derived from the round-start record's frozen `logPaths` (the orchestrator owns
 * those); every other class comes from the pointer the mechanism reported, and an
 * absent/`null` pointer records no row rather than inventing a path — so a `script`
 * round (no result file) and a `one-shot` round (a captured result document) flow
 * through the same projection. Rows are minted with deterministic ids
 * (`<roundId>-<class>`, and `<roundId>-logs-<index>` for each bounded log) and
 * emitted in the contract {@link EXECUTOR_ARTIFACT_CLASSES} order so the durable
 * evidence is stable and reattachable. Pure: no SQLite, no file system.
 */
export function planSingleShotRoundArtifacts(
  input: PlanSingleShotRoundArtifactsInput,
): ExecutorArtifactRecord[] {
  const { roundId, logPaths } = input;
  const artifacts = input.artifacts ?? {};
  const records: ExecutorArtifactRecord[] = [];

  // Order matches EXECUTOR_ARTIFACT_CLASSES: result, logs, checkpoint,
  // verification, commit/reset, recovery.
  if (artifacts.resultDocument != null) {
    records.push(
      singleShotArtifactRecord(
        roundId,
        "result_document",
        artifacts.resultDocument,
      ),
    );
  }
  logPaths.forEach((path, index) => {
    records.push(singleShotArtifactRecord(roundId, "logs", { path }, index));
  });
  if (artifacts.checkpointStream != null) {
    records.push(
      singleShotArtifactRecord(
        roundId,
        "checkpoint_stream",
        artifacts.checkpointStream,
      ),
    );
  }
  if (artifacts.verificationOutput != null) {
    records.push(
      singleShotArtifactRecord(
        roundId,
        "verification_output",
        artifacts.verificationOutput,
      ),
    );
  }
  if (artifacts.commitOrResetEvidence != null) {
    records.push(
      singleShotArtifactRecord(
        roundId,
        "commit_or_reset_evidence",
        artifacts.commitOrResetEvidence,
      ),
    );
  }
  if (artifacts.recoveryNote != null) {
    records.push(
      singleShotArtifactRecord(
        roundId,
        "recovery_note",
        artifacts.recoveryNote,
      ),
    );
  }
  return records;
}

/**
 * Build one durable artifact row for a single-shot round. The id is deterministic so
 * a re-projection of the same round yields the same evidence ids; `logs` carry an
 * `index` suffix because a round may write several bounded log files.
 */
function singleShotArtifactRecord(
  roundId: string,
  artifactClass: ExecutorArtifactClass,
  pointer: SingleShotArtifactPointer,
  index?: number,
): ExecutorArtifactRecord {
  const suffix =
    index !== undefined ? `${artifactClass}-${index}` : artifactClass;
  return {
    artifactId: `${roundId}-${suffix}`,
    roundId,
    artifactClass,
    path: pointer.path,
    digest: pointer.digest ?? null,
    description: pointer.description ?? null,
  };
}

/**
 * The inputs to {@link planSingleShotRoundCheckpoints}: the round id the checkpoints
 * hang below, the {@link SingleShotInvocationOutcome} the bounded mechanism reported,
 * whether a normalized result was captured, and the daemon classification the round
 * settled into. These are the coarse round-lifecycle stages Momentum itself owns and
 * needs no product decision to derive; the mechanism's own fine-grained checkpoint
 * stream is the separate `checkpoint_stream` artifact *file* projected by
 * {@link planSingleShotRoundArtifacts}.
 */
export type PlanSingleShotRoundCheckpointsInput = {
  roundId: string;
  outcome: SingleShotInvocationOutcome;
  /**
   * Whether the round captured a normalized result document (the `one-shot` family
   * does on success; the exit-code-based `script` family never does), so the
   * projection stays family-agnostic — the caller, not a family parameter, decides.
   */
  capturedResult: boolean;
  classification: ExecutorCompletionClassification;
};

export function planSingleShotRoundStartedCheckpoint(
  roundId: string,
  detail: string | null = null,
): ExecutorCheckpointRecord {
  return {
    checkpointId: `${roundId}-checkpoint-0`,
    roundId,
    sequence: 0,
    stage: "round_started",
    detail,
  };
}

/**
 * Project a finished single-shot round's major executor stages into the durable
 * {@link ExecutorCheckpointRecord} stream the executor-loop persistence layer
 * (`insertExecutorCheckpoint`) writes — the contract "Round Lifecycle" step 7
 * "Capture ... checkpoints ..." for the single-shot families. These are the coarse
 * stages Momentum itself drives around the bounded mechanism, so they are derived
 * mechanically (no product decision, no invented vocabulary): the round started, the
 * bounded mechanism finished (carrying its invocation outcome — `ok` or the precise
 * recovery code), the normalized result was captured (only when one was produced —
 * the `one-shot` family on success, never the exit-code-based `script` family), and
 * the daemon classified the round (carrying its classification). The mechanism's own
 * fine-grained checkpoint stream is the separate `checkpoint_stream` artifact file
 * ({@link planSingleShotRoundArtifacts}); this stream is Momentum's queryable record
 * of how far the round got, useful for reattach when the round fields alone do not
 * say which stage was reached. Like {@link planSingleShotRoundArtifacts} this is
 * family-agnostic — `capturedResult` (not a family parameter) decides whether the
 * `result_captured` stage appears. Checkpoints are minted with deterministic ids
 * (`<roundId>-checkpoint-<sequence>`) and sequenced from 0 so the `(round_id,
 * sequence)` uniqueness the persistence layer enforces always holds. Pure: no SQLite,
 * no file system.
 */
export function planSingleShotRoundCheckpoints(
  input: PlanSingleShotRoundCheckpointsInput,
): ExecutorCheckpointRecord[] {
  const { roundId } = input;
  const records: ExecutorCheckpointRecord[] = [
    planSingleShotRoundStartedCheckpoint(roundId),
  ];
  const checkpoint = (stage: string, detail: string | null): void => {
    const sequence = records.length;
    records.push({
      checkpointId: `${roundId}-checkpoint-${sequence}`,
      roundId,
      sequence,
      stage,
      detail,
    });
  };

  // The single-shot mechanism reports either success or a precise recovery code;
  // the mechanism stage carries that outcome the way the goal-loop stream carries
  // its finalize outcome.
  const outcomeDetail = input.outcome.ok
    ? "invocation outcome: ok"
    : `invocation outcome: ${input.outcome.recoveryCode}`;

  // Contract Round Lifecycle stages, in order: round created before external work,
  // bounded mechanism + normalized result, classification. A round that produced no
  // result skips `result_captured` — the `script` family always, and any failed
  // round that routed straight from running to its terminal state.
  checkpoint("mechanism_completed", outcomeDetail);
  if (input.capturedResult) {
    checkpoint("result_captured", null);
  }
  checkpoint("classified", `classification: ${input.classification}`);
  return records;
}

/**
 * The verification / commit evidence a finished single-shot round reports for its
 * terminal patch (contract Round Schema: a round records its verification status,
 * the commit SHA after a safe finalize, and the committed change set). Every field
 * is optional: a blocked / failed round may have run no verification and committed
 * nothing, so an absent field is left off the terminal patch and `coalesce` keeps
 * the round-start record's null / empty in place rather than overwriting it.
 */
export type SingleShotRoundEvidence = {
  verificationStatus?: SingleShotVerificationStatus | null;
  commitSha?: string | null;
  changedFiles?: string[];
};

export const SINGLE_SHOT_VERIFICATION_STATUSES = [
  "passed",
  "failed",
  "skipped",
] as const;

export type SingleShotVerificationStatus =
  (typeof SINGLE_SHOT_VERIFICATION_STATUSES)[number];

const SINGLE_SHOT_VERIFICATION_STATUS_SET: ReadonlySet<string> = new Set(
  SINGLE_SHOT_VERIFICATION_STATUSES,
);
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;

/**
 * The inputs to {@link planSingleShotRoundPersistence}: the normalized
 * {@link SingleShotInvocationOutcome} the bounded mechanism reported, the one-shot
 * family's captured {@link RunnerResult} (omitted for the exit-code-based `script`
 * family and for any non-success outcome), the captured result's content digest,
 * and the verification / commit {@link SingleShotRoundEvidence} for the terminal
 * patch.
 */
export type PlanSingleShotRoundPersistenceInput = {
  outcome: SingleShotInvocationOutcome;
  /**
   * The normalized result document a one-shot success captured. The `script`
   * family is exit-code based and captures no result document, so it omits this
   * (or passes `null`); a non-success outcome captures nothing either way. Only
   * meaningful on a successful outcome — a result alongside a failure is ignored,
   * since a failed round records no capture.
   */
  result?: RunnerResult | null;
  /**
   * The content digest of the captured result document (the round-schema
   * `result_digest` reattach fingerprint), or omitted / `null` when the round
   * captured no result. Consistent with {@link result} by construction.
   */
  resultDigest?: string | null;
  /** The verification / commit evidence the mechanism reported for the terminal patch. */
  evidence?: SingleShotRoundEvidence;
};

/**
 * A pure, durable persistence plan for one finished single-shot round. The
 * orchestrator applies {@link captureUpdate} (when present) then
 * {@link terminalUpdate} through `updateExecutorRound`, in that lifecycle order.
 * The decision and both patches are derived from the single invocation outcome, so
 * the classification, recovery code, verification status, and commit SHA can never
 * disagree.
 */
export type SingleShotRoundPersistencePlan = {
  decision: SingleShotDecision;
  /**
   * The `capturing_result` patch, present on every successful outcome and `null`
   * otherwise. The `one-shot` family fills it with the captured result; the
   * `script` family (no result document) leaves it a bare capture transition — but
   * a capture is still emitted, because the round transition graph forbids
   * `running -> succeeded` directly, so even a script success must pass through
   * `capturing_result`. A non-success outcome captures nothing and transitions from
   * `running` straight to its terminal abort state.
   */
  captureUpdate: ExecutorRoundUpdate | null;
  /**
   * The terminal patch carrying the daemon classification, the preserved recovery
   * code, the human gate, and any verification / commit / changed-file evidence the
   * mechanism reported.
   */
  terminalUpdate: ExecutorRoundUpdate;
};

/**
 * Build the durable persistence plan for one finished single-shot round. Composes
 * {@link decideSingleShotInvocation} into the two round patches the orchestrator
 * applies, so the daemon decision and both patches derive from the same invocation
 * outcome (contract "Round Lifecycle" steps 7-10 for the single-shot families).
 *
 * The structural difference from `planGoalLoopRoundPersistence` is the capture
 * rule: goal-loop keys the capture on a non-null result, but a single shot keys it
 * on *success* — the exit-code-based `script` family succeeds with no result
 * document yet still needs the `capturing_result` transition to legally reach
 * `succeeded`, so a successful round always emits a capture (bare for `script`,
 * result-bearing for `one-shot`) while a non-success round emits none and
 * transitions from `running` straight to its terminal abort state. Verification /
 * commit / changed-file evidence is stamped only when the mechanism reported it, so
 * a bare failure leaves the round-start record's null / empty fields in place. Pure:
 * no SQLite, no file system; the same outcome + evidence always yields the same plan.
 *
 * @throws {Error} if the outcome carries an unknown recovery code (via
 * {@link decideSingleShotInvocation}).
 */
export function planSingleShotRoundPersistence(
  input: PlanSingleShotRoundPersistenceInput,
): SingleShotRoundPersistencePlan {
  const decision = decideSingleShotInvocation(input.outcome);
  if (
    input.outcome.ok &&
    input.result != null &&
    input.result.success !== true
  ) {
    throw new Error(
      "Invalid single-shot persistence input: successful outcomes require a successful result document.",
    );
  }
  const evidence = input.evidence ?? {};
  const verificationStatus = evidence.verificationStatus;
  if (
    verificationStatus != null &&
    !SINGLE_SHOT_VERIFICATION_STATUS_SET.has(verificationStatus)
  ) {
    throw new Error(
      `Invalid single-shot persistence input: verificationStatus must be one of ${SINGLE_SHOT_VERIFICATION_STATUSES.join(", ")}.`,
    );
  }
  if (input.outcome.ok && verificationStatus === "failed") {
    throw new Error(
      "Invalid single-shot persistence input: successful outcomes cannot carry failed verificationStatus.",
    );
  }
  const capturedResult = input.result != null;
  const canStampCommitEvidence = input.outcome.ok;
  const commitSha = canStampCommitEvidence ? evidence.commitSha : undefined;
  const changedFiles = canStampCommitEvidence
    ? evidence.changedFiles
    : undefined;
  if (commitSha != null && !COMMIT_SHA_RE.test(commitSha)) {
    throw new Error(
      "Invalid single-shot persistence input: commitSha must be a 40-character hex SHA.",
    );
  }
  if (
    changedFiles != null &&
    changedFiles.length > 0 &&
    (commitSha == null || commitSha.trim() === "")
  ) {
    throw new Error(
      "Invalid single-shot persistence input: changedFiles requires commitSha.",
    );
  }

  // A successful single shot must reach `succeeded`, and the round transition graph
  // forbids running -> succeeded directly: the result must be captured first. So a
  // success always emits a capture patch — result-bearing for the one-shot family,
  // a bare transition for the script family (no result document). A non-success
  // outcome captures nothing and transitions from running straight to its terminal.
  const captureUpdate: ExecutorRoundUpdate | null = input.outcome.ok
    ? {
        toState: "capturing_result",
        // Stamp the normalized result fields only when a result was captured (the
        // one-shot family); a script success stays a bare capture.
        ...(input.result != null
          ? {
              summary: input.result.summary,
              keyChanges: input.result.key_changes_made,
              keyLearnings: input.result.key_learnings,
              remainingWork: input.result.remaining_work,
            }
          : {}),
        ...(capturedResult && input.resultDigest != null
          ? { resultDigest: input.resultDigest }
          : {}),
      }
    : null;

  const terminalUpdate: ExecutorRoundUpdate = {
    toState: decision.roundState,
    classification: decision.classification,
    recoveryCode: decision.recoveryCode,
    humanGate: decision.humanGate,
    // Stamp verification status when reported; commit / changed-file evidence only
    // on success. An absent field is left off so `coalesce` keeps the round-start
    // record's null / empty rather than overwriting it.
    ...(evidence.verificationStatus !== undefined
      ? { verificationStatus: evidence.verificationStatus }
      : {}),
    ...(commitSha !== undefined ? { commitSha } : {}),
    ...(changedFiles != null && changedFiles.length > 0
      ? { changedFiles }
      : {}),
  };

  return { decision, captureUpdate, terminalUpdate };
}

/** One precedence level for {@link resolveSelectionField}. */
type SelectionLevel = {
  config: SingleShotSelectionConfig | undefined;
  source: SingleShotSelectionSource;
};

/**
 * Resolve one selection field through the ordered precedence levels: the first
 * level with a present (`!== undefined`) value wins, carrying its source. An absent
 * level (undefined config) is skipped. The built-in global floor defines every
 * field, so the trailing fallback is unreachable and exists only for totality.
 */
function resolveSelectionField<T extends string | number>(
  levels: readonly SelectionLevel[],
  pick: (config: SingleShotSelectionConfig) => T | null | undefined,
): { value: T | null; source: SingleShotSelectionSource } {
  for (const level of levels) {
    if (level.config === undefined) continue;
    const value = pick(level.config);
    if (value !== undefined) {
      return { value, source: level.source };
    }
  }
  return { value: null, source: "momentum_global_default" };
}
