/**
 * Live-wrapper daemon dispatch composition.
 *
 * The production dispatch lane is assembled from landed, individually-tested seams:
 *
 *   - `dispatch/execute.ts` (`executeWorkflowStepDispatch`) advances a claimed step
 *     `approved -> running`, creates the `<run>::<step>::dispatch` executor
 *     invocation + first round start scaffold, and holds the dispatch lease.
 *   - `dispatch/executor-run.ts` (`executeAndReconcileDispatchedWorkflowStep`) runs
 *     the dispatched step's executor through an injected registry, records the
 *     result as terminal evidence, and lets the reconciliation seam finalize
 *     the step exactly once. It REQUIRES the scaffold to already exist.
 *
 * Nothing in production composed these two in a single daemon tick, so a dispatched
 * step's executor was never run by the daemon: the base dispatch only ever created
 * the scaffold and left the step `running`. This module is that missing composition.
 * It is the production analogue of the test/dogfood `createTerminalizingWorkflowDispatch`
 * (`dispatch/dogfood.ts`): same wrap-the-base-dispatch shape, but it drives the REAL
 * executor registry and finalizes through the reconciliation seam instead of stamping a fake `succeeded`.
 *
 * Boundary discipline (so the reconciliation seam stays the single finalization owner):
 *
 *   - The executor runs only after a dispatch that genuinely started (or re-entered)
 *     a scaffold ({@link shouldRunDispatchedExecutor}) AND the scaffold belongs to
 *     a live-wrapper-owned family. A fail-closed / not-startable base dispatch
 *     already released its lease and either parked the run or wrote nothing, so
 *     this wrapper leaves it untouched and echoes the base result. Adapter-owned
 *     families such as `external-apply` and `subworkflow` are left for their
 *     dedicated dispatch wrappers.
 *   - It returns the base dispatch's result verbatim. Step finalization is a durable
 *     side effect layered after the dispatch, exactly as the dogfood wrapper layers
 *     its terminalization — daemon telemetry still reports the dispatch outcome.
 *   - It never releases the dispatch lease or writes step/executor rows itself:
 *     `executeAndReconcileDispatchedWorkflowStep` terminalizes the evidence and the
 *     the reconciliation seam reconcile seam owns the `running -> terminal` finalization + lease release.
 *   - Idempotent on re-entry: a re-entered tick's base dispatch reports
 *     `alreadyDispatched` and the producer recognises the already-terminal invocation,
 *     so the executor is never run a second time.
 *   - A refused context derivation never throws: the deriver returns a total
 *     {@link DispatchedStepExecutorContextResolution}, and an `ok: false` resolution
 *     is routed to manual recovery (`recordUnresolvedDispatchedStepContext`) instead
 *     of running the executor. Throwing inside the dispatch closure — after the base
 *     dispatch advanced the step to `running` and created the scaffold — would make
 *     the scheduler release the dispatch lease and rethrow (its dispatch contract),
 *     stranding a `running` step with no terminal evidence and no recovery gate.
 *
 * It takes the {@link WorkflowStepExecutorRegistry} and the per-step execution-context
 * deriver by injection: daemon callers resolve the daemon-default live-wrapper
 * profile into a registry (`live-wrapper/daemon-profile.ts`) and derive the run-dir
 * / result / log layout (`live-wrapper/daemon-exec-context.ts`) before handing both to
 * this reusable, registry-agnostic dispatch-lane composition.
 */

import path from "node:path";

import {
  WORKFLOW_EXECUTE_RECONCILE_STATUS,
  executeAndReconcileDispatchedWorkflowStep,
  recordDispatchedStepManualRecovery,
  recordUnresolvedDispatchedStepContext,
  type DispatchedStepExecutorContext,
  type DispatchedStepRepoSafetyContext,
  type ExecuteAndReconcileDispatchedStepResult
} from "./executor-run.js";
import {
  WORKFLOW_DISPATCH_RESULT_STATUS,
  deriveDispatchInvocationId
} from "./execute.js";
import { loadExecutorInvocation } from "../../executors/loop/persist.js";
import {
  isTerminalExecutorInvocationState,
  type ExecutorInvocationState
} from "../../executors/loop/reducer.js";
import { heartbeatWorkflowLease } from "../leases.js";
import {
  acquireRepoLock,
  markRepoLockNeedsManualRecovery,
  releaseRepoLock,
  updateRepoLockHeartbeat
} from "../../repo/locks.js";
import type {
  ClaimedWorkflowStep,
  WorkflowStepDispatch,
  WorkflowStepDispatchContext,
  WorkflowStepDispatchResult
} from "./scheduler.js";
import type { WorkflowStepExecutorRegistry } from "../step/executor.js";

