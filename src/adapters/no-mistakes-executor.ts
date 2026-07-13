/**
 * no-mistakes executor mirror — decision brain and identity.
 *
 * The executor-loop contract (SPEC.md) pins the
 * `no-mistakes` family as a *mirror*, not a runner: it "mirrors no-mistakes
 * daemon state and turns review findings into durable Momentum gates, findings,
 * and decisions." Momentum does not own or re-run the no-mistakes pipeline; it
 * mirrors enough external state to decide workflow progress. The contract's
 * "External Executor Mirroring" section lists exactly what Momentum mirrors for
 * no-mistakes:
 *
 *   - External run id.
 *   - Branch and head SHA.
 *   - Active external step.
 *   - Step status.
 *   - Review findings.
 *   - Selected finding IDs.
 *   - Decisions and delegated-policy results.
 *   - PR URL and CI state.
 *
 * This module owns the *pure* half of that mirror: the {@link NoMistakesExternalState}
 * snapshot shape, the daemon classification of a mirrored snapshot, the durable
 * finding / decision projections, and the deterministic, reattachable invocation
 * / round identity. Like `single-shot/executor.ts` and `goal-loop/executor.ts`,
 * it is a pure function of its inputs: no SQLite, no file system, no git, no
 * executor invocation. The mechanism / orchestrator siblings layer the
 * external-state reader and durable persistence on top, exactly as the
 * single-shot twins layer on `single-shot/executor.ts`.
 *
 * The defining discipline is the ticket's "Treat external no-mistakes state as
 * evidence to classify, not blindly trusted authority" and the contract's
 * "External state strings are never enough on their own." So unlike
 * `decideSingleShotInvocation` — which classifies an outcome Momentum's *own*
 * mechanism produced and therefore *throws* on an unknown code (a programming
 * error) — {@link decideNoMistakesMirror} classifies *external* evidence and is
 * total: any malformed, contradictory, or unrecognized snapshot routes to
 * `manual_recovery_required` for operator inspection rather than being trusted or
 * crashing the daemon.
 *
 * Classification, grounded in the contract's "Completion Classification" and the
 * ticket's "Preserve no-mistakes daemon ownership and human-gate semantics":
 *
 *   - `running` is `continue`: the external pipeline is still working, so the
 *     mirror round stays in `mirroring_external_state` and the daemon polls
 *     again. No human gate; nothing is decided yet.
 *   - `awaiting_decision` is `operator_decision_required`: no-mistakes surfaced a
 *     decision point. Momentum mirrors it as a durable `waiting_operator` gate
 *     and never auto-resolves it — the no-mistakes daemon and the operator keep
 *     ownership of the decision.
 *   - `awaiting_approval` is `approval_required`: an approval boundary that the
 *     mirror surfaces as a durable `waiting_operator` gate.
 *   - `completed` is `complete` *only when the corroborating evidence agrees* —
 *     no active findings remain, CI is passing or not configured, and every
 *     surfaced decision is resolved.
 *     A `completed` claim that contradicts its own CI / decision evidence is not
 *     trusted; it routes to `manual_recovery_required` (`external_state_inconsistent`).
 *   - `failed` is `failed` (`external_run_failed`).
 *   - `cancelled` is `manual_recovery_required`
 *     (`external_state_inconsistent`) because cancellation is not reliable
 *     completion evidence.
 *   - `blocked` is `blocked` (`external_state_blocked`) with an
 *     `external_state_required` gate naming the blocker; the round ends blocked
 *     while the workflow may later start a fresh invocation once the blocker
 *     clears.
 *   - A structurally unreadable snapshot (empty run id, malformed head SHA, a
 *     selected finding id with no surfaced finding, an empty finding title, a
 *     decision with no allowed actions, duplicate ids, an unknown step status,
 *     an unknown CI state) routes to `manual_recovery_required`
 *     (`external_state_unreadable`): untrusted evidence, not authority.
 */

import type { ExecutorRoundUpdate } from "../core/executors/loop/persist.js";
import {
  classifyDelegateSupervisorState,
  classifyDelegateSupervisorUnreadable,
} from "../core/executors/delegate-supervisor/classifier.js";
import type {
  ExecutorCompletionClassification,
  ExecutorDecisionRecord,
  ExecutorFindingRecord,
  ExecutorHumanGateType,
  ExecutorInvocationRecord,
  ExecutorInvocationState,
  ExecutorRoundRecord,
  ExecutorRoundState,
  WorkflowExecutorFamily,
} from "../core/executors/loop/reducer.js";

