import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import { CODING_WORKFLOW_DEFINITION } from "../src/core/workflow/definition/definition.js";
import { persistWorkflowDefinition } from "../src/core/workflow/definition/persist.js";
import { persistWorkflowRunStart } from "../src/core/workflow/run/start-persist.js";
import { MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE } from "../src/core/workflow/run/start.js";
import {
  claimRunnableWorkflowStep,
  type ClaimedWorkflowStep,
  type WorkflowStepDispatchContext,
  type WorkflowStepDispatchResult,
} from "../src/core/workflow/dispatch/scheduler.js";
import {
  getWorkflowLease,
  releaseWorkflowLease,
} from "../src/core/workflow/leases.js";
import { acquireRepoLock, getActiveRepoLock } from "../src/core/repo/locks.js";
import { listWorkflowGatesForRun } from "../src/core/workflow/gate/persist.js";
import {
  clearWorkflowRunManualRecoveryGuarded,
  getWorkflowRunManualRecoveryState,
} from "../src/core/workflow/run/recovery.js";
import { getWorkflowStep } from "../src/core/workflow/step/transitions.js";
import {
  loadExecutorInvocation,
  listExecutorRoundsForInvocation,
} from "../src/core/executors/loop/persist.js";
import {
  deriveDispatchInvocationId,
  executeWorkflowStepDispatch,
  WORKFLOW_DISPATCH_RESULT_STATUS,
} from "../src/core/workflow/dispatch/execute.js";
import {
  WORKFLOW_STEP_EXECUTOR_KINDS,
  type WorkflowStepExecutor,
  type WorkflowStepExecutorDispatchResult,
  type WorkflowStepExecutorInput,
  type WorkflowStepExecutorKind,
  type WorkflowStepExecutorRegistry,
} from "../src/core/workflow/step/executor.js";
import { buildRealWorkflowStepExecutorRegistry } from "../src/core/workflow/step/executor-real-adapters.js";
import {
  parseLiveWrapperProfile,
  type LiveWrapperProfile,
} from "../src/adapters/live-wrapper-registry.js";
import type { DispatchedStepExecutorContext } from "../src/core/workflow/dispatch/executor-run.js";
import {
  createLiveWrapperWorkflowDispatch,
  shouldRunDispatchedExecutor,
} from "../src/core/workflow/dispatch/live-wrapper.js";

/**
 * NGX-492 (RC-5b) — the daemon dispatch composition that turns the registry-injected
 * execution-path producer (`executeAndReconcileDispatchedWorkflowStep`) into a
 * `WorkflowStepDispatch` the bounded `daemon start` lane can use directly.
 *
 * The producer requires the `<run>::<step>::dispatch` scaffold to already exist; the
 * production base dispatch (`executeWorkflowStepDispatch`) creates it. Nothing in
 * production composed the two in one tick — so a dispatched step's executor was never
 * run by the daemon. These tests pin that missing composition: a wrapper that runs the
 * base dispatch (scaffold) and, only for a genuinely-started dispatch, runs the
 * executor + RC-2 reconcile in the same tick. It mirrors the dogfood
 * `createTerminalizingWorkflowDispatch` shape, but drives the REAL executor registry
 * instead of a fake terminalize, with RC-2 the single finalization owner.
 */

