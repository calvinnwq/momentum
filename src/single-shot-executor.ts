/**
 * Single-shot executor adapter — decision brain and identity (M10-06, NGX-350).
 *
 * The executor-loop contract (internal/contracts/executor-loop.md) pins two
 * single-invocation executor families that this module serves together:
 *
 *   - `one-shot` "runs a single command, agent call, or script-like invocation.
 *     It may retry under policy, but it does not own an open-ended loop."
 *   - `script` "runs deterministic local commands with explicit argv/env/cwd and
 *     bounded logs."
 *
 * Both families share the same control shape: one {@link ExecutorInvocation} with
 * exactly one {@link ExecutorRound}, no continue-loop and no round budget (a
 * retry is a fresh `attempt`, never a `continue`). They differ only in their
 * *mechanism* — `one-shot` requires a normalized {@link RunnerResult} document
 * (an agent/review pass) while `script` is exit-code based (a deterministic local
 * command) — which is the later-slice concern of the mechanism / orchestrator
 * twins, the same way `goal-loop-mechanism.ts` / `goal-loop-orchestrator.ts`
 * layer on `goal-loop-executor.ts`. This module owns the *pure* half both
 * families share: the recovery taxonomy, the daemon classification of a single
 * invocation, and the deterministic, reattachable invocation / round identity.
 *
 * It is a pure function of its inputs: no SQLite, no file system, no git, no
 * executor invocation — exactly the discipline `goal-loop-executor.ts` and
 * `executor-loop-reducer.ts` follow.
 *
 * Classification, grounded in the contract's "Completion Classification"
 * definitions:
 *
 *   - A successful invocation is `complete`. A single shot has no further round,
 *     so success terminates the step toward success directly (subject to final
 *     workflow checks the daemon still owns).
 *   - `runtime_unavailable` / `auth_unavailable` are `blocked`: "a durable
 *     non-terminal blockage that may be resolved by changing input, policy,
 *     credentials, or external state." A missing runtime or failed credential
 *     check is fixed by changing the environment, not by failing the step; the
 *     workflow can recover by starting a fresh invocation once it clears.
 *     `auth_unavailable` additionally raises a durable `credential_required`
 *     gate so the operator surface names the blocker.
 *   - `command_failed` / `command_timed_out` / `output_overflow` /
 *     `result_missing` / `result_invalid` are `failed`: "the step should fail
 *     under the current policy." These are genuine execution failures of the
 *     bounded unit itself.
 *   - The unsafe repo-finalization codes (`head_mismatch`, `repo_lock_lost`,
 *     `reset_failed`, `commit_failed`, `git_failed`, `invalid_input`) route to
 *     `manual_recovery_required` and preserve the precise code, mirroring how
 *     `decideGoalLoopRound` treats the same finalize ambiguity: Momentum cannot
 *     safely proceed without operator inspection.
 *
 * The recovery taxonomy reuses the existing vocabulary rather than inventing a
 * parallel one: the execution-time codes are exactly the M9
 * {@link LIVE_STEP_WRAPPER_RECOVERY_CODES}, and the unsafe-finalize codes are the
 * same strings `goal-loop-executor.ts` preserves for an unsafe finalize outcome
 * (`head_mismatch` is the moved-HEAD guard's code; the rest name themselves).
 */

import type {
  ExecutorCompletionClassification,
  ExecutorHumanGateType,
  ExecutorInvocationRecord,
  ExecutorInvocationState,
  ExecutorRoundState,
  WorkflowExecutorFamily
} from "./executor-loop-reducer.js";
import { LIVE_STEP_WRAPPER_RECOVERY_CODES } from "./live-step-wrapper.js";

/**
 * The executor families this adapter serves: the single-invocation families from
 * the contract's "Executor Families" list. Pinned as the canonical set so the
 * mechanism / orchestrator twins and the family guard stay in sync.
 */
export const SINGLE_SHOT_EXECUTOR_FAMILIES = [
  "one-shot",
  "script"
] as const satisfies readonly WorkflowExecutorFamily[];

export type SingleShotExecutorFamily =
  (typeof SINGLE_SHOT_EXECUTOR_FAMILIES)[number];

const SINGLE_SHOT_FAMILY_SET: ReadonlySet<string> = new Set(
  SINGLE_SHOT_EXECUTOR_FAMILIES
);

/**
 * Whether an executor family is one this adapter drives. Lets the daemon route a
 * `StepDefinition.executor` to the single-shot adapter without hard-coding the
 * two names at the call site.
 */
export function isSingleShotExecutorFamily(
  family: string
): family is SingleShotExecutorFamily {
  return SINGLE_SHOT_FAMILY_SET.has(family);
}

/**
 * Recovery codes that mark a `blocked` outcome: a durable non-terminal blockage
 * resolvable by changing the environment, credentials, or external state. These
 * are the M9 live-wrapper runtime/credential codes — the runtime is not the
 * step's fault, so the step blocks rather than fails.
 */
export const SINGLE_SHOT_BLOCKED_RECOVERY_CODES = [
  "runtime_unavailable",
  "auth_unavailable"
] as const;

