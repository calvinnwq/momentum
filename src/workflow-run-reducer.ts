/**
 * Pure state model for OpenClaw coding workflow runs (M7 contract).
 *
 * This module owns only the canonical vocabulary and the transition reducer
 * for `WorkflowRun` / `workflow_steps` records described in
 * internal/contracts/workflow-runs.md. It does not touch SQLite, the file
 * system, or any executor. Schema migrations, ingest paths, and CLI envelopes
 * are layered on top of these primitives in follow-up M7 slices.
 */

export const WORKFLOW_STEP_KINDS = [
  "preflight",
  "implementation",
  "postflight",
  "no-mistakes",
  "merge-cleanup",
  "linear-refresh"
] as const;
export type WorkflowStepKind = (typeof WORKFLOW_STEP_KINDS)[number];

export const WORKFLOW_STEP_STATES = [
  "pending",
  "approved",
  "running",
  "succeeded",
  "failed",
  "skipped",
  "blocked",
  "canceled"
] as const;
export type WorkflowStepState = (typeof WORKFLOW_STEP_STATES)[number];

export const WORKFLOW_STEP_TERMINAL_STATES = [
  "succeeded",
  "failed",
  "skipped",
  "canceled"
] as const satisfies readonly WorkflowStepState[];

export const WORKFLOW_RUN_STATES = [
  "pending",
  "approved",
  "running",
  "succeeded",
  "failed",
  "blocked",
  "canceled"
] as const;
export type WorkflowRunState = (typeof WORKFLOW_RUN_STATES)[number];

export const WORKFLOW_RUN_TERMINAL_STATES = [
  "succeeded",
  "failed",
  "canceled"
] as const satisfies readonly WorkflowRunState[];

export const WORKFLOW_APPROVAL_BOUNDARIES = [
  "implementation",
  "through-implementation",
  "no-mistakes",
  "through-no-mistakes",
  "merge-cleanup",
  "through-merge-cleanup",
  "full",
  "plan-only",
  "overnight-safe",
  "through-postflight",
  "through-merge-gates",
  "final-cleanup",
  "full-batch"
] as const;
export type WorkflowApprovalBoundary =
  (typeof WORKFLOW_APPROVAL_BOUNDARIES)[number];

export const WORKFLOW_LEASE_KINDS = [
  "monitor",
  "managed-step",
  "dispatch"
] as const;
export type WorkflowLeaseKind = (typeof WORKFLOW_LEASE_KINDS)[number];

export const WORKFLOW_LEASE_STALE_POLICIES = [
  "auto-release",
  "manual-recovery-required"
] as const;
export type WorkflowLeaseStalePolicy =
  (typeof WORKFLOW_LEASE_STALE_POLICIES)[number];

export type WorkflowStepRecord = {
  stepId: string;
  kind: WorkflowStepKind;
  state: WorkflowStepState;
  order: number;
  required: boolean;
};

const STEP_STATE_SET: ReadonlySet<WorkflowStepState> = new Set(
  WORKFLOW_STEP_STATES
);
const RUN_STATE_SET: ReadonlySet<WorkflowRunState> = new Set(
  WORKFLOW_RUN_STATES
);
const STEP_TERMINAL_SET: ReadonlySet<WorkflowStepState> = new Set(
  WORKFLOW_STEP_TERMINAL_STATES
);
const RUN_TERMINAL_SET: ReadonlySet<WorkflowRunState> = new Set(
  WORKFLOW_RUN_TERMINAL_STATES
);

const STEP_ALLOWED: Readonly<
  Record<WorkflowStepState, readonly WorkflowStepState[]>
> = {
  pending: ["approved", "skipped", "canceled", "blocked"],
  approved: ["running", "skipped", "canceled", "blocked"],
  running: ["succeeded", "failed", "blocked", "canceled"],
  blocked: ["approved", "canceled"],
  succeeded: [],
  failed: [],
  skipped: [],
  canceled: []
};

const RUN_ALLOWED: Readonly<
  Record<WorkflowRunState, readonly WorkflowRunState[]>
> = {
  pending: ["approved", "canceled", "blocked"],
  approved: ["running", "canceled", "blocked"],
  running: ["succeeded", "failed", "blocked", "canceled"],
  blocked: ["approved", "canceled"],
  succeeded: [],
  failed: [],
  canceled: []
};

export type StepTransitionErrorCode =
  | "workflow_step_unknown_state"
  | "workflow_step_terminal"
  | "workflow_step_invalid_transition";

export type RunTransitionErrorCode =
  | "workflow_run_unknown_state"
  | "workflow_run_terminal"
  | "workflow_run_invalid_transition";

export type TransitionResult<S, E> =
  | { ok: true; state: S }
  | { ok: false; errorCode: E; errorMessage: string };

export function isTerminalStepState(state: WorkflowStepState): boolean {
  return STEP_TERMINAL_SET.has(state);
}

export function isTerminalRunState(state: WorkflowRunState): boolean {
  return RUN_TERMINAL_SET.has(state);
}