const NOW = 1_700_000_000_000;
const RUN_ID = "run-livewrap-001";
const WORKER = "worker-1";
const TICK_AT = NOW + 5;

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-livewrap-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function runGit(repoPath: string, args: string[]): string {
  return execFileSync("git", ["-C", repoPath, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initRepo(): { repoPath: string; baseHead: string } {
  const repoPath = makeTempDir("momentum-livewrap-repo-");
  runGit(repoPath, ["init", "--initial-branch=main", "--quiet"]);
  runGit(repoPath, ["config", "user.email", "test@example.com"]);
  runGit(repoPath, ["config", "user.name", "Test User"]);
  runGit(repoPath, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(repoPath, "README.md"), "init\n", "utf-8");
  runGit(repoPath, ["add", "README.md"]);
  runGit(repoPath, ["commit", "-m", "init", "--quiet"]);
  return { repoPath, baseHead: runGit(repoPath, ["rev-parse", "HEAD"]) };
}

/** Open a migrated DB seeded exactly as the CLI `workflow run start` leaves it. */
function openSeededDb(runId: string = RUN_ID): MomentumDb {
  const db = openDb(makeTempDir());
  persistWorkflowDefinition(db, CODING_WORKFLOW_DEFINITION, { now: NOW });
  persistWorkflowRunStart(db, {
    definition: CODING_WORKFLOW_DEFINITION,
    runId,
    repoPath: "/repos/momentum",
    objective: "Dogfood NGX-492",
    now: NOW,
  });
  return db;
}

function openNativeCodingDbWithRoute(
  route: Record<string, unknown>,
): MomentumDb {
  const db = openDb(makeTempDir());
  persistWorkflowRunStart(db, {
    definition: CODING_WORKFLOW_DEFINITION,
    runId: RUN_ID,
    repoPath: "/repos/momentum",
    objective: "Dogfood route retry",
    now: NOW,
    source: MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE,
    route,
  });
  return db;
}

function approveAndClaim(
  db: MomentumDb,
  stepId: string,
  runId: string = RUN_ID,
): ClaimedWorkflowStep {
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
  if (!claim.ok) throw new Error(`test setup: claim failed (${claim.reason})`);
  return claim.claim;
}

function tickContext(
  db: MomentumDb,
  now: number = TICK_AT,
): WorkflowStepDispatchContext {
  return { db, workerId: WORKER, now };
}

function stepState(db: MomentumDb, stepId: string): string {
  const row = getWorkflowStep(db, RUN_ID, stepId);
  if (!row) throw new Error(`step ${stepId} not found`);
  return row.state;
}

function dispatchRounds(db: MomentumDb, stepId: string) {
  return listExecutorRoundsForInvocation(
    db,
    deriveDispatchInvocationId(RUN_ID, stepId),
  );
}

const EXEC_CONTEXT: DispatchedStepExecutorContext = {
  repoPath: "/repos/momentum",
  runDir: "/repos/momentum/.agent-workflows/run-livewrap-001",
  resultJsonPath:
    "/repos/momentum/.agent-workflows/run-livewrap-001/result.json",
  executorLogPath:
    "/repos/momentum/.agent-workflows/run-livewrap-001/executor.log",
};

/**
 * A registry whose every kind runs `result` and counts execute calls, so a test
 * can assert the executor ran exactly once (or never).
 */
function countingRegistry(
  result:
    | WorkflowStepExecutorDispatchResult
    | ((
        input: WorkflowStepExecutorInput,
      ) => WorkflowStepExecutorDispatchResult),
): { registry: WorkflowStepExecutorRegistry; calls: () => number } {
  let calls = 0;
  const registry = new Map<WorkflowStepExecutorKind, WorkflowStepExecutor>(
    WORKFLOW_STEP_EXECUTOR_KINDS.map((kind) => [
      kind,
      {
        kind,
        executes: true,
        execute: (input: WorkflowStepExecutorInput) => {
          calls += 1;
          return typeof result === "function" ? result(input) : result;
        },
      },
    ]),
  );
  return { registry, calls: () => calls };
}

function succeededResult(
  input: WorkflowStepExecutorInput,
): WorkflowStepExecutorDispatchResult {
  return {
    ok: true,
    result: {
      state: "succeeded",
      summary: "preflight passed",
      checkpoints: [],
      artifacts: [{ kind: "executor-log", path: input.executorLogPath }],
      resultDigest: "sha256:live",
      errorCode: null,
      errorMessage: null,
      retryHint: null,
      recoveryHint: null,
    },
    executorLogPath: input.executorLogPath,
    resultJsonPath: input.resultJsonPath,
  };
}

function failedResult(
  input: WorkflowStepExecutorInput,
): WorkflowStepExecutorDispatchResult {
  return {
    ok: true,
    result: {
      state: "failed",
      summary: "preflight reported success=false",
      checkpoints: [],
      artifacts: [{ kind: "executor-log", path: input.executorLogPath }],
      resultDigest: null,
      errorCode: "command_failed",
      errorMessage: "live step runner reported success=false",
      retryHint: null,
      recoveryHint: null,
    },
    executorLogPath: input.executorLogPath,
    resultJsonPath: input.resultJsonPath,
  };
}

function wrapperBootstrapFailure(
  input: WorkflowStepExecutorInput,
): WorkflowStepExecutorDispatchResult {
  return {
    ok: false,
    code: "runtime_unavailable",
    error: `live step runtime is unavailable: ${input.kind} wrapper dist path is stale`,
    executorLogPath: input.executorLogPath,
    resultJsonPath: input.resultJsonPath,
  };
}

const VALID_RESULT_JSON = JSON.stringify({
  success: true,
  summary: "live preflight succeeded",
  key_changes_made: ["did the thing"],
  key_learnings: [],
  remaining_work: [],
  goal_complete: false,
  commit: { type: "chore", subject: "do the thing", body: "", breaking: false },
});
const WRITE_VALID_RESULT = `printf '%s' '${VALID_RESULT_JSON}' > "$MOMENTUM_RESULT_PATH"`;

function profileWith(
  kind: WorkflowStepExecutorKind,
  args: string[],
): LiveWrapperProfile {
  const parsed = parseLiveWrapperProfile({
    name: "rc5b-livewrap-test",
    wrappers: {
      [kind]: {
        command: "/bin/sh",
        args,
        cwd: "iteration",
        timeout_sec: 30,
        env_allow: [],
        result_file: "result.json",
      },
    },
  });
  if (!parsed.ok) throw new Error(`test setup: bad profile: ${parsed.error}`);
  return parsed.profile;
}

describe("shouldRunDispatchedExecutor", () => {
  it("runs the executor only for a genuinely-started or re-entered dispatch", () => {
    expect(
      shouldRunDispatchedExecutor(WORKFLOW_DISPATCH_RESULT_STATUS.dispatched),
    ).toBe(true);
    expect(
      shouldRunDispatchedExecutor(
        WORKFLOW_DISPATCH_RESULT_STATUS.alreadyDispatched,
      ),
    ).toBe(true);
  });

  it("never runs the executor for a fail-closed or not-startable dispatch", () => {
    expect(
      shouldRunDispatchedExecutor(WORKFLOW_DISPATCH_RESULT_STATUS.failClosed),
    ).toBe(false);
    expect(
      shouldRunDispatchedExecutor(
        WORKFLOW_DISPATCH_RESULT_STATUS.stepNotStartable,
      ),
    ).toBe(false);
  });
});

describe("createLiveWrapperWorkflowDispatch — configured success", () => {
  it("starts the scaffold, runs the executor, and RC-2 finalizes the step succeeded in one tick", () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db, "preflight");
    const { registry, calls } = countingRegistry(succeededResult);
    const dispatch = createLiveWrapperWorkflowDispatch(
      executeWorkflowStepDispatch,
      { registry, deriveExec: () => ({ ok: true, exec: EXEC_CONTEXT }) },
    );

    const result = dispatch(claim, tickContext(db));

    // The wrapper echoes the base dispatch's status (telemetry contract: the
    // daemon still reports the dispatch outcome, finalization is a side effect).
    expect(result.status).toBe(WORKFLOW_DISPATCH_RESULT_STATUS.dispatched);
    // The executor ran exactly once and the step is finalized + lease released.
    expect(calls()).toBe(1);
    expect(stepState(db, "preflight")).toBe("succeeded");
    expect(getWorkflowLease(db, RUN_ID, "dispatch")?.releasedAt).not.toBeNull();
    const invocation = loadExecutorInvocation(
      db,
      deriveDispatchInvocationId(RUN_ID, "preflight"),
    );
    expect(invocation?.state).toBe("succeeded");
    const rounds = dispatchRounds(db, "preflight");
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.summary).toBe("preflight passed");
  });

  it("finalizes the step failed when the executor reports a clean failed terminal", () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db, "preflight");
    const { registry } = countingRegistry(failedResult);
    const dispatch = createLiveWrapperWorkflowDispatch(
      executeWorkflowStepDispatch,
      { registry, deriveExec: () => ({ ok: true, exec: EXEC_CONTEXT }) },
    );

    dispatch(claim, tickContext(db));

    expect(stepState(db, "preflight")).toBe("failed");
    expect(getWorkflowLease(db, RUN_ID, "dispatch")?.releasedAt).not.toBeNull();
  });

  it("passes the derived exec context into a real configured live-wrapper command end to end", () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db, "preflight");
    const { repoPath, baseHead } = initRepo();
    const runDir = makeTempDir("momentum-livewrap-run-");
    const registry = buildRealWorkflowStepExecutorRegistry({
      profile: profileWith("preflight", [
        "-c",
        `printf 'from-wrapper\\n' > "$MOMENTUM_REPO_PATH/live-edit.txt" && ${WRITE_VALID_RESULT}`,
      ]),
    });
    const exec: DispatchedStepExecutorContext = {
      repoPath,
      runDir,
      resultJsonPath: path.join(runDir, "result.json"),
      executorLogPath: path.join(runDir, "executor.log"),
      repoSafety: {
        baseHead,
        verificationCommands: ["test -f live-edit.txt"],
        verificationTimeoutSec: 30,
        verificationLogPath: path.join(runDir, "verification.log"),
      },
    };
    const dispatch = createLiveWrapperWorkflowDispatch(
      executeWorkflowStepDispatch,
      {
        registry,
        deriveExec: () => ({ ok: true, exec }),
        nowMs: () => TICK_AT,
      },
    );

    const result = dispatch(claim, tickContext(db));

    expect(result.status).toBe(WORKFLOW_DISPATCH_RESULT_STATUS.dispatched);
    expect(stepState(db, "preflight")).toBe("succeeded");
    expect(runGit(repoPath, ["rev-parse", "HEAD"])).not.toBe(baseHead);
    expect(runGit(repoPath, ["rev-parse", "HEAD^"])).toBe(baseHead);
    expect(fs.existsSync(path.join(runDir, "verification.log"))).toBe(true);
  });

  it("runs verification and resets live-wrapper edits before reconciliation on verification failure", () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db, "preflight");
    const { repoPath, baseHead } = initRepo();
    const runDir = makeTempDir("momentum-livewrap-run-");
    const registry = buildRealWorkflowStepExecutorRegistry({
      profile: profileWith("preflight", [
        "-c",
        `printf 'from-wrapper\\n' > "$MOMENTUM_REPO_PATH/live-edit.txt" && ${WRITE_VALID_RESULT}`,
      ]),
    });
    const exec: DispatchedStepExecutorContext = {
      repoPath,
      runDir,
      resultJsonPath: path.join(runDir, "result.json"),
      executorLogPath: path.join(runDir, "executor.log"),
      repoSafety: {
        baseHead,
        verificationCommands: ["false"],
        verificationTimeoutSec: 30,
        verificationLogPath: path.join(runDir, "verification.log"),
      },
    };
    const dispatch = createLiveWrapperWorkflowDispatch(
      executeWorkflowStepDispatch,
      {
        registry,
        deriveExec: () => ({ ok: true, exec }),
        nowMs: () => TICK_AT,
      },
    );

    const result = dispatch(claim, tickContext(db));

    expect(result.status).toBe(WORKFLOW_DISPATCH_RESULT_STATUS.dispatched);
    expect(stepState(db, "preflight")).toBe("failed");
    expect(runGit(repoPath, ["rev-parse", "HEAD"])).toBe(baseHead);
    expect(fs.existsSync(path.join(repoPath, "live-edit.txt"))).toBe(false);
    expect(
      fs.readFileSync(path.join(runDir, "verification.log"), "utf-8"),
    ).toContain("exit_code: 1");
  });

  it("fails the step without manual recovery when finalization has nothing to commit", () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db, "preflight");
    const { repoPath, baseHead } = initRepo();
    const runDir = makeTempDir("momentum-livewrap-run-");
    const { registry } = countingRegistry((input) => {
      fs.mkdirSync(input.runDir, { recursive: true });
      fs.writeFileSync(input.resultJsonPath, VALID_RESULT_JSON, "utf-8");
      return succeededResult(input);
    });
    const exec: DispatchedStepExecutorContext = {
      repoPath,
      runDir,
      resultJsonPath: path.join(runDir, "result.json"),
      executorLogPath: path.join(runDir, "executor.log"),
      repoSafety: {
        baseHead,
        verificationCommands: ["true"],
        verificationTimeoutSec: 30,
        verificationLogPath: path.join(runDir, "verification.log"),
      },
    };
    const dispatch = createLiveWrapperWorkflowDispatch(
      executeWorkflowStepDispatch,
      {
        registry,
        deriveExec: () => ({ ok: true, exec }),
        nowMs: () => TICK_AT,
      },
    );

    dispatch(claim, tickContext(db));

    expect(stepState(db, "preflight")).toBe("failed");
    expect(
      getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery,
    ).toBe(false);
    expect(getWorkflowLease(db, RUN_ID, "dispatch")?.releasedAt).not.toBeNull();
    expect(dispatchRounds(db, "preflight")[0]?.recoveryCode).toBeNull();
  });

  it("routes finalization to recovery when the dispatch lease is lost before git mutation", () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db, "preflight");
    const { repoPath, baseHead } = initRepo();
    const runDir = makeTempDir("momentum-livewrap-run-");
    const { registry } = countingRegistry((input) => {
      fs.mkdirSync(input.runDir, { recursive: true });
      fs.writeFileSync(path.join(repoPath, "live-edit.txt"), "edit\n", "utf-8");
      fs.writeFileSync(input.resultJsonPath, VALID_RESULT_JSON, "utf-8");
      releaseWorkflowLease(db, {
        runId: claim.lease.runId,
        leaseKind: claim.lease.leaseKind,
        holder: claim.lease.holder,
        acquiredAt: claim.lease.acquiredAt,
        now: TICK_AT + 1,
      });
      return succeededResult(input);
    });
    const exec: DispatchedStepExecutorContext = {
      repoPath,
      runDir,
      resultJsonPath: path.join(runDir, "result.json"),
      executorLogPath: path.join(runDir, "executor.log"),
      repoSafety: {
        baseHead,
        verificationCommands: ["test -f live-edit.txt"],
        verificationTimeoutSec: 30,
        verificationLogPath: path.join(runDir, "verification.log"),
      },
    };
    const dispatch = createLiveWrapperWorkflowDispatch(
      executeWorkflowStepDispatch,
      {
        registry,
        deriveExec: () => ({ ok: true, exec }),
        nowMs: () => TICK_AT,
      },
    );

    dispatch(claim, tickContext(db));

    expect(stepState(db, "preflight")).toBe("running");
    expect(
      getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery,
    ).toBe(true);
    expect(dispatchRounds(db, "preflight")[0]?.recoveryCode).toBe(
      "repo_lock_lost",
    );
    expect(runGit(repoPath, ["rev-parse", "HEAD"])).toBe(baseHead);
    expect(fs.existsSync(path.join(repoPath, "live-edit.txt"))).toBe(true);
  });

  it("refuses git mutation when the dispatch lease expired while the wrapper ran", () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db, "preflight");
    const { repoPath, baseHead } = initRepo();
    const runDir = makeTempDir("momentum-livewrap-run-");
    const { registry } = countingRegistry((input) => {
      fs.mkdirSync(input.runDir, { recursive: true });
      fs.writeFileSync(path.join(repoPath, "live-edit.txt"), "edit\n", "utf-8");
      fs.writeFileSync(input.resultJsonPath, VALID_RESULT_JSON, "utf-8");
      return succeededResult(input);
    });
    const exec: DispatchedStepExecutorContext = {
      repoPath,
      runDir,
      resultJsonPath: path.join(runDir, "result.json"),
      executorLogPath: path.join(runDir, "executor.log"),
      repoSafety: {
        baseHead,
        verificationCommands: ["test -f live-edit.txt"],
        verificationTimeoutSec: 30,
        verificationLogPath: path.join(runDir, "verification.log"),
      },
    };
    // The wrapper "ran" past the claim's 30s lease: the wall clock at mutation
    // time is a minute after the claim. The stale tick timestamp
    // (`context.now = TICK_AT`) would still satisfy `expires_at >=
    // heartbeat_at` and retroactively extend the expired lease; the fresh
    // clock must refuse instead.
    const dispatch = createLiveWrapperWorkflowDispatch(
      executeWorkflowStepDispatch,
      {
        registry,
        deriveExec: () => ({ ok: true, exec }),
        nowMs: () => NOW + 60_000,
      },
    );

    dispatch(claim, tickContext(db));

    expect(stepState(db, "preflight")).toBe("running");
    expect(
      getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery,
    ).toBe(true);
    expect(dispatchRounds(db, "preflight")[0]?.recoveryCode).toBe(
      "repo_lock_lost",
    );
    // Neither a commit nor a destructive reset happened after expiry.
    expect(runGit(repoPath, ["rev-parse", "HEAD"])).toBe(baseHead);
    expect(fs.existsSync(path.join(repoPath, "live-edit.txt"))).toBe(true);
  });

  it("never verifies or mutates git for an unexpected skipped executor terminal", () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db, "preflight");
    const { repoPath, baseHead } = initRepo();
    const runDir = makeTempDir("momentum-livewrap-run-");
    const { registry } = countingRegistry((input) => {
      fs.mkdirSync(input.runDir, { recursive: true });
      fs.writeFileSync(path.join(repoPath, "live-edit.txt"), "edit\n", "utf-8");
      fs.writeFileSync(input.resultJsonPath, VALID_RESULT_JSON, "utf-8");
      return {
        ok: true,
        result: {
          state: "skipped",
          summary: "wrapper reported an unexpected skip",
          checkpoints: [],
          artifacts: [],
          resultDigest: null,
          errorCode: null,
          errorMessage: null,
          retryHint: null,
          recoveryHint: null,
        },
        executorLogPath: input.executorLogPath,
        resultJsonPath: input.resultJsonPath,
      };
    });
    const exec: DispatchedStepExecutorContext = {
      repoPath,
      runDir,
      resultJsonPath: path.join(runDir, "result.json"),
      executorLogPath: path.join(runDir, "executor.log"),
      repoSafety: {
        baseHead,
        verificationCommands: ["true"],
        verificationTimeoutSec: 30,
        verificationLogPath: path.join(runDir, "verification.log"),
      },
    };
    const dispatch = createLiveWrapperWorkflowDispatch(
      executeWorkflowStepDispatch,
      {
        registry,
        deriveExec: () => ({ ok: true, exec }),
        nowMs: () => TICK_AT,
      },
    );

    dispatch(claim, tickContext(db));

    // Terminalization parks the unexpected skip for manual recovery, and
    // finalization never verified, committed, or reset over it.
    expect(
      getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery,
    ).toBe(true);
    expect(dispatchRounds(db, "preflight")[0]?.recoveryCode).toBe(
      "unexpected_skipped_terminal",
    );
    expect(runGit(repoPath, ["rev-parse", "HEAD"])).toBe(baseHead);
    expect(fs.existsSync(path.join(repoPath, "live-edit.txt"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "verification.log"))).toBe(false);
  });

  it("refuses to execute when another run holds the repository lock", () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db, "preflight");
    const { repoPath } = initRepo();
    const runDir = makeTempDir("momentum-livewrap-run-");
    const { registry, calls } = countingRegistry(succeededResult);
    const foreign = acquireRepoLock(db, {
      repoRoot: repoPath,
      holder: "other-worker",
      goalId: "run-other",
      iteration: 1,
      jobId: "run-other::implementation::dispatch",
      leaseExpiresAt: TICK_AT + 600_000,
      now: NOW,
    });
    expect(foreign.ok).toBe(true);
    const exec: DispatchedStepExecutorContext = {
      repoPath,
      runDir,
      resultJsonPath: path.join(runDir, "result.json"),
      executorLogPath: path.join(runDir, "executor.log"),
      repoSafety: {
        baseHead: "unused",
        verificationCommands: ["true"],
        verificationTimeoutSec: 30,
        verificationLogPath: path.join(runDir, "verification.log"),
      },
    };
    const dispatch = createLiveWrapperWorkflowDispatch(
      executeWorkflowStepDispatch,
      {
        registry,
        deriveExec: () => ({ ok: true, exec }),
        nowMs: () => TICK_AT,
      },
    );

    dispatch(claim, tickContext(db));

    // The executor never ran: a shared worktree is never executed over, so the
    // other run's changes can never be swept into this step's commit.
    expect(calls()).toBe(0);
    expect(
      getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery,
    ).toBe(true);
    const rounds = dispatchRounds(db, "preflight");
    expect(rounds[0]?.recoveryCode).toBe("repo_lock_lost");
    expect(rounds[0]?.summary).toContain("is locked by other-worker");
    const recoveryMd = fs.readFileSync(
      path.join(runDir, "recovery.md"),
      "utf-8",
    );
    expect(recoveryMd).toContain("repo_lock_lost");
    expect(recoveryMd).toContain(`Repo path: ${repoPath}`);
  });

  it("holds the repository lock across execution and releases it after finalization", () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db, "preflight");
    const { repoPath, baseHead } = initRepo();
    const runDir = makeTempDir("momentum-livewrap-run-");
    const { registry } = countingRegistry((input) => {
      // The lock is active while the wrapper runs.
      expect(getActiveRepoLock(db, repoPath)?.goal_id).toBe(RUN_ID);
      fs.mkdirSync(input.runDir, { recursive: true });
      fs.writeFileSync(path.join(repoPath, "live-edit.txt"), "edit\n", "utf-8");
      fs.writeFileSync(input.resultJsonPath, VALID_RESULT_JSON, "utf-8");
      return succeededResult(input);
    });
    const exec: DispatchedStepExecutorContext = {
      repoPath,
      runDir,
      resultJsonPath: path.join(runDir, "result.json"),
      executorLogPath: path.join(runDir, "executor.log"),
      repoSafety: {
        baseHead,
        verificationCommands: ["test -f live-edit.txt"],
        verificationTimeoutSec: 30,
        verificationLogPath: path.join(runDir, "verification.log"),
      },
    };
    const dispatch = createLiveWrapperWorkflowDispatch(
      executeWorkflowStepDispatch,
      {
        registry,
        deriveExec: () => ({ ok: true, exec }),
        nowMs: () => TICK_AT,
      },
    );

    dispatch(claim, tickContext(db));

    expect(stepState(db, "preflight")).toBe("succeeded");
    // The lock does not outlive the execution.
    expect(getActiveRepoLock(db, repoPath)).toBeUndefined();
    const lockRow = db
      .prepare("SELECT state FROM repo_locks WHERE repo_root = ?")
      .get(repoPath) as { state: string } | undefined;
    expect(lockRow?.state).toBe("released");
  });

  it("refuses git mutation when the repository lock is lost while the wrapper ran", () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db, "preflight");
    const { repoPath, baseHead } = initRepo();
    const runDir = makeTempDir("momentum-livewrap-run-");
    const { registry } = countingRegistry((input) => {
      fs.mkdirSync(input.runDir, { recursive: true });
      fs.writeFileSync(path.join(repoPath, "live-edit.txt"), "edit\n", "utf-8");
      fs.writeFileSync(input.resultJsonPath, VALID_RESULT_JSON, "utf-8");
      db.prepare(
        "UPDATE repo_locks SET state = 'released', released_at = ?, updated_at = ? WHERE repo_root = ? AND state = 'active'",
      ).run(TICK_AT + 1, TICK_AT + 1, repoPath);
      return succeededResult(input);
    });
    const exec: DispatchedStepExecutorContext = {
      repoPath,
      runDir,
      resultJsonPath: path.join(runDir, "result.json"),
      executorLogPath: path.join(runDir, "executor.log"),
      repoSafety: {
        baseHead,
        verificationCommands: ["test -f live-edit.txt"],
        verificationTimeoutSec: 30,
        verificationLogPath: path.join(runDir, "verification.log"),
      },
    };
    const dispatch = createLiveWrapperWorkflowDispatch(
      executeWorkflowStepDispatch,
      {
        registry,
        deriveExec: () => ({ ok: true, exec }),
        nowMs: () => TICK_AT,
      },
    );

    dispatch(claim, tickContext(db));

    expect(
      getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery,
    ).toBe(true);
    expect(dispatchRounds(db, "preflight")[0]?.recoveryCode).toBe(
      "repo_lock_lost",
    );
    // No commit and no destructive reset over a worktree Momentum may not own.
    expect(runGit(repoPath, ["rev-parse", "HEAD"])).toBe(baseHead);
    expect(fs.existsSync(path.join(repoPath, "live-edit.txt"))).toBe(true);
  });

  it("keeps the repository lock guarding an unproven worktree after a manual-recovery park", () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db, "preflight");
    const { repoPath } = initRepo();
    const runDir = makeTempDir("momentum-livewrap-run-");
    const { registry } = countingRegistry((input) => {
      fs.mkdirSync(input.runDir, { recursive: true });
      fs.writeFileSync(path.join(repoPath, "live-edit.txt"), "edit\n", "utf-8");
      // An untrusted result document: finalization refuses to commit or reset,
      // so the wrapper's edit is still sitting in the worktree.
      fs.writeFileSync(input.resultJsonPath, "{not json", "utf-8");
      return succeededResult(input);
    });
    const exec: DispatchedStepExecutorContext = {
      repoPath,
      runDir,
      resultJsonPath: path.join(runDir, "result.json"),
      executorLogPath: path.join(runDir, "executor.log"),
      repoSafety: {
        baseHead: runGit(repoPath, ["rev-parse", "HEAD"]),
        verificationCommands: ["true"],
        verificationTimeoutSec: 30,
        verificationLogPath: path.join(runDir, "verification.log"),
      },
    };
    const dispatch = createLiveWrapperWorkflowDispatch(
      executeWorkflowStepDispatch,
      {
        registry,
        deriveExec: () => ({ ok: true, exec }),
        nowMs: () => TICK_AT,
      },
    );

    dispatch(claim, tickContext(db));

    expect(
      getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery,
    ).toBe(true);
    // The dirty worktree stays guarded: the lock is marked for manual recovery
    // instead of released, so another run cannot acquire the repository and
    // sweep the leftover edit into its own commit.
    const lockRow = db
      .prepare(
        "SELECT state, recovery_status FROM repo_locks WHERE repo_root = ?",
      )
      .get(repoPath) as { state: string; recovery_status: string | null };
    expect(lockRow.state).toBe("needs_manual_recovery");
    expect(lockRow.recovery_status).toContain("unproven worktree");
    const blocked = acquireRepoLock(db, {
      repoRoot: repoPath,
      holder: "other-worker",
      goalId: "run-other",
      iteration: 1,
      jobId: "run-other::implementation::dispatch",
      leaseExpiresAt: TICK_AT + 600_000,
      now: TICK_AT + 2,
    });
    expect(blocked.ok).toBe(false);
  });

  it("preserves precise finalization recovery context and writes recovery.md", () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db, "preflight");
    const { repoPath, baseHead } = initRepo();
    const runDir = makeTempDir("momentum-livewrap-run-");
    const { registry } = countingRegistry((input) => {
      fs.mkdirSync(input.runDir, { recursive: true });
      fs.writeFileSync(input.resultJsonPath, "{not json", "utf-8");
      return succeededResult(input);
    });
    const exec: DispatchedStepExecutorContext = {
      repoPath,
      runDir,
      resultJsonPath: path.join(runDir, "result.json"),
      executorLogPath: path.join(runDir, "executor.log"),
      repoSafety: {
        baseHead,
        verificationCommands: ["true"],
        verificationTimeoutSec: 30,
        verificationLogPath: path.join(runDir, "verification.log"),
      },
    };
    const dispatch = createLiveWrapperWorkflowDispatch(
      executeWorkflowStepDispatch,
      {
        registry,
        deriveExec: () => ({ ok: true, exec }),
        nowMs: () => TICK_AT,
      },
    );

    dispatch(claim, tickContext(db));

    const recovery = getWorkflowRunManualRecoveryState(db, RUN_ID);
    expect(recovery?.needsManualRecovery).toBe(true);
    expect(recovery?.reason).toContain("result_invalid");
    expect(dispatchRounds(db, "preflight")[0]?.recoveryCode).toBe(
      "result_invalid",
    );
    const recoveryMd = fs.readFileSync(
      path.join(runDir, "recovery.md"),
      "utf-8",
    );
    expect(recoveryMd).toContain("result_invalid");
  });
});

