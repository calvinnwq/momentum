/**
 * Dogfood terminalize-and-continue dispatch wrapper (M10-09b, NGX-391).
 *
 * The production workflow-lane dispatcher (`workflow-dispatch-execute.ts`) stops
 * at the phase-1 *start scaffold*: it advances a claimed step `approved ->
 * running`, creates the durable `executor_invocations` / `executor_rounds` rows,
 * and *holds* the dispatch lease while the (not-yet-landed) bounded executor
 * mechanism would drive the round to terminal out of band. Because nothing
 * terminalizes the step inside a single managed loop, the scheduler can only ever
 * dispatch the *first* runnable step per process — the NGX-390 proof needed three
 * separate `daemon start` invocations plus a manual `update-step` to advance past
 * preflight.
 *
 * This module supplies the missing controlled fixture: a {@link WorkflowStepDispatch}
 * that wraps the real production dispatch, then — only when that dispatch actually
 * started a scaffold — safely terminalizes the step through the shipped durable
 * primitives so the *same* daemon process can scan, claim, and dispatch the next
 * runnable step. It is the dogfood stand-in for "the bounded executor session
 * started and finished cleanly", not a real executor: it never spawns an agent,
 * runs verification, or writes anything external. It composes the production
 * dispatch (so the real `executor_invocations` scaffold is exercised) with three
 * shipped operations, atomically:
 *
 *   1. `finishWorkflowStep(... succeeded)` — the live `running -> succeeded`
 *      transition (never an operator override; no `operator_*` column is touched).
 *   2. `releaseWorkflowLease(...)` — the dispatch lease the scheduler handed the
 *      seam, honouring the contract's "release on terminal" half so the run is not
 *      left busy and no lease is stranded or corrupted.
 *   3. A run-state re-derivation so `workflow status` / `workflow run monitor` /
 *      `workflow handoff` explain the post-step state from durable Momentum rows
 *      alone (no Discord-derived reconstruction).
 *
 * Safety posture: the terminalization is gated on {@link shouldTerminalizeAfterDispatch}
 * so a *fail-closed* or *not-startable* dispatch — both of which already released
 * the lease and either parked the run for manual recovery or wrote nothing — is
 * echoed back untouched. Terminalizing a parked run to `succeeded` would mask a
 * manual-recovery condition, the one unsafe move this gate exists to prevent.
 */

import type { MomentumDb } from "../../adapters/db.js";
import { releaseWorkflowLease } from "./leases.js";
import { deriveWorkflowMonitorState } from "./monitor-state.js";
import {
  loadWorkflowLeaseRecords,
  loadWorkflowStepRecords,
  WORKFLOW_DISPATCH_RESULT_STATUS
} from "./dispatch-execute.js";
import { finishWorkflowStep } from "./step-transitions.js";
import type {
  ClaimedWorkflowStep,
  WorkflowStepDispatch,
  WorkflowStepDispatchContext,
  WorkflowStepDispatchResult
} from "./scheduler.js";

/**
 * `result_digest` stamped on a step this fixture terminalizes, so durable state
 * carries an unmistakable marker that the dogfood path — not a real executor —
 * closed the step.
 */
export const DOGFOOD_TERMINALIZE_RESULT_DIGEST_PREFIX = "dogfood-terminalize";

/**
 * Whether a finished production dispatch is one this fixture may safely
 * terminalize. Pure: the only inputs are the dispatcher's own stable status
 * strings.
 *
 * Only a dispatch that genuinely started (or re-entered) an executor scaffold has
 * a `running` step and a held lease to terminalize. A fail-closed dispatch already
 * parked the run for manual recovery and released its lease; a not-startable
 * dispatch wrote nothing and released its lease. Returning `false` for those keeps
 * the fixture from masking a parked run or double-releasing a lease.
 */
export function shouldTerminalizeAfterDispatch(status: string): boolean {
  return (
    status === WORKFLOW_DISPATCH_RESULT_STATUS.dispatched ||
    status === WORKFLOW_DISPATCH_RESULT_STATUS.alreadyDispatched
  );
}

/**
 * Opt-in switch that swaps the bounded `daemon start` workflow lane from the
 * production dispatch to the terminalize-and-continue fixture. Off by default, so
 * a normal `daemon start` is byte-for-byte unchanged; a dogfood sets it against an
 * isolated data dir to prove single-process multi-dispatch. Mirrors the
 * `MOMENTUM_REAL_SMOKE_*` opt-in convention.
 *
 * WARNING: when enabled, the lane marks every dispatched local step `succeeded`
 * without running a real executor. Only ever set it for an isolated dogfood data
 * dir, never against production workflow state.
 */
export const DOGFOOD_TERMINALIZE_DISPATCH_ENV_VAR =
  "MOMENTUM_DOGFOOD_TERMINALIZE_DISPATCH";

/** Truthy opt-in spellings, matching the repo's other env-flag gates. */
const TRUTHY_ENV_VALUES: ReadonlySet<string> = new Set([
  "1",
  "true",
  "yes",
  "on"
]);

