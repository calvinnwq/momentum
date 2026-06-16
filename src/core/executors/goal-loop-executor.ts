/**
 * Goal-loop executor adapter — round decision brain (M10-05, NGX-349).
 *
 * The executor-loop contract (internal/contracts/executor-loop.md) pins the
 * `goal-loop` family as "bounded autonomous implementation rounds. It may
 * continue across multiple rounds, but each round must have a normalized result,
 * finalization decision, and daemon classification." This module owns the
 * *daemon classification* half of one such round: given the executor's own
 * completion recommendation (projected from the bounded round's normalized
 * `RunnerResult`) and the repo-safety finalization outcome (the M9
 * `finalizeLiveWorkflowStep*` transaction's result), it decides the contract's
 * "Completion Classification" for the round, the terminal round state, the
 * preserved recovery code, and any durable human gate.
 *
 * It is a pure function of its inputs: no SQLite, no file system, no git, no
 * executor invocation — exactly the discipline `loop-reducer.ts` and
 * `live-step-finalize.ts` follow. The durable orchestrator that creates the
 * invocation, inserts the round, runs the bounded mechanism, runs finalization,
 * and persists this decision is layered on top in later M10-05 slices, the same
 * way `live-step-orchestrator.ts` composes `live-step-finalize.ts`.
 *
 * Beyond the classification, this module also projects a finished round into the
 * durable {@link ExecutorRoundUpdate} patches the M10-03 persistence twin
 * (`loop-persist.ts`) writes — implementing the contract's "Round
 * Schema" result/verification/commit/recovery evidence requirement. The
 * projection is two-phase to honour both the contract's Round Lifecycle and the
 * round transition graph: a `capturing_result` patch carries the normalized
 * runner result (summary / key changes / remaining work), then a terminal patch
 * carries the verification status, commit SHA, classification, preserved recovery
 * code, and human gate. {@link planGoalLoopRoundPersistence} ties the decision
 * and both patches to one finalize result so they can never drift, and the
 * orchestrator applies them through `updateExecutorRound` in lifecycle order.
 *
 * The module also owns the *start* of a round, mirroring the terminal half it
 * already projects. {@link resolveGoalLoopRoundSelection} resolves the contract's
 * deterministic agent / model / effort / timeout / round-budget / policy
 * selection ("Agent And Model Selection") through the fixed precedence
 * step-definition > workflow-definition > repository-policy > executor-family
 * default > momentum global default, tracking the winning source per field so the
 * historical record is explainable. {@link planGoalLoopRoundStart} then projects
 * the resolved selection into the durable round-start {@link ExecutorRoundRecord}
 * the orchestrator inserts *before* invoking external work (contract Round
 * Lifecycle steps 2 and 4): a `running` round that has copied in its agent /
 * model / effort, input digest, and artifact root, with empty result evidence the
 * terminal projection fills later. Freezing the selection into the row at start is
 * the contract's "a later config edit must not rewrite the historical record for
 * an already-started round." The resolved `maxRounds` is the same budget
 * {@link decideGoalLoopRound} enforces, so selection and classification stay tied.
 *
 * The boundaries this module preserves, grounded in the contract and the M9
 * finalization reuse:
 *
 *   - "Executors may recommend progress. The daemon decides progress." The
 *     executor's `complete` recommendation is honoured only when the round
 *     actually committed; a verification-failure reset can never complete a step
 *     even if the round reported `goal_complete` ("the daemon must still enforce
 *     ... verification status").
 *   - Repo safety wins over everything. Any unsafe or ambiguous finalize outcome
 *     (moved HEAD, failed reset/commit, lost repo lock, missing/invalid result)
 *     routes the round to `manual_recovery_required` and preserves the precise
 *     M9 recovery code, never silently retrying. This mirrors how
 *     `live-step-run-recovery.ts` sets `needs_manual_recovery` for the same
 *     finalize outcomes.
 *   - Bounded autonomy. "`continue` means the executor recommends another round,
 *     but the daemon must still enforce max rounds ...": once the configured
 *     round budget is exhausted without completion, the round raises a durable
 *     `quota_exhausted` gate (an `operator_decision_required` classification)
 *     rather than looping forever or silently failing.
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
  WorkflowExecutorFamily
} from "./loop-reducer.js";
import type { ExecutorRoundUpdate } from "./loop-persist.js";
import type { FinalizeLiveWorkflowStepFromResultFileResult } from "./live-step-finalize.js";
import type { RunnerResult } from "../../runner-result.js";

/**
 * The finalize outcomes a goal-loop round consumes: exactly the discriminant of
 * the M9 `finalizeLiveWorkflowStepFromResultFile` result, so the adapter and the
 * finalization transaction can never drift out of sync.
 */
export type GoalLoopFinalizeOutcome =
  FinalizeLiveWorkflowStepFromResultFileResult["outcome"];

/**
 * The verification verdict a finished round records (contract "Round Schema":
 * `verification_status`). `passed` / `failed` mirror a run of the configured
 * verification commands; `skipped` is a successful finalize with no commands
 * configured. `null` means verification never ran for this round (the step
 * failed first, or the round aborted before/around the verify+commit step).
 */
export type GoalLoopVerificationStatus = "passed" | "failed" | "skipped";

