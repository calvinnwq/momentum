import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/adapters/db/route-state.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/adapters/db/route-state.js")>();
  return {
    ...actual,
    projectValidatedLegacyWorkflowRunRoute: vi.fn(
      actual.projectValidatedLegacyWorkflowRunRoute,
    ),
  };
});

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import { projectValidatedLegacyWorkflowRunRoute } from "../src/adapters/db/route-state.js";
import {
  DELEGATE_SUPERVISOR_CONFIG_SCHEMA,
  DelegateSupervisorExecutor,
} from "../src/core/executors/delegate-supervisor/executor.js";
import type { DelegateSupervisorToolAdapter } from "../src/core/executors/delegate-supervisor/types.js";
import type { Executor } from "../src/core/executors/sdk/types.js";
import { CODING_WORKFLOW_DEFINITION } from "../src/core/workflow/definition/definition.js";
import { persistWorkflowDefinition } from "../src/core/workflow/definition/persist.js";
import { executeWorkflowStepDispatch } from "../src/core/workflow/dispatch/execute.js";
import { createRegisteredExecutorWorkflowDispatch } from "../src/core/workflow/dispatch/registered-executor.js";
import { claimRunnableWorkflowStep } from "../src/core/workflow/dispatch/scheduler.js";
import { listWorkflowGatesForRun } from "../src/core/workflow/gate/persist.js";
import { clearWorkflowRunManualRecoveryGuarded } from "../src/core/workflow/run/recovery.js";
import { MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE } from "../src/core/workflow/run/start.js";
import { persistWorkflowRunStart } from "../src/core/workflow/run/start-persist.js";

const NOW = 1_700_000_000_000;
const WORKER = "canonical-agent-config-test";
const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function openTempDb(): MomentumDb {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "momentum-canonical-agent-config-"),
  );
  tempRoots.push(dir);
  return openDb(dir);
}

function seedNativeImplementationRun(runId: string): MomentumDb {
  const db = openTempDb();
  persistWorkflowRunStart(db, {
    definition: CODING_WORKFLOW_DEFINITION,
    runId,
    repoPath: "/repos/momentum",
    objective: "Prove canonical agent config ownership",
    now: NOW,
    source: MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE,
    route: {
      implementationEngine: "gnhf",
      steps: {
        implementation: {
          harness: "codex",
          model: "gpt-5.6-codex",
          effort: "high",
        },
      },
    },
  });
  db.prepare("UPDATE workflow_runs SET route_json = ? WHERE id = ?").run(
    JSON.stringify({
      steps: {
        implementation: {
          harness: "claude",
          model: "stale-model",
          effort: "low",
        },
      },
    }),
    runId,
  );
  return db;
}

function claimImplementation(db: MomentumDb, runId: string) {
  db.prepare(
    "UPDATE workflow_steps SET state = 'succeeded' WHERE run_id = ? AND step_id <> 'implementation'",
  ).run(runId);
  db.prepare(
    "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ? AND step_id = 'implementation'",
  ).run(runId);
  const claimed = claimRunnableWorkflowStep(db, {
    runId,
    stepId: "implementation",
    holder: WORKER,
    leaseExpiresAt: NOW + 30_000,
    now: NOW,
  });
  if (!claimed.ok) throw new Error(`claim failed: ${claimed.reason}`);
  return claimed.claim;
}

