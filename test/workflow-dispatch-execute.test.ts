import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import {
  CODING_WORKFLOW_DEFINITION,
  type WorkflowDefinition,
} from "../src/core/workflow/definition/definition.js";
import { persistWorkflowDefinition } from "../src/core/workflow/definition/persist.js";
import { persistWorkflowRunStart } from "../src/core/workflow/run/start-persist.js";
import { MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE } from "../src/core/workflow/run/start.js";
import {
  claimRunnableWorkflowStep,
  type ClaimedWorkflowStep,
  type WorkflowStepDispatch,
} from "../src/core/workflow/dispatch/scheduler.js";
import { getWorkflowLease } from "../src/core/workflow/leases.js";
import { listWorkflowGatesForRun } from "../src/core/workflow/gate/persist.js";
import { getWorkflowRunManualRecoveryState } from "../src/core/workflow/run/recovery.js";
import {
  executeWorkflowStepDispatch,
  WORKFLOW_DISPATCH_RESULT_STATUS,
} from "../src/core/workflow/dispatch/execute.js";

const NOW = 1_700_000_000_000;
const RUN_ID = "run-dispatch-exec-001";
const WORKER = "worker-1";

// Compile-time guard: the dispatcher must satisfy the scheduler's executor seam
// so the bounded `daemon start` lane can pass it straight through (no injection).
const _seamCheck: WorkflowStepDispatch = executeWorkflowStepDispatch;
void _seamCheck;

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "momentum-workflow-dispatch-exec-"),
  );
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

/** Open a migrated DB seeded exactly as the CLI `workflow run start` leaves it. */
function openSeededDb(runId: string = RUN_ID): MomentumDb {
  const db = openDb(makeTempDir());
  persistWorkflowDefinition(db, CODING_WORKFLOW_DEFINITION, { now: NOW });
  persistWorkflowRunStart(db, {
    definition: CODING_WORKFLOW_DEFINITION,
    runId,
    repoPath: "/repos/momentum",
    objective: "Dogfood NGX-367",
    now: NOW,
  });
  return db;
}

function openNativeCodingDbWithoutPersistedDefinition(
  runId: string = RUN_ID,
): MomentumDb {
  const db = openDb(makeTempDir());
  persistWorkflowRunStart(db, {
    definition: CODING_WORKFLOW_DEFINITION,
    runId,
    repoPath: "/repos/momentum",
    objective: "Dogfood NGX-508",
    now: NOW,
    source: MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE,
  });
  return db;
}

function openNativeCodingDbWithRoute(
  route: Record<string, unknown>,
  runId: string = RUN_ID,
): MomentumDb {
  const db = openDb(makeTempDir());
  persistWorkflowRunStart(db, {
    definition: CODING_WORKFLOW_DEFINITION,
    runId,
    repoPath: "/repos/momentum",
    objective: "Dogfood NGX-510",
    now: NOW,
    source: MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE,
    route,
  });
  return db;
}

function persistedCodingOverride(
  executor: "script" | "external-apply",
): WorkflowDefinition {
  return {
    key: "coding-workflow",
    title: "Persisted Coding Override",
    version: 1,
    steps: [
      {
        key: "preflight",
        kind: "preflight",
        executor,
        order: 0,
        required: true,
      },
      {
        key: "implementation",
        kind: "implementation",
        executor: "goal-loop",
        order: 1,
        required: false,
      },
    ],
  };
}

/**
 * Approve the target step (the operator-approval boundary is exercised
 * elsewhere) and claim it through the real scheduler claim path, so the
 * dispatcher receives a genuine {@link ClaimedWorkflowStep} holding a real
 * `dispatch` lease.
 */
function approveAndClaim(
  db: MomentumDb,
  stepId: string,
  runId: string = RUN_ID,
): ClaimedWorkflowStep {
  const target = db
    .prepare(
      "SELECT step_order FROM workflow_steps WHERE run_id = ? AND step_id = ?",
    )
    .get(runId, stepId) as { step_order: number } | undefined;
  if (target === undefined) {
    throw new Error(`test setup: missing step ${stepId}`);
  }
  db.prepare(
    "UPDATE workflow_steps SET state = 'succeeded' WHERE run_id = ? AND step_order < ?",
  ).run(runId, target.step_order);
  db.prepare(
    "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ? AND step_id = ?",
  ).run(runId, stepId);
  const claim = claimRunnableWorkflowStep(db, {
    runId,
    stepId,
    holder: WORKER,
    leaseExpiresAt: NOW + 30_000,
    now: NOW,
  });
  if (!claim.ok) {
    throw new Error(`test setup: claim failed (${claim.reason})`);
  }
  return claim.claim;
}