/**
 * The single executor family this adapter mirrors. Pinned as a named constant —
 * mirroring `goal-loop/executor.ts`'s `GOAL_LOOP_EXECUTOR_FAMILY` — so the
 * mechanism / orchestrator twins and the family guard stay in sync.
 */
export const NO_MISTAKES_EXECUTOR_FAMILY =
  "no-mistakes" as const satisfies WorkflowExecutorFamily;

export type NoMistakesExecutorFamily = typeof NO_MISTAKES_EXECUTOR_FAMILY;

/**
 * The executor families this adapter serves: just `no-mistakes`. Exposed as a
 * one-element set so a daemon dispatcher can route a `StepDefinition.executor` to
 * the no-mistakes mirror the same way it routes the single-shot families, without
 * hard-coding the family string at the call site.
 */
export const NO_MISTAKES_EXECUTOR_FAMILIES = [
  NO_MISTAKES_EXECUTOR_FAMILY,
] as const satisfies readonly WorkflowExecutorFamily[];

/**
 * Whether an executor family is the one this adapter mirrors.
 */
export function isNoMistakesExecutorFamily(
  family: string,
): family is NoMistakesExecutorFamily {
  return family === NO_MISTAKES_EXECUTOR_FAMILY;
}

/**
 * The external no-mistakes step statuses Momentum can mirror (contract "External
 * Executor Mirroring": "Active external step" / "Step status"). These are the
 * status strings the no-mistakes daemon exposes for its active step; the mirror
 * reconciles them with the rest of the snapshot rather than trusting them
 * outright.
 */
export const NO_MISTAKES_EXTERNAL_STEP_STATUSES = [
  "running",
  "awaiting_decision",
  "awaiting_approval",
  "blocked",
  "failed",
  "cancelled",
  "completed",
] as const;
export type NoMistakesExternalStepStatus =
  (typeof NO_MISTAKES_EXTERNAL_STEP_STATUSES)[number];

/**
 * The external CI states Momentum can mirror (contract "External Executor
 * Mirroring": "PR URL and CI state"). `none` means CI is not configured for the
 * run (no PR checks); `passed` / `failed` / `pending` mirror the PR's check
 * conclusion. A completed external run is only trusted as `complete` when CI is
 * `passed` or `none`.
 */
export const NO_MISTAKES_CI_STATES = [
  "passed",
  "failed",
  "pending",
  "none",
] as const;
export type NoMistakesCiState = (typeof NO_MISTAKES_CI_STATES)[number];

/**
 * Recovery codes for untrusted or contradictory external no-mistakes state. These
 * are the mirror-specific codes the round records when it cannot trust the
 * snapshot, parallel to the single-shot adapter's recovery taxonomy but scoped to
 * external-state reconciliation rather than local execution:
 *
 *   - `external_run_failed` — the external run reported failure.
 *   - `external_state_blocked` — the external run reported a durable blockage.
 *   - `external_state_inconsistent` — the snapshot's own fields contradict each
 *     other (a `completed` claim with failing / pending CI or an unresolved
 *     decision; an `awaiting_decision` claim with no surfaced decision), or the
 *     orchestrator saw unchanged running mirror evidence long enough that it
 *     needs operator inspection.
 *   - `external_state_unreadable` — the snapshot is structurally malformed and
 *     cannot be trusted at all (bad ids / SHA, dangling selected finding,
 *     unknown status / CI state).
 */
export const NO_MISTAKES_RECOVERY_CODES = [
  "external_run_failed",
  "external_state_blocked",
  "external_state_inconsistent",
  "external_state_unreadable",
] as const;
export type NoMistakesRecoveryCode =
  (typeof NO_MISTAKES_RECOVERY_CODES)[number];

/**
 * One review finding surfaced by an external no-mistakes run (contract "External
 * Executor Mirroring": "Review findings"). `externalId` is no-mistakes' own
 * finding id (e.g. `F-1`); the projection mints the durable Momentum finding id
 * and `externalRef` from it.
 */
export type NoMistakesExternalFinding = {
  externalId: string;
  title: string;
  severity?: string | null;
  detail?: string | null;
};

