import type { MomentumDb } from "../../../adapters/db.js";
import {
  listExecutorCheckpointsForRound,
  listExecutorDecisionsForRound,
  listExecutorRoundsForAttempt,
  loadExecutorAttempt,
  updateExecutorAttemptState,
  updateExecutorRound,
} from "../../executors/loop/persist.js";
import { selectExecutorDecisionForHumanGate } from "../../executors/loop/reducer.js";
import { EXECUTOR_HUMAN_GATE_DECISION_CHECKPOINT_STAGE } from "../../executors/sdk/types.js";
import type { GateDecisionRequest } from "../gate/gate.js";
import {
  insertWorkflowGate,
  loadWorkflowGate,
  resolveWorkflowGate,
  type WorkflowGateRecord,
} from "../gate/persist.js";
import { getWorkflowLease, releaseWorkflowLease } from "../leases.js";
import { classifyWorkflowLease } from "../run/reducer.js";
import { refreshWorkflowRunRuntimeState } from "../run/runtime-state.js";
import type { ClaimedWorkflowStep } from "./scheduler.js";

/** Persist an SDK executor's pause as a workflow gate and relinquish dispatch. */
export function parkRegisteredExecutorAtHumanGate(input: {
  db: MomentumDb;
  claim: ClaimedWorkflowStep;
  attemptId: string;
  decisionId?: string | null;
  now: number;
  requireStaleLeaseAt?: { now: number; graceMs: number };
}): WorkflowGateRecord {
  const { db, claim, attemptId, now } = input;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (input.requireStaleLeaseAt !== undefined) {
      const lease = getWorkflowLease(
        db,
        claim.lease.runId,
        claim.lease.leaseKind,
      );
      if (
        lease === undefined ||
        lease.holder !== claim.lease.holder ||
        lease.acquiredAt !== claim.lease.acquiredAt ||
        classifyWorkflowLease(lease, input.requireStaleLeaseAt) !==
          "stale-auto-release"
      ) {
        throw new Error(
          `Cannot recover registered executor attempt ${attemptId}: dispatch lease is no longer stale.`,
        );
      }
    }
    const attempt = loadExecutorAttempt(db, attemptId);
    if (attempt?.state !== "waiting_operator") {
      throw new Error(
        `Cannot park registered executor attempt ${attemptId}: expected waiting_operator.`,
      );
    }
    const round = listExecutorRoundsForAttempt(db, attemptId).at(-1);
    if (
      round === undefined ||
      !["waiting_operator", "succeeded", "failed"].includes(round.state) ||
      (round.classification !== "approval_required" &&
        round.classification !== "operator_decision_required") ||
      round.humanGate === null
    ) {
      throw new Error(
        `Cannot park registered executor attempt ${attemptId}: no resumable operator round exists.`,
      );
    }
    const decision = selectExecutorDecisionForHumanGate(
      listExecutorDecisionsForRound(db, round.roundId),
      resolveHumanGateDecisionId(db, round.roundId, input.decisionId),
    );
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
          attemptId: round.attemptId,
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

function resolveHumanGateDecisionId(
  db: MomentumDb,
  roundId: string,
  decisionId: string | null | undefined,
): string | null | undefined {
  if (decisionId !== undefined) return decisionId;
  const checkpoint = listExecutorCheckpointsForRound(db, roundId)
    .filter(
      (candidate) =>
        candidate.stage === EXECUTOR_HUMAN_GATE_DECISION_CHECKPOINT_STAGE,
    )
    .at(-1);
  if (checkpoint === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(checkpoint.detail ?? "null") as unknown;
  } catch {
    throw new Error(
      `Cannot park registered executor round ${roundId}: its durable gate decision selector is invalid.`,
    );
  }
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    const selected = (parsed as Record<string, unknown>)["decisionId"];
    if (selected === null) return null;
    if (typeof selected === "string" && selected.length > 0) return selected;
  }
  throw new Error(
    `Cannot park registered executor round ${roundId}: its durable gate decision selector is invalid.`,
  );
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
      resolved.attemptId !== null &&
      resolved.roundId !== null &&
      resolved.evidence !== null
    ) {
      const attempt = loadExecutorAttempt(db, resolved.attemptId);
      const round = listExecutorRoundsForAttempt(
        db,
        resolved.attemptId,
      ).find((candidate) => candidate.roundId === resolved.roundId);
      const decision = listExecutorDecisionsForRound(db, resolved.roundId).find(
        (candidate) => candidate.decisionId === resolved.evidence,
      );
      if (
        attempt?.state === "waiting_operator" &&
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
        updateExecutorAttemptState(db, attempt.attemptId, "running", {
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