/**
 * The repo-safety evidence a finished finalize transaction carries that the
 * durable round record must preserve: the commit SHA of a committed round and
 * the verification verdict, projected from the full M9 finalize result. The
 * decision module consumes only the {@link GoalLoopFinalizeOutcome} discriminant;
 * this evidence carries the extra round-schema fields the persistence layer
 * stores.
 */
export type GoalLoopFinalizeEvidence = {
  outcome: GoalLoopFinalizeOutcome;
  commitSha: string | null;
  verificationStatus: GoalLoopVerificationStatus | null;
};

/**
 * The executor's completion recommendation for one bounded round, projected from
 * the round's normalized {@link RunnerResult}. `success` is whether the round's
 * own work succeeded; `goalComplete` is the round's own recommendation that the
 * implementation step is finished. The daemon treats both as advisory.
 */
export type GoalLoopRecommendation = {
  success: boolean;
  goalComplete: boolean;
};

export type DecideGoalLoopRoundInput = {
  /** The executor's recommendation, from {@link goalLoopRecommendationFromResult}. */
  recommendation: GoalLoopRecommendation;
  /** The repo-safety outcome of the round's finalization transaction. */
  finalizeOutcome: GoalLoopFinalizeOutcome;
  /** 0-based index of the round that just finished. */
  roundIndex: number;
  /** Maximum rounds the executor definition allows, or null for unbounded. */
  maxRounds: number | null;
};

/**
 * The daemon's decision for one completed goal-loop round. `roundState` is the
 * terminal state for the round attempt itself; `classification` is the contract
 * completion decision that drives the owning invocation/step; `continueLoop` is
 * the daemon's go/no-go for another round under the same invocation.
 */
export type GoalLoopRoundDecision = {
  classification: ExecutorCompletionClassification;
  roundState: ExecutorRoundState;
  recoveryCode: string | null;
  humanGate: ExecutorHumanGateType | null;
  continueLoop: boolean;
  reason: string;
};

export type PlanGoalLoopRoundPersistenceInput = {
  /**
   * The round's normalized result, or `null` when the round produced no valid
   * result document (a `result_missing` / `result_invalid` finalize). A `null`
   * result is only consistent with an unsafe finalize outcome; the decision then
   * routes to manual recovery regardless of any recommendation.
   */
  result: RunnerResult | null;
  /** The full repo-safety outcome of the round's finalization transaction. */
  finalize: FinalizeLiveWorkflowStepFromResultFileResult;
  /** 0-based index of the round that just finished. */
  roundIndex: number;
  /** Maximum rounds the executor definition allows, or null for unbounded. */
  maxRounds: number | null;
  /**
   * The content digest of the captured result document (the round-schema
   * `result_digest` reattach fingerprint), or `null` / omitted when the round
   * produced no usable result. It is consistent with {@link result} by
   * construction — both come from the same successful read of the document — so a
   * digest is only ever stamped when there is a result to capture.
   */
  resultDigest?: string | null;
  /**
   * The repository-relative paths the round committed (the round-schema
   * `changed_files` field), or omitted / empty for any non-committed outcome (a
   * reset or manual-recovery round committed nothing). Stamped onto the terminal
   * patch alongside the commit SHA — its sibling commit evidence — only when
   * non-empty, so a non-committed round leaves the round-start empty array in
   * place.
   */
  changedFiles?: string[];
};

/**
 * A pure, durable persistence plan for one finished goal-loop round. The
 * orchestrator applies {@link captureUpdate} (when present) then
 * {@link terminalUpdate} through `updateExecutorRound`, in that lifecycle order.
 * The decision and both patches are derived from a single finalize result, so
 * the classification, recovery code, verification status, and commit SHA can
 * never disagree.
 */
export type GoalLoopRoundPersistencePlan = {
  decision: GoalLoopRoundDecision;
  evidence: GoalLoopFinalizeEvidence;
  /**
   * The `capturing_result` patch carrying the normalized runner result, or
   * `null` when the round produced no result to capture (it then transitions
   * straight from `running` to the terminal patch's manual-recovery state).
   */
  captureUpdate: ExecutorRoundUpdate | null;
  /**
   * The terminal patch carrying the daemon classification, verification status,
   * commit SHA, preserved recovery code, and human gate.
   */
  terminalUpdate: ExecutorRoundUpdate;
};

/**
 * One precedence level's contribution to a round's resolved selection. Every
 * field is optional with a three-way meaning: `undefined` defers to the next
 * (lower) level, an explicit value (including `null`) is a deliberate choice at
 * this level. Mirrors the {@link ExecutorDefinitionRecord} knobs the contract's
 * "Agent And Model Selection" precedence resolves.
 */
export type GoalLoopSelectionConfig = {
  agentProvider?: string | null;
  model?: string | null;
  effort?: string | null;
  timeoutMs?: number | null;
  maxRounds?: number | null;
  policyEnvelope?: string | null;
};

/**
 * Which precedence level won a resolved selection field, in contract order
 * (highest first). Tracked per field so an already-started round's frozen
 * selection stays explainable, the same way `resolvePolicyEffectiveValues`
 * reports a {@link PolicyEffectiveFieldSource}.
 */
