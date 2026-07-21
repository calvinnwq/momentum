import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import {
  GOAL_LOOP_GLOBAL_DEFAULT_SELECTION,
  decideGoalLoopRound,
  resolveGoalLoopRoundSelection,
} from "../src/core/executors/goal-loop/executor.js";
import {
  insertExecutorAttempt,
  insertExecutorRound,
  listExecutorArtifactsForRound,
  listExecutorCheckpointsForRound,
  listExecutorDecisionsForRound,
  listExecutorFindingsForRound,
  loadExecutorAttempt,
  loadExecutorRound,
  updateExecutorAttemptState,
} from "../src/core/executors/loop/persist.js";
import type {
  ExecutorAttemptRecord,
  ExecutorRoundRecord,
} from "../src/core/executors/loop/reducer.js";
import type { RunnerResult } from "../src/core/executors/runner/types.js";
import { createDurableExecutorEnvelope } from "../src/core/executors/sdk/envelope.js";
import { driveExecutorTicks } from "../src/core/executors/sdk/driver.js";
import type {
  Executor,
  ExecutorConfigSchema,
  ExecutorRoundStart,
  ExecutorTickContext,
  ExecutorTickResult,
} from "../src/core/executors/sdk/types.js";
import {
  AGENT_ONCE_EXECUTOR_CONFIG_SCHEMA,
  SCRIPT_EXECUTOR_CONFIG_SCHEMA,
  SingleShotExecutor,
  type SingleShotExecutorConfig,
  type SingleShotExecutorHostBindings,
} from "../src/core/executors/single-shot/sdk.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function openExecutorDb(family: ExecutorAttemptRecord["executorFamily"]): {
  db: MomentumDb;
  attempt: ExecutorAttemptRecord;
} {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "momentum-executor-sdk-")),
  );
  tempRoots.push(root);
  const db = openDb(root);
  db.prepare(
    "INSERT INTO workflow_runs (id, source, created_at, updated_at) VALUES ('run-1', 'test', 1, 1)",
  ).run();
  db.prepare(
    `INSERT INTO workflow_steps (run_id, step_id, kind, step_order, created_at, updated_at)
       VALUES ('run-1', 'step-1', 'implementation', 0, 1, 1)`,
  ).run();
  const attempt: ExecutorAttemptRecord = {
    attemptId: `inv-${family}`,
    workflowRunId: "run-1",
    stepRunId: "step-1",
    stepKey: "implementation",
    executorFamily: family,
    state: "running",
    attemptNumber: 1,
    startedAt: 1,
    heartbeatAt: 1,
    finishedAt: null,
  };
  insertExecutorAttempt(db, attempt, { now: 1 });
  return { db, attempt };
}