/**
 * Whether the dogfood terminalize-and-continue lane is opted in via
 * {@link DOGFOOD_TERMINALIZE_DISPATCH_ENV_VAR}. Pure: reads only the supplied
 * environment snapshot.
 */
export function isDogfoodTerminalizeDispatchEnabled(
  env: Record<string, string | undefined>
): boolean {
  const value = env[DOGFOOD_TERMINALIZE_DISPATCH_ENV_VAR];
  if (value === undefined) return false;
  return TRUTHY_ENV_VALUES.has(value.trim().toLowerCase());
}

/**
 * Resolve which dispatch the bounded `daemon start` workflow lane should use:
 * the unchanged production `baseDispatch` by default, or the
 * terminalize-and-continue wrapper when the dogfood opt-in is set. Returning the
 * exact `baseDispatch` reference when off keeps default `daemon start` behavior
 * provably untouched.
 */
export function resolveDaemonWorkflowDispatch(
  env: Record<string, string | undefined>,
  baseDispatch: WorkflowStepDispatch
): WorkflowStepDispatch {
  return isDogfoodTerminalizeDispatchEnabled(env)
    ? createTerminalizingWorkflowDispatch(baseDispatch)
    : baseDispatch;
}

/**
 * Wrap a base {@link WorkflowStepDispatch} (the production
 * `executeWorkflowStepDispatch`) so a successfully-dispatched step is immediately,
 * safely terminalized — the terminalize-and-continue fixture the NGX-391 dogfood
 * drives through a single daemon loop. The base dispatch's result status is
 * returned unchanged; the terminalization is a durable side effect layered after
 * it, gated on {@link shouldTerminalizeAfterDispatch}.
 */
export function createTerminalizingWorkflowDispatch(
  baseDispatch: WorkflowStepDispatch
): WorkflowStepDispatch {
  return (
    claim: ClaimedWorkflowStep,
    context: WorkflowStepDispatchContext
  ): WorkflowStepDispatchResult => {
    const result = baseDispatch(claim, context);
    if (shouldTerminalizeAfterDispatch(result.status)) {
      terminalizeDispatchedStep(context.db, claim, context.now);
    }
    return result;
  };
}

/**
 * Terminalize a just-dispatched step to `succeeded`, release its dispatch lease,
 * and re-derive the owning run's cached state — all inside one `BEGIN IMMEDIATE`
 * transaction so a mid-write failure can never leave a step succeeded with its
 * lease still held (which would strand the run) or a released lease over a
 * still-running step. Idempotent: a re-entry whose step is already `succeeded`
 * and whose lease is already released is a no-op.
 */
function terminalizeDispatchedStep(
  db: MomentumDb,
  claim: ClaimedWorkflowStep,
  now: number
): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const finished = finishWorkflowStep(db, {
      runId: claim.runId,
      stepId: claim.stepId,
      state: "succeeded",
      resultDigest: `${DOGFOOD_TERMINALIZE_RESULT_DIGEST_PREFIX}::${claim.stepId}`,
      now
    });
    if (!finished.ok) {
      const cause =
        finished.reason === "invalid_transition"
          ? `${finished.reason} from ${finished.from}`
          : finished.reason;
      throw new Error(
        `dogfood terminalize: step ${claim.runId}/${claim.stepId} could not be finished succeeded (${cause}); rolling back so the dispatch lease is not released over a non-terminalized step`
      );
    }
    releaseWorkflowLease(db, {
      runId: claim.lease.runId,
      leaseKind: claim.lease.leaseKind,
      holder: claim.lease.holder,
      acquiredAt: claim.lease.acquiredAt,
      now
    });
    refreshWorkflowRunStateAfterTerminalize(db, claim.runId, now);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Already rolled back / not in a transaction; surface the original error.
    }
    throw error;
  }
}

/**
 * Re-derive `workflow_runs.state` and the monitor advisory columns from the
 * post-terminalization step / lease rows, mirroring the production dispatcher's
 * own post-dispatch refresh so the read-only status / monitor / handoff surfaces
 * agree with the durable step rows.
 */
function refreshWorkflowRunStateAfterTerminalize(
  db: MomentumDb,
  runId: string,
  now: number
): void {
  const steps = loadWorkflowStepRecords(db, runId);
  const leases = loadWorkflowLeaseRecords(db, runId);
  const monitorState = deriveWorkflowMonitorState({
    runId,
    steps,
    leases,
    monitor: null,
    lastCheckpoint: null,
    now
  });
  const finishedAt = monitorState.terminal ? now : null;
  db.prepare(
    `UPDATE workflow_runs
       SET state = ?,
           finished_at = COALESCE(finished_at, ?),
           monitor_last_seen_state = ?,
           monitor_terminal = ?,
           monitor_step = ?,
           monitor_last_seen_digest = NULL,
           monitor_last_emitted_digest = NULL,
           updated_at = ?
     WHERE id = ?`
  ).run(
    monitorState.runState,
    finishedAt,
    monitorState.runState,
    monitorState.terminal ? 1 : 0,
    monitorState.activeStep?.stepId ?? null,
    now,
    runId
  );
}