export type GoalLoopSelectionSource =
  | "step_definition"
  | "workflow_definition"
  | "repository_policy"
  | "executor_family_default"
  | "momentum_global_default";

/** The winning precedence source for each resolved selection field. */
export type GoalLoopSelectionFieldSources = {
  agentProvider: GoalLoopSelectionSource;
  model: GoalLoopSelectionSource;
  effort: GoalLoopSelectionSource;
  timeoutMs: GoalLoopSelectionSource;
  maxRounds: GoalLoopSelectionSource;
  policyEnvelope: GoalLoopSelectionSource;
};

/**
 * The deterministic agent / model / effort / timeout / round-budget / policy a
 * round runs under, plus the precedence source that won each field. The
 * agent/model/effort are copied into the round-start record; `maxRounds` is the
 * budget {@link decideGoalLoopRound} enforces; `timeoutMs` / `policyEnvelope`
 * configure the owning invocation.
 */
export type GoalLoopRoundSelection = {
  agentProvider: string | null;
  model: string | null;
  effort: string | null;
  timeoutMs: number | null;
  maxRounds: number | null;
  policyEnvelope: string | null;
  source: GoalLoopSelectionFieldSources;
};

/**
 * The layered configuration {@link resolveGoalLoopRoundSelection} resolves, one
 * optional config per contract precedence level. An omitted level is treated the
 * same as an all-`undefined` config (it contributes nothing); `familyDefault`
 * and `globalDefault` fall back to the built-in goal-loop defaults when omitted.
 */
export type ResolveGoalLoopRoundSelectionInput = {
  stepConfig?: GoalLoopSelectionConfig;
  workflowConfig?: GoalLoopSelectionConfig;
  repositoryPolicy?: GoalLoopSelectionConfig;
  familyDefault?: GoalLoopSelectionConfig;
  globalDefault?: GoalLoopSelectionConfig;
};

/**
 * The inputs to {@link planGoalLoopRoundStart}: the daemon-owned round identity,
 * the resolved {@link GoalLoopRoundSelection}, the round's input digest and
 * artifact root, optional log paths, and the start clock. The orchestrator owns
 * the ids/clock; this module owns projecting them into a durable round record.
 */
export type PlanGoalLoopRoundStartInput = {
  roundId: string;
  invocationId: string;
  workflowRunId: string;
  stepRunId: string;
  stepKey: string;
  attempt: number;
  roundIndex: number;
  selection: GoalLoopRoundSelection;
  inputDigest: string | null;
  artifactRoot: string | null;
  logPaths?: string[];
  startedAt: number;
};

/**
 * The StepRun identity {@link planGoalLoopInvocation} projects into a durable
 * goal-loop {@link ExecutorInvocationRecord}. This is the "below `StepRun`" half of
 * the adapter: one configured executor session for a `(workflowRunId, stepRunId)`
 * step run, materialized before any round runs. `attempt` distinguishes a re-run of
 * the same step (a fresh invocation, never a mutated one).
 */
export type PlanGoalLoopInvocationInput = {
  workflowRunId: string;
  stepRunId: string;
  stepKey: string;
  attempt: number;
  /** Invocation start clock; stamped as `started_at` and the initial `heartbeat_at`. */
  startedAt: number;
};

/**
 * The per-round runtime inputs the daemon provides for a given round index: the
 * round's input digest, its daemon-provided artifact directory, and its bounded
 * log paths (contract "Round Lifecycle" steps 4-5). These are the filesystem /
 * content concerns the pure adapter never invents — the caller resolves them per
 * round (threading prior-round context into the next round's `inputDigest` in the
 * real wiring) and {@link planGoalLoopRoundStartForInvocation} freezes them into
 * the round-start record.
 */
export type GoalLoopRoundRuntimeInputs = {
  inputDigest: string | null;
  artifactRoot: string | null;
  logPaths?: string[];
};

/**
 * The inputs to {@link planGoalLoopRoundStartForInvocation}: the materialized
 * invocation (whose identity each round inherits), the resolved selection frozen
 * into every round, the 0-based round index, the per-round runtime inputs, and the
 * round start clock.
 */
export type PlanGoalLoopRoundStartForInvocationInput = {
  invocation: ExecutorInvocationRecord;
  selection: GoalLoopRoundSelection;
  roundIndex: number;
  runtime: GoalLoopRoundRuntimeInputs;
  startedAt: number;
};

/**
 * An evidence pointer a finished bounded round reports for one artifact class:
 * the `path` the round actually wrote (contract "Required Artifacts": "Artifact
 * paths are evidence pointers"), plus an optional content `digest` and human
 * `description`. The durable row — not the file — is the source of truth that the
 * artifact exists for the round.
 */
export type GoalLoopArtifactPointer = {
  path: string;
  digest?: string | null;
  description?: string | null;
};

/**
 * The evidence pointers a finished bounded round produced, one optional slot per
 * contract artifact class *except* `logs` — the orchestrator derives those from
 * the round-start record's frozen `logPaths`, which it already owns. A
 * missing/`null` slot means the round wrote no such artifact (e.g. no
 * `recoveryNote` on a committed round, no `verificationOutput` when verification
 * never ran); {@link planGoalLoopRoundArtifacts} then records no row for that
 * class rather than inventing a path.
 */
