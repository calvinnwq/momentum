import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/adapters/db/route-state.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/adapters/db/route-state.js")>();
  return {
    ...actual,
    projectValidatedLegacyWorkflowRunRoute: vi.fn(() => {
      throw new Error(
        "compatibility route must not be read for agent selection",
      );
    }),
  };
});

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import { CODING_WORKFLOW_DEFINITION } from "../src/core/workflow/definition/definition.js";
import { executeWorkflowStepDispatch } from "../src/core/workflow/dispatch/execute.js";
import { claimRunnableWorkflowStep } from "../src/core/workflow/dispatch/scheduler.js";
import { listWorkflowGatesForRun } from "../src/core/workflow/gate/persist.js";
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
        expect.objectContaining({ evidence: "route_config_invalid" }),
      ]);
    } finally {
      db.close();
    }
  });
});