/**
 * One decision point surfaced by an external no-mistakes run (contract "External
 * Executor Mirroring": "Decisions and delegated-policy results"). `resolution`
 * mirrors the delegated-policy or operator outcome once the external daemon has
 * settled the decision; an absent / empty `resolution` means the decision is
 * still open.
 */
export type NoMistakesExternalDecision = {
  externalId: string;
  summary: string;
  allowedActions: readonly string[];
  recommendedAction?: string | null;
  chosenAction?: string | null;
  resolution?: string | null;
};

/**
 * A mirrored snapshot of external no-mistakes daemon state — exactly the fields
 * the contract's "External Executor Mirroring" section lists for no-mistakes. The
 * mechanism twin reads this from the external state store; this pure module
 * classifies it and projects its findings / decisions into durable Momentum
 * records. It is evidence to reconcile, not authoritative Momentum state.
 */
export type NoMistakesExternalState = {
  externalRunId: string;
  branch: string;
  headSha: string;
  activeStep: string | null;
  stepStatus: NoMistakesExternalStepStatus;
  findings: readonly NoMistakesExternalFinding[];
  selectedFindingIds: readonly string[];
  decisions: readonly NoMistakesExternalDecision[];
  prUrl: string | null;
  ciState: NoMistakesCiState;
};

/**
 * The daemon's decision for one mirrored no-mistakes snapshot. Unlike the
 * single-shot decision, a no-mistakes decision is not always terminal: a
 * still-running external run is `continue` (the round stays in
 * `mirroring_external_state`, the invocation stays `running`), and a gate is
 * `waiting_operator` (a durable, non-terminal pause). `recoveryCode` is a
 * {@link NoMistakesRecoveryCode} for any non-clean settle, or `null` otherwise.
 */
export type NoMistakesMirrorDecision = {
  classification: ExecutorCompletionClassification;
  roundState: ExecutorRoundState;
  invocationState: ExecutorInvocationState;
  humanGate: ExecutorHumanGateType | null;
  recoveryCode: NoMistakesRecoveryCode | null;
  reason: string;
};

/**
 * Classify one mirrored no-mistakes snapshot into a daemon decision. Pure and
 * total: the same snapshot always yields the same decision, and *any* input —
 * including a malformed or self-contradictory one — yields a decision rather than
 * throwing, because the snapshot is untrusted external evidence (contract
 * "External state strings are never enough on their own"; ticket "Treat external
 * no-mistakes state as evidence to classify, not blindly trusted authority").
 *
 * See the module doc for the per-status classification boundaries.
 */
export function decideNoMistakesMirror(
  state: NoMistakesExternalState,
): NoMistakesMirrorDecision {
  return classifyDelegateSupervisorState(
    state,
    "external no-mistakes",
  ) as NoMistakesMirrorDecision;
}

/**
 * Classify an external-state *read failure* into a daemon decision. The mechanism
 * twin's reader ({@link parseNoMistakesExternalState} / `readNoMistakesExternalState`)
 * returns an `error` when the external store cannot even be turned into a typed
 * snapshot — a missing / unreadable file, non-JSON bytes, a wrong-typed field.
 * That is a structurally unreadable store, so it settles identically to a
 * semantically unreadable snapshot: `manual_recovery_required` with
 * `external_state_unreadable`. Exposed so the orchestrator routes a reader error
 * through this single classification authority rather than reinventing the
 * manual-recovery decision, keeping the reader (JSON-type) and brain (semantic)
 * failures converging on one terminal shape.
 *
 * `reason` is the reader's own error string, already a full sentence (e.g.
 * "external no-mistakes state file is unreadable: ..."), so it is preserved
 * verbatim as the decision reason rather than re-prefixed.
 */
export function decideNoMistakesUnreadable(
  reason: string,
): NoMistakesMirrorDecision {
  return classifyDelegateSupervisorUnreadable(
    reason,
  ) as NoMistakesMirrorDecision;
}

/**
 * Mint the deterministic, reattachable executor-invocation id for a no-mistakes
 * mirror under a step run. The id embeds the `(workflowRunId, stepRunId)`
 * step-run identity, the `no-mistakes` family, and the `attempt`, so it is
 * globally unique yet recomputable from durable state alone (contract "Heartbeat
 * And Reattach"). A re-run of the step is a fresh `attempt`, so it never collides
 * with the prior mirror.
 */