describe("createLiveWrapperWorkflowDispatch — unconfigured fails honestly", () => {
  it("parks the run for manual recovery on runtime_unavailable instead of a fake success", () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db, "preflight");
    const runDir = makeTempDir("momentum-livewrap-run-");
    const exec: DispatchedStepExecutorContext = {
      ...EXEC_CONTEXT,
      runDir,
      resultJsonPath: path.join(runDir, "result.json"),
      executorLogPath: path.join(runDir, "executor.log"),
    };
    // The real registry with NO profile resolves every kind to the honest
    // unconfigured adapter that refuses with runtime_unavailable.
    const registry = buildRealWorkflowStepExecutorRegistry();
    const dispatch = createLiveWrapperWorkflowDispatch(
      executeWorkflowStepDispatch,
      {
        registry,
        deriveExec: () => ({ ok: true, exec }),
        nowMs: () => TICK_AT,
      },
    );

    const result = dispatch(claim, tickContext(db));

    // The base dispatch still reports the scaffold start; the honest failure is
    // a durable side effect, NOT a fabricated clean terminal.
    expect(result.status).toBe(WORKFLOW_DISPATCH_RESULT_STATUS.dispatched);
    expect(
      getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery,
    ).toBe(true);
    expect(stepState(db, "preflight")).toBe("running");
    const invocation = loadExecutorInvocation(
      db,
      deriveDispatchInvocationId(RUN_ID, "preflight"),
    );
    expect(invocation?.state).toBe("manual_recovery_required");
    const gates = listWorkflowGatesForRun(db, RUN_ID);
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({
      gateType: "manual_recovery_required",
      stepRunId: "preflight",
    });
    const recoveryMd = fs.readFileSync(
      path.join(runDir, "recovery.md"),
      "utf-8",
    );
    expect(recoveryMd).toContain("runtime_unavailable");
    expect(recoveryMd).toContain(`executor-log: ${exec.executorLogPath}`);
    expect(recoveryMd).toContain(`result-file: ${exec.resultJsonPath}`);
  });
});

