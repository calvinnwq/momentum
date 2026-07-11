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
  insertExecutorInvocation,
  listExecutorArtifactsForRound,
  listExecutorCheckpointsForRound,
  loadExecutorInvocation,
  loadExecutorRound,
  updateExecutorInvocationState,
} from "../src/core/executors/loop/persist.js";
import type {
  ExecutorInvocationRecord,
  ExecutorRoundRecord,
} from "../src/core/executors/loop/reducer.js";
import type { RunnerResult } from "../src/core/executors/runner/types.js";
import { createDurableExecutorEnvelope } from "../src/core/executors/sdk/envelope.js";
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

function openExecutorDb(family: ExecutorInvocationRecord["executorFamily"]): {
  db: MomentumDb;
  invocation: ExecutorInvocationRecord;
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
  const invocation: ExecutorInvocationRecord = {
    invocationId: `inv-${family}`,
    workflowRunId: "run-1",
    stepRunId: "step-1",
    stepKey: "implementation",
    executorFamily: family,
    state: "running",
    attempt: 1,
    startedAt: 1,
    heartbeatAt: 1,
    finishedAt: null,
  };
  insertExecutorInvocation(db, invocation, { now: 1 });
  return { db, invocation };
}

function emptyRound(
  invocation: ExecutorInvocationRecord,
  state: ExecutorRoundRecord["state"],
): ExecutorRoundRecord {
  return {
    roundId: `${invocation.invocationId}::round::0`,
    invocationId: invocation.invocationId,
    workflowRunId: invocation.workflowRunId,
    stepRunId: invocation.stepRunId,
    stepKey: invocation.stepKey,
    executorFamily: invocation.executorFamily,
    attempt: invocation.attempt,
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
      context.state.invocation as ExecutorInvocationRecord,
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
      recommendedInvocationState: "waiting_operator",
      recoveryCode: null,
      humanGate: "operator_decision_required",
      reason: "the mirrored tool state requires an operator choice",
    };
  }
}

