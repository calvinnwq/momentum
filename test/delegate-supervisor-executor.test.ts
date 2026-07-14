import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import {
  createNoMistakesToolAdapter,
  parseNoMistakesAxiStatus,
  parseNoMistakesLaunchIdentity,
  settleNoMistakesHandoffState,
} from "../src/adapters/no-mistakes-tool-adapter.js";
import { createPersistedProfileDelegateToolAdapter } from "../src/adapters/profile-backed-delegate-tool-adapter.js";
import { LIVE_STEP_WRAPPER_RESULT_MAX_BYTES } from "../src/adapters/live-step-wrapper.js";
import {
  classifyDelegateSupervisorState,
  delegateSupervisorProgressDigest,
} from "../src/core/executors/delegate-supervisor/classifier.js";
import {
  DelegateSupervisorExecutor,
  DELEGATE_SUPERVISOR_CONFIG_SCHEMA,
  DELEGATE_SUPERVISOR_STALL_AFTER_MS,
} from "../src/core/executors/delegate-supervisor/executor.js";
import type {
  DelegateSupervisorExternalState,
  DelegateSupervisorToolAdapter,
} from "../src/core/executors/delegate-supervisor/types.js";
import {
  insertExecutorInvocation,
  updateExecutorInvocationState,
  updateExecutorRound,
} from "../src/core/executors/loop/persist.js";
import type { ExecutorInvocationRecord } from "../src/core/executors/loop/reducer.js";
import { driveExecutorTicks } from "../src/core/executors/sdk/driver.js";
import { createDurableExecutorEnvelope } from "../src/core/executors/sdk/envelope.js";
import { resolveWorkflowGateAndResumeRegisteredExecutor } from "../src/core/workflow/dispatch/executor-gate.js";
import { insertWorkflowGate } from "../src/core/workflow/gate/persist.js";

const roots: string[] = [];
const HEAD = "a".repeat(40);

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function openDelegateDb(): {
  db: MomentumDb;
  invocation: ExecutorInvocationRecord;
  root: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-supervisor-"));
  roots.push(root);
  const db = openDb(root);
  db.prepare(
    "INSERT INTO workflow_runs (id, source, created_at, updated_at) VALUES ('run-1', 'test', 1, 1)",
  ).run();
  db.prepare(
    `INSERT INTO workflow_steps (run_id, step_id, kind, step_order, created_at, updated_at)
     VALUES ('run-1', 'step-1', 'no-mistakes', 0, 1, 1)`,
  ).run();
  const invocation: ExecutorInvocationRecord = {
    invocationId: "run-1::step-1::dispatch",
    workflowRunId: "run-1",
    stepRunId: "step-1",
    stepKey: "no-mistakes",
    executorFamily: "delegate-supervisor",
    state: "running",
    attempt: 1,
    startedAt: 1,
    heartbeatAt: 1,
    finishedAt: null,
  };
  insertExecutorInvocation(db, invocation, { now: 1 });
  return { db, invocation, root };
}

function state(
  overrides: Partial<DelegateSupervisorExternalState> = {},
): DelegateSupervisorExternalState {
  return {
    externalRunId: "nm-run-1",
    branch: "feature/delegate-supervisor",
    headSha: HEAD,
    activeStep: "review",
    stepStatus: "running",
    findings: [],
    selectedFindingIds: [],
    decisions: [],
    prUrl: "https://example.test/pull/1",
    ciState: "pending",
    ...overrides,
  };
}

function writeState(statePath: string, value: DelegateSupervisorExternalState) {
  fs.writeFileSync(statePath, JSON.stringify(value));
}

function seedCurrentRoundCheckpoint(
  db: MomentumDb,
  invocation: ExecutorInvocationRecord,
  stage: string,
  detail: string | null,
): string {
  const roundId = seedRound(db, invocation, 0);
  const envelope = createDurableExecutorEnvelope({
    db,
    invocationId: invocation.invocationId,
    now: () => 5,
  });
  envelope.facade.recordCheckpoint(roundId, {
    checkpointId: `${roundId}-${stage}`,
    sequence: 0,
    stage,
    detail,
  });
  return roundId;
}

function seedRound(
  db: MomentumDb,
  invocation: ExecutorInvocationRecord,
  roundIndex: number,
): string {
  const envelope = createDurableExecutorEnvelope({
    db,
    invocationId: invocation.invocationId,
    now: () => 5,
  });
  const roundId = `${invocation.invocationId}::round-${roundIndex + 1}`;
  envelope.facade.startRound({
    roundId,
    invocationId: invocation.invocationId,
    workflowRunId: invocation.workflowRunId,
    stepRunId: invocation.stepRunId,
    stepKey: invocation.stepKey,
    executorFamily: invocation.executorFamily,
    attempt: invocation.attempt,
    roundIndex,
    state: "running",
    agentProvider: null,
    model: null,
    effort: null,
    inputDigest: null,
    resultDigest: null,
    artifactRoot: null,
    logPaths: [],
    summary: null,
    keyChanges: [],
    keyLearnings: [],
    remainingWork: [],
    changedFiles: [],
    verificationStatus: null,
    commitSha: null,
  });
  return roundId;
}