function emptyRound(
  attempt: ExecutorAttemptRecord,
  state: ExecutorRoundRecord["state"],
): ExecutorRoundRecord {
  return {
    roundId: `${attempt.attemptId}::round::0`,
    attemptId: attempt.attemptId,
    workflowRunId: attempt.workflowRunId,
    stepRunId: attempt.stepRunId,
    stepKey: attempt.stepKey,
    executorFamily: attempt.executorFamily,
    attemptNumber: attempt.attemptNumber,
    roundIndex: 0,
    state,
    classification: null,
    startedAt: 10,
    heartbeatAt: 10,
    finishedAt: null,
    agentProvider: null,
    model: null,
    effort: null,
    inputDigest: null,
    resultDigest: null,
    artifactRoot: "/artifacts/round-0",
    logPaths: [],
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

const SUPERVISOR_SCHEMA = {
  type: "object",
  properties: {
    tool: { type: "string", minLength: 1 },
    pollIntervalMs: { type: "integer", minimum: 1 },
  },
  required: ["tool"],
  additionalProperties: false,
} as const satisfies ExecutorConfigSchema;

class PollingSupervisor implements Executor<
  { tool: string; pollIntervalMs?: number },
  Record<never, never>
> {
  readonly name = "polling-supervisor";
  readonly configSchema = SUPERVISOR_SCHEMA;

  tick(
    context: ExecutorTickContext<
      { tool: string; pollIntervalMs?: number },
      Record<never, never>
    >,
  ): ExecutorTickResult {
    const round = emptyRound(
      context.state.attempt as ExecutorAttemptRecord,
      "mirroring_external_state",
    );
    context.envelope.startRound(roundStartForSdk(round));
    context.envelope.recordArtifact(round.roundId, {
      artifactId: `${round.roundId}-external-state`,
      artifactClass: "result_document",
      path: `/evidence/${context.config.tool}.json`,
      digest: "sha256:external",
      description: "mirrored external state",
    });
    context.envelope.recordCheckpoint(round.roundId, {
      checkpointId: `${round.roundId}-checkpoint-0`,
      sequence: 0,
      stage: "external_state_polled",
      detail: null,
    });
    context.envelope.recordFinding(round.roundId, {
      findingId: `${round.roundId}-finding-1`,
      severity: "high",
      title: "Review requires a choice",
      detail: null,
      selected: false,
      externalRef: "finding-1",
    });
    context.envelope.recordDecision(round.roundId, {
      decisionId: `${round.roundId}-decision-1`,
      summary: "Choose whether to apply the finding",
      allowedActions: ["apply", "ignore"],
      recommendedAction: "apply",
      chosenAction: null,
      resolution: null,
      externalRef: "decision-1",
    });
    return {
      roundId: round.roundId,
      recommendation: "operator_decision_required",
      recommendedRoundState: "waiting_operator",
      recommendedAttemptState: "waiting_operator",
      recoveryCode: null,
      humanGate: "operator_decision_required",
      reason: "the mirrored tool state requires an operator choice",
    };
  }
}

describe("executor SDK core contract", () => {
  it.each([
    {
      label: "blank allowed actions",
      allowedActions: [" "],
      recommendedAction: null,
    },
    {
      label: "a recommendation outside the allowed actions",
      allowedActions: ["apply"],
      recommendedAction: "ignore",
    },
  ])(
    "settles a human gate with $label as executor_contract_invalid",
    async ({ allowedActions, recommendedAction }) => {
      const { db, attempt } = openExecutorDb("one-shot");
      const result = await driveExecutorTicks({
        db,
        attemptId: attempt.attemptId,
        executor: {
          name: "one-shot",
          configSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          tick(context) {
            const round = emptyRound(attempt, "mirroring_external_state");
            context.envelope.startRound(roundStartForSdk(round));
            context.envelope.recordDecision(round.roundId, {
              decisionId: `${round.roundId}-decision`,
              summary: "Choose how to continue",
              allowedActions,
              recommendedAction,
              chosenAction: null,
              resolution: null,
              externalRef: null,
            });
            return {
              roundId: round.roundId,
              recommendation: "operator_decision_required",
              recommendedRoundState: "waiting_operator",
              recommendedAttemptState: "waiting_operator",
              recoveryCode: null,
              humanGate: "operator_decision_required",
              reason: "An operator decision is required.",
            };
          },
        },
        config: {},
        hostBindings: {},
        now: () => 20,
      });

      expect(result.attempt.state).toBe("manual_recovery_required");
      expect(result.lastRound).toMatchObject({
        state: "manual_recovery_required",
        recoveryCode: "executor_contract_invalid",
      });
    },
  );

  it("fits a poll-per-tick supervisor using only the durable envelope facade", () => {
    const { db, attempt } = openExecutorDb("no-mistakes");
    const envelope = createDurableExecutorEnvelope({
      db,
      attemptId: attempt.attemptId,
      now: () => 20,
    });
    const executor: Executor<
      { tool: string; pollIntervalMs?: number },
      Record<never, never>
    > = new PollingSupervisor();

    const recommendation = executor.tick({
      state: envelope.snapshot(),
      config: { tool: "review-pipeline", pollIntervalMs: 1_000 },
      hostBindings: {},
      envelope: envelope.facade,
      signal: new AbortController().signal,
    });
    expect(recommendation).not.toBeInstanceOf(Promise);
    const tick = recommendation as ExecutorTickResult;

    // The executor recorded observations and evidence but did not classify.
    const beforeDecision = loadExecutorRound(db, tick.roundId);
    expect(beforeDecision?.state).toBe("mirroring_external_state");
    expect(beforeDecision?.classification).toBeNull();
    expect(beforeDecision?.executorRecommendation).toBeNull();
    expect(loadExecutorAttempt(db, attempt.attemptId)?.state).toBe("running");

    envelope.applyDaemonDecision(
      {
        roundId: tick.roundId,
        classification: tick.recommendation,
        executorRecommendation: tick.recommendation,
        roundState: tick.recommendedRoundState,
        attemptState: tick.recommendedAttemptState,
        recoveryCode: tick.recoveryCode,
        humanGate: tick.humanGate,
      },
      { classificationCheckpoint: daemonCheckpoint(tick.roundId, 1) },
    );

    const snapshot = envelope.snapshot();
    expect(snapshot.attempt.state).toBe("waiting_operator");
    expect(snapshot.currentRound?.round.classification).toBe(
      "operator_decision_required",
    );
    expect(snapshot.currentRound?.artifacts).toHaveLength(1);
    expect(
      snapshot.currentRound?.checkpoints.map((checkpoint) => checkpoint.stage),
    ).toEqual(["external_state_polled", "classified"]);
    expect(snapshot.currentRound?.findings).toHaveLength(1);
    expect(snapshot.currentRound?.decisions).toHaveLength(1);
  });

  it("passes executors a frozen facade without daemon decision authority", () => {
    const { db, attempt } = openExecutorDb("one-shot");
    const envelope = createDurableExecutorEnvelope({
      db,
      attemptId: attempt.attemptId,
    });

    expect(Object.isFrozen(envelope.facade)).toBe(true);
    expect(Object.keys(envelope.facade).sort()).toEqual([
      "heartbeat",
      "observeRound",
      "recordArtifact",
      "recordCheckpoint",
      "recordDecision",
      "recordFinding",
      "recordRoundProgress",
      "snapshot",
      "startRound",
    ]);
    expect(
      (envelope.facade as unknown as Record<string, unknown>)[
        "applyDaemonDecision"
      ],
    ).toBeUndefined();
  });

  it("revokes every executor write while the attempt waits for an operator", () => {
    const { db, attempt } = openExecutorDb("one-shot");
    const envelope = createDurableExecutorEnvelope({
      db,
      attemptId: attempt.attemptId,
      now: () => 25,
    });
    const round = emptyRound(attempt, "running");
    envelope.facade.startRound(roundStartForSdk(round));
    envelope.applyDaemonDecision(
      {
        roundId: round.roundId,
        classification: "operator_decision_required",
        executorRecommendation: "operator_decision_required",
        roundState: "waiting_operator",
        attemptState: "waiting_operator",
        recoveryCode: null,
        humanGate: "operator_decision_required",
      },
      { classificationCheckpoint: daemonCheckpoint(round.roundId, 0) },
    );

    const writes = [
      () => envelope.facade.heartbeat(),
      () => envelope.facade.observeRound(round.roundId, { phase: "running" }),
      () =>
        envelope.facade.recordArtifact(round.roundId, {
          artifactId: "paused-artifact",
          artifactClass: "logs",
          path: "/paused.log",
          digest: null,
          description: null,
        }),
      () =>
        envelope.facade.recordCheckpoint(round.roundId, {
          checkpointId: "paused-checkpoint",
          sequence: 1,
          stage: "paused",
          detail: null,
        }),
    ];

    for (const write of writes) {
      expect(write).toThrow("not executor-writable (waiting_operator)");
    }
    expect(loadExecutorAttempt(db, attempt.attemptId)?.state).toBe(
      "waiting_operator",
    );
    expect(loadExecutorRound(db, round.roundId)?.state).toBe(
      "waiting_operator",
    );
  });

  it("enforces observation-only state authority at runtime", () => {
    const { db, attempt } = openExecutorDb("one-shot");
    const envelope = createDurableExecutorEnvelope({
      db,
      attemptId: attempt.attemptId,
      now: () => 25,
    });
    const round = emptyRound(attempt, "running");
    const start = roundStartForSdk(round);

    expect(() =>
      envelope.facade.startRound({
        ...start,
        state: "cancelled",
      } as unknown as Parameters<typeof envelope.facade.startRound>[0]),
    ).toThrow("observation phase");
    expect(loadExecutorRound(db, round.roundId)).toBeUndefined();

    envelope.facade.startRound(start);
    const observed = envelope.facade.observeRound(round.roundId, {
      phase: "mirroring_external_state",
      summary: "bounded progress",
      toState: "cancelled",
      classification: "complete",
      executorRecommendation: "complete",
      finishedAt: 25,
      recoveryCode: "runtime_unavailable",
      humanGate: "manual_recovery_required",
    } as unknown as Parameters<typeof envelope.facade.observeRound>[1]);
    expect(observed).toMatchObject({
      state: "mirroring_external_state",
      summary: "bounded progress",
      classification: null,
      executorRecommendation: null,
      finishedAt: null,
      recoveryCode: null,
      humanGate: null,
    });

    expect(() =>
      envelope.facade.observeRound(round.roundId, {
        phase: "succeeded",
      } as unknown as Parameters<typeof envelope.facade.observeRound>[1]),
    ).toThrow("observation phase");
    expect(loadExecutorRound(db, round.roundId)?.state).toBe(
      "mirroring_external_state",
    );
  });

  it("uses the envelope clock for executor round timestamps", () => {
    const { db, attempt } = openExecutorDb("one-shot");
    let clockCalls = 0;
    const envelope = createDurableExecutorEnvelope({
      db,
      attemptId: attempt.attemptId,
      now: () => {
        clockCalls += 1;
        return 25;
      },
    });
    const round = emptyRound(attempt, "running");
    const hostileStart = {
      ...roundStartForSdk(round),
      startedAt: Number.MAX_SAFE_INTEGER,
      heartbeatAt: Number.MAX_SAFE_INTEGER,
    } as unknown as ExecutorRoundStart;

    const started = envelope.facade.startRound(hostileStart);

    expect(started).toMatchObject({ startedAt: 25, heartbeatAt: 25 });
    expect(loadExecutorRound(db, round.roundId)).toMatchObject({
      startedAt: 25,
      heartbeatAt: 25,
    });
    expect(clockCalls).toBe(1);
  });

  it("rejects malformed round starts and observations without coercion", () => {
    const { db, attempt } = openExecutorDb("one-shot");
    const envelope = createDurableExecutorEnvelope({
      db,
      attemptId: attempt.attemptId,
      now: () => 25,
    });
    const round = emptyRound(attempt, "running");

    expect(() =>
      envelope.facade.startRound({
        ...roundStartForSdk(round),
        logPaths: "/tmp/executor.log",
      } as unknown as ExecutorRoundStart),
    ).toThrow("round start logPaths must be an array of strings");
    expect(loadExecutorRound(db, round.roundId)).toBeUndefined();

    envelope.facade.startRound(roundStartForSdk(round));
    expect(() =>
      envelope.facade.observeRound(round.roundId, {
        changedFiles: "src/index.ts",
      } as unknown as Parameters<typeof envelope.facade.observeRound>[1]),
    ).toThrow("round observation changedFiles must be an array of strings");
    expect(loadExecutorRound(db, round.roundId)?.changedFiles).toEqual([]);
  });

  it("rejects malformed progress and child evidence before any durable write", () => {
    const { db, attempt } = openExecutorDb("one-shot");
    const envelope = createDurableExecutorEnvelope({
      db,
      attemptId: attempt.attemptId,
      now: () => 25,
    });
    const round = emptyRound(attempt, "mirroring_external_state");
    envelope.facade.startRound(roundStartForSdk(round));

    expect(() =>
      envelope.facade.recordRoundProgress(round.roundId, {
        observation: { summary: "must not persist" },
        checkpoints: [
          {
            checkpointId: "bad-sequence",
            sequence: 0.5,
            stage: "captured",
            detail: null,
          },
        ],
      }),
    ).toThrow("checkpoint sequence must be a non-negative integer");
    expect(loadExecutorRound(db, round.roundId)?.summary).toBeNull();

    expect(() =>
      envelope.facade.recordArtifact(round.roundId, {
        artifactId: "artifact",
        artifactClass: "logs",
        path: 42,
        digest: null,
        description: null,
      } as unknown as Parameters<typeof envelope.facade.recordArtifact>[1]),
    ).toThrow("artifact path must be a non-empty string");
    expect(() =>
      envelope.facade.recordCheckpoint(round.roundId, {
        checkpointId: "checkpoint",
        sequence: -1,
        stage: "captured",
        detail: null,
      }),
    ).toThrow("checkpoint sequence must be a non-negative integer");
    expect(() =>
      envelope.facade.recordFinding(round.roundId, {
        findingId: "finding",
        severity: null,
        title: "finding",
        detail: null,
        selected: "false",
        externalRef: null,
      } as unknown as Parameters<typeof envelope.facade.recordFinding>[1]),
    ).toThrow("finding selected must be a boolean");
    expect(() =>
      envelope.facade.recordDecision(round.roundId, {
        decisionId: "decision",
        summary: "decision",
        allowedActions: "apply",
        recommendedAction: null,
        chosenAction: null,
        resolution: null,
      } as unknown as Parameters<typeof envelope.facade.recordDecision>[1]),
    ).toThrow("decision allowedActions must be an array of strings");

    expect(listExecutorArtifactsForRound(db, round.roundId)).toEqual([]);
    expect(listExecutorCheckpointsForRound(db, round.roundId)).toEqual([]);
    expect(listExecutorFindingsForRound(db, round.roundId)).toEqual([]);
    expect(listExecutorDecisionsForRound(db, round.roundId)).toEqual([]);
  });

  it("atomically records a round observation with its checkpoint batch", () => {
    const { db, attempt } = openExecutorDb("one-shot");
    const envelope = createDurableExecutorEnvelope({
      db,
      attemptId: attempt.attemptId,
      now: () => 25,
    });
    const round = emptyRound(attempt, "running");
    envelope.facade.startRound(roundStartForSdk(round));
    envelope.facade.recordCheckpoint(round.roundId, {
      checkpointId: "existing-checkpoint",
      sequence: 0,
      stage: "existing",
      detail: null,
    });

    expect(() =>
      envelope.facade.recordRoundProgress(round.roundId, {
        observation: {
          phase: "capturing_result",
          summary: "must roll back",
        },
        checkpoints: [
          {
            checkpointId: "new-checkpoint",
            sequence: 1,
            stage: "mechanism_completed",
            detail: "outcome: ok",
          },
          {
            checkpointId: "existing-checkpoint",
            sequence: 2,
            stage: "result_captured",
            detail: null,
          },
        ],
      }),
    ).toThrow();

    expect(loadExecutorRound(db, round.roundId)).toMatchObject({
      state: "mirroring_external_state",
      summary: null,
    });
    expect(listExecutorCheckpointsForRound(db, round.roundId)).toMatchObject([
      { checkpointId: "existing-checkpoint", sequence: 0 },
    ]);
  });

  it("rejects a second round while its predecessor is active", () => {
    const { db, attempt } = openExecutorDb("one-shot");
    const envelope = createDurableExecutorEnvelope({
      db,
      attemptId: attempt.attemptId,
    });
    envelope.facade.startRound(
      roundStartForSdk(emptyRound(attempt, "running")),
    );
    const second = {
      ...emptyRound(attempt, "running"),
      roundId: `${attempt.attemptId}::round::1`,
      roundIndex: 1,
    };

    expect(() => envelope.facade.startRound(roundStartForSdk(second))).toThrow(
      "previous round",
    );
    expect(loadExecutorRound(db, second.roundId)).toBeUndefined();
  });

  it("rejects gapped indexes and attempt identity mismatches", () => {
    const { db, attempt } = openExecutorDb("one-shot");
    const envelope = createDurableExecutorEnvelope({
      db,
      attemptId: attempt.attemptId,
    });
    const gapped = {
      ...emptyRound(attempt, "running"),
      roundIndex: 1,
    };
    const mismatched = {
      ...emptyRound(attempt, "running"),
      stepKey: "another-step",
    };

    expect(() => envelope.facade.startRound(roundStartForSdk(gapped))).toThrow(
      "expected roundIndex 0",
    );
    expect(() =>
      envelope.facade.startRound(roundStartForSdk(mismatched)),
    ).toThrow("stepKey");
    expect(loadExecutorRound(db, gapped.roundId)).toBeUndefined();
  });

  it("continues migrated one-based round indexes at max plus one", () => {
    // Migrated SDK-05 dispatch rounds are 1-based, so the next expected index
    // is max(roundIndex) + 1 across the step, never the round count.
    const { db, attempt } = openExecutorDb("one-shot");
    insertExecutorRound(db, {
      ...emptyRound(attempt, "manual_recovery_required"),
      roundId: `${attempt.attemptId}::round-1`,
      roundIndex: 1,
      classification: "manual_recovery_required",
      recoveryCode: "executor_threw",
      humanGate: "manual_recovery_required",
      finishedAt: 20,
    });
    const envelope = createDurableExecutorEnvelope({
      db,
      attemptId: attempt.attemptId,
    });
    const duplicate = {
      ...emptyRound(attempt, "running"),
      roundId: `${attempt.attemptId}::round::1`,
      roundIndex: 1,
    };
    expect(() =>
      envelope.facade.startRound(roundStartForSdk(duplicate)),
    ).toThrow("expected roundIndex 2");
    const next = {
      ...emptyRound(attempt, "running"),
      roundId: `${attempt.attemptId}::round::2`,
      roundIndex: 2,
    };
    expect(envelope.facade.startRound(roundStartForSdk(next)).roundIndex).toBe(
      2,
    );
  });

  it("rejects every executor evidence path after a round becomes terminal", () => {
    const { db, attempt } = openExecutorDb("one-shot");
    const envelope = createDurableExecutorEnvelope({
      db,
      attemptId: attempt.attemptId,
      now: () => 30,
    });
    const round = emptyRound(attempt, "mirroring_external_state");
    envelope.facade.startRound(roundStartForSdk(round));
    envelope.applyDaemonDecision(
      {
        roundId: round.roundId,
        classification: "continue",
        executorRecommendation: "continue",
        roundState: "succeeded",
        attemptState: "running",
        recoveryCode: null,
        humanGate: null,
      },
      { classificationCheckpoint: daemonCheckpoint(round.roundId, 0) },
    );

    const writes = [
      () => envelope.facade.observeRound(round.roundId, { summary: "late" }),
      () =>
        envelope.facade.recordArtifact(round.roundId, {
          artifactId: "late-artifact",
          artifactClass: "logs",
          path: "/late.log",
          digest: null,
          description: null,
        }),
      () =>
        envelope.facade.recordCheckpoint(round.roundId, {
          checkpointId: "late-checkpoint",
          sequence: 0,
          stage: "late",
          detail: null,
        }),
      () =>
        envelope.facade.recordFinding(round.roundId, {
          findingId: "late-finding",
          severity: "high",
          title: "late",
          detail: null,
          selected: false,
          externalRef: null,
        }),
      () =>
        envelope.facade.recordDecision(round.roundId, {
          decisionId: "late-decision",
          summary: "late",
          allowedActions: [],
          recommendedAction: null,
          chosenAction: null,
          resolution: null,
          externalRef: null,
        }),
    ];

    for (const write of writes) {
      expect(write).toThrow("terminal round");
    }
  });

  it("rejects every executor write after the attempt becomes terminal", () => {
    const { db, attempt } = openExecutorDb("one-shot");
    const envelope = createDurableExecutorEnvelope({
      db,
      attemptId: attempt.attemptId,
      now: () => 30,
    });
    const round = emptyRound(attempt, "running");
    envelope.facade.startRound(roundStartForSdk(round));
    updateExecutorAttemptState(db, attempt.attemptId, "succeeded", {
      finishedAt: 25,
      now: 25,
    });

    const writes = [
      () =>
        envelope.facade.startRound(
          roundStartForSdk({
            ...round,
            roundId: `${attempt.attemptId}::round::1`,
            roundIndex: 1,
          }),
        ),
      () => envelope.facade.observeRound(round.roundId, { summary: "late" }),
      () =>
        envelope.facade.recordArtifact(round.roundId, {
          artifactId: "late-artifact",
          artifactClass: "logs",
          path: "/late.log",
          digest: null,
          description: null,
        }),
      () =>
        envelope.facade.recordCheckpoint(round.roundId, {
          checkpointId: "late-checkpoint",
          sequence: 0,
          stage: "late",
          detail: null,
        }),
      () =>
        envelope.facade.recordFinding(round.roundId, {
          findingId: "late-finding",
          severity: "high",
          title: "late",
          detail: null,
          selected: false,
          externalRef: null,
        }),
      () =>
        envelope.facade.recordDecision(round.roundId, {
          decisionId: "late-decision",
          summary: "late",
          allowedActions: [],
          recommendedAction: null,
          chosenAction: null,
          resolution: null,
          externalRef: null,
        }),
      () =>
        envelope.applyDaemonDecision(
          {
            roundId: round.roundId,
            classification: "complete",
            executorRecommendation: "complete",
            roundState: "succeeded",
            attemptState: "succeeded",
            recoveryCode: null,
            humanGate: null,
          },
          { classificationCheckpoint: daemonCheckpoint(round.roundId, 0) },
        ),
    ];

    for (const write of writes) {
      expect(write).toThrow("attempt inv-one-shot is terminal");
    }
    expect(loadExecutorRound(db, round.roundId)?.state).toBe(
      "mirroring_external_state",
    );
  });

  it("rolls back round classification and its checkpoint when attempt settlement fails", () => {
    const { db, attempt } = openExecutorDb("one-shot");
    const envelope = createDurableExecutorEnvelope({
      db,
      attemptId: attempt.attemptId,
      now: () => 40,
    });
    const round = emptyRound(attempt, "mirroring_external_state");
    envelope.facade.startRound(roundStartForSdk(round));
    db.exec(`
      CREATE TRIGGER fail_attempt_settlement
      BEFORE UPDATE ON executor_attempts
      BEGIN
        SELECT RAISE(ABORT, 'forced attempt settlement failure');
      END
    `);

    expect(() =>
      envelope.applyDaemonDecision(
        {
          roundId: round.roundId,
          classification: "complete",
          executorRecommendation: "complete",
          roundState: "succeeded",
          attemptState: "succeeded",
          recoveryCode: null,
          humanGate: null,
        },
        {
          classificationCheckpoint: {
            checkpointId: "classification-checkpoint",
            sequence: 0,
            stage: "classified",
            detail: "complete",
          },
        },
      ),
    ).toThrow("forced attempt settlement failure");

    expect(loadExecutorAttempt(db, attempt.attemptId)?.state).toBe("running");
    expect(loadExecutorRound(db, round.roundId)).toMatchObject({
      state: "mirroring_external_state",
      classification: null,
    });
    expect(listExecutorCheckpointsForRound(db, round.roundId)).toEqual([]);
  });

  it("rejects daemon decisions with inconsistent attempt state before writing", () => {
    const { db, attempt } = openExecutorDb("one-shot");
    const envelope = createDurableExecutorEnvelope({
      db,
      attemptId: attempt.attemptId,
      now: () => 40,
    });
    const round = emptyRound(attempt, "mirroring_external_state");
    envelope.facade.startRound(roundStartForSdk(round));

    expect(() =>
      envelope.applyDaemonDecision(
        {
          roundId: round.roundId,
          classification: "continue",
          executorRecommendation: "continue",
          roundState: "succeeded",
          attemptState: "succeeded",
          recoveryCode: null,
          humanGate: null,
        },
        { classificationCheckpoint: daemonCheckpoint(round.roundId, 0) },
      ),
    ).toThrow("expected attempt state running, got succeeded");

    expect(loadExecutorAttempt(db, attempt.attemptId)?.state).toBe("running");
    expect(loadExecutorRound(db, round.roundId)).toMatchObject({
      state: "mirroring_external_state",
      classification: null,
    });
    expect(listExecutorCheckpointsForRound(db, round.roundId)).toEqual([]);
  });

  it("rejects daemon decisions with incompatible round state before writing", () => {
    const { db, attempt } = openExecutorDb("one-shot");
    const envelope = createDurableExecutorEnvelope({
      db,
      attemptId: attempt.attemptId,
      now: () => 40,
    });
    const round = emptyRound(attempt, "mirroring_external_state");
    envelope.facade.startRound(roundStartForSdk(round));

    expect(() =>
      envelope.applyDaemonDecision(
        {
          roundId: round.roundId,
          classification: "complete",
          executorRecommendation: "complete",
          roundState: "failed",
          attemptState: "succeeded",
          recoveryCode: null,
          humanGate: null,
        },
        { classificationCheckpoint: daemonCheckpoint(round.roundId, 0) },
      ),
    ).toThrow("incompatible round state failed");

    expect(loadExecutorAttempt(db, attempt.attemptId)?.state).toBe("running");
    expect(loadExecutorRound(db, round.roundId)).toMatchObject({
      state: "mirroring_external_state",
      classification: null,
    });
    expect(listExecutorCheckpointsForRound(db, round.roundId)).toEqual([]);
  });

  it("rejects classification-inconsistent recovery codes and human gates", () => {
    const { db, attempt } = openExecutorDb("one-shot");
    const envelope = createDurableExecutorEnvelope({
      db,
      attemptId: attempt.attemptId,
      now: () => 40,
    });
    const round = emptyRound(attempt, "mirroring_external_state");
    envelope.facade.startRound(roundStartForSdk(round));
    const invalid = [
      {
        classification: "complete",
        roundState: "succeeded",
        attemptState: "succeeded",
        recoveryCode: "auth_unavailable",
        humanGate: null,
      },
      {
        classification: "complete",
        roundState: "succeeded",
        attemptState: "succeeded",
        recoveryCode: null,
        humanGate: "credential_required",
      },
      {
        classification: "failed",
        roundState: "failed",
        attemptState: "failed",
        recoveryCode: null,
        humanGate: null,
      },
      {
        classification: "blocked",
        roundState: "blocked",
        attemptState: "blocked",
        recoveryCode: null,
        humanGate: null,
      },
      {
        classification: "manual_recovery_required",
        roundState: "manual_recovery_required",
        attemptState: "manual_recovery_required",
        recoveryCode: "reset_failed",
        humanGate: "credential_required",
      },
      {
        classification: "approval_required",
        roundState: "waiting_operator",
        attemptState: "waiting_operator",
        recoveryCode: null,
        humanGate: null,
      },
      {
        classification: "operator_decision_required",
        roundState: "waiting_operator",
        attemptState: "waiting_operator",
        recoveryCode: null,
        humanGate: null,
      },
      {
        classification: "cancelled",
        roundState: "cancelled",
        attemptState: "cancelled",
        recoveryCode: "cancelled",
        humanGate: null,
      },
    ] as const;

    for (const decision of invalid) {
      expect(() =>
        envelope.applyDaemonDecision(
          {
            roundId: round.roundId,
            executorRecommendation: decision.classification,
            ...decision,
          },
          { classificationCheckpoint: daemonCheckpoint(round.roundId, 0) },
        ),
      ).toThrow(/incompatible (recovery code|human gate)/);
    }

    expect(loadExecutorAttempt(db, attempt.attemptId)?.state).toBe("running");
    expect(loadExecutorRound(db, round.roundId)).toMatchObject({
      state: "mirroring_external_state",
      classification: null,
    });
    expect(listExecutorCheckpointsForRound(db, round.roundId)).toEqual([]);
  });
});

function roundStartForSdk(round: ExecutorRoundRecord): ExecutorRoundStart {
  const {
    classification: _classification,
    executorRecommendation: _executorRecommendation,
    startedAt: _startedAt,
    heartbeatAt: _heartbeatAt,
    finishedAt: _finishedAt,
    recoveryCode: _recoveryCode,
    humanGate: _humanGate,
    verificationResults,
    ...start
  } = round;
  return {
    ...start,
    state: "mirroring_external_state",
    ...(verificationResults !== undefined
      ? { verificationResults: [...verificationResults] }
      : {}),
  };
}

function daemonCheckpoint(roundId: string, sequence: number) {
  return {
    checkpointId: `${roundId}-daemon-checkpoint-${sequence}`,
    sequence,
    stage: "classified",
    detail: null,
  };
}

describe("single-shot built-in SDK proof", () => {
  it("implements the same contract and leaves classification to its host", async () => {
    const { db, attempt } = openExecutorDb("one-shot");
    const envelope = createDurableExecutorEnvelope({
      db,
      attemptId: attempt.attemptId,
      now: () => 30,
    });
    const result: RunnerResult = {
      success: true,
      summary: "bounded agent turn completed",
      key_changes_made: ["proved the SDK path"],
      key_learnings: [],
      remaining_work: [],
      goal_complete: true,
      commit: {
        type: "test",
        scope: "sdk",
        subject: "prove built-in contract",
        body: "",
        breaking: false,
      },
    };
    const executor: Executor<
      SingleShotExecutorConfig,
      SingleShotExecutorHostBindings
    > = new SingleShotExecutor("one-shot", () => ({
      outcome: { ok: true },
      result,
      resultDigest: "sha256:result",
      artifacts: {
        resultDocument: { path: "/artifacts/round-0/result.json" },
      },
    }));

    const tickResult = await executor.tick({
      state: envelope.snapshot(),
      config: { agent: { harness: "codex", model: "gpt-5" } },
      hostBindings: {
        start: {
          roundId: `${attempt.attemptId}::round::0`,
          attemptId: attempt.attemptId,
          workflowRunId: attempt.workflowRunId,
          stepRunId: attempt.stepRunId,
          stepKey: attempt.stepKey,
          family: "one-shot",
          attemptNumber: attempt.attemptNumber,
          inputDigest: "sha256:input",
          artifactRoot: "/artifacts/round-0",
          logPaths: ["/artifacts/round-0/executor.log"],
          startedAt: 10,
        },
      },
      envelope: envelope.facade,
      signal: new AbortController().signal,
    });
    const tick = tickResult as ExecutorTickResult;

    const observed = loadExecutorRound(db, tick.roundId);
    expect(observed?.state).toBe("capturing_result");
    expect(observed?.summary).toBe("bounded agent turn completed");
    expect(observed?.classification).toBeNull();
    expect(observed?.executorRecommendation).toBeNull();
    expect(tick.recommendation).toBe("complete");

    envelope.applyDaemonDecision(
      {
        roundId: tick.roundId,
        classification: tick.recommendation,
        executorRecommendation: tick.recommendation,
        roundState: tick.recommendedRoundState,
        attemptState: tick.recommendedAttemptState,
        recoveryCode: tick.recoveryCode,
        humanGate: tick.humanGate,
      },
      { classificationCheckpoint: daemonCheckpoint(tick.roundId, 3) },
    );
    expect(() =>
      envelope.recordCheckpoint(tick.roundId, {
        checkpointId: `${tick.roundId}-late-checkpoint`,
        sequence: 99,
        stage: "late",
        detail: null,
      }),
    ).toThrow("attempt inv-one-shot is terminal");
  });

  it("rejects malformed successful runner results before persisting evidence", async () => {
    const { db, attempt } = openExecutorDb("one-shot");
    const envelope = createDurableExecutorEnvelope({
      db,
      attemptId: attempt.attemptId,
      now: () => 30,
    });
    const roundId = `${attempt.attemptId}::round::0`;
    const executor = new SingleShotExecutor("one-shot", () => ({
      outcome: { ok: true },
      result: { success: true } as RunnerResult,
      resultDigest: "sha256:malformed",
      artifacts: {
        resultDocument: { path: "/artifacts/round-0/result.json" },
      },
    }));

    await expect(
      executor.tick({
        state: envelope.snapshot(),
        config: {},
        hostBindings: {
          start: {
            roundId,
            attemptId: attempt.attemptId,
            workflowRunId: attempt.workflowRunId,
            stepRunId: attempt.stepRunId,
            stepKey: attempt.stepKey,
            family: "one-shot",
            attemptNumber: attempt.attemptNumber,
            inputDigest: "sha256:input",
            artifactRoot: "/artifacts/round-0",
            logPaths: ["/artifacts/round-0/executor.log"],
            startedAt: 10,
          },
        },
        envelope: envelope.facade,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(
      "Invalid one-shot mechanism output: Runner result `summary` must be a non-empty string.",
    );

    expect(loadExecutorRound(db, roundId)?.state).toBe("running");
    expect(listExecutorArtifactsForRound(db, roundId)).toEqual([]);
    expect(listExecutorCheckpointsForRound(db, roundId)).toEqual([
      expect.objectContaining({ stage: "round_started" }),
    ]);
  });

  it.each([
    [
      "non-boolean outcomes",
      { outcome: { ok: "false" } },
      "outcome.ok must be a boolean",
    ],
    [
      "unknown recovery codes",
      { outcome: { ok: false, recoveryCode: "unknown" } },
      "failed outcomes require a known recoveryCode",
    ],
    [
      "recovery codes on success",
      { outcome: { ok: true, recoveryCode: "command_failed" } },
      "successful outcomes must not carry recoveryCode",
    ],
    [
      "malformed failed results",
      {
        outcome: { ok: false, recoveryCode: "command_failed" },
        result: { success: false },
      },
      "Runner result `summary` must be a non-empty string",
    ],
    [
      "malformed artifact pointers",
      {
        outcome: { ok: false, recoveryCode: "command_failed" },
        artifacts: { recoveryNote: { path: 42 } },
      },
      "artifacts.recoveryNote.path must be a non-empty string",
    ],
    [
      "malformed evidence",
      {
        outcome: { ok: false, recoveryCode: "command_failed" },
        evidence: { changedFiles: "src/unsafe.ts" },
      },
      "evidence.changedFiles must be an array of strings",
    ],
  ])("rejects %s before persistence", async (_name, mechanism, message) => {
    const { db, attempt } = openExecutorDb("one-shot");
    const envelope = createDurableExecutorEnvelope({
      db,
      attemptId: attempt.attemptId,
      now: () => 30,
    });
    const roundId = `${attempt.attemptId}::round::0`;
    const executor = new SingleShotExecutor(
      "one-shot",
      () => mechanism as never,
    );

    await expect(
      executor.tick({
        state: envelope.snapshot(),
        config: {},
        hostBindings: {
          start: {
            roundId,
            attemptId: attempt.attemptId,
            workflowRunId: attempt.workflowRunId,
            stepRunId: attempt.stepRunId,
            stepKey: attempt.stepKey,
            family: "one-shot",
            attemptNumber: attempt.attemptNumber,
            inputDigest: "sha256:input",
            artifactRoot: "/artifacts/round-0",
            logPaths: ["/artifacts/round-0/executor.log"],
            startedAt: 10,
          },
        },
        envelope: envelope.facade,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(message);

    expect(loadExecutorRound(db, roundId)?.state).toBe("running");
    expect(listExecutorArtifactsForRound(db, roundId)).toEqual([]);
    expect(listExecutorCheckpointsForRound(db, roundId)).toHaveLength(1);
  });

  it("routes portable config, host bindings, and caller cancellation to an async runner", async () => {
    const { db, attempt } = openExecutorDb("script");
    const envelope = createDurableExecutorEnvelope({
      db,
      attemptId: attempt.attemptId,
      now: () => 30,
    });
    const abort = new AbortController();
    let observedCommand: string | undefined;
    let observedStartId: string | undefined;
    const executor = new SingleShotExecutor(
      "script",
      async (_round, context) => {
        observedCommand = context.config.command;
        observedStartId = context.hostBindings.start.roundId;
        abort.abort();
        await Promise.resolve();
        throw abort.signal.reason;
      },
    );
    const roundId = `${attempt.attemptId}::round::0`;

    await expect(
      executor.tick({
        state: envelope.snapshot(),
        config: { command: "test" },
        hostBindings: {
          start: {
            roundId,
            attemptId: attempt.attemptId,
            workflowRunId: attempt.workflowRunId,
            stepRunId: attempt.stepRunId,
            stepKey: attempt.stepKey,
            family: "script",
            attemptNumber: attempt.attemptNumber,
            inputDigest: "sha256:input",
            artifactRoot: "/artifacts/round-0",
            logPaths: ["/artifacts/round-0/executor.log"],
            startedAt: 10,
          },
        },
        envelope: envelope.facade,
        signal: abort.signal,
      }),
    ).rejects.toThrow(/aborted/i);

    expect(observedCommand).toBe("test");
    expect(observedStartId).toBe(roundId);
    expect(loadExecutorRound(db, roundId)?.state).toBe("running");
  });

  it("isolates durable dispatch binding from runner mutations", async () => {
    const { db, attempt } = openExecutorDb("one-shot");
    const envelope = createDurableExecutorEnvelope({
      db,
      attemptId: attempt.attemptId,
      now: () => 40,
    });
    const roundId = `${attempt.attemptId}::round::0`;
    const config = { agent: { harness: "codex", model: "gpt-5" } };
    const hostBindings = {
      start: {
        roundId,
        attemptId: attempt.attemptId,
        workflowRunId: attempt.workflowRunId,
        stepRunId: attempt.stepRunId,
        stepKey: attempt.stepKey,
        family: "one-shot" as const,
        attemptNumber: attempt.attemptNumber,
        inputDigest: "sha256:input",
        artifactRoot: "/artifacts/round-0",
        logPaths: ["/artifacts/round-0/executor.log"],
        startedAt: 10,
      },
    };
    const first = new SingleShotExecutor("one-shot", (_round, context) => {
      expect(() => {
        (context.config.agent as { harness?: string }).harness = "mutated";
      }).toThrow();
      expect(() => {
        (context.hostBindings.start as { inputDigest: string }).inputDigest =
          "sha256:mutated";
      }).toThrow();
      return {
        outcome: { ok: true },
        result: {
          success: true,
          summary: "completed before host classification",
          key_changes_made: [],
          key_learnings: [],
          remaining_work: [],
          goal_complete: true,
          commit: {
            type: "test",
            scope: "sdk",
            subject: "freeze dispatch binding",
            body: "",
            breaking: false,
          },
        },
      };
    });

    await first.tick({
      state: envelope.snapshot(),
      config,
      hostBindings,
      envelope: envelope.facade,
      signal: new AbortController().signal,
    });

    let reran = false;
    const resumed = await new SingleShotExecutor("one-shot", () => {
      reran = true;
      throw new Error("mechanism must not rerun");
    }).tick({
      state: envelope.snapshot(),
      config,
      hostBindings,
      envelope: envelope.facade,
      signal: new AbortController().signal,
    });

    expect(reran).toBe(false);
    expect(resumed.recommendation).toBe("complete");
  });

  it("resumes daemon classification from a durable mechanism checkpoint", async () => {
    const { db, attempt } = openExecutorDb("one-shot");
    const envelope = createDurableExecutorEnvelope({
      db,
      attemptId: attempt.attemptId,
      now: () => 40,
    });
    const roundId = `${attempt.attemptId}::round::0`;
    const hostBindings = {
      start: {
        roundId,
        attemptId: attempt.attemptId,
        workflowRunId: attempt.workflowRunId,
        stepRunId: attempt.stepRunId,
        stepKey: attempt.stepKey,
        family: "one-shot" as const,
        attemptNumber: attempt.attemptNumber,
        inputDigest: "sha256:input",
        artifactRoot: "/artifacts/round-0",
        logPaths: ["/artifacts/round-0/executor.log"],
        startedAt: 10,
      },
    };
    const first = new SingleShotExecutor("one-shot", () => ({
      outcome: { ok: true },
      result: {
        success: true,
        summary: "completed before host classification",
        key_changes_made: [],
        key_learnings: [],
        remaining_work: [],
        goal_complete: true,
        commit: {
          type: "test",
          scope: "sdk",
          subject: "resume classification",
          body: "",
          breaking: false,
        },
      },
    }));
    await first.tick({
      state: envelope.snapshot(),
      config: {},
      hostBindings,
      envelope: envelope.facade,
      signal: new AbortController().signal,
    });

    expect(loadExecutorRound(db, roundId)).toMatchObject({
      state: "capturing_result",
      classification: null,
    });
    db.prepare(
      `UPDATE executor_attempts
          SET attempt_number = 2,
              legacy_invocation_id = ?,
              legacy_provenance = ?
        WHERE attempt_id = ?`,
    ).run(
      attempt.attemptId,
      JSON.stringify({ legacyAttemptNumber: 1 }),
      attempt.attemptId,
    );
    db.prepare(
      "UPDATE executor_rounds SET attempt_number = 2 WHERE round_id = ?",
    ).run(roundId);
    const migratedHostBindings = {
      ...hostBindings,
      start: { ...hostBindings.start, attemptNumber: 2 },
    };
    await expect(
      new SingleShotExecutor("one-shot", () => {
        throw new Error("changed dispatch must not rerun");
      }).tick({
        state: envelope.snapshot(),
        config: { agent: { model: "changed-model" } },
        hostBindings: migratedHostBindings,
        envelope: envelope.facade,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("changed dispatch inputs");

    let reran = false;
    const resumed = new SingleShotExecutor("one-shot", () => {
      reran = true;
      throw new Error("mechanism must not rerun");
    });
    const tick = await resumed.tick({
      state: envelope.snapshot(),
      config: {},
      hostBindings: migratedHostBindings,
      envelope: envelope.facade,
      signal: new AbortController().signal,
    });

    expect(reran).toBe(false);
    expect(tick.recommendation).toBe("complete");
    envelope.applyDaemonDecision(
      {
        roundId,
        classification: tick.recommendation,
        executorRecommendation: tick.recommendation,
        roundState: tick.recommendedRoundState,
        attemptState: tick.recommendedAttemptState,
        recoveryCode: tick.recoveryCode,
        humanGate: tick.humanGate,
      },
      {
        allocateClassificationCheckpointIdentity: true,
        classificationCheckpoint: {
          stage: tick.classificationCheckpoint.stage,
          detail: tick.classificationCheckpoint.detail,
        },
      },
    );
    expect(loadExecutorRound(db, roundId)).toMatchObject({
      state: "succeeded",
      classification: "complete",
    });
  });

  it("resumes classification from a pre-migration mechanism checkpoint prefix", async () => {
    // SDK-05 recorded `invocation outcome: ...` details and the migration
    // preserves checkpoint payloads verbatim; the resume parser must accept the
    // historical prefix while new checkpoints emit the attempt vocabulary.
    const { db, attempt } = openExecutorDb("one-shot");
    const envelope = createDurableExecutorEnvelope({
      db,
      attemptId: attempt.attemptId,
      now: () => 40,
    });
    const roundId = `${attempt.attemptId}::round::0`;
    const hostBindings = {
      start: {
        roundId,
        attemptId: attempt.attemptId,
        workflowRunId: attempt.workflowRunId,
        stepRunId: attempt.stepRunId,
        stepKey: attempt.stepKey,
        family: "one-shot" as const,
        attemptNumber: attempt.attemptNumber,
        inputDigest: "sha256:input",
        artifactRoot: "/artifacts/round-0",
        logPaths: ["/artifacts/round-0/executor.log"],
        startedAt: 10,
      },
    };
    await new SingleShotExecutor("one-shot", () => ({
      outcome: { ok: true },
      result: {
        success: true,
        summary: "completed before host classification",
        key_changes_made: [],
        key_learnings: [],
        remaining_work: [],
        goal_complete: true,
        commit: {
          type: "test",
          scope: "sdk",
          subject: "legacy prefix resume",
          body: "",
          breaking: false,
        },
      },
    })).tick({
      state: envelope.snapshot(),
      config: {},
      hostBindings,
      envelope: envelope.facade,
      signal: new AbortController().signal,
    });
    db.prepare(
      `UPDATE executor_checkpoints
          SET detail = 'invocation outcome: ok'
        WHERE round_id = ? AND stage = 'mechanism_completed'`,
    ).run(roundId);

    let reran = false;
    const tick = await new SingleShotExecutor("one-shot", () => {
      reran = true;
      throw new Error("mechanism must not rerun");
    }).tick({
      state: envelope.snapshot(),
      config: {},
      hostBindings,
      envelope: envelope.facade,
      signal: new AbortController().signal,
    });

    expect(reran).toBe(false);
    expect(tick.recommendation).toBe("complete");
  });

  it("declares strict portable schemas for agent-once and script config", () => {
    expect(AGENT_ONCE_EXECUTOR_CONFIG_SCHEMA.additionalProperties).toBe(false);
    expect(AGENT_ONCE_EXECUTOR_CONFIG_SCHEMA.properties.agent).toEqual(
      expect.objectContaining({ type: "object", additionalProperties: false }),
    );
    expect(SCRIPT_EXECUTOR_CONFIG_SCHEMA.additionalProperties).toBe(false);
    expect(SCRIPT_EXECUTOR_CONFIG_SCHEMA.properties).toHaveProperty("command");
    expect(SCRIPT_EXECUTOR_CONFIG_SCHEMA.properties).not.toHaveProperty("args");
    expect(SCRIPT_EXECUTOR_CONFIG_SCHEMA.required).toEqual(["command"]);
    expect(AGENT_ONCE_EXECUTOR_CONFIG_SCHEMA.properties.timeoutMs).toEqual(
      expect.objectContaining({
        minimum: 1_000,
        maximum: 2_147_453_000,
        multipleOf: 1_000,
      }),
    );
    expect(SCRIPT_EXECUTOR_CONFIG_SCHEMA.properties.timeoutMs).toEqual(
      expect.objectContaining({
        minimum: 1_000,
        maximum: 2_147_453_000,
        multipleOf: 1_000,
      }),
    );
    const commandPattern = new RegExp(
      SCRIPT_EXECUTOR_CONFIG_SCHEMA.properties.command.pattern,
    );
    expect(commandPattern.test("pnpm")).toBe(true);
    expect(commandPattern.test("/usr/local/bin/pnpm")).toBe(false);
    expect(commandPattern.test("..\\bin\\tool.exe")).toBe(false);

    const serialized = JSON.stringify({
      agent: AGENT_ONCE_EXECUTOR_CONFIG_SCHEMA,
      script: SCRIPT_EXECUTOR_CONFIG_SCHEMA,
    });
    for (const machineLocalKey of [
      "cwd",
      "env",
      "credentials",
      "executablePath",
    ]) {
      expect(serialized).not.toContain(`"${machineLocalKey}"`);
    }
  });
});

describe("agent-loop iteration budget contract", () => {
  it("has no default round cap and raises quota_exhausted only for an opt-in cap", () => {
    expect(GOAL_LOOP_GLOBAL_DEFAULT_SELECTION.maxRounds).toBeNull();
    expect(resolveGoalLoopRoundSelection({}).maxRounds).toBeNull();

    const unbounded = decideGoalLoopRound({
      recommendation: { success: true, goalComplete: false },
      finalizeOutcome: "committed",
      roundIndex: 10_000,
      maxRounds: null,
    });
    expect(unbounded.classification).toBe("continue");
    expect(unbounded.continueLoop).toBe(true);
    expect(unbounded.humanGate).toBeNull();

    const capped = decideGoalLoopRound({
      recommendation: { success: true, goalComplete: false },
      finalizeOutcome: "committed",
      roundIndex: 0,
      maxRounds: 1,
    });
    expect(capped.classification).toBe("operator_decision_required");
    expect(capped.continueLoop).toBe(false);
    expect(capped.humanGate).toBe("quota_exhausted");
  });
});