describe("createLiveWrapperWorkflowDispatch — idempotent re-entry", () => {
  it("never re-runs the executor when a re-entered tick finds the existing scaffold", () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db, "preflight");
    const { registry, calls } = countingRegistry(succeededResult);
    const dispatch = createLiveWrapperWorkflowDispatch(
      executeWorkflowStepDispatch,
      { registry, deriveExec: () => ({ ok: true, exec: EXEC_CONTEXT }) },
    );

    const first = dispatch(claim, tickContext(db, TICK_AT));
    expect(first.status).toBe(WORKFLOW_DISPATCH_RESULT_STATUS.dispatched);
    expect(calls()).toBe(1);
    expect(stepState(db, "preflight")).toBe("succeeded");

    // A re-entered tick (same claim) finds the existing scaffold: the base
    // dispatch reports `alreadyDispatched` and the producer sees the terminal
    // invocation, so the executor is NEVER run a second time.
    const second = dispatch(claim, tickContext(db, TICK_AT + 100));
    expect(second.status).toBe(
      WORKFLOW_DISPATCH_RESULT_STATUS.alreadyDispatched,
    );
    expect(calls()).toBe(1);
    expect(dispatchRounds(db, "preflight")).toHaveLength(1);
    expect(stepState(db, "preflight")).toBe("succeeded");
  });
});