export type GoalLoopRoundArtifacts = {
  resultDocument?: GoalLoopArtifactPointer | null;
  checkpointStream?: GoalLoopArtifactPointer | null;
  verificationOutput?: GoalLoopArtifactPointer | null;
  commitOrResetEvidence?: GoalLoopArtifactPointer | null;
  recoveryNote?: GoalLoopArtifactPointer | null;
};

/**
 * The inputs to {@link planGoalLoopRoundArtifacts}: the round id the artifacts
 * hang below, the round-start record's frozen `logPaths` (projected into `logs`
 * artifacts), and the evidence pointers the mechanism reported for the remaining
 * classes.
 */
export type PlanGoalLoopRoundArtifactsInput = {
  roundId: string;
  logPaths: readonly string[];
  artifacts?: GoalLoopRoundArtifacts;
};

/**
 * The inputs to {@link planGoalLoopRoundCheckpoints}: the round id the checkpoints
 * hang below, the finalize outcome the bounded mechanism reported, whether a
 * normalized result was captured, and the daemon classification the round settled
 * into. These are the coarse round-lifecycle stages Momentum itself owns and
 * needs no product decision to derive; the mechanism's own fine-grained
 * checkpoint stream is the separate `checkpoint_stream` artifact *file* projected
 * by {@link planGoalLoopRoundArtifacts}.
 */
export type PlanGoalLoopRoundCheckpointsInput = {
  roundId: string;
  finalizeOutcome: GoalLoopFinalizeOutcome;
  /** Whether the round captured a normalized result (vs routing straight to recovery). */
  capturedResult: boolean;
  classification: ExecutorCompletionClassification;
};

/** The executor family this adapter implements. */
const GOAL_LOOP_EXECUTOR_FAMILY: WorkflowExecutorFamily = "goal-loop";

/**
 * The goal-loop executor family default selection (precedence level 4). The
 * family holds no opinion of its own yet — agent/model/effort/timeout/budget come
 * from the higher-precedence step / workflow / repo config or fall through to the
 * global floor below — so this is empty. It is the documented hook for a future
 * family-specific default without disturbing the resolver.
 */
export const GOAL_LOOP_FAMILY_DEFAULT_SELECTION: GoalLoopSelectionConfig = {};

/**
 * The Momentum global default selection (precedence level 5, the floor). Every
 * field is an explicit `null` so resolution always terminates with a value and a
 * source even when no higher level provides one — Momentum holds no built-in
 * agent/model/effort opinion, leaving the actual provider to repo/run config.
 */
export const GOAL_LOOP_GLOBAL_DEFAULT_SELECTION: Required<GoalLoopSelectionConfig> =
  {
    agentProvider: null,
    model: null,
    effort: null,
    timeoutMs: null,
    maxRounds: null,
    policyEnvelope: null
  };

/**
 * Finalize outcomes that leave the worktree in an unsafe or ambiguous state. The
 * round routes to manual recovery and preserves the precise code; this is the
 * same set `live-step-run-recovery.ts` flags as `needs_manual_recovery`.
 */
const UNSAFE_FINALIZE_OUTCOMES: ReadonlySet<GoalLoopFinalizeOutcome> = new Set([
  "manual_recovery_required",
  "reset_failed",
  "commit_failed",
  "git_failed",
  "repo_lock_lost",
  "invalid_input",
  "result_missing",
  "result_invalid"
]);

/**
 * Project a normalized runner result into the goal-loop recommendation. The
 * bounded round writes a {@link RunnerResult}; the daemon only needs its
 * `success` flag and `goal_complete` completion recommendation to classify.
 */
export function goalLoopRecommendationFromResult(
  result: RunnerResult
): GoalLoopRecommendation {
  return { success: result.success, goalComplete: result.goal_complete };
}

/**
 * Resolve the deterministic selection a goal-loop round runs under, per the
 * contract's "Agent And Model Selection" precedence (highest first):
 * step-definition > workflow-definition > repository-policy > executor-family
 * default > momentum global default. Each field resolves independently to the
 * first level that provides it, where "provides" means the field is present (an
 * explicit value, including `null`); an omitted (`undefined`) field defers to the
 * next level. The all-`null` global floor guarantees every field resolves with a
 * source. Pure: the same layered config always yields the same selection.
 */