function countInvocations(db: MomentumDb, runId: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM executor_attempts WHERE workflow_run_id = ?",
    )
    .get(runId) as { n: number };
  return row.n;
}

function stepState(db: MomentumDb, runId: string, stepId: string): string {
  const row = db
    .prepare(
      "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = ?",
    )
    .get(runId, stepId) as { state: string };
  return row.state;
}

function runState(db: MomentumDb, runId: string): string {
  const row = db
    .prepare("SELECT state FROM workflow_runs WHERE id = ?")
    .get(runId) as { state: string };
  return row.state;
}

function monitorAdvisory(
  db: MomentumDb,
  runId: string,
): {
  state: string | null;
  terminal: number | null;
  step: string | null;
} {
  return db
    .prepare(
      `SELECT monitor_last_seen_state AS state,
              monitor_terminal AS terminal,
              monitor_step AS step
         FROM workflow_runs
        WHERE id = ?`,
    )
    .get(runId) as {
    state: string | null;
    terminal: number | null;
    step: string | null;
  };
}

describe("executeWorkflowStepDispatch — supported family", () => {
  it("dispatches native coding runs through the built-in definition without persisted rows", () => {
    const db = openNativeCodingDbWithoutPersistedDefinition();
    const claim = approveAndClaim(db, "preflight");

    const result = executeWorkflowStepDispatch(claim, {
      db,
      workerId: WORKER,
      now: NOW + 1,
    });

    expect(result.status).toBe(WORKFLOW_DISPATCH_RESULT_STATUS.dispatched);
    const invocation = db
      .prepare(
        `SELECT executor_family
           FROM executor_attempts WHERE workflow_run_id = ?`,
      )
      .get(RUN_ID) as { executor_family: string };
    expect(invocation.executor_family).toBe("one-shot");
    expect(stepState(db, RUN_ID, "preflight")).toBe("running");
  });

  it("ignores persisted coding overrides when dispatching native coding runs", () => {
    const db = openDb(makeTempDir());
    persistWorkflowDefinition(db, persistedCodingOverride("script"), {
      now: NOW,
    });
    persistWorkflowRunStart(db, {
      definition: CODING_WORKFLOW_DEFINITION,
      runId: RUN_ID,
      repoPath: "/repos/momentum",
      objective: "Dogfood NGX-508",
      now: NOW,
      source: MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE,
    });
    const claim = approveAndClaim(db, "preflight");

    const result = executeWorkflowStepDispatch(claim, {
      db,
      workerId: WORKER,
      now: NOW + 1,
    });

    expect(result.status).toBe(WORKFLOW_DISPATCH_RESULT_STATUS.dispatched);
    const invocation = db
      .prepare(
        `SELECT executor_family
           FROM executor_attempts WHERE workflow_run_id = ?`,
      )
      .get(RUN_ID) as { executor_family: string };
    expect(invocation.executor_family).toBe("one-shot");
  });

  it("creates the executor invocation + round scaffold and advances the step", () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db, "preflight");

    const result = executeWorkflowStepDispatch(claim, {
      db,
      workerId: WORKER,
      now: NOW + 1,
    });

    expect(result.status).toBe(WORKFLOW_DISPATCH_RESULT_STATUS.dispatched);

    // A durable invocation row proves the bounded unit started through the
    // production path (preflight resolves to the one-shot family).
    const invocation = db
      .prepare(
        `SELECT attempt_id, step_run_id, step_key, executor_family, state, attempt
           FROM executor_attempts WHERE workflow_run_id = ?`,
      )
      .get(RUN_ID) as {
      attempt_id: string;
      step_run_id: string;
      step_key: string;
      executor_family: string;
      state: string;
      attempt: number;
    };
    expect(invocation).toMatchObject({
      step_run_id: "preflight",
      step_key: "preflight",
      executor_family: "one-shot",
      state: "running",
      attempt: 1,
    });

    // The first round scaffold exists, created before external work runs.
    const round = db
      .prepare(
        `SELECT attempt_id, round_index, state, executor_family
           FROM executor_rounds WHERE workflow_run_id = ?`,
      )
      .get(RUN_ID) as {
      attempt_id: string;
      round_index: number;
      state: string;
      executor_family: string;
    };
    expect(round.attempt_id).toBe(invocation.attempt_id);
    expect(round.executor_family).toBe("one-shot");
    expect(round.state).toBe("pending");

    // The step advanced approved -> running so the lane will not re-offer it.
    expect(stepState(db, RUN_ID, "preflight")).toBe("running");
    expect(runState(db, RUN_ID)).toBe("running");
    expect(monitorAdvisory(db, RUN_ID)).toEqual({
      state: "running",
      terminal: 0,
      step: "preflight",
    });
  });

  it("derives stable, recomputable scaffold ids namespaced to the dispatcher", () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db, "preflight");

    executeWorkflowStepDispatch(claim, { db, workerId: WORKER, now: NOW + 1 });

    // The invocation id is the deterministic `<run>::<step>::dispatch` triple,
    // not a random handle: it is recomputable from durable state (so idempotent
    // re-entry finds the same row) and the `::dispatch` namespace keeps it
    // distinct from a future landed adapter's reattachable invocation id.
    const invocation = db
      .prepare(
        "SELECT attempt_id FROM executor_attempts WHERE workflow_run_id = ?",
      )
      .get(RUN_ID) as { attempt_id: string };
    expect(invocation.attempt_id).toBe(`${RUN_ID}::preflight::dispatch`);

    // The first round id is the invocation id suffixed with `::round-1`, equally
    // recomputable so re-entry never forks a second round.
    const round = db
      .prepare(
        "SELECT round_id, round_index FROM executor_rounds WHERE workflow_run_id = ?",
      )
      .get(RUN_ID) as { round_id: string; round_index: number };
    expect(round.round_id).toBe(`${RUN_ID}::preflight::dispatch::round-1`);
    expect(round.round_index).toBe(1);
  });

  it("creates the scaffold round with no fabricated evidence", () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db, "preflight");

    executeWorkflowStepDispatch(claim, { db, workerId: WORKER, now: NOW + 1 });

    // The round row is created before any external work runs, so it must carry
    // zero evidence: an operator or auditor must never mistake a phase-1 scaffold
    // row for completed adapter work. Every evidence/payload pointer stays empty
    // (null scalars, empty `[]` arrays) until a landed adapter fills them.
    const round = db
      .prepare(
        `SELECT classification,
                started_at AS startedAt, heartbeat_at AS heartbeatAt,
                finished_at AS finishedAt, agent_provider AS agentProvider,
                model, effort, input_digest AS inputDigest,
                result_digest AS resultDigest, artifact_root AS artifactRoot,
                log_paths AS logPaths, summary, key_changes AS keyChanges,
                key_learnings AS keyLearnings,
                remaining_work AS remainingWork, changed_files AS changedFiles,
                verification_status AS verificationStatus, commit_sha AS commitSha,
                recovery_code AS recoveryCode, human_gate AS humanGate
           FROM executor_rounds WHERE workflow_run_id = ?`,
      )
      .get(RUN_ID) as Record<string, unknown>;

    expect(round).toEqual({
      classification: null,
      startedAt: null,
      heartbeatAt: null,
      finishedAt: null,
      agentProvider: null,
      model: null,
      effort: null,
      inputDigest: null,
      resultDigest: null,
      artifactRoot: null,
      logPaths: "[]",
      summary: null,
      keyChanges: "[]",
      keyLearnings: "[]",
      remainingWork: "[]",
      changedFiles: "[]",
      verificationStatus: null,
      commitSha: null,
      recoveryCode: null,
      humanGate: null,
    });
  });

  it("dispatches persisted coding route overrides into the round selection", () => {
    const db = openNativeCodingDbWithRoute({
      steps: {
        implementation: {
          harness: "codex",
          model: "gpt-5.1",
          effort: "high",
        },
      },
    });
    const claim = approveAndClaim(db, "implementation");

    const result = executeWorkflowStepDispatch(claim, {
      db,
      workerId: WORKER,
      now: NOW + 1,
    });

    expect(result.status).toBe(WORKFLOW_DISPATCH_RESULT_STATUS.dispatched);
    const round = db
      .prepare(
        `SELECT agent_provider AS agentProvider, model, effort
           FROM executor_rounds
          WHERE workflow_run_id = ? AND step_run_id = ?`,
      )
      .get(RUN_ID, "implementation") as {
      agentProvider: string | null;
      model: string | null;
      effort: string | null;
    };
    expect(round).toEqual({
      agentProvider: "codex",
      model: "gpt-5.1",
      effort: "high",
    });
  });

  it("routes unsupported current GNHF/CWFP implementation dispatch to manual recovery", () => {
    const db = openNativeCodingDbWithRoute({
      implementationEngine: "current-gnhf-cwfp",
    });
    const claim = approveAndClaim(db, "implementation");

    const result = executeWorkflowStepDispatch(claim, {
      db,
      workerId: WORKER,
      now: NOW + 1,
    });

    expect(result.status).toBe(WORKFLOW_DISPATCH_RESULT_STATUS.failClosed);
    const gates = listWorkflowGatesForRun(db, RUN_ID);
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({
      gateType: "manual_recovery_required",
      targetScope: "step",
      stepRunId: "implementation",
      evidence: "route_config_invalid",
      resolvedAt: null,
    });
    expect(gates[0]?.reason).toContain("current-gnhf-cwfp");
    expect(
      getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery,
    ).toBe(true);
    expect(getWorkflowLease(db, RUN_ID, "dispatch")?.releasedAt).not.toBeNull();
    expect(countInvocations(db, RUN_ID)).toBe(0);
    expect(stepState(db, RUN_ID, "implementation")).toBe("approved");
  });

  it("holds the dispatch lease on a successful dispatch (owns the lifecycle)", () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db, "preflight");

    executeWorkflowStepDispatch(claim, { db, workerId: WORKER, now: NOW + 1 });

    const lease = getWorkflowLease(db, RUN_ID, "dispatch");
    expect(lease).toBeDefined();
    expect(lease?.releasedAt).toBeNull();
  });

  it("is idempotent: a second dispatch of the same claim creates no duplicate rows", () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db, "preflight");

    executeWorkflowStepDispatch(claim, { db, workerId: WORKER, now: NOW + 1 });
    const second = executeWorkflowStepDispatch(claim, {
      db,
      workerId: WORKER,
      now: NOW + 2,
    });

    expect(second.status).toBe(
      WORKFLOW_DISPATCH_RESULT_STATUS.alreadyDispatched,
    );
    expect(countInvocations(db, RUN_ID)).toBe(1);
    const rounds = db
      .prepare(
        "SELECT COUNT(*) AS n FROM executor_rounds WHERE workflow_run_id = ?",
      )
      .get(RUN_ID) as { n: number };
    expect(rounds.n).toBe(1);
  });
});

