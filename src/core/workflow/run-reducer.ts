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

export function isWorkflowApprovalBoundary(
  value: string
): value is WorkflowApprovalBoundary {
  return (WORKFLOW_APPROVAL_BOUNDARIES as readonly string[]).includes(value);
}

export function highestWorkflowApprovalBoundary(
  current: string | null,
  next: WorkflowApprovalBoundary | null
): WorkflowApprovalBoundary | null {
  if (next === null) {
    return current !== null && isWorkflowApprovalBoundary(current)
      ? current
      : null;
  }
  if (current !== null && isWorkflowApprovalBoundary(current)) {
    const currentOrder = workflowApprovalBoundaryRank(current);
    const nextOrder = workflowApprovalBoundaryRank(next);
    if (currentOrder > nextOrder) return current;
  }
  return next;
}

export function workflowApprovalBoundaryRank(
  boundary: WorkflowApprovalBoundary
): number {
  return workflowStepKindsForApprovalBoundary(boundary).length;
}

export function workflowStepKindsForApprovalBoundary(
  boundary: WorkflowApprovalBoundary
): WorkflowStepKind[] {
  switch (boundary) {
    case "implementation":
    case "through-implementation":
      return ["preflight", "implementation"];
    case "no-mistakes":
    case "through-no-mistakes":
    case "overnight-safe":
    case "through-merge-gates":
      return ["preflight", "implementation", "postflight", "no-mistakes"];
    case "merge-cleanup":
    case "through-merge-cleanup":
      return [
        "preflight",
        "implementation",
        "postflight",
        "no-mistakes",
        "merge-cleanup"
      ];
    case "full":
    case "final-cleanup":
    case "full-batch":
      return [
        "preflight",
        "implementation",
        "postflight",
        "no-mistakes",
        "merge-cleanup",
        "linear-refresh"
      ];
    case "through-postflight":
      return ["preflight", "implementation", "postflight"];
    case "plan-only":
      return [];
  }
}

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

export const WORKFLOW_LEASE_FRESHNESS_CLASSIFICATIONS = [
  "released",
  "fresh",
  "stale-auto-release",
  "stale-manual-recovery-required"
] as const;
export type WorkflowLeaseFreshnessClassification =
  (typeof WORKFLOW_LEASE_FRESHNESS_CLASSIFICATIONS)[number];

export type WorkflowLeaseRecord = {
  runId: string;
  leaseKind: WorkflowLeaseKind;
  holder: string;
  acquiredAt: number;
  expiresAt: number;
  heartbeatAt: number;
  releasedAt: number | null;
  stalePolicy: WorkflowLeaseStalePolicy;
};

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
 * Derive a run state from the durable step rows (and optionally the durable
 * `workflow_leases` rows). Step-only precedence:
 *   1. any step `running`  → `running`
 *   2. any step `blocked`  → `blocked`
 *   3. any required step `failed` → `failed`
 *   4. every required step is `succeeded` or `skipped`, at least one `succeeded` → `succeeded`
 *   5. every step is `canceled` or `skipped` (no successes, no failures) → `canceled`
 *   6. any step is `approved` → `approved`
 *   7. otherwise → `pending`
 *
 * Non-required steps cannot trip a run into `failed`. Empty step lists are
 * treated as `pending`.
 *
 * When `leaseContext` is supplied the result is additionally constrained by
 * `workflow_leases` per the M7 contract:
 *   - Any outstanding `stale-manual-recovery-required` lease forces `blocked`,
 *     except when the step-derived state is already terminal-non-success
 *     (`failed` / `canceled`); a terminal-non-success run is not "rescued"
 *     back into `blocked` by an orphaned recovery lease, but the lease still
 *     needs operator cleanup before any new claims succeed.
 *   - A step-derived `succeeded` is demoted to `running` whenever any
 *     non-released lease (fresh, stale-auto-release, or stale-manual-recovery
 *     when steps would otherwise have allowed succeeded) is still outstanding,
 *     since the contract requires "no outstanding leases" for terminal success.
 *
 * Released leases (`releasedAt !== null`) never affect the derived state.
 */
export function deriveWorkflowRunState(
  steps: readonly WorkflowStepRecord[],
  leaseContext?: {
    leases: readonly WorkflowLeaseRecord[];
    now: number;
    graceMs?: number;
  }
): WorkflowRunState {
  const stepState = deriveStepOnlyRunState(steps);
  if (!leaseContext) return stepState;

  let anyManualRecovery = false;
  let anyOutstanding = false;
  for (const lease of leaseContext.leases) {
    const classification = classifyWorkflowLease(lease, {
      now: leaseContext.now,
      ...(leaseContext.graceMs !== undefined
        ? { graceMs: leaseContext.graceMs }
        : {})
    });
    if (classification === "released") continue;
    anyOutstanding = true;
    if (classification === "stale-manual-recovery-required") {
      anyManualRecovery = true;
    }
  }

  if (anyManualRecovery && stepState !== "failed" && stepState !== "canceled") {
    return "blocked";
  }
  if (stepState === "succeeded" && anyOutstanding) {
    return "running";
  }
  return stepState;
}

function deriveStepOnlyRunState(
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
  if (hasRequired && allRequiredFinalSuccessOrSkip && anySucceeded) {
    return "succeeded";
  }
  if (allCanceledOrSkipped) return "canceled";
  if (anyApproved) return "approved";
  return "pending";
}

/**
 * Classify the freshness of a `workflow_leases` row without touching the file
 * system, cron platform, or `monitor.json`. A lease is the durable bookkeeping
 * the M7 contract uses to detect a missing / stuck monitor or managed-step
 * dispatcher independent of the cron tick that maintains it.
 *
 * Precedence:
 *   1. `releasedAt !== null`  → `released` (terminal; recovery never re-touches
 *       a released row regardless of expiry or stale policy).
 *   2. `now <= expiresAt + graceMs`  → `fresh` (holder still owns the lease).
 *   3. otherwise, the lease is stale and the row's `stalePolicy` decides:
 *      `auto-release`  → `stale-auto-release` (safe for the scheduler-lane
 *      recovery pass to release without operator involvement).
 *      `manual-recovery-required`  → `stale-manual-recovery-required` (must
 *      surface in `recovery.md` and block further claims on the run until an
 *      operator clears it).
 *
 * `heartbeatAt` is informational only: the contract treats `expiresAt` as the
 * sole owner-of-record for freshness, mirroring M3 `repo_locks` stale-lease
 * semantics (`listStaleRepoLocks` uses `lease_expires_at < cutoff`). A holder
 * extends the lease by writing both `heartbeatAt` and `expiresAt`; a stalled
 * heartbeat that failed to advance `expiresAt` is correctly classified stale.
 */
export function classifyWorkflowLease(
  lease: WorkflowLeaseRecord,
  input: { now: number; graceMs?: number }
): WorkflowLeaseFreshnessClassification {
  if (!Number.isFinite(input.now)) {
    throw new Error("classifyWorkflowLease: now must be a finite number");
  }
  const graceMs = input.graceMs ?? 0;
  if (!Number.isFinite(graceMs) || graceMs < 0) {
    throw new Error(
      "classifyWorkflowLease: graceMs must be a non-negative finite number"
    );
  }
  if (lease.releasedAt !== null) return "released";
  if (input.now <= lease.expiresAt + graceMs) return "fresh";
  return lease.stalePolicy === "auto-release"
    ? "stale-auto-release"
    : "stale-manual-recovery-required";
}