export function noMistakesInvocationId(
  workflowRunId: string,
  stepRunId: string,
  attempt: number,
): string {
  return `${workflowRunId}::${stepRunId}::${NO_MISTAKES_EXECUTOR_FAMILY}::${attempt}`;
}

/**
 * Mint the deterministic, reattachable round id for the single mirror round under
 * a no-mistakes invocation. The mirror is one long-lived round (index 0) that
 * lives in `mirroring_external_state` while the external run is in progress, so
 * the id is fixed by the invocation id alone — consistent with the
 * `(invocation_id, round_index)` uniqueness the persistence layer enforces.
 */
export function noMistakesRoundId(invocationId: string): string {
  return `${invocationId}::round::0`;
}

/**
 * The `StepRun` identity {@link planNoMistakesInvocation} projects into a durable
 * no-mistakes {@link ExecutorInvocationRecord}: the `(workflowRunId, stepRunId)`
 * step run, the step key, the re-run `attempt`, and the start clock the
 * orchestrator owns. There is no `family` field — the mirror serves exactly the
 * `no-mistakes` family — unlike the single-shot projection that carries a chosen
 * `one-shot` / `script` family.
 */
export type PlanNoMistakesInvocationInput = {
  workflowRunId: string;
  stepRunId: string;
  stepKey: string;
  attempt: number;
  /** Invocation start clock; stamped as `started_at` and the initial `heartbeat_at`. */
  startedAt: number;
};

/**
 * Project a `StepRun` identity into the durable no-mistakes
 * {@link ExecutorInvocationRecord} the orchestrator twin inserts before the mirror
 * round runs (contract "State Model": `StepRun -> ExecutorInvocation ->
 * ExecutorRound[]`). One configured mirror session for the step, materialized at
 * `running` with the deterministic {@link noMistakesInvocationId} and the start
 * clock copied in. Pure: no ids or clocks are invented beyond the supplied
 * `startedAt`. A re-mirror is a fresh `attempt` minting a fresh invocation.
 */
export function planNoMistakesInvocation(
  input: PlanNoMistakesInvocationInput,
): ExecutorInvocationRecord {
  return {
    invocationId: noMistakesInvocationId(
      input.workflowRunId,
      input.stepRunId,
      input.attempt,
    ),
    workflowRunId: input.workflowRunId,
    stepRunId: input.stepRunId,
    stepKey: input.stepKey,
    executorFamily: NO_MISTAKES_EXECUTOR_FAMILY,
    state: "running",
    attempt: input.attempt,
    startedAt: input.startedAt,
    heartbeatAt: input.startedAt,
    finishedAt: null,
  };
}

/**
 * The per-round runtime inputs the daemon provides for the mirror: the round's
 * input digest, its daemon-provided artifact directory, and its bounded log paths
 * (contract "Round Lifecycle" steps 4-5). These are the filesystem / content
 * concerns the pure adapter never invents — the orchestrator resolves them and
 * {@link planNoMistakesRoundStart} freezes them into the round-start record.
 */
export type NoMistakesRoundRuntimeInputs = {
  inputDigest: string | null;
  artifactRoot: string | null;
  logPaths?: string[];
};

/**
 * The inputs to {@link planNoMistakesRoundStart}: the materialized no-mistakes
 * invocation (whose identity and family the single mirror round inherits), the
 * per-round runtime inputs, and the round start clock. There is no round index — a
 * mirror is always the one long-lived round at index 0 — and no resolved
 * agent/model selection, because no-mistakes owns its own pipeline (the mirror
 * reflects external state, it never drives an agent Momentum chose).
 */
export type PlanNoMistakesRoundStartInput = {
  invocation: ExecutorInvocationRecord;
  runtime: NoMistakesRoundRuntimeInputs;
  startedAt: number;
};