describe("createLiveWrapperWorkflowDispatch — recovery retry after repaired wrapper path", () => {
  it("lets merge-cleanup retry after clearing a retryable stale wrapper failure without duplicating the first attempt", () => {
    const db = openSeededDb();
    db.prepare(
      `UPDATE workflow_steps
          SET state = 'succeeded', started_at = ?, finished_at = ?, result_digest = ?
        WHERE run_id = ? AND step_order < 4`,
    ).run(NOW, NOW, "test-predecessor", RUN_ID);
    const firstClaim = approveAndClaim(db, "merge-cleanup");
    let repaired = false;
    const attempts: number[] = [];
    const { registry, calls } = countingRegistry((input) => {
      attempts.push(input.attempt);
      return repaired ? succeededResult(input) : wrapperBootstrapFailure(input);
    });
    const dispatch = createLiveWrapperWorkflowDispatch(
      executeWorkflowStepDispatch,
      { registry, deriveExec: () => ({ ok: true, exec: EXEC_CONTEXT }) },
    );

    const first = dispatch(firstClaim, tickContext(db, TICK_AT));

    expect(first.status).toBe(WORKFLOW_DISPATCH_RESULT_STATUS.dispatched);
    expect(calls()).toBe(1);
    expect(stepState(db, "merge-cleanup")).toBe("running");
    expect(
      getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery,
    ).toBe(true);
    expect(dispatchRounds(db, "merge-cleanup")).toHaveLength(1);
    expect(listWorkflowGatesForRun(db, RUN_ID)).toHaveLength(1);

    repaired = true;
    const cleared = clearWorkflowRunManualRecoveryGuarded(db, {
      runId: RUN_ID,
      now: TICK_AT + 100,
    });

    expect(cleared.ok).toBe(true);
    if (!cleared.ok) throw new Error("clear failed");
    expect(cleared.retryPrepared).toEqual({
      stepId: "merge-cleanup",
      recoveryCode: "runtime_unavailable",
    });
    expect(stepState(db, "merge-cleanup")).toBe("approved");
    const retryClaim = claimRunnableWorkflowStep(db, {
      runId: RUN_ID,
      stepId: "merge-cleanup",
      holder: WORKER,
      leaseExpiresAt: TICK_AT + 30_000,
      now: TICK_AT + 101,
    });
    expect(retryClaim.ok).toBe(true);
    if (!retryClaim.ok) throw new Error("retry claim failed");

    const second = dispatch(retryClaim.claim, tickContext(db, TICK_AT + 102));

    expect(second.status).toBe(WORKFLOW_DISPATCH_RESULT_STATUS.dispatched);
    expect(calls()).toBe(2);
    expect(attempts).toEqual([1, 2]);
    expect(stepState(db, "merge-cleanup")).toBe("succeeded");
    expect(
      getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery,
    ).toBe(false);
    const rounds = dispatchRounds(db, "merge-cleanup");
    expect(rounds).toHaveLength(2);
    expect(rounds[0]?.logPaths[0]).toBe(EXEC_CONTEXT.executorLogPath);
    expect(rounds[1]?.logPaths[0]).toContain("attempt-2/executor.log");
    expect(rounds[1]?.logPaths[0]).not.toBe(rounds[0]?.logPaths[0]);
    expect(listWorkflowGatesForRun(db, RUN_ID)).toHaveLength(1);
  });

  it("preserves persisted route selection when retrying merge-cleanup after clearing recovery", () => {
    const db = openNativeCodingDbWithRoute({
      steps: {
        "merge-cleanup": {
          harness: "codex",
          model: "gpt-5.1",
          effort: "high",
        },
      },
    });
    db.prepare(
      `UPDATE workflow_steps
          SET state = 'succeeded', started_at = ?, finished_at = ?, result_digest = ?
        WHERE run_id = ? AND step_order < 4`,
    ).run(NOW, NOW, "test-predecessor", RUN_ID);
    const firstClaim = approveAndClaim(db, "merge-cleanup");
    let repaired = false;
    const { registry } = countingRegistry((input) =>
      repaired ? succeededResult(input) : wrapperBootstrapFailure(input),
    );
    const dispatch = createLiveWrapperWorkflowDispatch(
      executeWorkflowStepDispatch,
      { registry, deriveExec: () => ({ ok: true, exec: EXEC_CONTEXT }) },
    );

    dispatch(firstClaim, tickContext(db, TICK_AT));

    let rounds = dispatchRounds(db, "merge-cleanup");
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({
      agentProvider: "codex",
      model: "gpt-5.1",
      effort: "high",
    });

    repaired = true;
    const cleared = clearWorkflowRunManualRecoveryGuarded(db, {
      runId: RUN_ID,
      now: TICK_AT + 100,
    });
    expect(cleared.ok).toBe(true);
    const retryClaim = claimRunnableWorkflowStep(db, {
      runId: RUN_ID,
      stepId: "merge-cleanup",
      holder: WORKER,
      leaseExpiresAt: TICK_AT + 30_000,
      now: TICK_AT + 101,
    });
    expect(retryClaim.ok).toBe(true);
    if (!retryClaim.ok) throw new Error("retry claim failed");

    dispatch(retryClaim.claim, tickContext(db, TICK_AT + 102));

    rounds = dispatchRounds(db, "merge-cleanup");
    expect(rounds).toHaveLength(2);
    expect(rounds[1]).toMatchObject({
      agentProvider: "codex",
      model: "gpt-5.1",
      effort: "high",
    });
  });

  it("passes persisted route selection into live-wrapper executor input", () => {
    const db = openNativeCodingDbWithRoute({
      steps: {
        "merge-cleanup": {
          harness: "codex",
          model: "gpt-5.1",
          effort: "high",
        },
      },
    });
    db.prepare(
      `UPDATE workflow_steps
          SET state = 'succeeded', started_at = ?, finished_at = ?, result_digest = ?
        WHERE run_id = ? AND step_order < 4`,
    ).run(NOW, NOW, "test-predecessor", RUN_ID);
    const claim = approveAndClaim(db, "merge-cleanup");
    const observed: Array<{
      agentProvider: unknown;
      model: unknown;
      effort: unknown;
    }> = [];
    const { registry } = countingRegistry((input) => {
      observed.push({
        agentProvider: input.agentProvider,
        model: input.model,
        effort: input.effort,
      });
      return succeededResult(input);
    });
    const dispatch = createLiveWrapperWorkflowDispatch(
      executeWorkflowStepDispatch,
      { registry, deriveExec: () => ({ ok: true, exec: EXEC_CONTEXT }) },
    );

    dispatch(claim, tickContext(db, TICK_AT));

    expect(observed).toEqual([
      {
        agentProvider: "codex",
        model: "gpt-5.1",
        effort: "high",
      },
    ]);
  });

  it("reattaches to already-terminal merge-cleanup evidence without rerunning side effects", () => {
    const db = openSeededDb();
    db.prepare(
      `UPDATE workflow_steps
          SET state = 'succeeded', started_at = ?, finished_at = ?, result_digest = ?
        WHERE run_id = ? AND step_order < 4`,
    ).run(NOW, NOW, "test-predecessor", RUN_ID);
    const claim = approveAndClaim(db, "merge-cleanup");
    const { registry, calls } = countingRegistry(succeededResult);
    const dispatch = createLiveWrapperWorkflowDispatch(
      executeWorkflowStepDispatch,
      { registry, deriveExec: () => ({ ok: true, exec: EXEC_CONTEXT }) },
    );

    dispatch(claim, tickContext(db, TICK_AT));
    const reentered = dispatch(claim, tickContext(db, TICK_AT + 100));

    expect(reentered.status).toBe(
      WORKFLOW_DISPATCH_RESULT_STATUS.alreadyDispatched,
    );
    expect(calls()).toBe(1);
    expect(stepState(db, "merge-cleanup")).toBe("succeeded");
    expect(dispatchRounds(db, "merge-cleanup")).toHaveLength(1);
  });
});

