import type { MomentumDb } from "../../../adapters/db.js";
import {
  listExecutorDecisionsForRound,
  listExecutorRoundsForInvocation,
  loadExecutorInvocation,
  updateExecutorInvocationState,
  updateExecutorRound,
} from "../../executors/loop/persist.js";
import type { GateDecisionRequest } from "../gate/gate.js";
import {
  insertWorkflowGate,
  loadWorkflowGate,
  resolveWorkflowGate,
  type WorkflowGateRecord,
} from "../gate/persist.js";
import { releaseWorkflowLease } from "../leases.js";
import { refreshWorkflowRunRuntimeState } from "../run/runtime-state.js";
import type { ClaimedWorkflowStep } from "./scheduler.js";

/** Persist an SDK executor's pause as a workflow gate and relinquish dispatch. */
export function parkRegisteredExecutorAtHumanGate(input: {
  db: MomentumDb;
  claim: ClaimedWorkflowStep;
  invocationId: string;
  now: number;
}): WorkflowGateRecord {
  const { db, claim, invocationId, now } = input;
  db.exec("BEGIN IMMEDIATE");
  try {
    const invocation = loadExecutorInvocation(db, invocationId);
    if (invocation?.state !== "waiting_operator") {
      throw new Error(
        `Cannot park registered executor invocation ${invocationId}: expected waiting_operator.`,
      );
    }
    const round = listExecutorRoundsForInvocation(db, invocationId).at(-1);
    if (
      round === undefined ||
      !["waiting_operator", "succeeded", "failed"].includes(round.state) ||
      (round.classification !== "approval_required" &&
        round.classification !== "operator_decision_required") ||
      round.humanGate === null
    ) {
      throw new Error(
        `Cannot park registered executor invocation ${invocationId}: no resumable operator round exists.`,
      );
    }
    const decision = listExecutorDecisionsForRound(db, round.roundId)
      .filter((candidate) => candidate.chosenAction === null)
      .at(-1);
    if (decision === undefined || decision.allowedActions.length === 0) {
      throw new Error(
        `Cannot park registered executor round ${round.roundId}: no unresolved durable decision exists.`,
      );
    }

    const gateId = `${round.roundId}::${decision.decisionId}::gate`;
    const existing = loadWorkflowGate(db, gateId);
    const gate =
      existing ??
      insertWorkflowGate(
        db,
        {
          gateId,
          workflowRunId: round.workflowRunId,
          stepRunId: round.stepRunId,
          invocationId: round.invocationId,
          roundId: round.roundId,
          targetScope: "round",
          gateType: round.humanGate,
          reason: decision.summary,
          evidence: decision.decisionId,
          allowedActions: decision.allowedActions,
          recommendedAction: decision.recommendedAction,
          policyEnvelope: [],
        },
        { now },
      );
    if (gate.resolvedAt !== null) {
      throw new Error(
        `Cannot park registered executor round ${round.roundId}: its gate is already resolved.`,
      );
    }
    const released = releaseWorkflowLease(db, {
      runId: claim.lease.runId,
      leaseKind: claim.lease.leaseKind,
      holder: claim.lease.holder,
      acquiredAt: claim.lease.acquiredAt,
      now,
    });
    if (!released.ok) {
      throw new Error(
        `Cannot park registered executor round ${round.roundId}: dispatch lease ownership was lost.`,
      );
    }
    refreshWorkflowRunRuntimeState(db, { runId: claim.runId, now });
    db.exec("COMMIT");
    return gate;
  } catch (error) {
    safeRollback(db);
    throw error;
  }
}

/** Resolve any workflow gate, resuming its SDK round when it owns one. */
export function resolveWorkflowGateAndResumeRegisteredExecutor(
  db: MomentumDb,
  gateId: string,
  request: GateDecisionRequest,
  options: { now?: number } = {},
): WorkflowGateRecord {
  const now = options.now ?? Date.now();
  db.exec("BEGIN IMMEDIATE");
  try {
    const resolved = resolveWorkflowGate(db, gateId, request, { now });
    if (
      resolved.targetScope === "round" &&
      resolved.invocationId !== null &&
      resolved.roundId !== null &&
      resolved.evidence !== null
    ) {
      const invocation = loadExecutorInvocation(db, resolved.invocationId);
      const round = listExecutorRoundsForInvocation(
        db,
        resolved.invocationId,
      ).find((candidate) => candidate.roundId === resolved.roundId);
      const decision = listExecutorDecisionsForRound(db, resolved.roundId).find(
        (candidate) => candidate.decisionId === resolved.evidence,
      );
      if (
        invocation?.state === "waiting_operator" &&
        round !== undefined &&
        ["waiting_operator", "succeeded", "failed"].includes(round.state) &&
        decision?.chosenAction === null
      ) {
        const updated = db
          .prepare(
            `UPDATE executor_decisions
                SET chosen_action = ?, resolution = ?
              WHERE decision_id = ?
                AND round_id = ?
                AND chosen_action IS NULL`,
          )
          .run(
            resolved.chosenAction,
            resolved.resolution,
            decision.decisionId,
            round.roundId,
          );
        if (Number(updated.changes) === 0) {
          throw new Error(
            `Executor decision ${decision.decisionId} was resolved concurrently.`,
          );
        }
        if (round.state === "waiting_operator") {
          updateExecutorRound(
            db,
            round.roundId,
            {
              toState: "running",
              classification: null,
              executorRecommendation: null,
              recoveryCode: null,
              humanGate: null,
              finishedAt: null,
            },
            { now },
          );
        }
        updateExecutorInvocationState(db, invocation.invocationId, "running", {
          finishedAt: null,
          now,
        });
        refreshWorkflowRunRuntimeState(db, {
          runId: resolved.workflowRunId,
          now,
        });
      }
    }
    db.exec("COMMIT");
    return resolved;
  } catch (error) {
    safeRollback(db);
    throw error;
  }
}

function safeRollback(db: MomentumDb): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // Preserve the original failure when SQLite already closed the transaction.
  }
}