export function resolveGoalLoopRoundSelection(
  input: ResolveGoalLoopRoundSelectionInput
): GoalLoopRoundSelection {
  // Highest precedence first. The caller's `globalDefault` overrides the built-in
  // floor at the same source level; the built-in floor is always all-defined so
  // resolution can never fall off the end.
  const levels: readonly SelectionLevel[] = [
    { config: input.stepConfig, source: "step_definition" },
    { config: input.workflowConfig, source: "workflow_definition" },
    { config: input.repositoryPolicy, source: "repository_policy" },
    {
      config: input.familyDefault ?? GOAL_LOOP_FAMILY_DEFAULT_SELECTION,
      source: "executor_family_default"
    },
    { config: input.globalDefault, source: "momentum_global_default" },
    {
      config: GOAL_LOOP_GLOBAL_DEFAULT_SELECTION,
      source: "momentum_global_default"
    }
  ];

  const agentProvider = resolveSelectionField(levels, (c) => c.agentProvider);
  const model = resolveSelectionField(levels, (c) => c.model);
  const effort = resolveSelectionField(levels, (c) => c.effort);
  const timeoutMs = resolveSelectionField(levels, (c) => c.timeoutMs);
  const maxRounds = resolveSelectionField(levels, (c) => c.maxRounds);
  const policyEnvelope = resolveSelectionField(levels, (c) => c.policyEnvelope);

  return {
    agentProvider: agentProvider.value,
    model: model.value,
    effort: effort.value,
    timeoutMs: timeoutMs.value,
    maxRounds: maxRounds.value,
    policyEnvelope: policyEnvelope.value,
    source: {
      agentProvider: agentProvider.source,
      model: model.source,
      effort: effort.source,
      timeoutMs: timeoutMs.source,
      maxRounds: maxRounds.source,
      policyEnvelope: policyEnvelope.source
    }
  };
}

/**
 * Project a resolved selection and the daemon-owned round identity into the
 * durable round-start {@link ExecutorRoundRecord} the orchestrator inserts before
 * invoking external work (contract Round Lifecycle steps 2 and 4). The round
 * starts `running` with its agent / model / effort, input digest, artifact root,
 * and log paths copied in and empty result evidence; the terminal projection
 * ({@link planGoalLoopRoundPersistence}) fills the rest. Pure: no ids or clock are
 * invented here — freezing the selection at start is the contract's "a later
 * config edit must not rewrite the historical record for an already-started
 * round."
 */
export function planGoalLoopRoundStart(
  input: PlanGoalLoopRoundStartInput
): ExecutorRoundRecord {
  return {
    roundId: input.roundId,
    invocationId: input.invocationId,
    workflowRunId: input.workflowRunId,
    stepRunId: input.stepRunId,
    stepKey: input.stepKey,
    executorFamily: GOAL_LOOP_EXECUTOR_FAMILY,
    attempt: input.attempt,
    roundIndex: input.roundIndex,
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
    remainingWork: [],
    changedFiles: [],
    verificationStatus: null,
    commitSha: null,
    recoveryCode: null,
    humanGate: null
  };
}

/**
 * Mint the deterministic, reattachable executor-invocation id for a goal-loop
 * step run. The id embeds the `(workflowRunId, stepRunId)` step-run identity, the
 * `goal-loop` family, and the `attempt`, so it is globally unique (the
 * `executor_invocations` primary key) yet recomputable from durable state alone —
 * the daemon can reattach to an in-flight invocation without a side table
 * (contract "Heartbeat And Reattach"). A re-run of the same step is a fresh
 * `attempt`, so it never collides with the prior invocation.
 */
export function goalLoopInvocationId(
  workflowRunId: string,
  stepRunId: string,
  attempt: number
): string {
  return `${workflowRunId}::${stepRunId}::${GOAL_LOOP_EXECUTOR_FAMILY}::${attempt}`;
}

/**
 * Mint the deterministic, reattachable round id for a 0-based round index under a
 * goal-loop invocation. The id embeds the invocation id and the index so it is
 * globally unique (the `executor_rounds` primary key) and consistent with the
 * `(invocation_id, round_index)` uniqueness the persistence layer enforces.
 */
export function goalLoopRoundId(
  invocationId: string,
  roundIndex: number
): string {
  return `${invocationId}::round::${roundIndex}`;
}

/**
 * Project a `StepRun` identity into the durable goal-loop
 * {@link ExecutorInvocationRecord} the orchestrator inserts before any round runs
 * (contract "State Model": `StepRun -> ExecutorInvocation -> ExecutorRound[]`).
 * This is the start of the adapter "below `StepRun`": one configured executor
 * session for the step, materialized at `running` with a deterministic id and the
 * start clock copied in. Pure: no ids or clocks are invented beyond the supplied
 * `startedAt`.
 */
export function planGoalLoopInvocation(
  input: PlanGoalLoopInvocationInput
): ExecutorInvocationRecord {
  return {
    invocationId: goalLoopInvocationId(
      input.workflowRunId,
      input.stepRunId,
      input.attempt
    ),
    workflowRunId: input.workflowRunId,
    stepRunId: input.stepRunId,
    stepKey: input.stepKey,
    executorFamily: GOAL_LOOP_EXECUTOR_FAMILY,
    state: "running",
    attempt: input.attempt,
    startedAt: input.startedAt,
    heartbeatAt: input.startedAt,
    finishedAt: null
  };
}

/**
 * Project a materialized invocation + resolved selection + per-round runtime
 * inputs into the {@link PlanGoalLoopRoundStartInput} for one round index. The
 * round inherits the invocation's `(workflowRunId, stepRunId, stepKey, attempt)`
 * identity and a deterministic {@link goalLoopRoundId}, freezes the resolved
 * selection, and copies in the round's input digest / artifact root / log paths.
 * Feed the result to {@link planGoalLoopRoundStart} to get the durable round-start
 * record. Pure: the caller owns the clock and the runtime inputs; this only wires
 * identity. This is the round-identity half of the adapter "below `StepRun`".
 */