describe("createLiveWrapperWorkflowDispatch — non-derivable exec context parks for manual recovery", () => {
  it("routes a refused context derivation through manual recovery without running the executor or stranding the step", () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db, "preflight");
    const { registry, calls } = countingRegistry(succeededResult);
    const dispatch = createLiveWrapperWorkflowDispatch(
      executeWorkflowStepDispatch,
      {
        registry,
        deriveExec: () => ({ ok: false, reason: "missing_repo_path" }),
      },
    );

    const result = dispatch(claim, tickContext(db));

    // The base dispatch still reports the scaffold start. Parking is a durable
    // side effect — NOT a thrown error that would make the scheduler release the
    // lease over a still-running step and strand it.
    expect(result.status).toBe(WORKFLOW_DISPATCH_RESULT_STATUS.dispatched);
    // The executor was never consulted: a non-derivable context runs no bounded
    // session at all (not even input validation).
    expect(calls()).toBe(0);
    // The run is parked with the derivation failure as honest evidence — NOT a
    // fabricated clean terminal, and NOT a generic input-validation failure.
    expect(
      getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery,
    ).toBe(true);
    expect(stepState(db, "preflight")).toBe("running");
    const invocation = loadExecutorInvocation(
      db,
      deriveDispatchInvocationId(RUN_ID, "preflight"),
    );
    expect(invocation?.state).toBe("manual_recovery_required");
    const rounds = dispatchRounds(db, "preflight");
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.recoveryCode).toBe("runtime_unavailable");
    expect(rounds[0]?.summary).toContain("cannot derive execution context");
    const gates = listWorkflowGatesForRun(db, RUN_ID);
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({
      gateType: "manual_recovery_required",
      stepRunId: "preflight",
    });
    // No stranded lease: RC-2 released the held dispatch lease while parking.
    expect(getWorkflowLease(db, RUN_ID, "dispatch")?.releasedAt).not.toBeNull();
  });

  it("preserves a precise recovery code from a refused derivation instead of runtime_unavailable", () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db, "preflight");
    const { registry, calls } = countingRegistry(succeededResult);
    const dispatch = createLiveWrapperWorkflowDispatch(
      executeWorkflowStepDispatch,
      {
        registry,
        deriveExec: () => ({
          ok: false,
          reason:
            "verification_policy_invalid: (policy_schema_invalid) bad MOMENTUM.md",
          recoveryCode: "invalid_input",
        }),
      },
    );

    dispatch(claim, tickContext(db));

    expect(calls()).toBe(0);
    expect(
      getWorkflowRunManualRecoveryState(db, RUN_ID)?.needsManualRecovery,
    ).toBe(true);
    const rounds = dispatchRounds(db, "preflight");
    expect(rounds).toHaveLength(1);
    // The precise setup classification survives to the round: `invalid_input`
    // is not in the retryable dispatch recovery codes, so clear-recovery will
    // not prepare a doomed retry for a config problem.
    expect(rounds[0]?.recoveryCode).toBe("invalid_input");
    expect(rounds[0]?.summary).toContain("verification_policy_invalid");
  });

  it("is idempotent on re-entry: never runs the executor and opens no duplicate gate", () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db, "preflight");
    const { registry, calls } = countingRegistry(succeededResult);
    const dispatch = createLiveWrapperWorkflowDispatch(
      executeWorkflowStepDispatch,
      {
        registry,
        deriveExec: () => ({ ok: false, reason: "missing_repo_path" }),
      },
    );

    const first = dispatch(claim, tickContext(db, TICK_AT));
    expect(first.status).toBe(WORKFLOW_DISPATCH_RESULT_STATUS.dispatched);
    const second = dispatch(claim, tickContext(db, TICK_AT + 100));

    expect(second.status).toBe(
      WORKFLOW_DISPATCH_RESULT_STATUS.alreadyDispatched,
    );
    expect(calls()).toBe(0);
    const rounds = dispatchRounds(db, "preflight");
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.summary).toContain("cannot derive execution context");
    expect(listWorkflowGatesForRun(db, RUN_ID)).toHaveLength(1);
    expect(stepState(db, "preflight")).toBe("running");
  });
});