describe("executeWorkflowStepDispatch — fail closed", () => {
  it("scaffolds an external-apply family step for its dedicated adapter lane", () => {
    const db = openSeededDb();
    // Force preflight to resolve to a family with a dedicated daemon adapter.
    db.prepare(
      `UPDATE step_definitions SET executor = 'external-apply'
         WHERE definition_key = ? AND definition_version = ? AND step_key = ?`,
    ).run(
      CODING_WORKFLOW_DEFINITION.key,
      CODING_WORKFLOW_DEFINITION.version,
      "preflight",
    );
    const claim = approveAndClaim(db, "preflight");

    const result = executeWorkflowStepDispatch(claim, {
      db,
      workerId: WORKER,
      now: NOW + 1,
    });

    expect(result.status).toBe(WORKFLOW_DISPATCH_RESULT_STATUS.dispatched);

    // The base dispatcher creates only the scaffold; the dedicated adapter lane
    // owns policy-gated external-write evidence and manual-recovery outcomes.
    expect(listWorkflowGatesForRun(db, RUN_ID)).toHaveLength(0);
    const recovery = getWorkflowRunManualRecoveryState(db, RUN_ID);
    expect(recovery?.needsManualRecovery).toBe(false);

    // The dispatch lease is held while the adapter lane owns terminalization.
    const lease = getWorkflowLease(db, RUN_ID, "dispatch");
    expect(lease?.releasedAt).toBeNull();

    expect(countInvocations(db, RUN_ID)).toBe(1);
    expect(stepState(db, RUN_ID, "preflight")).toBe("running");
  });

  it("routes a resolution failure (definition unlinked) to manual recovery", () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db, "preflight");
    // The run advanced past resolvable state between claim and dispatch.
    db.prepare(
      `UPDATE workflow_runs
         SET workflow_definition_key = NULL, workflow_definition_version = NULL
       WHERE id = ?`,
    ).run(RUN_ID);

    const result = executeWorkflowStepDispatch(claim, {
      db,
      workerId: WORKER,
      now: NOW + 1,
    });

    expect(result.status).toBe(WORKFLOW_DISPATCH_RESULT_STATUS.failClosed);
    const gates = listWorkflowGatesForRun(db, RUN_ID);
    expect(gates).toHaveLength(1);
    expect(gates[0]?.gateType).toBe("manual_recovery_required");
    expect(
      getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery,
    ).toBe(true);
    expect(getWorkflowLease(db, RUN_ID, "dispatch")?.releasedAt).not.toBeNull();
    expect(countInvocations(db, RUN_ID)).toBe(0);
  });

  it("routes an invalid executor name (corrupt step definition) to manual recovery", () => {
    const db = openSeededDb();
    // The step definition's `executor` column does not hold a valid stable
    // executor name (corrupt or legacy durable state). Claiming does
    // not read `step_definitions`, so the corrupt value only bites at dispatch.
    db.prepare(
      `UPDATE step_definitions SET executor = 'Invalid Executor Name'
         WHERE definition_key = ? AND definition_version = ? AND step_key = ?`,
    ).run(
      CODING_WORKFLOW_DEFINITION.key,
      CODING_WORKFLOW_DEFINITION.version,
      "preflight",
    );
    const claim = approveAndClaim(db, "preflight");

    const result = executeWorkflowStepDispatch(claim, {
      db,
      workerId: WORKER,
      now: NOW + 1,
    });

    expect(result.status).toBe(WORKFLOW_DISPATCH_RESULT_STATUS.failClosed);

    // The gate stamps the stable `unknown_executor_family` code as evidence and
    // surfaces the offending raw family string to the operator.
    const gates = listWorkflowGatesForRun(db, RUN_ID);
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({
      gateType: "manual_recovery_required",
      targetScope: "step",
      stepRunId: "preflight",
      evidence: "unknown_executor_family",
      resolvedAt: null,
    });
    expect(gates[0]?.reason).toContain("Invalid Executor Name");

    // Durable park + released lease + no half scaffold + step not advanced.
    expect(
      getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery,
    ).toBe(true);
    expect(getWorkflowLease(db, RUN_ID, "dispatch")?.releasedAt).not.toBeNull();
    expect(countInvocations(db, RUN_ID)).toBe(0);
    expect(stepState(db, RUN_ID, "preflight")).toBe("approved");
  });

  it("routes a missing step definition to manual recovery", () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db, "preflight");
    // The step definition row vanished between claim and dispatch, so the claimed
    // step can no longer be resolved to an executor family.
    db.prepare(
      `DELETE FROM step_definitions
         WHERE definition_key = ? AND definition_version = ? AND step_key = ?`,
    ).run(
      CODING_WORKFLOW_DEFINITION.key,
      CODING_WORKFLOW_DEFINITION.version,
      "preflight",
    );

    const result = executeWorkflowStepDispatch(claim, {
      db,
      workerId: WORKER,
      now: NOW + 1,
    });

    expect(result.status).toBe(WORKFLOW_DISPATCH_RESULT_STATUS.failClosed);
    const gates = listWorkflowGatesForRun(db, RUN_ID);
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({
      gateType: "manual_recovery_required",
      targetScope: "step",
      stepRunId: "preflight",
      evidence: "step_definition_not_found",
      resolvedAt: null,
    });
    expect(gates[0]?.reason).toContain("preflight");
    expect(
      getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery,
    ).toBe(true);
    expect(getWorkflowLease(db, RUN_ID, "dispatch")?.releasedAt).not.toBeNull();
    expect(countInvocations(db, RUN_ID)).toBe(0);
    expect(stepState(db, RUN_ID, "preflight")).toBe("approved");
  });

  it("routes corrupt native coding route overrides to manual recovery", () => {
    const db = openNativeCodingDbWithRoute({
      steps: {
        preflight: { model: "opus" },
      },
    });
    const claim = approveAndClaim(db, "implementation");

    const result = executeWorkflowStepDispatch(claim, {
      db,
      workerId: WORKER,
      now: NOW + 1,
    });

    expect(result.status).toBe(WORKFLOW_DISPATCH_RESULT_STATUS.failClosed);
    const gates = listWorkflowGatesForRun(db, RUN_ID);
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({
      gateType: "manual_recovery_required",
      targetScope: "step",
      stepRunId: "implementation",
      evidence: "route_config_invalid",
      resolvedAt: null,
    });
    expect(gates[0]?.reason).toContain("preflight");
    expect(
      getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery,
    ).toBe(true);
    expect(getWorkflowLease(db, RUN_ID, "dispatch")?.releasedAt).not.toBeNull();
    expect(countInvocations(db, RUN_ID)).toBe(0);
    expect(stepState(db, RUN_ID, "implementation")).toBe("approved");
  });

  it("routes a vanished run to manual recovery without stranding the lease or opening a gate", () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db, "preflight");
    // The whole run row vanished between claim and dispatch (e.g. torn down by a
    // concurrent operation). FK enforcement is toggled off only to delete the
    // parent row while its claimed step + dispatch lease linger as orphans,
    // reproducing the race the dispatcher must tolerate without crashing on the
    // gate's NOT NULL run FK.
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("DELETE FROM workflow_runs WHERE id = ?").run(RUN_ID);
    db.exec("PRAGMA foreign_keys = ON");

    const result = executeWorkflowStepDispatch(claim, {
      db,
      workerId: WORKER,
      now: NOW + 1,
    });

    expect(result.status).toBe(WORKFLOW_DISPATCH_RESULT_STATUS.failClosed);
    expect(result.detail).toContain("workflow_run_not_found");

    // A vanished run cannot carry a gate (the gate's run FK would dangle), so none
    // is opened and no recovery flag is written — there is no run row to flag.
    expect(listWorkflowGatesForRun(db, RUN_ID)).toHaveLength(0);
    expect(getWorkflowRunManualRecoveryState(db, RUN_ID)).toBeUndefined();

    // The dispatch lease is still released so the run is not held busy on a no-op,
    // no executor scaffold was created, and the orphaned step was not advanced.
    expect(getWorkflowLease(db, RUN_ID, "dispatch")?.releasedAt).not.toBeNull();
    expect(countInvocations(db, RUN_ID)).toBe(0);
    expect(stepState(db, RUN_ID, "preflight")).toBe("approved");
  });
});

describe("executeWorkflowStepDispatch — safety", () => {
  it("does not strand a lease or create rows when the step cannot be started", () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db, "preflight");
    // Another worker advanced the step out of `approved` between claim and
    // dispatch: the dispatcher must not create a half scaffold.
    db.prepare(
      "UPDATE workflow_steps SET state = 'running' WHERE run_id = ? AND step_id = ?",
    ).run(RUN_ID, "preflight");

    const result = executeWorkflowStepDispatch(claim, {
      db,
      workerId: WORKER,
      now: NOW + 1,
    });

    expect(result.status).toBe(
      WORKFLOW_DISPATCH_RESULT_STATUS.stepNotStartable,
    );
    expect(countInvocations(db, RUN_ID)).toBe(0);
    // The dispatch lease is released so the run is not held busy on a no-op.
    expect(getWorkflowLease(db, RUN_ID, "dispatch")?.releasedAt).not.toBeNull();
  });
});