/**
 * The outcome of deriving a dispatched step's execution context. Total so the
 * deriver never has to throw inside the dispatch closure: a refused derivation
 * (`ok: false`) is routed to manual recovery instead — a throw there would make the
 * scheduler release the dispatch lease over a still-`running` step and strand it.
 * The `reason` is preserved as the parked run's recovery evidence. Kept general
 * (`reason: string`) so the wrapper does not couple to the daemon lane's specific
 * refusal codes; the daemon deriver's narrower resolution is assignable to it.
 */
export type DispatchedStepExecutorContextResolution =
  | { ok: true; exec: DispatchedStepExecutorContext }
  | {
      ok: false;
      reason: string;
      /**
       * Optional precise recovery classification (a
       * `WorkflowLiveRunRecoveryCode` string such as `git_failed` or
       * `invalid_input`) preserved on the parked round as `liveRecoveryCode`.
       * Without it the refusal classifies as `runtime_unavailable`, which the
       * retry lane treats as a retryable setup failure - wrong for
       * config/git-safety refusals that need operator or config repair.
       */
      recoveryCode?: string;
    };

/**
 * Derive the per-run/per-step execution context a claimed dispatched step's executor
 * needs (repo path, run dir, result / log paths). Injected so the daemon-lane caller
 * owns the run-dir layout decision; the wrapper forwards a resolved context verbatim
 * into the execution-path producer and routes a refused derivation through manual
 * recovery.
 */
export type DeriveDispatchedStepExecutorContext = (
  claim: ClaimedWorkflowStep,
  context: WorkflowStepDispatchContext
) => DispatchedStepExecutorContextResolution;

/** The injected dependencies the live-wrapper dispatch composition needs. */
export type LiveWrapperWorkflowDispatchDeps = {
  /**
   * The `WorkflowStepExecutor` registry the dispatched step runs through. A
   * configured live-wrapper profile resolves a kind to a real live executor; an
   * unconfigured registry resolves to the honest `runtime_unavailable` adapter so
   * dispatch fails honestly into manual recovery rather than fabricating success.
   */
  registry: WorkflowStepExecutorRegistry;
  /** Derives the executor context for a claimed dispatched step. */
  deriveExec: DeriveDispatchedStepExecutorContext;
  /**
   * Wall-clock source for the lease-freshness check made before each git
   * mutation. The wrapper may run long after the tick's `context.now` was
   * captured, so the check must not reuse that stale timestamp: a lease that
   * expired mid-wrapper has to fail `expires_at >= heartbeat_at` and refuse
   * the mutation instead of being retroactively extended. Defaults to
   * `Date.now`; tests inject their fake tick clock.
   */
  nowMs?: () => number;
};

/**
 * Whether a finished base dispatch is one the live-wrapper lane should run the
 * executor for. Pure: the only input is the dispatcher's own stable status string.
 *
 * Only a dispatch that genuinely started (or re-entered) an executor scaffold has a
 * `running` step, a held lease, and a `<run>::<step>::dispatch` invocation for the
 * producer to execute against and reconcile. A fail-closed dispatch already parked
 * the run for manual recovery and released its lease; a not-startable dispatch wrote
 * nothing and released its lease. Returning `false` for those keeps the wrapper from
 * executing over a parked run or a step that left `approved` under it.
 */
export function shouldRunDispatchedExecutor(status: string): boolean {
  return (
    status === WORKFLOW_DISPATCH_RESULT_STATUS.dispatched ||
    status === WORKFLOW_DISPATCH_RESULT_STATUS.alreadyDispatched
  );
}