describe("delegate-supervisor SDK executor", () => {
  it("settles a legacy completed live-step checkpoint without repeating handoff", async () => {
    const { db, invocation } = openDelegateDb();
    const envelope = createDurableExecutorEnvelope({
      db,
      invocationId: invocation.invocationId,
      now: () => 5,
    });
    const roundId = `${invocation.invocationId}::round-1`;
    envelope.facade.startRound({
      roundId,
      invocationId: invocation.invocationId,
      workflowRunId: invocation.workflowRunId,
      stepRunId: invocation.stepRunId,
      stepKey: invocation.stepKey,
      executorFamily: invocation.executorFamily,
      attempt: invocation.attempt,
      roundIndex: 0,
      state: "running",
      agentProvider: null,
      model: null,
      effort: null,
      inputDigest: null,
      resultDigest: null,
      artifactRoot: null,
      logPaths: [],
      summary: null,
      keyChanges: [],
      keyLearnings: [],
      remainingWork: [],
      changedFiles: [],
      verificationStatus: null,
      commitSha: null,
    });
    envelope.facade.recordRoundProgress(roundId, {
      observation: {
        phase: "capturing_result",
        summary: "legacy wrapper completed cleanly",
      },
      checkpoints: [
        {
          checkpointId: `${roundId}-legacy-complete`,
          sequence: 0,
          stage: "mechanism_completed",
          detail: JSON.stringify({
            recommendation: "complete",
            recommendedRoundState: "succeeded",
            recommendedInvocationState: "succeeded",
            recoveryCode: null,
            humanGate: null,
            reason: "legacy wrapper completed cleanly",
          }),
        },
      ],
    });
    let handoffs = 0;
    let settled: boolean | undefined;
    const result = await driveExecutorTicks({
      db,
      invocationId: invocation.invocationId,
      executor: new DelegateSupervisorExecutor(),
      config: { tool: "no-mistakes" },
      hostBindings: {
        tools: {
          "no-mistakes": {
            name: "no-mistakes",
            handoff: () => {
              handoffs += 1;
              throw new Error("legacy replay must not hand off again");
            },
            readExternalState: () => ({
              ok: false,
              error: "legacy replay must not read external state",
            }),
          },
        },
        settleHandoff: (provenClean: boolean) => {
          settled = provenClean;
        },
      },
      now: () => 6,
    });
    expect(result.lastRound).toMatchObject({
      state: "succeeded",
      classification: "complete",
      recoveryCode: null,
    });
    expect(handoffs).toBe(0);
    expect(settled).toBe(true);
    db.close();
  });

  it("replays legacy completion from a prior attempt without relaunching", async () => {
    const { db, invocation } = openDelegateDb();
    const roundId = seedCurrentRoundCheckpoint(
      db,
      invocation,
      "mechanism_completed",
      JSON.stringify({
        recommendation: "complete",
        recommendedRoundState: "succeeded",
        recommendedInvocationState: "succeeded",
        recoveryCode: null,
        humanGate: null,
        reason: "legacy wrapper completed cleanly",
      }),
    );
    updateExecutorRound(db, roundId, { toState: "capturing_result" });
    updateExecutorRound(db, roundId, {
      toState: "succeeded",
      classification: "complete",
      executorRecommendation: "complete",
      recoveryCode: null,
      humanGate: null,
      finishedAt: 5,
    });
    db.prepare(
      `UPDATE executor_invocations
          SET attempt = 2, state = 'running', finished_at = NULL
        WHERE invocation_id = ?`,
    ).run(invocation.invocationId);
    const activeReplayRoundId = seedRound(db, { ...invocation, attempt: 2 }, 1);
    let handoffs = 0;
    const result = await driveExecutorTicks({
      db,
      invocationId: invocation.invocationId,
      executor: new DelegateSupervisorExecutor(),
      config: { tool: "no-mistakes" },
      hostBindings: {
        tools: {
          "no-mistakes": {
            name: "no-mistakes",
            handoff: () => {
              handoffs += 1;
              throw new Error("legacy completion must not relaunch");
            },
            readExternalState: () => {
              throw new Error("legacy completion must not poll");
            },
          },
        },
      },
      now: () => 6,
    });
    expect(handoffs).toBe(0);
    expect(result.lastRound).toMatchObject({
      roundId: activeReplayRoundId,
      classification: "complete",
      recoveryCode: null,
      state: "succeeded",
      summary: "legacy wrapper completed cleanly",
    });
    expect(result.invocation).toMatchObject({ state: "succeeded", attempt: 2 });
    expect(
      createDurableExecutorEnvelope({
        db,
        invocationId: invocation.invocationId,
      }).snapshot().rounds,
    ).toHaveLength(2);
    db.close();
  });

  it("consumes a prior nonterminal legacy completion before handoff", async () => {
    const { db, invocation } = openDelegateDb();
    const legacyRoundId = seedCurrentRoundCheckpoint(
      db,
      invocation,
      "mechanism_completed",
      JSON.stringify({
        recommendation: "continue",
        recommendedRoundState: "succeeded",
        recommendedInvocationState: "running",
        recoveryCode: null,
        humanGate: null,
        reason: "legacy wrapper requested another round",
      }),
    );
    updateExecutorRound(db, legacyRoundId, { toState: "capturing_result" });
    updateExecutorRound(db, legacyRoundId, {
      toState: "succeeded",
      classification: "continue",
      executorRecommendation: "continue",
      recoveryCode: null,
      humanGate: null,
      finishedAt: 5,
    });
    db.prepare(
      `UPDATE executor_invocations
          SET attempt = 2, state = 'running', finished_at = NULL
        WHERE invocation_id = ?`,
    ).run(invocation.invocationId);
    let handoffs = 0;
    const result = await driveExecutorTicks({
      db,
      invocationId: invocation.invocationId,
      executor: new DelegateSupervisorExecutor(),
      config: { tool: "no-mistakes" },
      hostBindings: {
        tools: {
          "no-mistakes": {
            name: "no-mistakes",
            handoff: () => {
              handoffs += 1;
              return {
                externalIdentity: {
                  externalRunId: "nm-run-2",
                  branch: "feature/delegate-supervisor",
                  headSha: HEAD,
                },
                summary: "new delegated handoff",
              };
            },
            readExternalState: () => {
              throw new Error("handoff should finish before polling");
            },
          },
        },
      },
      maxTicks: 2,
      now: () => 6,
    });
    expect(handoffs).toBe(1);
    expect(result.lastRound).toMatchObject({
      classification: "continue",
      state: "succeeded",
      summary: "new delegated handoff",
    });
    const rounds = createDurableExecutorEnvelope({
      db,
      invocationId: invocation.invocationId,
    }).snapshot().rounds;
    expect(rounds).toHaveLength(3);
    expect(
      rounds[1]?.checkpoints.some(
        (checkpoint) =>
          checkpoint.stage === "delegate_legacy_completion_replayed",
      ),
    ).toBe(true);
    db.close();
  });

  it("consumes a retryable legacy recovery before the next repaired attempt", async () => {
    const { db, invocation } = openDelegateDb();
    const legacyRoundId = seedCurrentRoundCheckpoint(
      db,
      invocation,
      "mechanism_completed",
      JSON.stringify({
        recommendation: "manual_recovery_required",
        recommendedRoundState: "manual_recovery_required",
        recommendedInvocationState: "manual_recovery_required",
        recoveryCode: "external_state_unreadable",
        humanGate: "manual_recovery_required",
        reason: "legacy state could not be read",
      }),
    );
    updateExecutorRound(db, legacyRoundId, { toState: "capturing_result" });
    updateExecutorRound(db, legacyRoundId, {
      toState: "manual_recovery_required",
      classification: "manual_recovery_required",
      executorRecommendation: "manual_recovery_required",
      recoveryCode: "external_state_unreadable",
      humanGate: "manual_recovery_required",
      finishedAt: 5,
    });
    db.prepare(
      `UPDATE executor_invocations
          SET attempt = 2, state = 'running', finished_at = NULL
        WHERE invocation_id = ?`,
    ).run(invocation.invocationId);
    let repaired = false;
    let handoffs = 0;
    const adapter: DelegateSupervisorToolAdapter = {
      name: "no-mistakes",
      handoff: () => {
        handoffs += 1;
        if (!repaired) throw new Error("legacy recovery must replay first");
        return {
          externalIdentity: {
            externalRunId: "nm-run-repaired",
            branch: "feature/delegate-supervisor",
            headSha: HEAD,
          },
          summary: "repaired delegated handoff",
        };
      },
      readExternalState: () => {
        throw new Error("handoff should finish before polling");
      },
    };

    const replayed = await driveExecutorTicks({
      db,
      invocationId: invocation.invocationId,
      executor: new DelegateSupervisorExecutor(),
      config: { tool: "no-mistakes" },
      hostBindings: { tools: { "no-mistakes": adapter } },
      now: () => 6,
    });
    expect(replayed.invocation.state).toBe("manual_recovery_required");
    expect(handoffs).toBe(0);

    repaired = true;
    db.prepare(
      `UPDATE executor_invocations
          SET attempt = 3, state = 'running', finished_at = NULL
        WHERE invocation_id = ?`,
    ).run(invocation.invocationId);
    const retried = await driveExecutorTicks({
      db,
      invocationId: invocation.invocationId,
      executor: new DelegateSupervisorExecutor(),
      config: { tool: "no-mistakes" },
      hostBindings: { tools: { "no-mistakes": adapter } },
      now: () => 7,
    });
    expect(handoffs).toBe(1);
    expect(retried.lastRound).toMatchObject({
      classification: "continue",
      summary: "repaired delegated handoff",
    });
    db.close();
  });

  it("prefers newer delegated handoff evidence over legacy completion", async () => {
    const { db, invocation } = openDelegateDb();
    const legacyRoundId = seedCurrentRoundCheckpoint(
      db,
      invocation,
      "mechanism_completed",
      JSON.stringify({
        recommendation: "complete",
        recommendedRoundState: "succeeded",
        recommendedInvocationState: "succeeded",
        recoveryCode: null,
        humanGate: null,
        reason: "stale legacy completion",
      }),
    );
    updateExecutorRound(db, legacyRoundId, { toState: "capturing_result" });
    updateExecutorRound(db, legacyRoundId, {
      toState: "succeeded",
      classification: "complete",
      executorRecommendation: "complete",
      recoveryCode: null,
      humanGate: null,
      finishedAt: 5,
    });
    const handoffRoundId = seedRound(db, invocation, 1);
    const envelope = createDurableExecutorEnvelope({
      db,
      invocationId: invocation.invocationId,
      now: () => 6,
    });
    envelope.facade.recordCheckpoint(handoffRoundId, {
      checkpointId: `${handoffRoundId}-delegate_handoff_completed`,
      sequence: 0,
      stage: "delegate_handoff_completed",
      detail: JSON.stringify({
        externalIdentity: {
          externalRunId: "nm-run-1",
          branch: "feature/delegate-supervisor",
          headSha: HEAD,
        },
        summary: "newer delegated handoff",
      }),
    });
    updateExecutorRound(db, handoffRoundId, { toState: "capturing_result" });
    updateExecutorRound(db, handoffRoundId, {
      toState: "succeeded",
      classification: "continue",
      executorRecommendation: "continue",
      recoveryCode: null,
      humanGate: null,
      finishedAt: 6,
    });
    let reads = 0;
    const result = await driveExecutorTicks({
      db,
      invocationId: invocation.invocationId,
      executor: new DelegateSupervisorExecutor(),
      config: { tool: "no-mistakes" },
      hostBindings: {
        tools: {
          "no-mistakes": {
            name: "no-mistakes",
            handoff: () => {
              throw new Error("newer handoff must not relaunch");
            },
            readExternalState: () => {
              reads += 1;
              return {
                ok: true,
                value: state(),
                digest: "sha256:newer-handoff-status",
              };
            },
          },
        },
      },
      now: () => 7,
    });

    expect(reads).toBe(1);
    expect(result.invocation.state).toBe("running");
    expect(result.lastRound).toMatchObject({ classification: "continue" });
    db.close();
  });

  it.each([
    ["delegated handoff", "delegate_handoff_completed", "not-json"],
    ["legacy mechanism completion", "mechanism_completed", "not-json"],
    ["legacy mechanism completion structure", "mechanism_completed", "null"],
  ])(
    "fails closed on malformed %s evidence without repeating handoff",
    async (_label, stage, detail) => {
      const { db, invocation } = openDelegateDb();
      seedCurrentRoundCheckpoint(db, invocation, stage, detail);
      let handoffs = 0;
      let settled: boolean | undefined;
      const result = await driveExecutorTicks({
        db,
        invocationId: invocation.invocationId,
        executor: new DelegateSupervisorExecutor(),
        config: { tool: "no-mistakes" },
        hostBindings: {
          tools: {
            "no-mistakes": {
              name: "no-mistakes",
              handoff: () => {
                handoffs += 1;
                throw new Error(
                  "corrupt completion evidence must not relaunch",
                );
              },
              readExternalState: () => {
                throw new Error("corrupt completion evidence must not poll");
              },
            },
          },
          settleHandoff: (provenClean: boolean) => {
            settled = provenClean;
          },
        },
        now: () => 6,
      });
      expect(result.lastRound).toMatchObject({
        state: "manual_recovery_required",
        classification: "manual_recovery_required",
        recoveryCode: "delegate_handoff_recovery_required",
      });
      expect(handoffs).toBe(0);
      expect(settled).toBe(false);
      db.close();
    },
  );

  it("uses the active round to report corrupt evidence from a prior round", async () => {
    const { db, invocation } = openDelegateDb();
    const priorRoundId = seedCurrentRoundCheckpoint(
      db,
      invocation,
      "mechanism_completed",
      "null",
    );
    updateExecutorRound(db, priorRoundId, {
      toState: "capturing_result",
    });
    updateExecutorRound(db, priorRoundId, {
      toState: "succeeded",
      classification: "complete",
      executorRecommendation: "complete",
      recoveryCode: null,
      humanGate: null,
      finishedAt: 5,
    });
    const activeRoundId = seedRound(db, invocation, 1);
    let handoffs = 0;
    const result = await driveExecutorTicks({
      db,
      invocationId: invocation.invocationId,
      executor: new DelegateSupervisorExecutor(),
      config: { tool: "no-mistakes" },
      hostBindings: {
        tools: {
          "no-mistakes": {
            name: "no-mistakes",
            handoff: () => {
              handoffs += 1;
              throw new Error("corrupt prior evidence must not relaunch");
            },
            readExternalState: () => {
              throw new Error("corrupt prior evidence must not poll");
            },
          },
        },
      },
      now: () => 6,
    });
    expect(result.lastRound).toMatchObject({
      roundId: activeRoundId,
      state: "manual_recovery_required",
      classification: "manual_recovery_required",
      recoveryCode: "delegate_handoff_recovery_required",
    });
    expect(handoffs).toBe(0);
    db.close();
  });

  it("recovers an interrupted handoff intent without launching again", async () => {
    const { db, invocation, root } = openDelegateDb();
    const evidencePath = path.join(root, "handoff.log");
    const envelope = createDurableExecutorEnvelope({
      db,
      invocationId: invocation.invocationId,
      now: () => 5,
    });
    const roundId = `${invocation.invocationId}::round-1`;
    envelope.facade.startRound({
      roundId,
      invocationId: invocation.invocationId,
      workflowRunId: invocation.workflowRunId,
      stepRunId: invocation.stepRunId,
      stepKey: invocation.stepKey,
      executorFamily: invocation.executorFamily,
      attempt: invocation.attempt,
      roundIndex: 0,
      state: "running",
      agentProvider: null,
      model: null,
      effort: null,
      inputDigest: null,
      resultDigest: null,
      artifactRoot: null,
      logPaths: [],
      summary: "handoff interrupted",
      keyChanges: [],
      keyLearnings: [],
      remainingWork: [],
      changedFiles: [],
      verificationStatus: null,
      commitSha: null,
    });
    envelope.facade.recordCheckpoint(roundId, {
      checkpointId: `${roundId}-delegate_handoff_intent`,
      sequence: 0,
      stage: "delegate_handoff_intent",
      detail: JSON.stringify({
        tool: "no-mistakes",
        invocationId: invocation.invocationId,
        attempt: invocation.attempt,
      }),
    });
    envelope.facade.recordArtifact(roundId, {
      artifactId: `${roundId}-handoff-artifact-0`,
      artifactClass: "logs",
      path: evidencePath,
      digest: null,
      description: "partially persisted handoff evidence",
    });
    let handoffs = 0;
    let recoveries = 0;
    const adapter: DelegateSupervisorToolAdapter = {
      name: "no-mistakes",
      handoff: () => {
        handoffs += 1;
        throw new Error("interrupted handoff must not launch again");
      },
      recoverHandoff: () => {
        recoveries += 1;
        return {
          externalIdentity: {
            externalRunId: "nm-run-1",
            branch: "feature/delegate-supervisor",
            headSha: HEAD,
          },
          summary: "reattached interrupted handoff",
          artifactPaths: [evidencePath],
        };
      },
      readExternalState: () => {
        throw new Error("first resumed tick only settles handoff");
      },
    };
    const result = await driveExecutorTicks({
      db,
      invocationId: invocation.invocationId,
      executor: new DelegateSupervisorExecutor(),
      config: { tool: "no-mistakes" },
      hostBindings: { tools: { "no-mistakes": adapter } },
      now: () => 6,
    });
    expect(handoffs).toBe(0);
    expect(recoveries).toBe(1);
    expect(result.lastRound).toMatchObject({
      roundId,
      state: "succeeded",
      classification: "continue",
    });
    const resumed = createDurableExecutorEnvelope({
      db,
      invocationId: invocation.invocationId,
    }).snapshot();
    expect(resumed.rounds).toHaveLength(1);
    expect(resumed.currentRound?.artifacts).toHaveLength(1);
    expect(
      resumed.currentRound?.checkpoints.map((checkpoint) => checkpoint.stage),
    ).toEqual([
      "delegate_handoff_intent",
      "delegate_handoff_completed",
      "classified",
    ]);
    db.close();
  });

  it.each([HEAD.slice(0, 8), "A".repeat(40)])(
    "rejects a non-canonical handoff head SHA %s",
    async (headSha) => {
      const { db, invocation } = openDelegateDb();
      let settled: boolean | undefined;
      const result = await driveExecutorTicks({
        db,
        invocationId: invocation.invocationId,
        executor: new DelegateSupervisorExecutor(),
        config: { tool: "no-mistakes" },
        hostBindings: {
          tools: {
            "no-mistakes": {
              name: "no-mistakes",
              handoff: () => ({
                externalIdentity: {
                  externalRunId: "nm-run-1",
                  branch: "feature/delegate-supervisor",
                  headSha,
                },
                summary: "invalid handoff identity",
              }),
              readExternalState: () => {
                throw new Error("invalid handoff must not be polled");
              },
            },
          },
          settleHandoff: (provenClean: boolean) => {
            settled = provenClean;
          },
        },
        now: () => 6,
      });

      expect(result.lastRound).toMatchObject({
        state: "manual_recovery_required",
        classification: "manual_recovery_required",
        recoveryCode: "delegate_handoff_failed",
      });
      expect(result.ticks[0]?.reason).toEqual(
        expect.stringContaining(
          "must be a canonical full 40-character commit SHA",
        ),
      );
      expect(settled).toBe(false);
      expect(
        createDurableExecutorEnvelope({
          db,
          invocationId: invocation.invocationId,
        })
          .snapshot()
          .currentRound?.checkpoints.some(
            ({ stage }) => stage === "delegate_handoff_completed",
          ),
      ).toBe(false);
      db.close();
    },
  );

  it("settles cached terminal state only after fresh adapter corroboration", async () => {
    const { db, invocation } = openDelegateDb();
    let reads = 0;
    const completed = state({
      activeStep: null,
      stepStatus: "completed",
      ciState: "passed",
    });
    const adapter: DelegateSupervisorToolAdapter = {
      name: "no-mistakes",
      handoff: () => ({
        externalIdentity: {
          externalRunId: completed.externalRunId,
          branch: completed.branch,
          headSha: completed.headSha,
        },
        summary: "checks passed during handoff",
        terminalState: {
          value: completed,
          digest: "sha256:checks-passed-handoff",
        },
      }),
      readExternalState: () => {
        reads += 1;
        return {
          ok: true,
          value: state({ activeStep: null, ciState: "passed" }),
          digest: "sha256:fresh-head-corroboration",
        };
      },
    };
    const result = await driveExecutorTicks({
      db,
      invocationId: invocation.invocationId,
      executor: new DelegateSupervisorExecutor(),
      config: { tool: "no-mistakes" },
      hostBindings: { tools: { "no-mistakes": adapter } },
      maxTicks: 2,
      now: () => 6,
    });
    expect(reads).toBe(1);
    expect(result.invocation.state).toBe("succeeded");
    expect(result.lastRound).toMatchObject({
      classification: "complete",
      state: "succeeded",
      inputDigest: expect.stringMatching(/^sha256:/),
    });
    db.prepare(
      `UPDATE executor_invocations
          SET attempt = 2, state = 'running', finished_at = NULL
        WHERE invocation_id = ?`,
    ).run(invocation.invocationId);
    const retried = await driveExecutorTicks({
      db,
      invocationId: invocation.invocationId,
      executor: new DelegateSupervisorExecutor(),
      config: { tool: "no-mistakes" },
      hostBindings: { tools: {} },
      now: () => 7,
    });
    expect(retried.invocation.state).toBe("manual_recovery_required");
    expect(retried.lastRound).toMatchObject({
      classification: "manual_recovery_required",
      recoveryCode: "tool_adapter_unavailable",
    });
    expect(reads).toBe(1);
    db.close();
  });

  it("rejects a host binding whose adapter name does not match the tool key", async () => {
    const { db, invocation } = openDelegateDb();
    let handoffs = 0;
    const result = await driveExecutorTicks({
      db,
      invocationId: invocation.invocationId,
      executor: new DelegateSupervisorExecutor(),
      config: { tool: "no-mistakes" },
      hostBindings: {
        tools: {
          "no-mistakes": {
            name: "different-tool",
            handoff: () => {
              handoffs += 1;
              throw new Error("mismatched adapter must not run");
            },
            readExternalState: () => {
              throw new Error("mismatched adapter must not be polled");
            },
          },
        },
      },
      now: () => 7,
    });
    expect(handoffs).toBe(0);
    expect(result.lastRound).toMatchObject({
      classification: "manual_recovery_required",
      recoveryCode: "tool_adapter_unavailable",
    });
    db.close();
  });

  it("does not settle cached terminal state while fresh work remains active", async () => {
    const { db, invocation } = openDelegateDb();
    const completed = state({
      activeStep: null,
      stepStatus: "completed",
      ciState: "passed",
    });
    const adapter: DelegateSupervisorToolAdapter = {
      name: "no-mistakes",
      handoff: () => ({
        externalIdentity: {
          externalRunId: completed.externalRunId,
          branch: completed.branch,
          headSha: completed.headSha,
        },
        summary: "checks passed during handoff",
        terminalState: {
          value: completed,
          digest: "sha256:cached-terminal",
        },
      }),
      readExternalState: () => ({
        ok: true,
        value: state({
          activeStep: "review",
          stepStatus: "running",
          ciState: "passed",
        }),
        digest: "sha256:fresh-active-work",
      }),
    };

    const result = await driveExecutorTicks({
      db,
      invocationId: invocation.invocationId,
      executor: new DelegateSupervisorExecutor(),
      config: { tool: "no-mistakes" },
      hostBindings: { tools: { "no-mistakes": adapter } },
      maxTicks: 2,
      now: () => 6,
    });

    expect(result.invocation.state).toBe("running");
    expect(result.lastRound).toMatchObject({
      classification: "continue",
      state: "succeeded",
    });
    db.close();
  });

  it("classifies malformed terminal corroboration as unreadable", async () => {
    const { db, invocation } = openDelegateDb();
    const completed = state({
      activeStep: null,
      stepStatus: "completed",
      ciState: "passed",
    });
    const adapter: DelegateSupervisorToolAdapter = {
      name: "no-mistakes",
      handoff: () => ({
        externalIdentity: {
          externalRunId: completed.externalRunId,
          branch: completed.branch,
          headSha: completed.headSha,
        },
        summary: "checks passed during handoff",
        terminalState: {
          value: completed,
          digest: "sha256:cached-terminal",
        },
      }),
      readExternalState: () => ({
        ok: true,
        value: {
          ...state({ ciState: "passed" }),
          decisions: null,
        } as unknown as DelegateSupervisorExternalState,
        digest: "sha256:malformed-corroboration",
      }),
    };

    const result = await driveExecutorTicks({
      db,
      invocationId: invocation.invocationId,
      executor: new DelegateSupervisorExecutor(),
      config: { tool: "no-mistakes" },
      hostBindings: { tools: { "no-mistakes": adapter } },
      maxTicks: 2,
      now: () => 6,
    });

    expect(result.invocation.state).toBe("manual_recovery_required");
    expect(result.lastRound).toMatchObject({
      classification: "manual_recovery_required",
      recoveryCode: "external_state_unreadable",
    });
    db.close();
  });

  it("does not replace a fresh terminal failure with cached success", async () => {
    const { db, invocation } = openDelegateDb();
    let reads = 0;
    const completed = state({
      activeStep: null,
      stepStatus: "completed",
      ciState: "passed",
    });
    const adapter: DelegateSupervisorToolAdapter = {
      name: "no-mistakes",
      handoff: () => ({
        externalIdentity: {
          externalRunId: completed.externalRunId,
          branch: completed.branch,
          headSha: completed.headSha,
        },
        summary: "checks passed during handoff",
        terminalState: {
          value: completed,
          digest: "sha256:cached-terminal",
        },
      }),
      readExternalState: () => {
        reads += 1;
        return {
          ok: true,
          value: state({
            activeStep: null,
            stepStatus: "failed",
            ciState: "failed",
          }),
          digest: "sha256:fresh-terminal-failure",
        };
      },
    };

    const result = await driveExecutorTicks({
      db,
      invocationId: invocation.invocationId,
      executor: new DelegateSupervisorExecutor(),
      config: { tool: "no-mistakes" },
      hostBindings: { tools: { "no-mistakes": adapter } },
      maxTicks: 2,
      now: () => 6,
    });

    expect(reads).toBe(1);
    expect(result.invocation.state).toBe("failed");
    expect(result.lastRound).toMatchObject({
      classification: "failed",
      recoveryCode: "external_run_failed",
    });
    db.close();
  });

  it("recovers a prior-attempt handoff intent without launching again", async () => {
    const { db, invocation } = openDelegateDb();
    const envelope = createDurableExecutorEnvelope({
      db,
      invocationId: invocation.invocationId,
      now: () => 5,
    });
    const priorRoundId = `${invocation.invocationId}::round-1`;
    envelope.facade.startRound({
      roundId: priorRoundId,
      invocationId: invocation.invocationId,
      workflowRunId: invocation.workflowRunId,
      stepRunId: invocation.stepRunId,
      stepKey: invocation.stepKey,
      executorFamily: invocation.executorFamily,
      attempt: 1,
      roundIndex: 0,
      state: "running",
      agentProvider: null,
      model: null,
      effort: null,
      inputDigest: null,
      resultDigest: null,
      artifactRoot: null,
      logPaths: [],
      summary: "handoff intent persisted",
      keyChanges: [],
      keyLearnings: [],
      remainingWork: [],
      changedFiles: [],
      verificationStatus: null,
      commitSha: null,
    });
    envelope.facade.recordCheckpoint(priorRoundId, {
      checkpointId: `${priorRoundId}-delegate_handoff_intent`,
      sequence: 0,
      stage: "delegate_handoff_intent",
      detail: JSON.stringify({
        tool: "no-mistakes",
        invocationId: invocation.invocationId,
        attempt: 1,
      }),
    });
    envelope.applyDaemonDecision(
      {
        roundId: priorRoundId,
        classification: "manual_recovery_required",
        executorRecommendation: "manual_recovery_required",
        roundState: "manual_recovery_required",
        invocationState: "manual_recovery_required",
        recoveryCode: "executor_threw",
        humanGate: "manual_recovery_required",
      },
      {
        classificationCheckpoint: {
          checkpointId: `${priorRoundId}-classified`,
          sequence: 1,
          stage: "classified",
          detail: "interrupted after external launch",
        },
      },
    );
    db.prepare(
      `UPDATE executor_invocations
          SET attempt = 2, state = 'running', finished_at = NULL
        WHERE invocation_id = ?`,
    ).run(invocation.invocationId);
    let handoffs = 0;
    let recoveries = 0;
    const adapter: DelegateSupervisorToolAdapter = {
      name: "no-mistakes",
      handoff: () => {
        handoffs += 1;
        throw new Error("prior unresolved intent must prevent launch");
      },
      recoverHandoff: () => {
        recoveries += 1;
        return {
          externalIdentity: {
            externalRunId: "nm-run-1",
            branch: "feature/delegate-supervisor",
            headSha: HEAD,
          },
          summary: "reattached prior-attempt handoff",
        };
      },
      readExternalState: () => ({
        ok: true,
        value: state(),
        digest: "sha256:recovered-status",
      }),
    };
    const result = await driveExecutorTicks({
      db,
      invocationId: invocation.invocationId,
      executor: new DelegateSupervisorExecutor(),
      config: { tool: "no-mistakes" },
      hostBindings: { tools: { "no-mistakes": adapter } },
      now: () => 6,
    });
    expect(handoffs).toBe(0);
    expect(recoveries).toBe(1);
    expect(result.lastRound).toMatchObject({
      state: "succeeded",
      classification: "continue",
      recoveryCode: null,
    });
    expect(
      createDurableExecutorEnvelope({
        db,
        invocationId: invocation.invocationId,
      })
        .snapshot()
        .currentRound?.checkpoints.map(({ stage }) => stage),
    ).toEqual([
      "delegate_handoff_intent",
      "delegate_handoff_completed",
      "classified",
    ]);
    db.prepare(
      `UPDATE executor_invocations
          SET attempt = 3, state = 'running', finished_at = NULL
        WHERE invocation_id = ?`,
    ).run(invocation.invocationId);
    const retried = await driveExecutorTicks({
      db,
      invocationId: invocation.invocationId,
      executor: new DelegateSupervisorExecutor(),
      config: { tool: "no-mistakes" },
      hostBindings: { tools: { "no-mistakes": adapter } },
      now: () => 7,
    });
    expect(recoveries).toBe(2);
    expect(retried.lastRound).toMatchObject({
      state: "succeeded",
      classification: "continue",
    });
    db.close();
  });

  it("reattaches a completed handoff when retrying an external-state read", async () => {
    const { db, invocation } = openDelegateDb();
    let handoffs = 0;
    let recoveries = 0;
    let reads = 0;
    const handoff = {
      externalIdentity: {
        externalRunId: "nm-run-1",
        branch: "feature/delegate-supervisor",
        headSha: HEAD,
      },
      summary: "correlated delegated run",
    };
    const adapter: DelegateSupervisorToolAdapter = {
      name: "no-mistakes",
      handoff: () => {
        handoffs += 1;
        return handoff;
      },
      recoverHandoff: () => {
        recoveries += 1;
        return handoff;
      },
      readExternalState: () => {
        reads += 1;
        return reads === 1
          ? {
              ok: false,
              error: "external status is temporarily unreadable",
            }
          : {
              ok: true,
              value: state(),
              digest: "sha256:resumed-status",
            };
      },
    };
    const input = {
      db,
      invocationId: invocation.invocationId,
      executor: new DelegateSupervisorExecutor(),
      config: { tool: "no-mistakes" },
      hostBindings: { tools: { "no-mistakes": adapter } },
      now: () => 6,
    };
    const parked = await driveExecutorTicks({ ...input, maxTicks: 2 });
    expect(parked.lastRound).toMatchObject({
      state: "manual_recovery_required",
      recoveryCode: "external_state_unreadable",
    });

    db.prepare(
      `UPDATE executor_invocations
          SET attempt = 2, state = 'running', finished_at = NULL
        WHERE invocation_id = ?`,
    ).run(invocation.invocationId);
    const recovered = await driveExecutorTicks(input);

    expect(handoffs).toBe(1);
    expect(recoveries).toBe(1);
    expect(reads).toBe(1);
    expect(recovered.lastRound).toMatchObject({
      state: "succeeded",
      classification: "continue",
      recoveryCode: null,
    });

    const retried = await driveExecutorTicks(input);

    expect(recoveries).toBe(1);
    expect(reads).toBe(2);
    expect(retried.lastRound).toMatchObject({
      state: "succeeded",
      classification: "continue",
      recoveryCode: null,
    });
    db.close();
  });

  it("resets the semantic stall window for a new retry attempt", async () => {
    const { db, invocation } = openDelegateDb();
    const handoff = {
      externalIdentity: {
        externalRunId: "nm-run-1",
        branch: "feature/delegate-supervisor",
        headSha: HEAD,
      },
      summary: "handoff complete",
    };
    const adapter: DelegateSupervisorToolAdapter = {
      name: "no-mistakes",
      handoff: () => handoff,
      recoverHandoff: () => handoff,
      readExternalState: () => ({
        ok: true,
        value: state(),
        digest: "sha256:unchanged-retry-status",
      }),
    };
    const executor = new DelegateSupervisorExecutor();
    await driveExecutorTicks({
      db,
      invocationId: invocation.invocationId,
      executor,
      config: { tool: "no-mistakes" },
      hostBindings: { tools: { "no-mistakes": adapter }, now: () => 1 },
      now: () => 1,
    });
    await driveExecutorTicks({
      db,
      invocationId: invocation.invocationId,
      executor,
      config: { tool: "no-mistakes" },
      hostBindings: { tools: { "no-mistakes": adapter }, now: () => 2 },
      now: () => 2,
    });
    db.prepare(
      `UPDATE executor_invocations
          SET attempt = 2, state = 'running', finished_at = NULL
        WHERE invocation_id = ?`,
    ).run(invocation.invocationId);
    const retriedAt = DELEGATE_SUPERVISOR_STALL_AFTER_MS + 10;

    const retried = await driveExecutorTicks({
      db,
      invocationId: invocation.invocationId,
      executor,
      config: { tool: "no-mistakes" },
      hostBindings: {
        tools: { "no-mistakes": adapter },
        now: () => retriedAt,
      },
      now: () => retriedAt,
    });

    expect(retried.invocation.state).toBe("running");
    expect(retried.lastRound).toMatchObject({
      classification: "continue",
      recoveryCode: null,
    });
    db.close();
  });

  it("carries prior-attempt mirrored decisions into terminal corroboration", async () => {
    const { db, invocation } = openDelegateDb();
    let external = state({
      stepStatus: "awaiting_decision",
      decisions: [
        {
          externalId: "review",
          summary: "Choose a review disposition",
          allowedActions: ["approve", "reject"],
          recommendedAction: "approve",
          chosenAction: null,
          resolution: null,
        },
      ],
    });
    const adapter: DelegateSupervisorToolAdapter = {
      name: "no-mistakes",
      handoff: () => ({
        externalIdentity: {
          externalRunId: external.externalRunId,
          branch: external.branch,
          headSha: external.headSha,
        },
        summary: "handoff complete",
      }),
      recoverHandoff: () => ({
        externalIdentity: {
          externalRunId: external.externalRunId,
          branch: external.branch,
          headSha: external.headSha,
        },
        summary: "reattached handoff",
      }),
      readExternalState: () => ({
        ok: true,
        value: external,
        digest: "sha256:decision-history",
      }),
    };
    const input = {
      db,
      invocationId: invocation.invocationId,
      executor: new DelegateSupervisorExecutor(),
      config: { tool: "no-mistakes" },
      hostBindings: { tools: { "no-mistakes": adapter } },
      now: () => 6,
    };
    await driveExecutorTicks(input);
    const gated = await driveExecutorTicks(input);
    expect(gated.invocation.state).toBe("waiting_operator");
    db.prepare(
      `UPDATE executor_invocations
          SET attempt = 2, state = 'running', finished_at = NULL
        WHERE invocation_id = ?`,
    ).run(invocation.invocationId);
    external = state({
      activeStep: null,
      stepStatus: "completed",
      ciState: "passed",
      decisions: [],
    });

    await driveExecutorTicks(input);
    const retried = await driveExecutorTicks(input);

    expect(retried.invocation.state).toBe("manual_recovery_required");
    expect(retried.lastRound).toMatchObject({
      recoveryCode: "external_state_inconsistent",
      summary: expect.stringContaining(
        "previously mirrored decision(s) remain unresolved",
      ),
    });
    db.close();
  });

  it("finishes an interrupted checkpointed handoff round before supervision", async () => {
    const { db, invocation } = openDelegateDb();
    const envelope = createDurableExecutorEnvelope({
      db,
      invocationId: invocation.invocationId,
      now: () => 5,
    });
    const roundId = `${invocation.invocationId}::round-1`;
    envelope.facade.startRound({
      roundId,
      invocationId: invocation.invocationId,
      workflowRunId: invocation.workflowRunId,
      stepRunId: invocation.stepRunId,
      stepKey: invocation.stepKey,
      executorFamily: invocation.executorFamily,
      attempt: invocation.attempt,
      roundIndex: 0,
      state: "running",
      agentProvider: null,
      model: null,
      effort: null,
      inputDigest: null,
      resultDigest: null,
      artifactRoot: null,
      logPaths: [],
      summary: null,
      keyChanges: [],
      keyLearnings: [],
      remainingWork: [],
      changedFiles: [],
      verificationStatus: null,
      commitSha: null,
    });
    envelope.facade.recordRoundProgress(roundId, {
      observation: {
        phase: "capturing_result",
        summary: "no-mistakes accepted the delegated run",
      },
      checkpoints: [
        {
          checkpointId: `${roundId}-handoff`,
          sequence: 0,
          stage: "delegate_handoff_completed",
          detail: JSON.stringify({
            externalIdentity: {
              externalRunId: "nm-run-1",
              branch: "feature/delegate-supervisor",
              headSha: HEAD,
            },
            summary: "no-mistakes accepted the delegated run",
          }),
        },
      ],
    });
    let handoffs = 0;
    let settled = 0;
    const adapter: DelegateSupervisorToolAdapter = {
      name: "no-mistakes",
      handoff: () => {
        handoffs += 1;
        throw new Error("checkpointed handoff must not repeat");
      },
      readExternalState: () => ({
        ok: true,
        value: state({
          activeStep: null,
          stepStatus: "completed",
          ciState: "passed",
        }),
        digest: "sha256:terminal",
      }),
    };
    const result = await driveExecutorTicks({
      db,
      invocationId: invocation.invocationId,
      executor: new DelegateSupervisorExecutor(),
      config: { tool: "no-mistakes" },
      hostBindings: {
        tools: { "no-mistakes": adapter },
        settleHandoff: (provenClean: boolean) => {
          expect(provenClean).toBe(true);
          settled += 1;
        },
      },
      maxTicks: 2,
      now: () => 6,
    });
    expect(result.invocation.state).toBe("succeeded");
    expect(handoffs).toBe(0);
    expect(settled).toBe(1);
    db.close();
  });

  it("hands off to no-mistakes, mirrors progress rounds, and corroborates terminal success", async () => {
    const { db, invocation, root } = openDelegateDb();
    const statePath = path.join(root, "no-mistakes-state.json");
    writeState(statePath, state());
    let handoffs = 0;
    const adapter = createNoMistakesToolAdapter({
      handoff: () => {
        handoffs += 1;
        return {
          externalIdentity: {
            externalRunId: "nm-run-1",
            branch: "feature/delegate-supervisor",
            headSha: HEAD,
          },
          summary: "no-mistakes accepted the delegated run",
          artifactPaths: [statePath],
        };
      },
      statePath: () => statePath,
    });
    const executor = new DelegateSupervisorExecutor();
    const bindings = { tools: new Map([[adapter.name, adapter]]) };

    const handedOff = await driveExecutorTicks({
      db,
      invocationId: invocation.invocationId,
      executor,
      config: { tool: "no-mistakes" },
      hostBindings: bindings,
      now: () => 10,
    });
    expect(handoffs).toBe(1);
    expect(handedOff.invocation.state).toBe("running");
    expect(handedOff.lastRound).toMatchObject({
      state: "succeeded",
      classification: "continue",
    });

    const mirrored = await driveExecutorTicks({
      db,
      invocationId: invocation.invocationId,
      executor,
      config: { tool: "no-mistakes" },
      hostBindings: { ...bindings, now: () => 20 },
      now: () => 20,
    });
    expect(mirrored.invocation.state).toBe("running");
    expect(mirrored.lastRound).toMatchObject({
      state: "succeeded",
      classification: "continue",
      inputDigest: expect.stringMatching(/^sha256:/),
      resultDigest: expect.stringMatching(/^sha256:/),
      heartbeatAt: 20,
    });

    writeState(
      statePath,
      state({
        activeStep: null,
        stepStatus: "completed",
        ciState: "passed",
      }),
    );
    const completed = await driveExecutorTicks({
      db,
      invocationId: invocation.invocationId,
      executor,
      config: { tool: "no-mistakes" },
      hostBindings: { ...bindings, now: () => 30 },
      now: () => 30,
    });
    expect(handoffs).toBe(1);
    expect(completed.invocation.state).toBe("succeeded");
    expect(completed.lastRound).toMatchObject({
      state: "succeeded",
      classification: "complete",
      verificationStatus: null,
      commitSha: HEAD,
    });
    expect(completed.ticks).toHaveLength(1);
    db.close();
  });

  it.each([
    {
      action: "approve",
      expectedState: "succeeded",
      expectedRecovery: null,
    },
    {
      action: "reject",
      expectedState: "manual_recovery_required",
      expectedRecovery: "external_state_inconsistent",
    },
  ])(
    "requires approve to clear a durable synthetic approval ($action)",
    async ({ action, expectedState, expectedRecovery }) => {
      const { db, invocation } = openDelegateDb();
      let external = state({
        activeStep: "review",
        stepStatus: "awaiting_approval",
      });
      const adapter: DelegateSupervisorToolAdapter = {
        name: "no-mistakes",
        handoff: () => ({
          externalIdentity: {
            externalRunId: external.externalRunId,
            branch: external.branch,
            headSha: external.headSha,
          },
          summary: "handoff complete",
        }),
        readExternalState: () => ({
          ok: true,
          value: external,
          digest: "sha256:approval-transition",
        }),
      };
      const input = {
        db,
        invocationId: invocation.invocationId,
        executor: new DelegateSupervisorExecutor(),
        config: { tool: "no-mistakes" },
        hostBindings: { tools: { "no-mistakes": adapter } },
        now: () => 10,
      };
      await driveExecutorTicks(input);
      const gated = await driveExecutorTicks(input);
      expect(gated.invocation.state).toBe("waiting_operator");
      const approval = createDurableExecutorEnvelope({
        db,
        invocationId: invocation.invocationId,
      })
        .snapshot()
        .currentRound?.decisions.find(
          ({ externalRef }) =>
            externalRef === "delegate-supervisor:synthetic-approval-gate",
        );
      expect(approval).toBeDefined();
      const gateId = `${approval!.decisionId}::gate`;
      insertWorkflowGate(
        db,
        {
          gateId,
          workflowRunId: invocation.workflowRunId,
          stepRunId: invocation.stepRunId,
          invocationId: invocation.invocationId,
          roundId: gated.lastRound!.roundId,
          targetScope: "round",
          gateType: "approval_required",
          reason: approval!.summary,
          evidence: approval!.decisionId,
          allowedActions: approval!.allowedActions,
          recommendedAction: approval!.recommendedAction,
          policyEnvelope: [],
        },
        { now: 11 },
      );
      resolveWorkflowGateAndResumeRegisteredExecutor(
        db,
        gateId,
        {
          action,
          actor: "test-operator",
          mode: "operator",
          resolutionNote: action === "approve" ? "approved" : "rejected",
        },
        { now: 12 },
      );
      external = state({
        activeStep: null,
        stepStatus: "completed",
        ciState: "passed",
      });

      const completed = await driveExecutorTicks(input);

      expect(completed.invocation.state).toBe(expectedState);
      expect(completed.lastRound?.recoveryCode).toBe(expectedRecovery);
      db.close();
    },
  );

  it("uses the latest synthetic approval when a rejected boundary is presented again", async () => {
    const { db, invocation } = openDelegateDb();
    let external = state({
      activeStep: "review",
      stepStatus: "awaiting_approval",
    });
    const adapter: DelegateSupervisorToolAdapter = {
      name: "no-mistakes",
      handoff: () => ({
        externalIdentity: {
          externalRunId: external.externalRunId,
          branch: external.branch,
          headSha: external.headSha,
        },
        summary: "handoff complete",
      }),
      readExternalState: () => ({
        ok: true,
        value: external,
        digest: "sha256:approval-represented",
      }),
    };
    const input = {
      db,
      invocationId: invocation.invocationId,
      executor: new DelegateSupervisorExecutor(),
      config: { tool: "no-mistakes" },
      hostBindings: { tools: { "no-mistakes": adapter } },
      now: () => 10,
    };
    await driveExecutorTicks(input);
    await driveExecutorTicks(input);

    const resolveCurrentApproval = (
      action: "approve" | "reject",
      now: number,
    ) => {
      const snapshot = createDurableExecutorEnvelope({
        db,
        invocationId: invocation.invocationId,
      }).snapshot();
      const round = snapshot.currentRound!;
      const approval = [...round.decisions]
        .reverse()
        .find(
          ({ chosenAction, externalRef }) =>
            chosenAction === null &&
            externalRef === "delegate-supervisor:synthetic-approval-gate",
        )!;
      const gateId = `${approval.decisionId}::gate`;
      insertWorkflowGate(
        db,
        {
          gateId,
          workflowRunId: invocation.workflowRunId,
          stepRunId: invocation.stepRunId,
          invocationId: invocation.invocationId,
          roundId: round.round.roundId,
          targetScope: "round",
          gateType: "approval_required",
          reason: approval.summary,
          evidence: approval.decisionId,
          allowedActions: approval.allowedActions,
          recommendedAction: approval.recommendedAction,
          policyEnvelope: [],
        },
        { now },
      );
      resolveWorkflowGateAndResumeRegisteredExecutor(
        db,
        gateId,
        {
          action,
          actor: "test-operator",
          mode: "operator",
          resolutionNote: action,
        },
        { now: now + 1 },
      );
    };

    resolveCurrentApproval("reject", 11);
    const represented = await driveExecutorTicks(input);
    expect(represented.invocation.state).toBe("waiting_operator");
    resolveCurrentApproval("approve", 13);
    external = state({
      activeStep: null,
      stepStatus: "completed",
      ciState: "passed",
    });

    const completed = await driveExecutorTicks(input);

    expect(completed.invocation.state).toBe("succeeded");
    const approvalActions = createDurableExecutorEnvelope({
      db,
      invocationId: invocation.invocationId,
    })
      .snapshot()
      .rounds.flatMap(({ decisions }) =>
        decisions
          .filter(
            ({ externalRef }) =>
              externalRef === "delegate-supervisor:synthetic-approval-gate",
          )
          .map(({ chosenAction }) => chosenAction),
      );
    expect(approvalActions).toEqual(
      expect.arrayContaining(["reject", "approve"]),
    );
    db.close();
  });

  it("synthesizes an approval decision alongside resolved history", async () => {
    const { db, invocation } = openDelegateDb();
    const external = state({
      activeStep: "publish",
      stepStatus: "awaiting_approval",
      decisions: [
        {
          externalId: "review",
          summary: "Review completed",
          allowedActions: ["approve"],
          recommendedAction: "approve",
          chosenAction: "approve",
          resolution: "approved",
        },
      ],
    });
    const adapter: DelegateSupervisorToolAdapter = {
      name: "no-mistakes",
      handoff: () => ({
        externalIdentity: {
          externalRunId: external.externalRunId,
          branch: external.branch,
          headSha: external.headSha,
        },
        summary: "handoff complete",
      }),
      readExternalState: () => ({
        ok: true,
        value: external,
        digest: "sha256:approval-with-history",
      }),
    };
    const input = {
      db,
      invocationId: invocation.invocationId,
      executor: new DelegateSupervisorExecutor(),
      config: { tool: "no-mistakes" },
      hostBindings: { tools: { "no-mistakes": adapter } },
      now: () => 10,
    };
    await driveExecutorTicks(input);
    const gated = await driveExecutorTicks(input);

    expect(gated.invocation.state).toBe("waiting_operator");
    const decisions = createDurableExecutorEnvelope({
      db,
      invocationId: invocation.invocationId,
    }).snapshot().currentRound?.decisions;
    expect(decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          externalRef: "review",
          resolution: "approved",
        }),
        expect.objectContaining({
          externalRef: "delegate-supervisor:synthetic-approval-gate",
          resolution: null,
        }),
      ]),
    );
    db.close();
  });

  it("keeps the synthetic approval current alongside unresolved history", async () => {
    const { db, invocation } = openDelegateDb();
    const external = state({
      activeStep: "publish",
      stepStatus: "awaiting_approval",
      decisions: [
        {
          externalId: "historical-review",
          summary: "Choose how to resolve the historical review",
          allowedActions: ["retry", "abort"],
          recommendedAction: "retry",
          chosenAction: null,
          resolution: null,
        },
      ],
    });
    const adapter: DelegateSupervisorToolAdapter = {
      name: "no-mistakes",
      handoff: () => ({
        externalIdentity: {
          externalRunId: external.externalRunId,
          branch: external.branch,
          headSha: external.headSha,
        },
        summary: "handoff complete",
      }),
      readExternalState: () => ({
        ok: true,
        value: external,
        digest: "sha256:approval-with-unresolved-history",
      }),
    };
    const input = {
      db,
      invocationId: invocation.invocationId,
      executor: new DelegateSupervisorExecutor(),
      config: { tool: "no-mistakes" },
      hostBindings: { tools: { "no-mistakes": adapter } },
      now: () => 10,
    };
    await driveExecutorTicks(input);
    const gated = await driveExecutorTicks(input);

    expect(gated.invocation.state).toBe("waiting_operator");
    const unresolved = createDurableExecutorEnvelope({
      db,
      invocationId: invocation.invocationId,
    })
      .snapshot()
      .currentRound?.decisions.filter(
        (decision) => decision.chosenAction === null,
      );
    expect(unresolved?.at(-1)).toMatchObject({
      externalRef: "delegate-supervisor:synthetic-approval-gate",
      allowedActions: ["approve", "reject"],
      recommendedAction: "approve",
    });
    db.close();
  });

  it("versions resolved decision evidence when a gated round resumes", async () => {
    const { db, invocation } = openDelegateDb();
    let external = state({
      activeStep: "review",
      stepStatus: "awaiting_decision",
      decisions: [
        {
          externalId: "review",
          summary: "choose review disposition",
          allowedActions: ["approve"],
          recommendedAction: "approve",
          chosenAction: null,
          resolution: null,
        },
      ],
    });
    const adapter: DelegateSupervisorToolAdapter = {
      name: "no-mistakes",
      handoff: () => ({
        externalIdentity: {
          externalRunId: external.externalRunId,
          branch: external.branch,
          headSha: external.headSha,
        },
        summary: "handoff complete",
      }),
      readExternalState: () => ({
        ok: true,
        value: external,
        digest: "sha256:decision-transition",
      }),
    };
    const input = {
      db,
      invocationId: invocation.invocationId,
      executor: new DelegateSupervisorExecutor(),
      config: { tool: "no-mistakes" },
      hostBindings: { tools: { "no-mistakes": adapter } },
      now: () => 10,
    };
    await driveExecutorTicks(input);
    const gated = await driveExecutorTicks(input);
    expect(gated.invocation.state).toBe("waiting_operator");
    external = state({
      activeStep: null,
      stepStatus: "completed",
      ciState: "passed",
      decisions: [
        {
          externalId: "review",
          summary: "choose review disposition",
          allowedActions: ["approve"],
          recommendedAction: "approve",
          chosenAction: "approve",
          resolution: "approved",
        },
      ],
    });
    updateExecutorRound(db, gated.lastRound!.roundId, {
      toState: "running",
      classification: null,
      executorRecommendation: null,
      recoveryCode: null,
      humanGate: null,
      finishedAt: null,
    });
    updateExecutorInvocationState(db, invocation.invocationId, "running", {
      finishedAt: null,
    });
    const completed = await driveExecutorTicks(input);
    expect(completed.invocation.state).toBe("succeeded");
    const decisions = createDurableExecutorEnvelope({
      db,
      invocationId: invocation.invocationId,
    }).snapshot().currentRound?.decisions;
    expect(decisions).toHaveLength(2);
    expect(decisions?.at(-1)).toMatchObject({
      externalRef: "review",
      chosenAction: "approve",
      resolution: "approved",
    });
    db.close();
  });

  it("parks unchanged semantic progress after the four-minute stall boundary", async () => {
    const { db, invocation, root } = openDelegateDb();
    const statePath = path.join(root, "no-mistakes-state.json");
    const initialState = state({
      findings: [
        {
          externalId: "finding-b",
          title: "Finding B",
          severity: "warning",
          detail: "Second finding",
        },
        {
          externalId: "finding-a",
          title: "Finding A",
          severity: "error",
          detail: "First finding",
        },
      ],
      selectedFindingIds: ["finding-b", "finding-a"],
      decisions: [
        {
          externalId: "decision-b",
          summary: "Second decision",
          allowedActions: ["reject", "approve"],
          recommendedAction: "approve",
          chosenAction: null,
          resolution: null,
        },
        {
          externalId: "decision-a",
          summary: "First decision",
          allowedActions: ["skip", "retry"],
          recommendedAction: "retry",
          chosenAction: null,
          resolution: null,
        },
      ],
    });
    writeState(statePath, initialState);
    const adapter = createNoMistakesToolAdapter({
      handoff: () => ({
        externalIdentity: {
          externalRunId: "nm-run-1",
          branch: "feature/delegate-supervisor",
          headSha: HEAD,
        },
        summary: "handoff complete",
      }),
      statePath: () => statePath,
    });
    const executor = new DelegateSupervisorExecutor();
    const tools = new Map([[adapter.name, adapter]]);

    await driveExecutorTicks({
      db,
      invocationId: invocation.invocationId,
      executor,
      config: { tool: "no-mistakes" },
      hostBindings: { tools, now: () => 10 },
      now: () => 10,
    });
    await driveExecutorTicks({
      db,
      invocationId: invocation.invocationId,
      executor,
      config: { tool: "no-mistakes" },
      hostBindings: { tools, now: () => 20 },
      now: () => 20,
    });
    const reorderedState = state({
      findings: [
        {
          detail: "First finding",
          severity: "error",
          title: "Finding A",
          externalId: "finding-a",
        },
        {
          detail: "Second finding",
          severity: "warning",
          title: "Finding B",
          externalId: "finding-b",
        },
      ],
      selectedFindingIds: ["finding-a", "finding-b"],
      decisions: [
        {
          resolution: null,
          chosenAction: null,
          recommendedAction: "retry",
          allowedActions: ["retry", "skip"],
          summary: "First decision",
          externalId: "decision-a",
        },
        {
          resolution: null,
          chosenAction: null,
          recommendedAction: "approve",
          allowedActions: ["approve", "reject"],
          summary: "Second decision",
          externalId: "decision-b",
        },
      ],
    });
    expect(delegateSupervisorProgressDigest(reorderedState)).toBe(
      delegateSupervisorProgressDigest(initialState),
    );
    writeState(statePath, reorderedState);
    const stalledAt = 20 + DELEGATE_SUPERVISOR_STALL_AFTER_MS;
    const stalled = await driveExecutorTicks({
      db,
      invocationId: invocation.invocationId,
      executor,
      config: { tool: "no-mistakes" },
      hostBindings: { tools, now: () => stalledAt },
      now: () => stalledAt,
    });
    expect(stalled.invocation.state).toBe("manual_recovery_required");
    expect(stalled.lastRound).toMatchObject({
      state: "manual_recovery_required",
      classification: "manual_recovery_required",
      recoveryCode: "external_state_inconsistent",
      humanGate: "manual_recovery_required",
    });
    db.close();
  });

  it("refuses a completed claim contradicted by pending CI", async () => {
    const { db, invocation } = openDelegateDb();
    const adapter: DelegateSupervisorToolAdapter = {
      name: "no-mistakes",
      handoff: () => ({
        externalIdentity: {
          externalRunId: "nm-run-1",
          branch: "feature/delegate-supervisor",
          headSha: HEAD,
        },
        summary: "handoff complete",
      }),
      readExternalState: () => ({
        ok: true,
        value: state({ stepStatus: "completed", ciState: "pending" }),
        digest: "sha256:pending-ci",
      }),
    };
    const executor = new DelegateSupervisorExecutor();
    const bindings = { tools: { "no-mistakes": adapter }, now: () => 20 };
    await driveExecutorTicks({
      db,
      invocationId: invocation.invocationId,
      executor,
      config: { tool: "no-mistakes" },
      hostBindings: bindings,
      now: () => 10,
    });
    const result = await driveExecutorTicks({
      db,
      invocationId: invocation.invocationId,
      executor,
      config: { tool: "no-mistakes" },
      hostBindings: bindings,
      now: () => 20,
    });
    expect(result.invocation.state).toBe("manual_recovery_required");
    expect(result.lastRound?.recoveryCode).toBe("external_state_inconsistent");
    db.close();
  });

  it("routes malformed adapter containers to unreadable recovery", async () => {
    const { db, invocation } = openDelegateDb();
    const adapter: DelegateSupervisorToolAdapter = {
      name: "no-mistakes",
      handoff: () => ({
        externalIdentity: {
          externalRunId: "nm-run-1",
          branch: "feature/delegate-supervisor",
          headSha: HEAD,
        },
        summary: "handoff complete",
      }),
      readExternalState: () => ({
        ok: true,
        value: {
          ...state(),
          findings: undefined,
        } as unknown as DelegateSupervisorExternalState,
        digest: "sha256:malformed",
      }),
    };
    const executor = new DelegateSupervisorExecutor();
    const bindings = { tools: new Map([[adapter.name, adapter]]) };
    await driveExecutorTicks({
      db,
      invocationId: invocation.invocationId,
      executor,
      config: { tool: "no-mistakes" },
      hostBindings: bindings,
      now: () => 10,
    });
    const result = await driveExecutorTicks({
      db,
      invocationId: invocation.invocationId,
      executor,
      config: { tool: "no-mistakes" },
      hostBindings: bindings,
      now: () => 20,
    });
    expect(result.lastRound).toMatchObject({
      classification: "manual_recovery_required",
      recoveryCode: "external_state_unreadable",
    });
    db.close();
  });

  it.each([
    ["failure without an error string", { ok: false, error: null }],
    [
      "success without an exact-source digest",
      {
        ok: true,
        value: state({
          activeStep: null,
          stepStatus: "completed",
          ciState: "passed",
        }),
      },
    ],
    [
      "success with an unknown head relation",
      {
        ok: true,
        value: state(),
        digest: "sha256:invalid-head-relation",
        headRelation: "same-branch",
      },
    ],
  ] as const)(
    "routes malformed adapter envelope %s to unreadable recovery",
    async (_label, malformedRead) => {
      const { db, invocation } = openDelegateDb();
      const adapter: DelegateSupervisorToolAdapter = {
        name: "no-mistakes",
        handoff: () => ({
          externalIdentity: {
            externalRunId: "nm-run-1",
            branch: "feature/delegate-supervisor",
            headSha: HEAD,
          },
          summary: "handoff complete",
        }),
        readExternalState: () => malformedRead as never,
      };
      const executor = new DelegateSupervisorExecutor();
      const bindings = { tools: new Map([[adapter.name, adapter]]) };
      await driveExecutorTicks({
        db,
        invocationId: invocation.invocationId,
        executor,
        config: { tool: "no-mistakes" },
        hostBindings: bindings,
        now: () => 10,
      });
      const result = await driveExecutorTicks({
        db,
        invocationId: invocation.invocationId,
        executor,
        config: { tool: "no-mistakes" },
        hostBindings: bindings,
        now: () => 20,
      });

      expect(result.lastRound).toMatchObject({
        classification: "manual_recovery_required",
        recoveryCode: "external_state_unreadable",
      });
      db.close();
    },
  );

  it("propagates cancellation raised while reading delegated state", async () => {
    const { db, invocation } = openDelegateDb();
    const controller = new AbortController();
    const reason = new Error("daemon claim cancelled");
    const adapter: DelegateSupervisorToolAdapter = {
      name: "no-mistakes",
      handoff: () => ({
        externalIdentity: {
          externalRunId: "nm-run-1",
          branch: "feature/delegate-supervisor",
          headSha: HEAD,
        },
        summary: "handoff complete",
      }),
      readExternalState: () => {
        controller.abort(reason);
        return Promise.reject(reason);
      },
    };
    const executor = new DelegateSupervisorExecutor();
    const input = {
      db,
      invocationId: invocation.invocationId,
      executor,
      config: { tool: "no-mistakes" },
      hostBindings: { tools: new Map([[adapter.name, adapter]]) },
      signal: controller.signal,
      now: () => 10,
    };
    await driveExecutorTicks(input);
    await expect(driveExecutorTicks(input)).rejects.toBe(reason);
    expect(
      createDurableExecutorEnvelope({
        db,
        invocationId: invocation.invocationId,
      }).snapshot().invocation.state,
    ).toBe("running");
    db.close();
  });

  it("supervises a second tool through adapter registration and portable config only", async () => {
    const { db, invocation } = openDelegateDb();
    const ciAdapter: DelegateSupervisorToolAdapter = {
      name: "ci-run",
      handoff: () => ({
        externalIdentity: {
          externalRunId: "ci-42",
          branch: "feature/delegate-supervisor",
          headSha: HEAD,
        },
        summary: "CI run dispatched",
      }),
      readExternalState: () => ({
        ok: true,
        value: state({
          externalRunId: "ci-42",
          activeStep: null,
          stepStatus: "completed",
          ciState: "passed",
        }),
        digest: "sha256:ci-42",
      }),
    };
    const executor = new DelegateSupervisorExecutor();
    const hostBindings = { tools: new Map([[ciAdapter.name, ciAdapter]]) };
    await driveExecutorTicks({
      db,
      invocationId: invocation.invocationId,
      executor,
      config: { tool: "ci-run" },
      hostBindings,
      now: () => 10,
    });
    const result = await driveExecutorTicks({
      db,
      invocationId: invocation.invocationId,
      executor,
      config: { tool: "ci-run" },
      hostBindings,
      now: () => 20,
    });
    expect(result.invocation.state).toBe("succeeded");
    expect(DELEGATE_SUPERVISOR_CONFIG_SCHEMA.properties.tool).toEqual({
      type: "string",
      minLength: 1,
    });
    db.close();
  });

  it.each([
    {
      relation: undefined,
      expectedState: "manual_recovery_required",
      expectedRecovery: "external_state_inconsistent",
    },
    {
      relation: "verified_descendant" as const,
      expectedState: "succeeded",
      expectedRecovery: null,
    },
  ])(
    "requires an adapter proof for changed external heads ($expectedState)",
    async ({ relation, expectedState, expectedRecovery }) => {
      const { db, invocation } = openDelegateDb();
      const adapter: DelegateSupervisorToolAdapter = {
        name: "ci-run",
        handoff: () => ({
          externalIdentity: {
            externalRunId: "ci-42",
            branch: "feature/delegate-supervisor",
            headSha: HEAD,
          },
          summary: "CI run dispatched",
        }),
        readExternalState: () => ({
          ok: true,
          value: state({
            externalRunId: "ci-42",
            headSha: "b".repeat(40),
            activeStep: null,
            stepStatus: "completed",
            ciState: "passed",
          }),
          digest: "sha256:ci-advanced",
          ...(relation !== undefined ? { headRelation: relation } : {}),
        }),
      };
      const result = await driveExecutorTicks({
        db,
        invocationId: invocation.invocationId,
        executor: new DelegateSupervisorExecutor(),
        config: { tool: "ci-run" },
        hostBindings: { tools: { "ci-run": adapter } },
        maxTicks: 2,
        now: () => 20,
      });
      expect(result.invocation.state).toBe(expectedState);
      expect(result.lastRound?.recoveryCode).toBe(expectedRecovery);
      db.close();
    },
  );

  it("does not checkpoint state from a mismatched external identity", async () => {
    const { db, invocation } = openDelegateDb();
    const adapter: DelegateSupervisorToolAdapter = {
      name: "ci-run",
      handoff: () => ({
        externalIdentity: {
          externalRunId: "ci-42",
          branch: "feature/delegate-supervisor",
          headSha: HEAD,
        },
        summary: "CI run dispatched",
      }),
      readExternalState: () => ({
        ok: true,
        value: state({ externalRunId: "untrusted-run" }),
        digest: "sha256:untrusted-raw-input",
      }),
    };
    const result = await driveExecutorTicks({
      db,
      invocationId: invocation.invocationId,
      executor: new DelegateSupervisorExecutor(),
      config: { tool: "ci-run" },
      hostBindings: { tools: { "ci-run": adapter } },
      maxTicks: 2,
      now: () => 20,
    });
    expect(result.lastRound).toMatchObject({
      inputDigest: "sha256:untrusted-raw-input",
      resultDigest: null,
      commitSha: null,
      summary: expect.stringContaining(
        "delegated external identity mismatch for externalRunId",
      ),
    });
    const currentRound = createDurableExecutorEnvelope({
      db,
      invocationId: invocation.invocationId,
    }).snapshot().currentRound;
    expect(
      currentRound?.checkpoints.some(
        (checkpoint) => checkpoint.stage === "delegate_external_state_mirrored",
      ),
    ).toBe(false);
    db.close();
  });
});