/**
 * Project a materialized invocation + per-round runtime inputs into the durable
 * round-start {@link ExecutorRoundRecord} the orchestrator inserts before it begins
 * mirroring (contract Round Lifecycle step 4). The round inherits the invocation's
 * `(workflowRunId, stepRunId, stepKey, attempt)` identity and its `no-mistakes`
 * family, takes the deterministic {@link noMistakesRoundId} (index 0), and copies in
 * the round's input digest / artifact root / log paths.
 *
 * Two mirror-specific differences from the single-shot round-start projection:
 *
 *   - The round is born in `mirroring_external_state`, not `running`. The mirror
 *     reflects external no-mistakes state rather than running local work, so it
 *     enters the capture/mirror phase directly; from there every decided round
 *     state ({@link decideNoMistakesMirror}) is a legal transition.
 *   - `agentProvider` / `model` / `effort` stay `null`. No-mistakes owns its own
 *     pipeline, so Momentum resolves no agent for the mirror (contract "Preserve
 *     no-mistakes daemon ownership"), exactly as the deterministic `script` family
 *     resolves no agent.
 *
 * Pure: no ids or clock are invented here — freezing the identity at start is the
 * contract's "a later config edit must not rewrite the historical record for an
 * already-started round."
 *
 * @throws {Error} if the invocation's family is not `no-mistakes` — the mirror
 * round must inherit the family {@link planNoMistakesInvocation} establishes.
 */