/**
 * Wrap a base {@link WorkflowStepDispatch} (the production
 * `executeWorkflowStepDispatch`) so a successfully-dispatched step's executor is
 * run and reconciled in the same tick. The base dispatch creates the scaffold; the
 * wrapper then runs `executeAndReconcileDispatchedWorkflowStep` against it, gated on
 * {@link shouldRunDispatchedExecutor}. The base dispatch's result is returned
 * unchanged; finalization is a durable side effect layered after it (see the module
 * doc for the single-finalization-owner / idempotent-re-entry discipline).
 */
export function createLiveWrapperWorkflowDispatch(
  baseDispatch: WorkflowStepDispatch,
  deps: LiveWrapperWorkflowDispatchDeps
): WorkflowStepDispatch {
  return (
    claim: ClaimedWorkflowStep,
    context: WorkflowStepDispatchContext
  ): WorkflowStepDispatchResult => {
    const result = baseDispatch(claim, context);
    if (!shouldRunDispatchedExecutor(result.status)) return result;
    const invocation = loadExecutorInvocation(
      context.db,
      deriveDispatchInvocationId(claim.runId, claim.stepId)
    );
    if (
      invocation?.executorFamily !== undefined &&
      invocation.executorFamily !== "external-apply" &&
      invocation.executorFamily !== "subworkflow"
    ) {
      const resolved = deps.deriveExec(claim, context);
      if (resolved.ok) {
        const attempt = resolved.exec.attempt ?? invocation.attempt;
        const nowMs = deps.nowMs ?? Date.now;
        const repoLock = acquireDispatchRepoOwnership(
          context,
          claim,
          invocation.state,
          resolved.exec,
          attempt,
          nowMs
        );
        if (!repoLock.ok) {
          // Another holder owns the repository worktree. Momentum's commit
          // stages the whole worktree (`git add -A`), so finalizing here could
          // sweep a concurrent run's changes into this step's commit and
          // fabricate clean terminal evidence for the wrong step. Park
          // honestly instead of mutating a shared worktree.
          recordDispatchedStepManualRecovery({
            db: context.db,
            runId: claim.runId,
            stepId: claim.stepId,
            error: repoLock.error,
            now: context.now,
            status: WORKFLOW_EXECUTE_RECONCILE_STATUS.executionRejected,
            recoveryCode: "repo_lock_lost"
          });
        } else {
          let outcome: ExecuteAndReconcileDispatchedStepResult | undefined;
          try {
            outcome = executeAndReconcileDispatchedWorkflowStep({
              db: context.db,
              runId: claim.runId,
              stepId: claim.stepId,
              registry: deps.registry,
              exec: withAttemptScopedEvidencePaths(
                withDispatchLeaseOwnership(
                  resolved.exec,
                  claim,
                  context,
                  nowMs,
                  repoLock.lockId !== null ? { lockId: repoLock.lockId } : null
                ),
                attempt
              ),
              now: context.now
            });
          } finally {
            if (repoLock.lockId !== null) {
              settleDispatchRepoOwnership(
                context,
                claim,
                repoLock.lockId,
                outcome,
                nowMs()
              );
            }
          }
        }
      } else {
        // The context could not be derived (e.g. the run carries no repo path).
        // Park the run for manual recovery through the same terminalize -> the reconciliation seam
        // reconcile path an unconfigured executor takes, rather than throwing —
        // a throw here would release the lease over a still-running step.
        recordUnresolvedDispatchedStepContext({
          db: context.db,
          runId: claim.runId,
          stepId: claim.stepId,
          reason: resolved.reason,
          now: context.now,
          ...(resolved.recoveryCode !== undefined
            ? { recoveryCode: resolved.recoveryCode }
            : {})
        });
      }
    }
    return result;
  };
}