describe("executor SDK core contract", () => {
  it("fits a poll-per-tick supervisor using only the durable envelope facade", () => {
    const { db, invocation } = openExecutorDb("no-mistakes");
    const envelope = createDurableExecutorEnvelope({
      db,
      invocationId: invocation.invocationId,
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
    expect(loadExecutorInvocation(db, invocation.invocationId)?.state).toBe(
      "running",
    );

    envelope.applyDaemonDecision(
      {
        roundId: tick.roundId,
        classification: tick.recommendation,
        executorRecommendation: tick.recommendation,
        roundState: tick.recommendedRoundState,
        invocationState: tick.recommendedInvocationState,
        recoveryCode: tick.recoveryCode,
        humanGate: tick.humanGate,
      },
      { classificationCheckpoint: daemonCheckpoint(tick.roundId, 1) },
    );

    const snapshot = envelope.snapshot();
    expect(snapshot.invocation.state).toBe("waiting_operator");
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
    const { db, invocation } = openExecutorDb("one-shot");
    const envelope = createDurableExecutorEnvelope({
      db,
      invocationId: invocation.invocationId,
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

  it("revokes every executor write while the invocation waits for an operator", () => {
    const { db, invocation } = openExecutorDb("one-shot");
    const envelope = createDurableExecutorEnvelope({
      db,
      invocationId: invocation.invocationId,
      now: () => 25,
    });
    const round = emptyRound(invocation, "running");
    envelope.facade.startRound(roundStartForSdk(round));
    envelope.applyDaemonDecision(
      {
        roundId: round.roundId,
        classification: "operator_decision_required",
        executorRecommendation: "operator_decision_required",
        roundState: "waiting_operator",
        invocationState: "waiting_operator",
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
    expect(loadExecutorInvocation(db, invocation.invocationId)?.state).toBe(
      "waiting_operator",
    );
    expect(loadExecutorRound(db, round.roundId)?.state).toBe(
      "waiting_operator",
    );
  });

  it("enforces observation-only state authority at runtime", () => {
    const { db, invocation } = openExecutorDb("one-shot");
    const envelope = createDurableExecutorEnvelope({
      db,
      invocationId: invocation.invocationId,
      now: () => 25,
    });
    const round = emptyRound(invocation, "running");
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

  it("atomically records a round observation with its checkpoint batch", () => {
    const { db, invocation } = openExecutorDb("one-shot");
    const envelope = createDurableExecutorEnvelope({
      db,
      invocationId: invocation.invocationId,
      now: () => 25,
    });
    const round = emptyRound(invocation, "running");
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
    const { db, invocation } = openExecutorDb("one-shot");
    const envelope = createDurableExecutorEnvelope({
      db,
      invocationId: invocation.invocationId,
    });
    envelope.facade.startRound(
      roundStartForSdk(emptyRound(invocation, "running")),
    );
    const second = {
      ...emptyRound(invocation, "running"),
      roundId: `${invocation.invocationId}::round::1`,
      roundIndex: 1,
    };

    expect(() => envelope.facade.startRound(roundStartForSdk(second))).toThrow(
      "previous round",
    );
    expect(loadExecutorRound(db, second.roundId)).toBeUndefined();
  });

  it("rejects gapped indexes and invocation identity mismatches", () => {
    const { db, invocation } = openExecutorDb("one-shot");
    const envelope = createDurableExecutorEnvelope({
      db,
      invocationId: invocation.invocationId,
    });
    const gapped = {
      ...emptyRound(invocation, "running"),
      roundIndex: 1,
    };
    const mismatched = {
      ...emptyRound(invocation, "running"),
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

  it("rejects every executor evidence path after a round becomes terminal", () => {
    const { db, invocation } = openExecutorDb("one-shot");
    const envelope = createDurableExecutorEnvelope({
      db,
      invocationId: invocation.invocationId,
      now: () => 30,
    });
    const round = emptyRound(invocation, "mirroring_external_state");
    envelope.facade.startRound(roundStartForSdk(round));
    envelope.applyDaemonDecision(
      {
        roundId: round.roundId,
        classification: "continue",
        executorRecommendation: "continue",
        roundState: "succeeded",
        invocationState: "running",
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

  it("rejects every executor write after the invocation becomes terminal", () => {
    const { db, invocation } = openExecutorDb("one-shot");
    const envelope = createDurableExecutorEnvelope({
      db,
      invocationId: invocation.invocationId,
      now: () => 30,
    });
    const round = emptyRound(invocation, "running");
    envelope.facade.startRound(roundStartForSdk(round));
    updateExecutorInvocationState(db, invocation.invocationId, "succeeded", {
      finishedAt: 25,
      now: 25,
    });

    const writes = [
      () =>
        envelope.facade.startRound(
          roundStartForSdk({
            ...round,
            roundId: `${invocation.invocationId}::round::1`,
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
            invocationState: "succeeded",
            recoveryCode: null,
            humanGate: null,
          },
          { classificationCheckpoint: daemonCheckpoint(round.roundId, 0) },
        ),
    ];

    for (const write of writes) {
      expect(write).toThrow("invocation inv-one-shot is terminal");
    }
    expect(loadExecutorRound(db, round.roundId)?.state).toBe(
      "mirroring_external_state",
    );
  });

  it("rolls back round classification and its checkpoint when invocation settlement fails", () => {
    const { db, invocation } = openExecutorDb("one-shot");
    const envelope = createDurableExecutorEnvelope({
      db,
      invocationId: invocation.invocationId,
      now: () => 40,
    });
    const round = emptyRound(invocation, "mirroring_external_state");
    envelope.facade.startRound(roundStartForSdk(round));

    expect(() =>
      envelope.applyDaemonDecision(
        {
          roundId: round.roundId,
          classification: "complete",
          executorRecommendation: "complete",
          roundState: "succeeded",
          invocationState: "preparing",
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
    ).toThrow();

    expect(loadExecutorInvocation(db, invocation.invocationId)?.state).toBe(
      "running",
    );
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
    const { db, invocation } = openExecutorDb("one-shot");
    const envelope = createDurableExecutorEnvelope({
      db,
      invocationId: invocation.invocationId,
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
          roundId: `${invocation.invocationId}::round::0`,
          invocationId: invocation.invocationId,
          workflowRunId: invocation.workflowRunId,
          stepRunId: invocation.stepRunId,
          stepKey: invocation.stepKey,
          family: "one-shot",
          attempt: invocation.attempt,
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
        invocationState: tick.recommendedInvocationState,
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
    ).toThrow("invocation inv-one-shot is terminal");
  });

  it("rejects malformed successful runner results before persisting evidence", async () => {
    const { db, invocation } = openExecutorDb("one-shot");
    const envelope = createDurableExecutorEnvelope({
      db,
      invocationId: invocation.invocationId,
      now: () => 30,
    });
    const roundId = `${invocation.invocationId}::round::0`;
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
            invocationId: invocation.invocationId,
            workflowRunId: invocation.workflowRunId,
            stepRunId: invocation.stepRunId,
            stepKey: invocation.stepKey,
            family: "one-shot",
            attempt: invocation.attempt,
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

  it("routes portable config, host bindings, and caller cancellation to an async runner", async () => {
    const { db, invocation } = openExecutorDb("script");
    const envelope = createDurableExecutorEnvelope({
      db,
      invocationId: invocation.invocationId,
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
    const roundId = `${invocation.invocationId}::round::0`;

    await expect(
      executor.tick({
        state: envelope.snapshot(),
        config: { command: "test", args: ["--run"] },
        hostBindings: {
          start: {
            roundId,
            invocationId: invocation.invocationId,
            workflowRunId: invocation.workflowRunId,
            stepRunId: invocation.stepRunId,
            stepKey: invocation.stepKey,
            family: "script",
            attempt: invocation.attempt,
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
    const { db, invocation } = openExecutorDb("one-shot");
    const envelope = createDurableExecutorEnvelope({
      db,
      invocationId: invocation.invocationId,
      now: () => 40,
    });
    const roundId = `${invocation.invocationId}::round::0`;
    const config = { agent: { harness: "codex", model: "gpt-5" } };
    const hostBindings = {
      start: {
        roundId,
        invocationId: invocation.invocationId,
        workflowRunId: invocation.workflowRunId,
        stepRunId: invocation.stepRunId,
        stepKey: invocation.stepKey,
        family: "one-shot" as const,
        attempt: invocation.attempt,
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
    const { db, invocation } = openExecutorDb("one-shot");
    const envelope = createDurableExecutorEnvelope({
      db,
      invocationId: invocation.invocationId,
      now: () => 40,
    });
    const roundId = `${invocation.invocationId}::round::0`;
    const hostBindings = {
      start: {
        roundId,
        invocationId: invocation.invocationId,
        workflowRunId: invocation.workflowRunId,
        stepRunId: invocation.stepRunId,
        stepKey: invocation.stepKey,
        family: "one-shot" as const,
        attempt: invocation.attempt,
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
    await expect(
      new SingleShotExecutor("one-shot", () => {
        throw new Error("changed dispatch must not rerun");
      }).tick({
        state: envelope.snapshot(),
        config: { agent: { model: "changed-model" } },
        hostBindings,
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
      hostBindings,
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
        invocationState: tick.recommendedInvocationState,
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

  it("declares strict portable schemas for agent-once and script config", () => {
    expect(AGENT_ONCE_EXECUTOR_CONFIG_SCHEMA.additionalProperties).toBe(false);
    expect(AGENT_ONCE_EXECUTOR_CONFIG_SCHEMA.properties.agent).toEqual(
      expect.objectContaining({ type: "object", additionalProperties: false }),
    );
    expect(SCRIPT_EXECUTOR_CONFIG_SCHEMA.additionalProperties).toBe(false);
    expect(SCRIPT_EXECUTOR_CONFIG_SCHEMA.properties).toHaveProperty("command");
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