describe("profile-backed persisted delegate state", () => {
  it.each(["symbolic link", "oversized file", "named pipe"])(
    "rejects a %s before reading external-state bytes",
    async (artifactKind) => {
      const { db, invocation, root } = openDelegateDb();
      const statePath = path.join(root, "delegate-external-state.json");
      if (artifactKind === "symbolic link") {
        const targetPath = path.join(root, "external-state-target.json");
        writeState(targetPath, state());
        fs.symlinkSync(targetPath, statePath);
      } else if (artifactKind === "oversized file") {
        fs.writeFileSync(statePath, "{}");
        fs.truncateSync(statePath, LIVE_STEP_WRAPPER_RESULT_MAX_BYTES + 1);
      } else {
        execFileSync("mkfifo", [statePath]);
      }
      const adapter = createPersistedProfileDelegateToolAdapter({
        tool: "gnhf",
        repoPath: root,
        command: "/bin/false",
        argsPrefix: [],
        env: {},
      });

      const read = await adapter.readExternalState({
        invocation,
        config: { tool: "gnhf" },
        signal: new AbortController().signal,
        handoff: {
          externalIdentity: {
            externalRunId: "gnhf-run-1",
            branch: "feature/delegate-supervisor",
            headSha: HEAD,
          },
          summary: "persisted handoff",
          artifactPaths: [statePath],
        },
      });

      expect(read).toMatchObject({
        ok: false,
        error: expect.stringContaining(
          "delegated external state is not a bounded regular file",
        ),
      });
      db.close();
    },
  );

  it("does not refresh no-mistakes state through a symbolic link", async () => {
    const { db, invocation, root } = openDelegateDb();
    const targetPath = path.join(root, "protected-target.json");
    const original = JSON.stringify({ protected: true });
    fs.writeFileSync(targetPath, original);
    const statePath = path.join(root, "delegate-external-state.json");
    fs.symlinkSync(targetPath, statePath);
    const adapter = createPersistedProfileDelegateToolAdapter({
      tool: "no-mistakes",
      repoPath: root,
      command: "/bin/sh",
      argsPrefix: [
        "-c",
        `printf 'run:\n  id: "nm-run-1"\n  branch: feature/delegate-supervisor\n  status: running\n  head: ${HEAD}\nsteps[1]{step,status,findings,duration_ms}:\n  review,running,0,1\n'`,
      ],
      env: {},
    });

    await expect(
      adapter.readExternalState({
        invocation,
        config: { tool: "no-mistakes" },
        signal: new AbortController().signal,
        handoff: {
          externalIdentity: {
            externalRunId: "nm-run-1",
            branch: "feature/delegate-supervisor",
            headSha: HEAD,
          },
          summary: "persisted handoff",
          artifactPaths: [statePath],
        },
      }),
    ).rejects.toThrow(
      "previous delegated external state is unreadable: delegated external state is not a bounded regular file",
    );
    expect(fs.readFileSync(targetPath, "utf8")).toBe(original);
    db.close();
  });
});