export function planGoalLoopRoundStartForInvocation(
  input: PlanGoalLoopRoundStartForInvocationInput
): PlanGoalLoopRoundStartInput {
  const { invocation, runtime } = input;
  return {
    roundId: goalLoopRoundId(invocation.invocationId, input.roundIndex),
    invocationId: invocation.invocationId,
    workflowRunId: invocation.workflowRunId,
    stepRunId: invocation.stepRunId,
    stepKey: invocation.stepKey,
    attempt: invocation.attempt,
    roundIndex: input.roundIndex,
    selection: input.selection,
    inputDigest: runtime.inputDigest,
    artifactRoot: runtime.artifactRoot,
    ...(runtime.logPaths !== undefined ? { logPaths: runtime.logPaths } : {}),
    startedAt: input.startedAt
  };
}

/**
 * Project the full M9 finalize result into the {@link GoalLoopFinalizeEvidence}
 * the durable round record preserves: the commit SHA of a committed round and
 * the verification verdict. Verification ran (and so resolves to passed/failed/
 * skipped) exactly when the finalize outcome carries a verification field;
 * otherwise the verdict is `null`.
 */
export function goalLoopFinalizeEvidenceFromResult(
  result: FinalizeLiveWorkflowStepFromResultFileResult
): GoalLoopFinalizeEvidence {
  return {
    outcome: result.outcome,
    commitSha: result.outcome === "committed" ? result.commit.commitSha : null,
    verificationStatus: verificationStatusFromResult(result)
  };
}

/**
 * Project a finished round's evidence into the durable {@link ExecutorArtifactRecord}
 * rows the M10-03 persistence layer (`insertExecutorArtifact`) writes — the
 * contract "Required Artifacts" / ticket "artifact evidence" half of the round's
 * per-round evidence. `logs` rows are derived from the round-start record's frozen
 * `logPaths` (the orchestrator owns those); every other class comes from the
 * pointer the mechanism reported, and an absent/`null` pointer records no row
 * rather than inventing a path. Rows are minted with deterministic ids
 * (`<roundId>-<class>`, and `<roundId>-logs-<index>` for each log) and emitted in
 * the contract {@link EXECUTOR_ARTIFACT_CLASSES} order so the durable evidence is
 * stable and reattachable. Pure: no SQLite, no file system.
 */
export function planGoalLoopRoundArtifacts(
  input: PlanGoalLoopRoundArtifactsInput
): ExecutorArtifactRecord[] {
  const { roundId, logPaths } = input;
  const artifacts = input.artifacts ?? {};
  const records: ExecutorArtifactRecord[] = [];

  // Order matches EXECUTOR_ARTIFACT_CLASSES: result, logs, checkpoint,
  // verification, commit/reset, recovery.
  if (artifacts.resultDocument != null) {
    records.push(
      goalLoopArtifactRecord(roundId, "result_document", artifacts.resultDocument)
    );
  }
  logPaths.forEach((path, index) => {
    records.push(goalLoopArtifactRecord(roundId, "logs", { path }, index));
  });
  if (artifacts.checkpointStream != null) {
    records.push(
      goalLoopArtifactRecord(
        roundId,
        "checkpoint_stream",
        artifacts.checkpointStream
      )
    );
  }
  if (artifacts.verificationOutput != null) {
    records.push(
      goalLoopArtifactRecord(
        roundId,
        "verification_output",
        artifacts.verificationOutput
      )
    );
  }
  if (artifacts.commitOrResetEvidence != null) {
    records.push(
      goalLoopArtifactRecord(
        roundId,
        "commit_or_reset_evidence",
        artifacts.commitOrResetEvidence
      )
    );
  }
  if (artifacts.recoveryNote != null) {
    records.push(
      goalLoopArtifactRecord(roundId, "recovery_note", artifacts.recoveryNote)
    );
  }
  return records;
}

/**
 * Project a finished round's major executor stages into the durable
 * {@link ExecutorCheckpointRecord} stream the M10-03 persistence layer
 * (`insertExecutorCheckpoint`) writes — the contract "Round Lifecycle" step 7
 * "Capture ... checkpoints ..." for the goal-loop family. These are the coarse
 * stages Momentum itself drives around the bounded mechanism, so they are derived
 * mechanically (no product decision, no invented vocabulary): the round started,
 * the bounded mechanism finished (carrying its finalize outcome), the normalized
 * result was captured (only when one was produced), and the daemon classified the
 * round (carrying its classification). The mechanism's own fine-grained checkpoint
 * stream is the separate `checkpoint_stream` artifact file
 * ({@link planGoalLoopRoundArtifacts}); this stream is Momentum's queryable
 * record of how far the round got, useful for reattach when the round fields
 * alone do not say which stage was reached. Checkpoints are minted with
 * deterministic ids (`<roundId>-checkpoint-<sequence>`) and sequenced from 0 so
 * the `(round_id, sequence)` uniqueness the persistence layer enforces always
 * holds. Pure: no SQLite, no file system.
 */