describe("native dispatch canonical agent config", () => {
  it("dispatches from the frozen step row and never from stale route.steps", () => {
    const runId = "canonical-agent-config-wins";
    const db = seedNativeImplementationRun(runId);
    try {
      expect(
        db
          .prepare(
            "SELECT agent_config_json FROM workflow_steps WHERE run_id = ? AND step_id = 'implementation'",
          )
          .get(runId),
      ).toEqual({
        agent_config_json:
          '{"harness":"codex","model":"gpt-5.6-codex","effort":"high"}',
      });

      const result = executeWorkflowStepDispatch(
        claimImplementation(db, runId),
        {
          db,
          workerId: WORKER,
          now: NOW + 1,
        },
      );

      expect(result.status).toBe("executor_dispatched");
      expect(
        db
          .prepare(
            `SELECT agent_provider AS agentProvider, model, effort
               FROM executor_rounds
              WHERE workflow_run_id = ? AND step_run_id = 'implementation'`,
          )
          .get(runId),
      ).toEqual({
        agentProvider: "codex",
        model: "gpt-5.6-codex",
        effort: "high",
      });
    } finally {
      db.close();
    }
  });

  it("carries the frozen selection through the registered native executor path", async () => {
    const runId = "canonical-agent-config-registered";
    const db = seedNativeImplementationRun(runId);
    const adapter: DelegateSupervisorToolAdapter = {
      name: "gnhf",
      handoff: () => ({
        externalIdentity: {
          externalRunId: "external-run",
          branch: "main",
          headSha: "a".repeat(40),
        },
        summary: "native handoff completed",
        terminalState: {
          value: {
            externalRunId: "external-run",
            branch: "main",
            headSha: "a".repeat(40),
            activeStep: null,
            stepStatus: "completed",
            findings: [],
            selectedFindingIds: [],
            decisions: [],
            prUrl: null,
            ciState: "passed",
          },
          digest: "external-state-digest",
        },
      }),
      readExternalState: ({ handoff }) => ({
        ok: true,
        value: handoff.terminalState!.value,
        digest: handoff.terminalState!.digest,
      }),
    };
    try {
      const production = createRegisteredExecutorWorkflowDispatch(
        executeWorkflowStepDispatch,
        {
          registry: new Map([
            ["delegate-supervisor", new DelegateSupervisorExecutor()],
          ]),
          resolveHostBindings: () => ({ tools: { gnhf: adapter } }),
        },
      );
      const projectRoute = vi.mocked(projectValidatedLegacyWorkflowRunRoute);
      projectRoute.mockClear();

      await production(claimImplementation(db, runId), {
        db,
        workerId: WORKER,
        now: NOW + 1,
      });

      expect(
        db
          .prepare(
            `SELECT agent_provider AS agentProvider, model, effort
               FROM executor_rounds
              WHERE workflow_run_id = ? AND step_run_id = 'implementation'`,
          )
          .get(runId),
      ).toEqual({
        agentProvider: "codex",
        model: "gpt-5.6-codex",
        effort: "high",
      });
      expect(projectRoute).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });

  it("does not pass an empty native selection to generic registered executors", async () => {
    const runId = "generic-registered-selection-fallback";
    const db = openTempDb();
    let observedSelection: unknown = "not-called";
    const executor: Executor = {
      name: "delegate-supervisor",
      configSchema: {
        type: "object",
        properties: {
          tool: { type: "string" },
        },
        additionalProperties: false,
      },
      tick(context) {
        observedSelection = context.selection;
        const attempt = context.state.attempt;
        const roundId = `${attempt.attemptId}::round-1`;
        context.envelope.startRound({
          roundId,
          attemptId: attempt.attemptId,
          workflowRunId: attempt.workflowRunId,
          stepRunId: attempt.stepRunId,
          stepKey: attempt.stepKey,
          executor: attempt.executor,
          attemptNumber: attempt.attemptNumber,
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
        return {
          roundId,
          recommendation: "complete",
          recommendedRoundState: "succeeded",
          recommendedAttemptState: "succeeded",
          recoveryCode: null,
          humanGate: null,
          reason: "generic executor completed",
        };
      },
    };
    persistWorkflowDefinition(db, CODING_WORKFLOW_DEFINITION, { now: NOW });
    persistWorkflowRunStart(db, {
      definition: CODING_WORKFLOW_DEFINITION,
      runId,
      repoPath: "/repos/momentum",
      objective: "Preserve generic executor fallback semantics",
      now: NOW,
    });
    try {
      const production = createRegisteredExecutorWorkflowDispatch(
        executeWorkflowStepDispatch,
        {
          registry: new Map([[executor.name, executor]]),
        },
      );
      const result = await production(claimImplementation(db, runId), {
        db,
        workerId: WORKER,
        now: NOW + 1,
      });

      expect(result.status, JSON.stringify(result)).toBe("executor_dispatched");
      expect(observedSelection).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("carries the frozen selection through registered reattachment rounds", async () => {
    const runId = "canonical-agent-config-reattach";
    const db = seedNativeImplementationRun(runId);
    const adapter: DelegateSupervisorToolAdapter = {
      name: "gnhf",
      handoff: () => ({
        externalIdentity: {
          externalRunId: "external-run",
          branch: "main",
          headSha: "a".repeat(40),
        },
        summary: "native handoff remains active",
      }),
      readExternalState: () => ({
        ok: true,
        value: {
          externalRunId: "external-run",
          branch: "main",
          headSha: "a".repeat(40),
          activeStep: "implementation",
          stepStatus: "running",
          findings: [],
          selectedFindingIds: [],
          decisions: [],
          prUrl: null,
          ciState: "none",
        },
        digest: "external-state-digest",
      }),
    };
    try {
      const production = createRegisteredExecutorWorkflowDispatch(
        executeWorkflowStepDispatch,
        {
          registry: new Map([
            ["delegate-supervisor", new DelegateSupervisorExecutor()],
          ]),
          resolveHostBindings: () => ({ tools: { gnhf: adapter } }),
        },
      );
      const claim = claimImplementation(db, runId);

      await production(claim, { db, workerId: WORKER, now: NOW + 1 });
      await production(claim, { db, workerId: WORKER, now: NOW + 2 });

      expect(
        db
          .prepare(
            `SELECT round_index AS roundIndex, agent_provider AS agentProvider, model, effort
               FROM executor_rounds
              WHERE workflow_run_id = ?
              ORDER BY round_index`,
          )
          .all(runId),
      ).toEqual([
        {
          roundIndex: 0,
          agentProvider: "codex",
          model: "gpt-5.6-codex",
          effort: "high",
        },
        {
          roundIndex: 1,
          agentProvider: "codex",
          model: "gpt-5.6-codex",
          effort: "high",
        },
      ]);
    } finally {
      db.close();
    }
  });

  it("carries the frozen selection through registered retry rounds", async () => {
    const runId = "canonical-agent-config-retry";
    const db = seedNativeImplementationRun(runId);
    const registry = new Map([
      ["delegate-supervisor", new DelegateSupervisorExecutor()],
    ]);
    try {
      const unavailable = createRegisteredExecutorWorkflowDispatch(
        executeWorkflowStepDispatch,
        {
          registry,
          resolveHostBindings: () => ({ tools: {} }),
        },
      );
      const firstClaim = claimImplementation(db, runId);
      await unavailable(firstClaim, {
        db,
        workerId: WORKER,
        now: NOW + 1,
      });
      expect(
        db
          .prepare(
            `SELECT agent_provider AS agentProvider, model, effort
               FROM executor_rounds
              WHERE workflow_run_id = ?
              ORDER BY round_index DESC
              LIMIT 1`,
          )
          .get(runId),
      ).toEqual({
        agentProvider: "codex",
        model: "gpt-5.6-codex",
        effort: "high",
      });

      expect(
        clearWorkflowRunManualRecoveryGuarded(db, {
          runId,
          now: NOW + 2,
        }),
      ).toMatchObject({
        ok: true,
        retryPrepared: {
          stepId: "implementation",
        },
      });

      const adapter: DelegateSupervisorToolAdapter = {
        name: "gnhf",
        handoff: () => ({
          externalIdentity: {
            externalRunId: "external-retry-run",
            branch: "main",
            headSha: "b".repeat(40),
          },
          summary: "retried native handoff",
        }),
        readExternalState: () => ({
          ok: false,
          error: "not polled in this bounded retry",
        }),
      };
      const repaired = createRegisteredExecutorWorkflowDispatch(
        executeWorkflowStepDispatch,
        {
          registry,
          resolveHostBindings: () => ({ tools: { gnhf: adapter } }),
        },
      );
      const secondClaim = claimImplementation(db, runId);
      await repaired(secondClaim, { db, workerId: WORKER, now: NOW + 3 });

      expect(
        db
          .prepare(
            `SELECT attempt_number AS attempt, agent_provider AS agentProvider, model, effort
               FROM executor_rounds
              WHERE workflow_run_id = ?
              ORDER BY round_index`,
          )
          .all(runId),
      ).toEqual([
        {
          attempt: 1,
          agentProvider: "codex",
          model: "gpt-5.6-codex",
          effort: "high",
        },
        {
          attempt: 2,
          agentProvider: "codex",
          model: "gpt-5.6-codex",
          effort: "high",
        },
      ]);
    } finally {
      db.close();
    }
  });

  it("carries the frozen selection into a driver-created recovery round", async () => {
    const runId = "canonical-agent-config-driver-recovery";
    const db = seedNativeImplementationRun(runId);
    const executor: Executor = {
      name: "delegate-supervisor",
      configSchema: DELEGATE_SUPERVISOR_CONFIG_SCHEMA,
      tick() {
        throw new Error("registered executor failed before starting a round");
      },
    };
    try {
      const production = createRegisteredExecutorWorkflowDispatch(
        executeWorkflowStepDispatch,
        { registry: new Map([[executor.name, executor]]) },
      );

      await production(claimImplementation(db, runId), {
        db,
        workerId: WORKER,
        now: NOW + 1,
      });

      expect(
        db
          .prepare(
            `SELECT agent_provider AS agentProvider, model, effort, recovery_code AS recoveryCode
               FROM executor_rounds
              WHERE workflow_run_id = ?`,
          )
          .get(runId),
      ).toEqual({
        agentProvider: "codex",
        model: "gpt-5.6-codex",
        effort: "high",
        recoveryCode: "executor_threw",
      });
    } finally {
      db.close();
    }
  });

  it("fails closed on corrupt canonical config before creating executor work", () => {
    const runId = "canonical-agent-config-corrupt";
    const db = seedNativeImplementationRun(runId);
    try {
      db.prepare(
        `UPDATE workflow_steps
            SET agent_config_json = '{"model":7}'
          WHERE run_id = ? AND step_id = 'implementation'`,
      ).run(runId);

      const result = executeWorkflowStepDispatch(
        claimImplementation(db, runId),
        {
          db,
          workerId: WORKER,
          now: NOW + 1,
        },
      );

      expect(result.status).toBe("manual_recovery_gated");
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM executor_attempts WHERE workflow_run_id = ?",
          )
          .get(runId),
      ).toEqual({ count: 0 });
      expect(listWorkflowGatesForRun(db, runId)).toEqual([
        expect.objectContaining({
          evidence: "route_config_invalid",
          reason: expect.stringContaining("canonical route state is corrupt"),
        }),
      ]);
    } finally {
      db.close();
    }
  });

  it("fails closed when a different canonical step config is corrupt", () => {
    const runId = "canonical-agent-config-other-step-corrupt";
    const db = seedNativeImplementationRun(runId);
    try {
      db.prepare(
        `UPDATE workflow_steps
            SET agent_config_json = '{"model":7}'
          WHERE run_id = ? AND step_id = 'postflight'`,
      ).run(runId);

      const result = executeWorkflowStepDispatch(
        claimImplementation(db, runId),
        {
          db,
          workerId: WORKER,
          now: NOW + 1,
        },
      );

      expect(result.status).toBe("manual_recovery_gated");
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM executor_attempts WHERE workflow_run_id = ?",
          )
          .get(runId),
      ).toEqual({ count: 0 });
      expect(listWorkflowGatesForRun(db, runId)).toEqual([
        expect.objectContaining({ evidence: "route_config_invalid" }),
      ]);
    } finally {
      db.close();
    }
  });

  it("fails closed on an invalid compatibility profile before creating executor work", () => {
    const runId = "canonical-agent-config-invalid-profile";
    const db = seedNativeImplementationRun(runId);
    try {
      db.exec("PRAGMA ignore_check_constraints = ON");
      db.prepare(
        `UPDATE workflow_run_coding_compatibility
            SET selected_profile = ''
          WHERE run_id = ?`,
      ).run(runId);
      db.exec("PRAGMA ignore_check_constraints = OFF");

      const result = executeWorkflowStepDispatch(
        claimImplementation(db, runId),
        {
          db,
          workerId: WORKER,
          now: NOW + 1,
        },
      );

      expect(result.status).toBe("manual_recovery_gated");
      expect(listWorkflowGatesForRun(db, runId)).toEqual([
        expect.objectContaining({
          evidence: "route_config_invalid",
          reason: expect.stringContaining("route.profile is invalid"),
        }),
      ]);
    } finally {
      db.close();
    }
  });
});