export function planNoMistakesRoundStart(
  input: PlanNoMistakesRoundStartInput,
): ExecutorRoundRecord {
  const { invocation, runtime } = input;
  if (!isNoMistakesExecutorFamily(invocation.executorFamily)) {
    throw new Error(
      `planNoMistakesRoundStart: invocation ${invocation.invocationId} has non-no-mistakes family ${invocation.executorFamily}; the mirror round must inherit the no-mistakes family`,
    );
  }
  return {
    roundId: noMistakesRoundId(invocation.invocationId),
    invocationId: invocation.invocationId,
    workflowRunId: invocation.workflowRunId,
    stepRunId: invocation.stepRunId,
    stepKey: invocation.stepKey,
    executorFamily: NO_MISTAKES_EXECUTOR_FAMILY,
    attempt: invocation.attempt,
    roundIndex: 0,
    state: "mirroring_external_state",
    classification: null,
    startedAt: input.startedAt,
    heartbeatAt: input.startedAt,
    finishedAt: null,
    agentProvider: null,
    model: null,
    effort: null,
    inputDigest: runtime.inputDigest,
    resultDigest: null,
    artifactRoot: runtime.artifactRoot,
    logPaths: runtime.logPaths ?? [],
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
 * The inputs to {@link planNoMistakesRoundPersistence}: the mirrored
 * {@link NoMistakesExternalState} snapshot the orchestrator read this poll. The plan
 * composes {@link decideNoMistakesMirror} over it, so the daemon decision and the
 * round patch can never disagree.
 */
export type PlanNoMistakesRoundPersistenceInput = {
  state: NoMistakesExternalState;
};

/**
 * A pure, durable persistence plan for one mirror poll. The orchestrator applies
 * {@link roundUpdate} through `updateExecutorRound`, stamping the daemon clock the
 * pure projection cannot supply. Unlike the single-shot / goal-loop plans there is
 * no separate capture patch: the mirror round already lives in
 * `mirroring_external_state` (the capture/mirror phase), from which the round
 * transition graph allows reaching `succeeded` directly, so one patch carries the
 * whole decision.
 */
export type NoMistakesRoundPersistencePlan = {
  decision: NoMistakesMirrorDecision;
  roundUpdate: ExecutorRoundUpdate;
};

/**
 * Project a mirror decision into the single durable round patch that carries it.
 * The patch transitions the round to the decided `roundState` — a `continue`
 * decision keeps it in `mirroring_external_state` (a legal same-state heartbeat),
 * a gate moves it to `waiting_operator`, and a settle moves it to its terminal —
 * and stamps the classification, the preserved recovery code, the human gate, and
 * the decision `reason` as the round's durable `summary` (the mirror has no
 * normalized result document, so the reason is its human-readable summary).
 *
 * The single source of truth for the decision -> patch mapping: both
 * {@link planNoMistakesRoundPersistence} (over a typed snapshot) and the
 * orchestrator's read-failure path (over a {@link decideNoMistakesUnreadable}
 * decision) build the patch through this, so a readable and an unreadable poll
 * patch the round identically modulo the decision they carry. The orchestrator
 * additionally threads the read's content digest onto `inputDigest` and the
 * orchestrator's semantic progress digest onto `resultDigest` so the durable
 * round fingerprints both the exact external evidence and the heartbeat / stall
 * signal it mirrored this poll. Pure: no SQLite, no file system.
 */
export function noMistakesRoundUpdate(
  decision: NoMistakesMirrorDecision,
): ExecutorRoundUpdate {
  return {
    toState: decision.roundState,
    classification: decision.classification,
    recoveryCode: decision.recoveryCode,
    humanGate: decision.humanGate,
    summary: decision.reason,
  };
}

/**
 * Build the durable persistence plan for one mirror poll. Composes
 * {@link decideNoMistakesMirror} into the single round patch the orchestrator
 * applies (via {@link noMistakesRoundUpdate}), so the daemon classification,
 * recovery code, and human gate all derive from the same snapshot (contract "Round
 * Lifecycle" steps 9-10 for the mirror). Pure: no SQLite, no file system; the same
 * snapshot always yields the same plan, and — like {@link decideNoMistakesMirror}
 * — it is total, never throwing on untrusted external evidence.
 */
export function planNoMistakesRoundPersistence(
  input: PlanNoMistakesRoundPersistenceInput,
): NoMistakesRoundPersistencePlan {
  const decision = decideNoMistakesMirror(input.state);
  return { decision, roundUpdate: noMistakesRoundUpdate(decision) };
}

/**
 * The inputs to {@link planNoMistakesRoundFindings}: the round id the findings
 * hang below, the external findings the run surfaced, and the external ids the
 * external daemon / operator selected to act on.
 */
export type PlanNoMistakesRoundFindingsInput = {
  roundId: string;
  findings: readonly NoMistakesExternalFinding[];
  selectedFindingIds: readonly string[];
};

/**
 * Project the external review findings into the durable {@link ExecutorFindingRecord}
 * rows the persistence layer (`insertExecutorFinding`) writes — the no-mistakes
 * mirror's "Review findings" / "Selected finding IDs" (contract "External
 * Executor Mirroring"). Each finding takes a deterministic id
 * (`<roundId>-finding-<externalId>`) and an `externalRef` of
 * `nomistakes:<externalId>`, is marked `selected` when its external id is in
 * `selectedFindingIds`, and preserves the surfaced order. Pure: no SQLite, no
 * file system.
 */
export function planNoMistakesRoundFindings(
  input: PlanNoMistakesRoundFindingsInput,
): ExecutorFindingRecord[] {
  const selected = new Set(input.selectedFindingIds);
  return input.findings.map((finding) => ({
    findingId: `${input.roundId}-finding-${finding.externalId}`,
    roundId: input.roundId,
    severity: finding.severity ?? null,
    title: finding.title,
    detail: finding.detail ?? null,
    selected: selected.has(finding.externalId),
    externalRef: `nomistakes:${finding.externalId}`,
  }));
}

/**
 * The inputs to {@link planNoMistakesRoundDecisions}: the round id the decisions
 * hang below and the external decisions the run surfaced.
 */
export type PlanNoMistakesRoundDecisionsInput = {
  roundId: string;
  decisions: readonly NoMistakesExternalDecision[];
};

/**
 * Project the external decision points into the durable {@link ExecutorDecisionRecord}
 * rows the persistence layer (`insertExecutorDecision`) writes — the no-mistakes
 * mirror's "Decisions and delegated-policy results" (contract "External Executor
 * Mirroring"). Each decision takes a deterministic id
 * (`<roundId>-decision-<externalId>`) and an `externalRef` of
 * `nomistakes:<externalId>`, copies its allowed actions, and mirrors its
 * recommended / chosen action and `resolution` (the delegated-policy or operator
 * outcome, or `null` while still open) so the durable record reflects — never
 * drives — the external decision. Pure: no SQLite, no file system.
 */
export function planNoMistakesRoundDecisions(
  input: PlanNoMistakesRoundDecisionsInput,
): ExecutorDecisionRecord[] {
  return input.decisions.map((decision) => ({
    decisionId: `${input.roundId}-decision-${decision.externalId}`,
    roundId: input.roundId,
    summary: decision.summary,
    allowedActions: [...decision.allowedActions],
    recommendedAction: decision.recommendedAction ?? null,
    chosenAction: decision.chosenAction ?? null,
    resolution: decision.resolution ?? null,
    externalRef: `nomistakes:${decision.externalId}`,
  }));
}