export function planGoalLoopRoundCheckpoints(
  input: PlanGoalLoopRoundCheckpointsInput
): ExecutorCheckpointRecord[] {
  const { roundId } = input;
  const records: ExecutorCheckpointRecord[] = [];
  const checkpoint = (stage: string, detail: string | null): void => {
    const sequence = records.length;
    records.push({
      checkpointId: `${roundId}-checkpoint-${sequence}`,
      roundId,
      sequence,
      stage,
      detail
    });
  };

  // Contract Round Lifecycle stages, in order: round created before external work
  // (step 4), bounded mechanism + normalized result (steps 5-7), classification
  // (steps 9-10). A round that produced no result skips `result_captured` — it
  // routed straight from running to manual recovery.
  checkpoint("round_started", null);
  checkpoint("mechanism_completed", `finalize outcome: ${input.finalizeOutcome}`);
  if (input.capturedResult) {
    checkpoint("result_captured", null);
  }
  checkpoint("classified", `classification: ${input.classification}`);
  return records;
}

/**
 * Build the durable persistence plan for one finished goal-loop round. Composes
 * {@link goalLoopRecommendationFromResult}, {@link decideGoalLoopRound}, and
 * {@link goalLoopFinalizeEvidenceFromResult} so the daemon decision and the two
 * round patches all derive from the same finalize result. See
 * {@link GoalLoopRoundPersistencePlan} for how the orchestrator applies them.
 *
 * @throws {Error} if `roundIndex` / `maxRounds` are out of range (via
 * {@link decideGoalLoopRound}).
 */
export function planGoalLoopRoundPersistence(
  input: PlanGoalLoopRoundPersistenceInput
): GoalLoopRoundPersistencePlan {
  // A missing/invalid result has no recommendation to project; the finalize
  // outcome is unsafe in that case, so the decision ignores the recommendation
  // and routes to manual recovery. The placeholder keeps the call total.
  const recommendation =
    input.result !== null
      ? goalLoopRecommendationFromResult(input.result)
      : { success: false, goalComplete: false };
  const decision = decideGoalLoopRound({
    recommendation,
    finalizeOutcome: input.finalize.outcome,
    roundIndex: input.roundIndex,
    maxRounds: input.maxRounds
  });
  const evidence = goalLoopFinalizeEvidenceFromResult(input.finalize);
  const captureUpdate: ExecutorRoundUpdate | null =
    input.result === null
      ? null
      : {
          toState: "capturing_result",
          summary: input.result.summary,
          keyChanges: input.result.key_changes_made,
          remainingWork: input.result.remaining_work,
          // Stamp the result digest only when the mechanism reported one; an
          // absent digest is left off the patch so `coalesce` keeps the
          // round-start record's null rather than overwriting it.
          ...(input.resultDigest != null
            ? { resultDigest: input.resultDigest }
            : {})
        };
  const terminalUpdate: ExecutorRoundUpdate = {
    toState: decision.roundState,
    classification: decision.classification,
    verificationStatus: evidence.verificationStatus,
    commitSha: evidence.commitSha,
    recoveryCode: decision.recoveryCode,
    humanGate: decision.humanGate,
    // Stamp the committed change set only when the round actually committed
    // files; an absent/empty list is left off the patch so `coalesce` keeps the
    // round-start record's empty array rather than overwriting it. By
    // construction a non-empty list only accompanies a committed outcome.
    ...(input.changedFiles != null && input.changedFiles.length > 0
      ? { changedFiles: input.changedFiles }
      : {})
  };
  return { decision, evidence, captureUpdate, terminalUpdate };
}

/**
 * Classify one completed goal-loop round. See the module doc for the boundaries
 * preserved. Pure: the same inputs always yield the same decision.
 *
 * @throws {Error} if `roundIndex` is not a non-negative integer, or `maxRounds`
 * is neither null nor a positive integer.
 */
export function decideGoalLoopRound(
  input: DecideGoalLoopRoundInput
): GoalLoopRoundDecision {
  validateInput(input);
  const { recommendation, finalizeOutcome, roundIndex, maxRounds } = input;

  // 1. Repo safety first: an unsafe or ambiguous finalize outcome can never be
  //    retried or completed away. Route to manual recovery and preserve the
  //    exact M9 recovery code, regardless of the executor's recommendation or
  //    the remaining round budget.
  if (UNSAFE_FINALIZE_OUTCOMES.has(finalizeOutcome)) {
    const recoveryCode = recoveryCodeForFinalize(finalizeOutcome);
    return {
      classification: "manual_recovery_required",
      roundState: "manual_recovery_required",
      recoveryCode,
      humanGate: "manual_recovery_required",
      continueLoop: false,
      reason: `goal-loop round finalize outcome ${finalizeOutcome} (${recoveryCode}) requires manual recovery before any further round`
    };
  }

  const budgetRemains = maxRounds === null || roundIndex + 1 < maxRounds;

  // 2. A committed round captured a durable result. Honour the executor's
  //    completion recommendation; otherwise continue (budget permitting) or
  //    raise a durable quota gate.
  if (finalizeOutcome === "committed") {
    if (recommendation.goalComplete) {
      return {
        classification: "complete",
        roundState: "succeeded",
        recoveryCode: null,
        humanGate: null,
        continueLoop: false,
        reason: "goal-loop round committed and recommended completion"
      };
    }
    return continueOrExhaust({
      roundState: "succeeded",
      budgetRemains,
      committed: true
    });
  }

  // 3. A safe reset (step failure or verification failure) produced no commit.
  //    Verification is authoritative — even a `goal_complete` recommendation
  //    cannot complete a step whose work was reset. Continue (budget permitting)
  //    or raise a durable quota gate.
  return continueOrExhaust({
    roundState: "failed",
    budgetRemains,
    committed: false
  });
}