describe("no-mistakes tool adapter", () => {
  const identity = {
    externalRunId: "nm-run-1",
    branch: "feature/delegate-supervisor",
    headSha: HEAD,
  };
  const parseStatus = (
    raw: string,
    expected: typeof identity,
    options: { previousState?: DelegateSupervisorExternalState } = {},
  ) =>
    parseNoMistakesAxiStatus(raw, expected, {
      resolveHeadSha: (abbreviatedHead) =>
        abbreviatedHead === HEAD.slice(0, abbreviatedHead.length) ? HEAD : null,
      ...options,
    });

  it.each([HEAD.slice(0, 8), "x".repeat(40)])(
    "requires a canonical full commit SHA before terminal classification",
    (headSha) => {
      expect(
        classifyDelegateSupervisorState(
          state({
            headSha,
            activeStep: null,
            stepStatus: "completed",
            ciState: "passed",
          }),
        ),
      ).toMatchObject({
        classification: "manual_recovery_required",
        recoveryCode: "external_state_unreadable",
      });
    },
  );

  it("reads launch identity without treating the bounded gate as status", () => {
    expect(
      parseNoMistakesLaunchIdentity(
        [
          "run:",
          '  id: "nm-run-1"',
          "gate: ci",
          "help[1]: inspect with `no-mistakes axi status --run nm-run-1`",
        ].join("\n"),
        { branch: identity.branch, headSha: identity.headSha },
      ),
    ).toEqual({ ok: true, value: identity });
  });

  it("ignores launch identities nested under historical sections", () => {
    expect(
      parseNoMistakesLaunchIdentity(
        ["historical:", '  id: "nm-run-old"'].join("\n"),
        { branch: identity.branch, headSha: identity.headSha },
      ),
    ).toEqual({
      ok: false,
      error: "no-mistakes launch output did not report the delegated run id",
    });
  });

  it("reads the current launch identity after historical output", () => {
    expect(
      parseNoMistakesLaunchIdentity(
        [
          "historical:",
          "  run:",
          '    id: "nm-run-old"',
          "run:",
          '  id: "nm-run-1"',
        ].join("\n"),
        { branch: identity.branch, headSha: identity.headSha },
      ),
    ).toEqual({ ok: true, value: identity });
  });

  it.each([
    [
      "conflicting launch id fields",
      ["run:", '  id: "nm-run-1"', 'id: "nm-run-other"'].join("\n"),
    ],
    [
      "duplicate launch run sections",
      ["run:", '  id: "nm-run-1"', "run:", '  id: "nm-run-other"'].join("\n"),
    ],
    [
      "conflicting top-level launch id fields",
      ['id: "nm-run-1"', 'id: "nm-run-other"'].join("\n"),
    ],
    [
      "duplicate top-level launch id fields",
      ['id: "nm-run-1"', 'id: "nm-run-1"'].join("\n"),
    ],
  ])("rejects %s", (_label, raw) => {
    expect(
      parseNoMistakesLaunchIdentity(raw, {
        branch: identity.branch,
        headSha: identity.headSha,
      }),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("ambiguous"),
    });
  });

  it("normalizes axi status into canonical delegated state", () => {
    const parsed = parseStatus(
      [
        "run:",
        '  id: "nm-run-1"',
        "  branch: feature/delegate-supervisor",
        "  status: running",
        "  head: aaaaaaaa",
        '  pr: "https://example.test/pull/1"',
        "  steps[1]{step,status,findings,duration_ms}:",
        "    ci,awaiting_approval,1,1000",
        "gate:",
        "  step: ci",
        "  status: awaiting_approval",
      ].join("\n"),
      identity,
    );
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        stepStatus: "awaiting_approval",
        activeStep: "ci",
        ciState: "pending",
        prUrl: "https://example.test/pull/1",
      },
    });
  });

  it("lets current gates override stale checks-passed output", () => {
    const parsed = parseStatus(
      [
        "run:",
        '  id: "nm-run-1"',
        "  branch: feature/delegate-supervisor",
        "  status: running",
        "  head: aaaaaaaa",
        '  pr: "https://example.test/pull/1"',
        "  findings: 1 awaiting",
        "outcome: checks-passed",
        "gate:",
        "  step: review",
        "  status: awaiting_approval",
      ].join("\n"),
      identity,
    );
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        stepStatus: "awaiting_approval",
        ciState: "pending",
        findings: [{ externalId: "active-findings" }],
      },
    });
  });

  it("preserves cancellation and decision gates for supervisor policy", () => {
    const cancelled = parseStatus(
      [
        "run:",
        '  id: "nm-run-1"',
        "  branch: feature/delegate-supervisor",
        "  status: cancelled",
        "  head: aaaaaaaa",
      ].join("\n"),
      identity,
    );
    expect(cancelled).toMatchObject({
      ok: true,
      value: { stepStatus: "cancelled" },
    });

    const decision = parseStatus(
      [
        "run:",
        '  id: "nm-run-1"',
        "  branch: feature/delegate-supervisor",
        "  status: running",
        "  head: aaaaaaaa",
        "gate:",
        "  step: review",
        "  status: awaiting_decision",
        "  summary: choose the review disposition",
        "help[1]: Run `no-mistakes axi respond --action approve`",
      ].join("\n"),
      identity,
    );
    expect(decision).toMatchObject({
      ok: true,
      value: {
        stepStatus: "awaiting_decision",
        decisions: [
          {
            summary: "choose the review disposition",
            allowedActions: ["approve"],
          },
        ],
      },
    });
  });

  it("carries resolution evidence forward when a decision step completes", () => {
    const gated = parseStatus(
      [
        "run:",
        '  id: "nm-run-1"',
        "  branch: feature/delegate-supervisor",
        "  status: running",
        "  head: aaaaaaaa",
        "gate:",
        "  step: review",
        "  status: awaiting_decision",
        "help[1]: Run `no-mistakes axi respond --action approve`",
      ].join("\n"),
      identity,
    );
    if (!gated.ok) throw new Error(gated.error);
    const completed = parseStatus(
      [
        "run:",
        '  id: "nm-run-1"',
        "  branch: feature/delegate-supervisor",
        "  status: completed",
        "  head: aaaaaaaa",
        "  steps[1]{step,status,findings,duration_ms}:",
        "    review,completed,0,1000",
        "outcome: passed",
      ].join("\n"),
      identity,
      { previousState: gated.value },
    );
    expect(completed).toMatchObject({
      ok: true,
      value: {
        stepStatus: "completed",
        decisions: [
          {
            externalId: "review",
            chosenAction: "external_resolution",
            resolution:
              "no-mistakes step review completed after its decision gate",
          },
        ],
      },
    });
  });

  it("preserves a resolved decision when a later decision gate appears", () => {
    const firstGate = parseStatus(
      [
        "run:",
        '  id: "nm-run-1"',
        "  branch: feature/delegate-supervisor",
        "  status: running",
        "  head: aaaaaaaa",
        "gate:",
        "  step: review",
        "  status: awaiting_decision",
        "help[1]: Run `no-mistakes axi respond --action approve`",
      ].join("\n"),
      identity,
    );
    if (!firstGate.ok) throw new Error(firstGate.error);
    const secondGate = parseStatus(
      [
        "run:",
        '  id: "nm-run-1"',
        "  branch: feature/delegate-supervisor",
        "  status: running",
        "  head: aaaaaaaa",
        "  steps[2]{step,status,findings,duration_ms}:",
        "    review,completed,0,1000",
        "    publish,awaiting_decision,0,0",
        "gate:",
        "  step: publish",
        "  status: awaiting_decision",
        "help[1]: Run `no-mistakes axi respond --action publish`",
      ].join("\n"),
      identity,
      { previousState: firstGate.value },
    );
    expect(secondGate).toMatchObject({
      ok: true,
      value: {
        stepStatus: "awaiting_decision",
        decisions: [
          {
            externalId: "review",
            chosenAction: "external_resolution",
            resolution:
              "no-mistakes step review completed after its decision gate",
          },
          {
            externalId: "publish",
            chosenAction: null,
            resolution: null,
          },
        ],
      },
    });
  });

  it("does not carry decisions from a different external run", () => {
    const parsed = parseStatus(
      [
        "run:",
        '  id: "nm-run-1"',
        "  branch: feature/delegate-supervisor",
        "  status: completed",
        "  head: aaaaaaaa",
        "outcome: passed",
      ].join("\n"),
      identity,
      {
        previousState: state({
          externalRunId: "nm-run-from-prior-attempt",
          decisions: [
            {
              externalId: "review",
              summary: "old decision",
              allowedActions: ["approve"],
              recommendedAction: "approve",
              chosenAction: null,
              resolution: null,
            },
          ],
        }),
      },
    );
    expect(parsed).toMatchObject({
      ok: true,
      value: { stepStatus: "completed", decisions: [] },
    });
  });

  it("refuses status without current head evidence", () => {
    const parsed = parseStatus(
      [
        "run:",
        '  id: "nm-run-1"',
        "  branch: feature/delegate-supervisor",
        "  status: completed",
      ].join("\n"),
      identity,
    );
    expect(parsed).toEqual({
      ok: false,
      error:
        "no-mistakes axi status did not report run id, branch, status, and head",
    });
  });

  it("does not infer absent checks from missing CI and PR evidence", () => {
    const parsed = parseStatus(
      [
        "run:",
        '  id: "nm-run-1"',
        "  branch: feature/delegate-supervisor",
        "  status: completed",
        "  head: aaaaaaaa",
      ].join("\n"),
      identity,
    );
    expect(parsed).toMatchObject({
      ok: true,
      value: { stepStatus: "completed", ciState: "pending", prUrl: null },
    });
    if (!parsed.ok) throw new Error(parsed.error);
    expect(classifyDelegateSupervisorState(parsed.value)).toMatchObject({
      classification: "manual_recovery_required",
      recoveryCode: "external_state_inconsistent",
    });
  });

  it("fails closed on unknown status vocabulary", () => {
    const parsed = parseStatus(
      [
        "run:",
        '  id: "nm-run-1"',
        "  branch: feature/delegate-supervisor",
        "  status: surprisingly_done",
        "  head: aaaaaaaa",
      ].join("\n"),
      identity,
    );
    expect(parsed).toEqual({
      ok: false,
      error:
        "no-mistakes axi status reported unknown run status surprisingly_done",
    });
  });

  it("treats an advanced external head as semantic progress", () => {
    const advancedHead = "b".repeat(40);
    const parsed = parseNoMistakesAxiStatus(
      [
        "run:",
        '  id: "nm-run-1"',
        "  branch: feature/delegate-supervisor",
        "  status: completed",
        "  head: bbbbbbbb",
        "outcome: passed",
      ].join("\n"),
      identity,
      {
        resolveHeadSha: () => advancedHead,
        isHeadDescendant: () => true,
      },
    );
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        headSha: advancedHead,
        stepStatus: "completed",
      },
    });
  });

  it("preserves an unresolved abbreviated external head", () => {
    const parsed = parseNoMistakesAxiStatus(
      [
        "run:",
        '  id: "nm-run-1"',
        "  branch: feature/delegate-supervisor",
        "  status: running",
        "  head: bbbbbbbb",
        "  steps[1]{step,status,findings,duration_ms}:",
        "    review,running,0,1000",
      ].join("\n"),
      identity,
      {
        resolveHeadSha: () => null,
        isHeadDescendant: () => true,
      },
    );
    expect(parsed).toMatchObject({
      ok: true,
      value: { headSha: "bbbbbbbb", stepStatus: "running" },
    });
    if (!parsed.ok) throw new Error(parsed.error);
    expect(classifyDelegateSupervisorState(parsed.value).classification).toBe(
      "continue",
    );
    expect(settleNoMistakesHandoffState(parsed, HEAD)).toBe(parsed);
  });

  it("rejects a changed head outside the launch ancestry", () => {
    const parsed = parseNoMistakesAxiStatus(
      [
        "run:",
        '  id: "nm-run-1"',
        "  branch: feature/delegate-supervisor",
        "  status: completed",
        "  head: bbbbbbbb",
        "outcome: passed",
      ].join("\n"),
      identity,
      {
        resolveHeadSha: () => "b".repeat(40),
        isHeadDescendant: () => false,
      },
    );
    expect(parsed).toEqual({
      ok: false,
      error: `no-mistakes axi status head bbbbbbbb is not a verified descendant of launch head ${HEAD}`,
    });
  });

  it("preserves pending status despite terminal proof and historical work", () => {
    const status = parseNoMistakesAxiStatus(
      [
        "run:",
        '  id: "nm-run-1"',
        "  branch: feature/delegate-supervisor",
        "  status: running",
        "  head: bbbbbbbb",
        '  findings: "3 awaiting, 1 auto-fix"',
        "  steps[1]{step,status,findings,duration_ms}:",
        "    ci,running,0,1000",
      ].join("\n"),
      identity,
      {
        resolveHeadSha: () => "b".repeat(40),
        isHeadDescendant: () => true,
      },
    );
    if (!status.ok) throw new Error(status.error);
    expect(status.value.findings).toEqual([
      expect.objectContaining({
        externalId: "active-findings",
        detail:
          "aggregate run findings remain, but every current step row reports zero findings",
      }),
    ]);
    expect(classifyDelegateSupervisorState(status.value).classification).toBe(
      "continue",
    );

    const settled = settleNoMistakesHandoffState(status, "b".repeat(40));
    expect(settled).toBe(status);
    expect(classifyDelegateSupervisorState(settled.value).classification).toBe(
      "continue",
    );
  });

  it("does not apply terminal handoff proof to a different head", () => {
    const read = {
      ok: true as const,
      value: state({ headSha: "b".repeat(40), ciState: "passed" }),
      digest: "sha256:newer-head-status",
      headRelation: "verified_descendant" as const,
    };
    expect(settleNoMistakesHandoffState(read, HEAD)).toBe(read);
  });

  it("does not settle terminal handoff proof from an abbreviated commit identity", () => {
    const read = {
      ok: true as const,
      value: state({ ciState: "passed" }),
      digest: "sha256:resolved-head-status",
    };
    expect(settleNoMistakesHandoffState(read, HEAD.slice(0, 8))).toBe(read);
  });

  it("does not override pending CI at the terminal proof head", () => {
    const read = {
      ok: true as const,
      value: state({ ciState: "pending" }),
      digest: "sha256:pending-current-status",
    };
    expect(settleNoMistakesHandoffState(read, HEAD)).toBe(read);
  });

  it.each([
    state({ activeStep: null, stepStatus: "failed", ciState: "failed" }),
    state({ activeStep: null, stepStatus: "cancelled" }),
    state({ activeStep: "review", stepStatus: "running", ciState: "passed" }),
    state({
      activeStep: "review",
      stepStatus: "awaiting_decision",
      decisions: [
        {
          externalId: "review",
          summary: "choose a disposition",
          allowedActions: ["approve"],
          recommendedAction: "approve",
          chosenAction: null,
          resolution: null,
        },
      ],
    }),
    state({
      findings: [
        {
          externalId: "current-finding",
          title: "current finding",
          severity: null,
          detail: null,
        },
      ],
    }),
    state({ ciState: "failed" }),
  ])("does not overwrite contradictory current status evidence", (value) => {
    const read = { ok: true as const, value, digest: "sha256:current-status" };
    expect(settleNoMistakesHandoffState(read, HEAD)).toBe(read);
  });

  it.each(["passed", "none"] as const)(
    "preserves terminal handoff evidence while status still monitors with %s CI",
    (ciState) => {
      const read = {
        ok: true as const,
        value: state({ activeStep: null, ciState }),
        digest: `sha256:monitoring-${ciState}`,
      };
      const settled = settleNoMistakesHandoffState(read, HEAD);
      expect(settled.value).toMatchObject({
        activeStep: null,
        stepStatus: "completed",
        ciState,
      });
      expect(
        classifyDelegateSupervisorState(settled.value).classification,
      ).toBe("complete");
    },
  );

  it("gives blocking outcomes and current CI evidence precedence", () => {
    const failed = parseStatus(
      [
        "run:",
        '  id: "nm-run-1"',
        "  branch: feature/delegate-supervisor",
        "  status: completed",
        "  head: aaaaaaaa",
        '  pr: "https://example.test/pull/1"',
        "  steps[1]{step,status,findings,duration_ms}:",
        "    ci,completed,0,1000",
        "outcome: failed",
      ].join("\n"),
      identity,
    );
    expect(failed).toMatchObject({
      ok: true,
      value: { stepStatus: "failed", ciState: "passed" },
    });

    const stalePassed = parseStatus(
      [
        "run:",
        '  id: "nm-run-1"',
        "  branch: feature/delegate-supervisor",
        "  status: completed",
        "  head: aaaaaaaa",
        '  pr: "https://example.test/pull/1"',
        "  steps[1]{step,status,findings,duration_ms}:",
        "    ci,pending,0,1000",
        "outcome: checks-passed",
      ].join("\n"),
      identity,
    );
    expect(stalePassed).toMatchObject({
      ok: true,
      value: { stepStatus: "running", ciState: "pending" },
    });
  });

  it("refuses terminal no-mistakes state while a step row is still active", () => {
    const parsed = parseStatus(
      [
        "run:",
        '  id: "nm-run-1"',
        "  branch: feature/delegate-supervisor",
        "  status: completed",
        "  head: aaaaaaaa",
        "  steps[2]{step,status,findings,duration_ms}:",
        "    review,failed,0,1000",
        "    ci,completed,0,1000",
        "outcome: checks-passed",
      ].join("\n"),
      identity,
    );
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        activeStep: "review",
        stepStatus: "completed",
        ciState: "passed",
      },
    });
    if (!parsed.ok) throw new Error(parsed.error);
    expect(classifyDelegateSupervisorState(parsed.value)).toMatchObject({
      classification: "manual_recovery_required",
      recoveryCode: "external_state_inconsistent",
    });
  });

  it("keeps pending non-CI work active after CI completes", () => {
    const parsed = parseStatus(
      [
        "run:",
        '  id: "nm-run-1"',
        "  branch: feature/delegate-supervisor",
        "  status: running",
        "  head: aaaaaaaa",
        '  pr: "https://example.test/pull/1"',
        "  clean: true",
        "  steps[2]{step,status,findings,duration_ms}:",
        "    ci,completed,0,1000",
        "    review,pending,0,0",
        "outcome: checks-passed",
      ].join("\n"),
      identity,
    );
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        activeStep: "review",
        stepStatus: "running",
        ciState: "passed",
      },
    });
    if (!parsed.ok) throw new Error(parsed.error);
    expect(classifyDelegateSupervisorState(parsed.value).classification).toBe(
      "continue",
    );
  });

  it.each([
    {
      name: "a malformed row",
      table: [
        "  steps[2]{step,status,findings,duration_ms}:",
        "    review,failed,0",
        "    ci,completed,0,1000",
      ],
      error: "no-mistakes axi status reported a malformed steps table row",
    },
    {
      name: "a mismatched declared row count",
      table: [
        "  steps[2]{step,status,findings,duration_ms}:",
        "    ci,completed,0,1000",
      ],
      error:
        "no-mistakes axi status steps table declared 2 rows but reported 1",
    },
    {
      name: "a malformed declaration",
      table: [
        "  steps[2] {step,status,findings,duration_ms}:",
        "    review,failed,0,1000",
        "    ci,completed,0,1000",
      ],
      error: "no-mistakes axi status reported a malformed steps table",
    },
    {
      name: "an unknown row status",
      table: [
        "  steps[1]{step,status,findings,duration_ms}:",
        "    review,garbage,0,1000",
      ],
      error: "no-mistakes axi status reported unknown step status garbage",
    },
    {
      name: "noncanonical row casing",
      table: [
        "  steps[1]{step,status,findings,duration_ms}:",
        "    Review,completed,0,1000",
      ],
      error: "no-mistakes axi status reported a malformed steps table row",
    },
    {
      name: "a duplicate step identity",
      table: [
        "  steps[2]{step,status,findings,duration_ms}:",
        "    review,pending,0,0",
        "    review,completed,0,1000",
      ],
      error: "no-mistakes axi status reported duplicate step review",
    },
  ])("fails closed when a steps table contains $name", ({ table, error }) => {
    const parsed = parseStatus(
      [
        "run:",
        '  id: "nm-run-1"',
        "  branch: feature/delegate-supervisor",
        "  status: completed",
        "  head: aaaaaaaa",
        ...table,
        "outcome: checks-passed",
      ].join("\n"),
      identity,
    );
    expect(parsed).toEqual({ ok: false, error });
  });

  it.each([
    {
      name: "outcome",
      extra: ["outcome: checks-passed", "outcome: failed"],
      error:
        "no-mistakes axi status reported ambiguous duplicate outcome fields",
    },
    {
      name: "run status",
      extra: ["  status: failed", "outcome: checks-passed"],
      error:
        "no-mistakes axi status reported ambiguous duplicate run.status fields",
    },
    {
      name: "whitespace-variant run section",
      extra: [
        "run:   ",
        '  id: "nm-run-1"',
        "  branch: feature/delegate-supervisor",
        "  status: failed",
        "  head: aaaaaaaa",
        "outcome: checks-passed",
      ],
      error:
        "no-mistakes axi status reported ambiguous noncanonical run section",
    },
    {
      name: "contradictory clean aliases",
      extra: ["  pr_clean: true", "  clean: false", "outcome: checks-passed"],
      error:
        "no-mistakes axi status reported ambiguous conflicting run clean aliases",
    },
    {
      name: "duplicate clean fields",
      extra: ["  clean: true", "  clean: false", "outcome: checks-passed"],
      error:
        "no-mistakes axi status reported ambiguous duplicate run.clean fields",
    },
  ])("rejects contradictory duplicate $name evidence", ({ extra, error }) => {
    const parsed = parseStatus(
      [
        "run:",
        '  id: "nm-run-1"',
        "  branch: feature/delegate-supervisor",
        "  status: completed",
        "  head: aaaaaaaa",
        ...extra,
      ].join("\n"),
      identity,
    );
    expect(parsed).toEqual({ ok: false, error });
  });

  it("derives CI status only from the validated steps table", () => {
    const parsed = parseStatus(
      [
        "run:",
        '  id: "nm-run-1"',
        "  branch: feature/delegate-supervisor",
        "  status: completed",
        "  head: aaaaaaaa",
        "  ci,completed,0,1000",
        "  steps[1]{step,status,findings,duration_ms}:",
        "    ci,pending,0,1000",
        "outcome: checks-passed",
      ].join("\n"),
      identity,
    );
    expect(parsed).toMatchObject({
      ok: true,
      value: { stepStatus: "running", ciState: "pending" },
    });
  });

  it("preserves ungated phase changes as supervisor progress", () => {
    const review = parseStatus(
      [
        "run:",
        '  id: "nm-run-1"',
        "  branch: feature/delegate-supervisor",
        "  status: running",
        "  head: aaaaaaaa",
        "  steps[2]{step,status,findings,duration_ms}:",
        "    review,running,0,1000",
        "    test,pending,0,0",
      ].join("\n"),
      identity,
    );
    const test = parseStatus(
      [
        "run:",
        '  id: "nm-run-1"',
        "  branch: feature/delegate-supervisor",
        "  status: running",
        "  head: aaaaaaaa",
        "  steps[2]{step,status,findings,duration_ms}:",
        "    review,completed,0,1000",
        "    test,running,0,1000",
      ].join("\n"),
      identity,
    );
    expect(review).toMatchObject({ ok: true, value: { activeStep: "review" } });
    expect(test).toMatchObject({ ok: true, value: { activeStep: "test" } });
  });

  it("normalizes explicitly skipped checks as absent", () => {
    const parsed = parseStatus(
      [
        "run:",
        '  id: "nm-run-1"',
        "  branch: feature/delegate-supervisor",
        "  status: completed",
        "  head: aaaaaaaa",
        '  pr: "https://example.test/pull/1"',
        "  steps[1]{step,status,findings,duration_ms}:",
        "    ci,skipped,0,1000",
      ].join("\n"),
      identity,
    );
    expect(parsed).toMatchObject({
      ok: true,
      value: { stepStatus: "completed", ciState: "none" },
    });
  });

  it("accepts the terminal passed outcome", () => {
    const parsed = parseStatus(
      [
        "run:",
        '  id: "nm-run-1"',
        "  branch: feature/delegate-supervisor",
        "  status: completed",
        "  head: aaaaaaaa",
        '  pr: "https://example.test/pull/1"',
        "outcome: passed",
      ].join("\n"),
      identity,
    );
    expect(parsed).toMatchObject({
      ok: true,
      value: { stepStatus: "completed", ciState: "passed" },
    });
  });

  it("settles clean green monitoring as terminal success", () => {
    const parsed = parseStatus(
      [
        "run:",
        '  id: "nm-run-1"',
        "  branch: feature/delegate-supervisor",
        "  status: running",
        "  head: aaaaaaaa",
        '  pr: "https://example.test/pull/1"',
        "  clean: true",
        "  steps[1]{step,status,findings,duration_ms}:",
        "    ci,completed,0,1000",
      ].join("\n"),
      identity,
    );
    expect(parsed).toMatchObject({
      ok: true,
      value: { stepStatus: "completed", ciState: "passed" },
    });
  });

  it("ignores clean PR evidence nested under historical sections", () => {
    const parsed = parseStatus(
      [
        "run:",
        '  id: "nm-run-1"',
        "  branch: feature/delegate-supervisor",
        "  status: running",
        "  head: aaaaaaaa",
        '  pr: "https://example.test/pull/1"',
        "  steps[1]{step,status,findings,duration_ms}:",
        "    ci,completed,0,1000",
        "history:",
        "  clean: true",
      ].join("\n"),
      identity,
    );
    expect(parsed).toMatchObject({
      ok: true,
      value: { stepStatus: "running" },
    });
  });

  it("ignores clean PR evidence from unrelated current sections", () => {
    const parsed = parseStatus(
      [
        "run:",
        '  id: "nm-run-1"',
        "  branch: feature/delegate-supervisor",
        "  status: running",
        "  head: aaaaaaaa",
        '  pr: "https://example.test/pull/1"',
        "  steps[1]{step,status,findings,duration_ms}:",
        "    ci,completed,0,1000",
        "notes:",
        "  clean: true",
      ].join("\n"),
      identity,
    );
    expect(parsed).toMatchObject({
      ok: true,
      value: { stepStatus: "running" },
    });
  });

  it("keeps polling a running run when a step row reports findings", () => {
    const parsed = parseStatus(
      [
        "run:",
        '  id: "nm-run-1"',
        "  branch: feature/delegate-supervisor",
        "  status: running",
        "  head: aaaaaaaa",
        '  pr: "https://example.test/pull/1"',
        "  clean: true",
        "  steps[1]{step,status,findings,duration_ms}:",
        "    ci,completed,1,1000",
      ].join("\n"),
      identity,
    );
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        stepStatus: "running",
        findings: [{ externalId: "active-findings" }],
      },
    });
  });

  it("preserves completed status when terminal findings remain", () => {
    const parsed = parseStatus(
      [
        "run:",
        '  id: "nm-run-1"',
        "  branch: feature/delegate-supervisor",
        "  status: completed",
        "  head: aaaaaaaa",
        "  findings: 1 unresolved",
        "outcome: passed",
      ].join("\n"),
      identity,
    );
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        stepStatus: "completed",
        findings: [{ externalId: "active-findings" }],
      },
    });
    if (!parsed.ok) throw new Error(parsed.error);
    expect(classifyDelegateSupervisorState(parsed.value)).toMatchObject({
      classification: "manual_recovery_required",
      recoveryCode: "external_state_inconsistent",
    });
  });

  it("keeps dirty or draft pull requests nonterminal", () => {
    for (const prEvidence of ["  draft: true", "  merge_state: dirty"]) {
      const parsed = parseStatus(
        [
          "run:",
          '  id: "nm-run-1"',
          "  branch: feature/delegate-supervisor",
          "  status: completed",
          "  head: aaaaaaaa",
          '  pr: "https://example.test/pull/1"',
          prEvidence,
          "  steps[1]{step,status,findings,duration_ms}:",
          "    ci,completed,0,1000",
          "outcome: checks-passed",
        ].join("\n"),
        identity,
      );
      expect(parsed).toMatchObject({
        ok: true,
        value: { stepStatus: "blocked", ciState: "passed" },
      });
    }
  });

  it("preserves the raw refresh digest through the adapter boundary", async () => {
    const refreshed = {
      ok: true as const,
      value: state(),
      digest: "sha256:raw-axi-status",
    };
    const adapter = createNoMistakesToolAdapter({
      handoff: () => ({ externalIdentity: identity, summary: "handed off" }),
      statePath: () => "unused",
      refreshState: () => refreshed,
      read: () => {
        throw new Error("normalized fallback should not run after refresh");
      },
    });
    const { invocation, db } = openDelegateDb();
    await expect(
      adapter.readExternalState({
        invocation,
        config: { tool: "no-mistakes" },
        signal: new AbortController().signal,
        handoff: { externalIdentity: identity, summary: "handed off" },
      }),
    ).resolves.toEqual(refreshed);
    db.close();
  });

  it("refuses terminal completion while active findings remain", () => {
    expect(
      classifyDelegateSupervisorState(
        state({
          stepStatus: "completed",
          ciState: "passed",
          findings: [
            {
              externalId: "review-1",
              title: "unresolved review finding",
            },
          ],
        }),
      ),
    ).toMatchObject({
      classification: "manual_recovery_required",
      recoveryCode: "external_state_inconsistent",
    });
  });

  it("refuses a chosen action outside the decision's allowed actions", () => {
    expect(
      classifyDelegateSupervisorState(
        state({
          activeStep: null,
          stepStatus: "completed",
          ciState: "passed",
          decisions: [
            {
              externalId: "review-1",
              summary: "choose the review disposition",
              allowedActions: ["approve"],
              chosenAction: "reject",
              resolution: "rejected",
            },
          ],
        }),
      ),
    ).toMatchObject({
      classification: "manual_recovery_required",
      recoveryCode: "external_state_unreadable",
    });
  });

  it("routes non-canonical decision actions to unreadable recovery", () => {
    expect(
      classifyDelegateSupervisorState(
        state({
          stepStatus: "awaiting_decision",
          decisions: [
            {
              externalId: "review-1",
              summary: "choose the review disposition",
              allowedActions: [" approve "],
              recommendedAction: " approve ",
              chosenAction: null,
              resolution: null,
            },
          ],
        }),
      ),
    ).toMatchObject({
      classification: "manual_recovery_required",
      recoveryCode: "external_state_unreadable",
    });
  });

  it("rejects the supervisor's reserved synthetic approval decision id", () => {
    expect(
      classifyDelegateSupervisorState(
        state({
          stepStatus: "awaiting_decision",
          decisions: [
            {
              externalId: "delegate-supervisor:synthetic-approval-gate",
              summary: "real delegated-tool decision",
              allowedActions: ["approve"],
              recommendedAction: "approve",
              chosenAction: null,
              resolution: null,
            },
          ],
        }),
      ),
    ).toMatchObject({
      classification: "manual_recovery_required",
      recoveryCode: "external_state_unreadable",
    });
  });

  it("refuses duplicate selected finding ids", () => {
    expect(
      classifyDelegateSupervisorState(
        state({
          findings: [
            {
              externalId: "review-1",
              title: "unresolved review finding",
            },
          ],
          selectedFindingIds: ["review-1", "review-1"],
        }),
      ),
    ).toMatchObject({
      classification: "manual_recovery_required",
      recoveryCode: "external_state_unreadable",
    });
  });
});