describe("createLiveWrapperWorkflowDispatch — does not execute over a non-startable dispatch", () => {
  it("returns the base result unchanged and never derives exec / runs the executor for a fail-closed dispatch", () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db, "preflight");
    const baseResult: WorkflowStepDispatchResult = {
      status: WORKFLOW_DISPATCH_RESULT_STATUS.failClosed,
      detail: "parked for manual recovery",
    };
    const { registry, calls } = countingRegistry(succeededResult);
    const dispatch = createLiveWrapperWorkflowDispatch(() => baseResult, {
      registry,
      deriveExec: () => {
        throw new Error("deriveExec must not run for a fail-closed dispatch");
      },
    });

    const result = dispatch(claim, tickContext(db));

    expect(result).toEqual(baseResult);
    expect(calls()).toBe(0);
  });

  it("never runs the executor when the base dispatch reports step_not_startable", () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db, "preflight");
    const baseResult: WorkflowStepDispatchResult = {
      status: WORKFLOW_DISPATCH_RESULT_STATUS.stepNotStartable,
    };
    const { registry, calls } = countingRegistry(succeededResult);
    const dispatch = createLiveWrapperWorkflowDispatch(() => baseResult, {
      registry,
      deriveExec: () => {
        throw new Error("deriveExec must not run for a not-startable dispatch");
      },
    });

    const result = dispatch(claim, tickContext(db));

    expect(result.status).toBe(
      WORKFLOW_DISPATCH_RESULT_STATUS.stepNotStartable,
    );
    expect(calls()).toBe(0);
  });
});