/**
 * Map a round classification onto the next state of its owning invocation. A
 * `continue` keeps the invocation `running` for another round; terminal and
 * pause classifications settle or park the invocation. Used by the durable
 * orchestrator when it transitions the `executor_invocations` row after a round.
 */
export function invocationStateForRoundClassification(
  classification: ExecutorCompletionClassification
): ExecutorInvocationState {
  switch (classification) {
    case "complete":
      return "succeeded";
    case "continue":
      return "running";
    case "approval_required":
    case "operator_decision_required":
      return "waiting_operator";
    case "manual_recovery_required":
      return "manual_recovery_required";
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

function continueOrExhaust(input: {
  roundState: ExecutorRoundState;
  budgetRemains: boolean;
  committed: boolean;
}): GoalLoopRoundDecision {
  const progress = input.committed
    ? "committed progress but is not complete"
    : "was reset without a commit";
  if (input.budgetRemains) {
    return {
      classification: "continue",
      roundState: input.roundState,
      recoveryCode: null,
      humanGate: null,
      continueLoop: true,
      reason: `goal-loop round ${progress}; another round remains in budget`
    };
  }
  return {
    classification: "operator_decision_required",
    roundState: input.roundState,
    recoveryCode: null,
    humanGate: "quota_exhausted",
    continueLoop: false,
    reason: `goal-loop round ${progress} and exhausted its round budget; operator decision required`
  };
}

/** One precedence level for {@link resolveSelectionField}. */
type SelectionLevel = {
  config: GoalLoopSelectionConfig | undefined;
  source: GoalLoopSelectionSource;
};

/**
 * Resolve one selection field through the ordered precedence levels: the first
 * level with a present (`!== undefined`) value wins, carrying its source. An
 * absent level (undefined config) is skipped. The built-in global floor defines
 * every field, so the trailing fallback is unreachable and exists only for
 * totality.
 */
function resolveSelectionField<T extends string | number>(
  levels: readonly SelectionLevel[],
  pick: (config: GoalLoopSelectionConfig) => T | null | undefined
): { value: T | null; source: GoalLoopSelectionSource } {
  for (const level of levels) {
    if (level.config === undefined) continue;
    const value = pick(level.config);
    if (value !== undefined) {
      return { value, source: level.source };
    }
  }
  return { value: null, source: "momentum_global_default" };
}

/**
 * The recovery code a goal-loop round records for an unsafe finalize outcome.
 * `manual_recovery_required` is only ever raised by the M9 finalizer's moved-HEAD
 * guard (`head_mismatch`); every other unsafe outcome already names its own code.
 */
function recoveryCodeForFinalize(outcome: GoalLoopFinalizeOutcome): string {
  return outcome === "manual_recovery_required" ? "head_mismatch" : outcome;
}

/**
 * Build one durable artifact row for a round. The id is deterministic so a
 * re-projection of the same round yields the same evidence ids; `logs` carry an
 * `index` suffix because a round may write several log files.
 */
function goalLoopArtifactRecord(
  roundId: string,
  artifactClass: ExecutorArtifactClass,
  pointer: GoalLoopArtifactPointer,
  index?: number
): ExecutorArtifactRecord {
  const suffix =
    index !== undefined ? `${artifactClass}-${index}` : artifactClass;
  return {
    artifactId: `${roundId}-${suffix}`,
    roundId,
    artifactClass,
    path: pointer.path,
    digest: pointer.digest ?? null,
    description: pointer.description ?? null
  };
}

/**
 * Derive the round's verification verdict from the finalize result. A finalize
 * outcome that ran verification carries a verification field: a
 * {@link VerificationSuccess} maps to `passed` (or `skipped` when no commands
 * were configured), a {@link VerificationFailure} to `failed`. Outcomes that
 * never reached verification (the step failed first, or git/lock/result-document
 * problems aborted finalize) carry no verdict.
 */
function verificationStatusFromResult(
  result: FinalizeLiveWorkflowStepFromResultFileResult
): GoalLoopVerificationStatus | null {
  switch (result.outcome) {
    case "committed":
    case "commit_failed":
      // A successful verification with no configured commands is `skipped`.
      return result.verification.results.length > 0 ? "passed" : "skipped";
    case "reset_verification_failure":
      return "failed";
    case "reset_failed":
      return result.verification === null ? null : "failed";
    default:
      return null;
  }
}

function validateInput(input: DecideGoalLoopRoundInput): void {
  if (!Number.isInteger(input.roundIndex) || input.roundIndex < 0) {
    throw new Error(
      `decideGoalLoopRound: roundIndex must be a non-negative integer, got ${String(input.roundIndex)}`
    );
  }
  if (
    input.maxRounds !== null &&
    (!Number.isInteger(input.maxRounds) || input.maxRounds <= 0)
  ) {
    throw new Error(
      `decideGoalLoopRound: maxRounds must be null or a positive integer, got ${String(input.maxRounds)}`
    );
  }
}