export function transitionWorkflowStep(
  from: WorkflowStepState,
  to: WorkflowStepState
): TransitionResult<WorkflowStepState, StepTransitionErrorCode> {
  if (!STEP_STATE_SET.has(from) || !STEP_STATE_SET.has(to)) {
    return {
      ok: false,
      errorCode: "workflow_step_unknown_state",
      errorMessage: `unknown workflow step state: from=${String(from)} to=${String(to)}`
    };
  }
  if (from === to) {
    return { ok: true, state: to };
  }
  if (STEP_TERMINAL_SET.has(from)) {
    return {
      ok: false,
      errorCode: "workflow_step_terminal",
      errorMessage: `workflow step is in terminal state ${from}; cannot transition to ${to}`
    };
  }
  const allowed = STEP_ALLOWED[from];
  if (!allowed.includes(to)) {
    return {
      ok: false,
      errorCode: "workflow_step_invalid_transition",
      errorMessage: `workflow step cannot transition from ${from} to ${to}`
    };
  }
  return { ok: true, state: to };
}

export function transitionWorkflowRun(
  from: WorkflowRunState,
  to: WorkflowRunState
): TransitionResult<WorkflowRunState, RunTransitionErrorCode> {
  if (!RUN_STATE_SET.has(from) || !RUN_STATE_SET.has(to)) {
    return {
      ok: false,
      errorCode: "workflow_run_unknown_state",
      errorMessage: `unknown workflow run state: from=${String(from)} to=${String(to)}`
    };
  }
  if (from === to) {
    return { ok: true, state: to };
  }
  if (RUN_TERMINAL_SET.has(from)) {
    return {
      ok: false,
      errorCode: "workflow_run_terminal",
      errorMessage: `workflow run is in terminal state ${from}; cannot transition to ${to}`
    };
  }
  const allowed = RUN_ALLOWED[from];
  if (!allowed.includes(to)) {
    return {
      ok: false,
      errorCode: "workflow_run_invalid_transition",
      errorMessage: `workflow run cannot transition from ${from} to ${to}`
    };
  }
  return { ok: true, state: to };
}

/**
 * Derive a run state from the durable step rows alone. Precedence:
 *   1. any step `running`  → `running`
 *   2. any step `blocked`  → `blocked`
 *   3. any required step `failed` → `failed`
 *   4. every required step is `succeeded` or `skipped`, at least one `succeeded` → `succeeded`
 *   5. every step is `canceled` or `skipped` (no successes, no failures) → `canceled`
 *   6. any step is `approved` → `approved`
 *   7. otherwise → `pending`
 *
 * Non-required steps cannot trip a run into `failed`. Empty step lists are
 * treated as `pending`. This mirrors the M7 contract's terminal-derivation
 * rule that the run state is a deterministic function of step states (plus
 * leases, which a follow-up slice will fold in once the lease table lands).
 */
export function deriveWorkflowRunState(
  steps: readonly WorkflowStepRecord[]
): WorkflowRunState {
  if (steps.length === 0) return "pending";

  let anyRunning = false;
  let anyBlocked = false;
  let anyRequiredFailed = false;
  let anyApproved = false;
  let anySucceeded = false;
  let allRequiredFinalSuccessOrSkip = true;
  let hasRequired = false;
  let allCanceledOrSkipped = true;
  let anyFailure = false;

  for (const step of steps) {
    if (step.required) hasRequired = true;
    switch (step.state) {
      case "running":
        anyRunning = true;
        if (step.required) allRequiredFinalSuccessOrSkip = false;
        allCanceledOrSkipped = false;
        break;
      case "blocked":
        anyBlocked = true;
        if (step.required) allRequiredFinalSuccessOrSkip = false;
        allCanceledOrSkipped = false;
        break;
      case "failed":
        anyFailure = true;
        if (step.required) {
          anyRequiredFailed = true;
          allRequiredFinalSuccessOrSkip = false;
        }
        allCanceledOrSkipped = false;
        break;
      case "succeeded":
        anySucceeded = true;
        allCanceledOrSkipped = false;
        break;
      case "skipped":
        // counts as terminal success for required-step closure
        break;
      case "canceled":
        if (step.required) allRequiredFinalSuccessOrSkip = false;
        break;
      case "approved":
        anyApproved = true;
        if (step.required) allRequiredFinalSuccessOrSkip = false;
        allCanceledOrSkipped = false;
        break;
      case "pending":
        if (step.required) allRequiredFinalSuccessOrSkip = false;
        allCanceledOrSkipped = false;
        break;
    }
  }

  if (anyRunning) return "running";
  if (anyBlocked) return "blocked";
  if (anyRequiredFailed) return "failed";
  if (
    hasRequired &&
    allRequiredFinalSuccessOrSkip &&
    (anySucceeded || !anyFailure)
  ) {
    if (anySucceeded || stepsAllSkippedOrSucceeded(steps)) return "succeeded";
  }
  if (allCanceledOrSkipped) return "canceled";
  if (anyApproved) return "approved";
  return "pending";
}

function stepsAllSkippedOrSucceeded(
  steps: readonly WorkflowStepRecord[]
): boolean {
  for (const step of steps) {
    if (!step.required) continue;
    if (step.state !== "succeeded" && step.state !== "skipped") return false;
  }
  return true;
}