describe("createLiveWrapperWorkflowDispatch — family-owned lanes", () => {
  it("leaves subworkflow scaffolds for the dedicated subworkflow dispatch wrapper", () => {
    const db = openSeededDb();
    db.prepare(
      `UPDATE step_definitions SET executor = 'subworkflow'
         WHERE definition_key = ? AND definition_version = ? AND step_key = ?`,
    ).run(
      CODING_WORKFLOW_DEFINITION.key,
      CODING_WORKFLOW_DEFINITION.version,
      "preflight",
    );
    const claim = approveAndClaim(db, "preflight");
    const { registry, calls } = countingRegistry(succeededResult);
    const dispatch = createLiveWrapperWorkflowDispatch(
      executeWorkflowStepDispatch,
      {
        registry,
        deriveExec: () => {
          throw new Error("deriveExec must not run for a subworkflow scaffold");
        },
      },
    );

    const result = dispatch(claim, tickContext(db));

    expect(result.status).toBe(WORKFLOW_DISPATCH_RESULT_STATUS.dispatched);
    expect(calls()).toBe(0);
    expect(stepState(db, "preflight")).toBe("running");
    const invocation = loadExecutorInvocation(
      db,
      deriveDispatchInvocationId(RUN_ID, "preflight"),
    );
    expect(invocation?.executorFamily).toBe("subworkflow");
    expect(invocation?.state).toBe("running");
    expect(getWorkflowLease(db, RUN_ID, "dispatch")?.releasedAt).toBeNull();
  });
});

describe("createLiveWrapperWorkflowDispatch — M9 direct-finalize lane preserved", () => {
  it("a real fail-closed base dispatch over an unlinked run finalizes nothing through this lane", () => {
    const db = openSeededDb();
    const claim = approveAndClaim(db, "preflight");
    // Sever the run's definition link so the production base dispatch fail-closes
    // (an M7-imported / M9 direct-finalize-style run has no dispatchable family).
    db.prepare(
      "UPDATE workflow_runs SET workflow_definition_key = NULL WHERE id = ?",
    ).run(RUN_ID);
    const { registry, calls } = countingRegistry(succeededResult);
    const dispatch = createLiveWrapperWorkflowDispatch(
      executeWorkflowStepDispatch,
      {
        registry,
        deriveExec: () => {
          throw new Error("deriveExec must not run for a fail-closed dispatch");
        },
      },
    );

    const result = dispatch(claim, tickContext(db));

    expect(result.status).toBe(WORKFLOW_DISPATCH_RESULT_STATUS.failClosed);
    // The executor never ran and no dispatch invocation exists for this lane to
    // reconcile — RC-2 stays the single finalization owner of dispatched steps.
    expect(calls()).toBe(0);
    expect(
      loadExecutorInvocation(
        db,
        deriveDispatchInvocationId(RUN_ID, "preflight"),
      ),
    ).toBeUndefined();
    expect(stepState(db, "preflight")).not.toBe("succeeded");
  });
});