/**
 * Recovery codes that mark a `failed` outcome: a genuine execution failure of
 * the bounded unit itself. These are the M9 live-wrapper execution codes minus
 * the runtime/credential codes above.
 */
export const SINGLE_SHOT_FAILED_RECOVERY_CODES = [
  "command_failed",
  "command_timed_out",
  "output_overflow",
  "result_missing",
  "result_invalid"
] as const;

/**
 * Recovery codes that route to `manual_recovery_required`: an unsafe or
 * ambiguous repo-finalization outcome that Momentum must not retry away. These
 * are the same strings `goal-loop-executor.ts` preserves for an unsafe finalize
 * (`head_mismatch` is the moved-HEAD guard's code).
 */
export const SINGLE_SHOT_MANUAL_RECOVERY_CODES = [
  "head_mismatch",
  "repo_lock_lost",
  "reset_failed",
  "commit_failed",
  "git_failed",
  "invalid_input"
] as const;

/**
 * The full single-shot recovery taxonomy: every code a single invocation can
 * record, partitioned by classification bucket. The execution-time codes
 * (`blocked` + `failed` buckets) are exactly the M9
 * {@link LIVE_STEP_WRAPPER_RECOVERY_CODES}; the manual-recovery codes are the
 * unsafe-finalize vocabulary shared with the goal-loop adapter.
 */
export const SINGLE_SHOT_RECOVERY_CODES = [
  ...SINGLE_SHOT_BLOCKED_RECOVERY_CODES,
  ...SINGLE_SHOT_FAILED_RECOVERY_CODES,
  ...SINGLE_SHOT_MANUAL_RECOVERY_CODES
] as const;

export type SingleShotRecoveryCode = (typeof SINGLE_SHOT_RECOVERY_CODES)[number];

const BLOCKED_SET: ReadonlySet<string> = new Set(
  SINGLE_SHOT_BLOCKED_RECOVERY_CODES
);
const FAILED_SET: ReadonlySet<string> = new Set(
  SINGLE_SHOT_FAILED_RECOVERY_CODES
);
const MANUAL_RECOVERY_SET: ReadonlySet<string> = new Set(
  SINGLE_SHOT_MANUAL_RECOVERY_CODES
);

// The execution-time codes must stay a subset of the M9 live-wrapper taxonomy so
// a wrapper failure always has a single-shot classification. This is a
// compile-time assertion: every live-wrapper code is a single-shot code. The
// tuple wrapping keeps the `extends` check non-distributive, so a *single*
// uncovered code collapses the whole assertion to `never` (a missing code would
// otherwise hide behind the union's other `true` members).
type LiveWrapperCode = (typeof LIVE_STEP_WRAPPER_RECOVERY_CODES)[number];
type _AssertWrapperCodesCovered =
  [LiveWrapperCode] extends [SingleShotRecoveryCode] ? true : never;
const _wrapperCodesCovered: _AssertWrapperCodesCovered = true;
void _wrapperCodesCovered;

/**
 * The outcome of one single-shot invocation, normalized for classification.
 * `ok: true` is a successful command/agent/script run (with any repo
 * finalization already proven safe by the mechanism); `ok: false` carries the
 * precise recovery code the mechanism reported.
 */
export type SingleShotInvocationOutcome =
  | { ok: true }
  | { ok: false; recoveryCode: SingleShotRecoveryCode };

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
  outcome: SingleShotInvocationOutcome
): SingleShotDecision {
  if (outcome.ok) {
    return {
      classification: "complete",
      roundState: "succeeded",
      invocationState: "succeeded",
      recoveryCode: null,
      humanGate: null,
      reason: "single-shot invocation succeeded"
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
      reason: `single-shot invocation blocked (${recoveryCode}); resolve the environment or credentials and re-run`
    };
  }

  if (FAILED_SET.has(recoveryCode)) {
    return {
      classification: "failed",
      roundState: "failed",
      invocationState: "failed",
      recoveryCode,
      humanGate: null,
      reason: `single-shot invocation failed (${recoveryCode})`
    };
  }

  if (MANUAL_RECOVERY_SET.has(recoveryCode)) {
    return {
      classification: "manual_recovery_required",
      roundState: "manual_recovery_required",
      invocationState: "manual_recovery_required",
      recoveryCode,
      humanGate: "manual_recovery_required",
      reason: `single-shot invocation finalize outcome ${recoveryCode} requires manual recovery before any retry`
    };
  }

  throw new Error(
    `decideSingleShotInvocation: unknown recovery code ${String(recoveryCode)}`
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
  attempt: number
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
  input: PlanSingleShotInvocationInput
): ExecutorInvocationRecord {
  return {
    invocationId: singleShotInvocationId(
      input.workflowRunId,
      input.stepRunId,
      input.family,
      input.attempt
    ),
    workflowRunId: input.workflowRunId,
    stepRunId: input.stepRunId,
    stepKey: input.stepKey,
    executorFamily: input.family,
    state: "running",
    attempt: input.attempt,
    startedAt: input.startedAt,
    heartbeatAt: input.startedAt,
    finishedAt: null
  };
}
