import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import { CODING_WORKFLOW_DEFINITION } from "../src/core/workflow/definition.js";
import { persistWorkflowDefinition } from "../src/core/workflow/definition-persist.js";
import { persistWorkflowRunStart } from "../src/core/workflow/run-start-persist.js";
import {
  resolveClaimedWorkflowStepFamily,
  resolveWorkflowStepDispatchPlan
} from "../src/core/workflow/dispatch-persist.js";

const NOW = 1_700_000_000_000;
const RUN_ID = "run-dispatch-001";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "momentum-workflow-dispatch-persist-")
  );
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

/**
 * Open a migrated DB seeded exactly as the CLI `workflow run start` path leaves
 * it: the built-in coding workflow definition persisted into `step_definitions`,
 * and a linked run whose `workflow_steps` mirror the definition. This is the
 * durable state the dispatcher resolves a claimed step against.
 */
function openSeededDb(runId: string = RUN_ID): MomentumDb {
  const db = openDb(makeTempDir());
  persistWorkflowDefinition(db, CODING_WORKFLOW_DEFINITION, { now: NOW });
  persistWorkflowRunStart(db, {
    definition: CODING_WORKFLOW_DEFINITION,
    runId,
    repoPath: "/repos/momentum",
    objective: "Dogfood NGX-367",
    now: NOW
  });
  return db;
}

describe("resolveClaimedWorkflowStepFamily — durable resolution", () => {
  it("resolves a linked step to its definition's dispatchable executor family", () => {
    const db = openSeededDb();
    const resolution = resolveClaimedWorkflowStepFamily(db, {
      runId: RUN_ID,
      stepId: "implementation"
    });
    expect(resolution).toEqual({ ok: true, executorFamily: "goal-loop" });
  });

  it("resolves a step to a real-but-unsupported executor family (still ok)", () => {
    const db = openSeededDb();
    // Resolution is independent of dispatchability: linear-refresh resolves to
    // external-apply; the supportability decision is the brain's job.
    const resolution = resolveClaimedWorkflowStepFamily(db, {
      runId: RUN_ID,
      stepId: "linear-refresh"
    });
    expect(resolution).toEqual({ ok: true, executorFamily: "external-apply" });
  });

  it("fails closed with run_not_found when the run row is gone", () => {
    const db = openSeededDb();
    const resolution = resolveClaimedWorkflowStepFamily(db, {
      runId: "run-does-not-exist",
      stepId: "implementation"
    });
    expect(resolution).toEqual({ ok: false, failure: "run_not_found" });
  });

  it("fails closed with definition_unlinked when the run carries no definition link", () => {
    const db = openSeededDb();
    db.prepare(
      `UPDATE workflow_runs
         SET workflow_definition_key = NULL, workflow_definition_version = NULL
       WHERE id = ?`
    ).run(RUN_ID);
    const resolution = resolveClaimedWorkflowStepFamily(db, {
      runId: RUN_ID,
      stepId: "implementation"
    });
    expect(resolution).toEqual({ ok: false, failure: "definition_unlinked" });
  });

  it("treats a partially-null definition link as unlinked", () => {
    const db = openSeededDb();
    db.prepare(
      `UPDATE workflow_runs SET workflow_definition_version = NULL WHERE id = ?`
    ).run(RUN_ID);
    const resolution = resolveClaimedWorkflowStepFamily(db, {
      runId: RUN_ID,
      stepId: "implementation"
    });
    expect(resolution).toEqual({ ok: false, failure: "definition_unlinked" });
  });

  it("fails closed with step_definition_not_found for an unknown step key", () => {
    const db = openSeededDb();
    const resolution = resolveClaimedWorkflowStepFamily(db, {
      runId: RUN_ID,
      stepId: "ghost-step"
    });
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.failure).toBe("step_definition_not_found");
      // The detail names the offending identity so an operator can see it.
      expect(resolution.detail).toContain("ghost-step");
    }
  });

  it("fails closed with unknown_executor_family when the executor column is corrupt", () => {
    const db = openSeededDb();
    db.prepare(
      `UPDATE step_definitions
         SET executor = ?
       WHERE definition_key = ? AND definition_version = ? AND step_key = ?`
    ).run(
      "legacy-family",
      CODING_WORKFLOW_DEFINITION.key,
      CODING_WORKFLOW_DEFINITION.version,
      "implementation"
    );
    const resolution = resolveClaimedWorkflowStepFamily(db, {
      runId: RUN_ID,
      stepId: "implementation"
    });
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.failure).toBe("unknown_executor_family");
      expect(resolution.detail).toBe("legacy-family");
    }
  });
});

describe("resolveWorkflowStepDispatchPlan — composed durable decision", () => {
  it("routes a dispatchable family to a real dispatch plan", () => {
    const db = openSeededDb();
    const plan = resolveWorkflowStepDispatchPlan(db, {
      runId: RUN_ID,
      stepId: "implementation"
    });
    expect(plan).toEqual({ action: "dispatch", executorFamily: "goal-loop" });
  });

  it("fails an unsupported resolved family closed to a manual-recovery gate", () => {
    const db = openSeededDb();
    const plan = resolveWorkflowStepDispatchPlan(db, {
      runId: RUN_ID,
      stepId: "linear-refresh"
    });
    expect(plan.action).toBe("fail_closed");
    if (plan.action === "fail_closed") {
      expect(plan.code).toBe("unsupported_executor_family");
      expect(plan.gateType).toBe("manual_recovery_required");
      expect(plan.reason).toContain("external-apply");
    }
  });

  it("maps a durable resolution failure to its fail-closed code", () => {
    const db = openSeededDb();
    db.prepare(
      `UPDATE workflow_runs
         SET workflow_definition_key = NULL, workflow_definition_version = NULL
       WHERE id = ?`
    ).run(RUN_ID);
    const plan = resolveWorkflowStepDispatchPlan(db, {
      runId: RUN_ID,
      stepId: "implementation"
    });
    expect(plan.action).toBe("fail_closed");
    if (plan.action === "fail_closed") {
      expect(plan.code).toBe("workflow_definition_unlinked");
      expect(plan.gateType).toBe("manual_recovery_required");
    }
  });
});