function withDispatchLeaseOwnership(
  exec: DispatchedStepExecutorContext,
  claim: ClaimedWorkflowStep,
  context: WorkflowStepDispatchContext,
  nowMs: () => number,
  repoLock: { lockId: string } | null
): DispatchedStepExecutorContext {
  if (exec.repoSafety === undefined) return exec;
  const extensionMs = dispatchOwnershipExtensionMs(claim, exec.repoSafety);
  const existing = exec.repoSafety.beforeGitMutation;
  return {
    ...exec,
    repoSafety: {
      ...exec.repoSafety,
      beforeGitMutation: () => {
        const existingCheck = existing?.();
        if (existingCheck?.ok === false) return existingCheck;
        // Heartbeat from the current clock, not the tick's `context.now`: the
        // wrapper ran between the two, and a lease that expired in that window
        // must fail the `expires_at >= heartbeat_at` guard here rather than be
        // extended after the fact while another daemon's stale-lease recovery
        // may already own the run.
        const mutationNow = nowMs();
        const heartbeat = heartbeatWorkflowLease(context.db, {
          runId: claim.lease.runId,
          leaseKind: claim.lease.leaseKind,
          holder: claim.lease.holder,
          acquiredAt: claim.lease.acquiredAt,
          heartbeatAt: mutationNow,
          expiresAt: mutationNow + extensionMs
        });
        if (!heartbeat.ok) {
          return {
            ok: false,
            error: `dispatch lease for ${claim.runId}/${claim.stepId} is no longer held by ${claim.lease.holder}`
          };
        }
        if (repoLock !== null) {
          const lockBeat = updateRepoLockHeartbeat(context.db, {
            lockId: repoLock.lockId,
            heartbeatAt: mutationNow,
            leaseExpiresAt: mutationNow + extensionMs
          });
          if (!lockBeat.ok) {
            return {
              ok: false,
              error: `repo lock for ${claim.runId}/${claim.stepId} is no longer active; refusing git mutation over a worktree Momentum may not own`
            };
          }
        }
        return { ok: true };
      }
    }
  };
}

/**
 * The ownership extension window for one dispatched execution: the claim's own
 * lease duration plus the worst-case verification window, so ownership held
 * across a long verification does not expire mid-finalization.
 */
function dispatchOwnershipExtensionMs(
  claim: ClaimedWorkflowStep,
  repoSafety: DispatchedStepRepoSafetyContext
): number {
  const leaseDurationMs = Math.max(
    1,
    claim.lease.expiresAt - claim.lease.acquiredAt
  );
  const verificationWindowMs =
    Math.max(1, repoSafety.verificationCommands.length) *
    repoSafety.verificationTimeoutSec *
    1000;
  return leaseDurationMs + verificationWindowMs;
}

type DispatchRepoOwnership =
  | { ok: true; lockId: string | null }
  | { ok: false; error: string };

/**
 * Take the exclusive repo lock for a dispatched execution that will finalize
 * git state. The dispatch lease is scoped per run, but the worktree is shared
 * per repository: without a repo-scoped guard, two runs against the same
 * `repoPath` could execute concurrently and Momentum's whole-worktree commit
 * (`git add -A`) could sweep the other run's changes into this step's
 * evidence.
 *
 * No lock is taken (`lockId: null`) when Momentum will not mutate git for this
 * execution: no repo-safety context, or an already-terminal invocation whose
 * re-entry only re-drives reconciliation and never re-runs the executor.
 *
 * The goal-era `repo_locks` columns carry workflow identities here (`goal_id`
 * = run id, `job_id` = dispatch invocation id, `iteration` = attempt): the
 * table's active-per-repo-root unique index is the exclusion primitive, and
 * daemon stale-lock recovery already owns expiring crashed holders.
 */
function acquireDispatchRepoOwnership(
  context: WorkflowStepDispatchContext,
  claim: ClaimedWorkflowStep,
  invocationState: ExecutorInvocationState,
  exec: DispatchedStepExecutorContext,
  attempt: number,
  nowMs: () => number
): DispatchRepoOwnership {
  if (exec.repoSafety === undefined) return { ok: true, lockId: null };
  if (isTerminalExecutorInvocationState(invocationState)) {
    return { ok: true, lockId: null };
  }
  const acquiredNow = nowMs();
  const acquired = acquireRepoLock(context.db, {
    repoRoot: exec.repoPath,
    holder: context.workerId,
    goalId: claim.runId,
    iteration: attempt,
    jobId: deriveDispatchInvocationId(claim.runId, claim.stepId),
    leaseExpiresAt:
      acquiredNow + dispatchOwnershipExtensionMs(claim, exec.repoSafety),
    now: acquiredNow
  });
  if (acquired.ok) return { ok: true, lockId: acquired.lockId };
  return {
    ok: false,
    error: `repository ${exec.repoPath} is locked by ${acquired.existing.holder} (run ${acquired.existing.goal_id}, ${acquired.existing.job_id}); refusing to execute and finalize ${claim.runId}/${claim.stepId} over a shared worktree`
  };
}

/**
 * Settle the repo lock after a dispatched execution. Releasing is only safe
 * when the worktree state is PROVEN clean: the executor never ran this tick,
 * or finalization ended in a clean terminal (`succeeded` = committed;
 * `failed` = reset proven or nothing to commit). Every other outcome - a
 * process-level wrapper failure, an untrusted result document, a moved HEAD,
 * a failed reset, lost ownership, or an unexpected `skipped` terminal - may
 * leave the wrapper's uncommitted edits in the worktree, so the lock is
 * marked `needs_manual_recovery` instead: it keeps blocking other runs (whose
 * whole-worktree `git add -A` commit would sweep the leftovers into their
 * evidence) until the operator inspects the repository. The mark only touches
 * a still-`active` lock, so ownership already lost or re-marked by stale-lock
 * recovery is never clobbered back to `released`.
 */
function settleDispatchRepoOwnership(
  context: WorkflowStepDispatchContext,
  claim: ClaimedWorkflowStep,
  lockId: string,
  outcome: ExecuteAndReconcileDispatchedStepResult | undefined,
  now: number
): void {
  const executorRanThisTick =
    outcome !== undefined &&
    outcome.status !== WORKFLOW_EXECUTE_RECONCILE_STATUS.notDispatched &&
    outcome.status !== WORKFLOW_EXECUTE_RECONCILE_STATUS.stepNotFound &&
    outcome.status !== WORKFLOW_EXECUTE_RECONCILE_STATUS.stepNotRunning;
  // Judge the worktree by the POST-finalization result: a wrapper can report
  // `succeeded` while finalization refused to commit or reset over it.
  const finalized = outcome?.finalizedResult;
  const provenClean =
    outcome !== undefined &&
    (!executorRanThisTick ||
      (finalized !== undefined &&
        finalized.ok &&
        (finalized.result.state === "succeeded" ||
          finalized.result.state === "failed")));
  if (provenClean) {
    releaseRepoLock(context.db, { lockId, now });
    return;
  }
  markRepoLockNeedsManualRecovery(context.db, {
    lockId,
    now,
    recoveryStatus: `dispatched step ${claim.runId}/${claim.stepId} parked with an unproven worktree; inspect the repository before clearing`
  });
}

function withAttemptScopedEvidencePaths(
  exec: DispatchedStepExecutorContext,
  attempt: number
): DispatchedStepExecutorContext {
  if (attempt <= 1) {
    return { ...exec, attempt };
  }
  const runDir = path.join(exec.runDir, `attempt-${attempt}`);
  return {
    ...exec,
    attempt,
    runDir,
    resultJsonPath: path.join(runDir, path.basename(exec.resultJsonPath)),
    executorLogPath: path.join(runDir, path.basename(exec.executorLogPath)),
    ...(exec.repoSafety !== undefined
      ? { repoSafety: withAttemptScopedRepoSafety(exec.repoSafety, runDir) }
      : {})
  };
}

function withAttemptScopedRepoSafety(
  repoSafety: DispatchedStepRepoSafetyContext,
  runDir: string
): DispatchedStepRepoSafetyContext {
  return {
    ...repoSafety,
    verificationLogPath: path.join(
      runDir,
      path.basename(repoSafety.verificationLogPath)
    )
  };
}
