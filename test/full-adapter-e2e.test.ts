import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import { CODING_WORKFLOW_DEFINITION } from "../src/core/workflow/definition/definition.js";
import { persistWorkflowDefinition } from "../src/core/workflow/definition/persist.js";
import { persistWorkflowRunStart } from "../src/core/workflow/run/start-persist.js";
import {
  reconcileLinearSource,
  type LinearReconciliationClient,
  type LinearReconciliationFetchPageInput,
  type LinearReconciliationFetchPageResult
} from "../src/core/source/reconciliation.js";
import {
  listSourceItems,
  listSourceSnapshotsForItem
} from "../src/core/source/items.js";
import { listSourceReconciliationRuns } from "../src/core/source/reconciliation-runs.js";
import { claimRunnableWorkflowStep } from "../src/core/workflow/dispatch/scheduler.js";
import { getWorkflowLease } from "../src/core/workflow/leases.js";
import { listWorkflowGatesForRun } from "../src/core/workflow/gate/persist.js";
import { getWorkflowRunManualRecoveryState } from "../src/core/workflow/run/recovery.js";
import {
  executeWorkflowStepDispatch,
  WORKFLOW_DISPATCH_RESULT_STATUS
} from "../src/core/workflow/dispatch/execute.js";
import {
  listExecutorArtifactsForRound,
  listExecutorCheckpointsForRound,
  listExecutorRoundsForInvocation,
  loadExecutorInvocation,
  loadExecutorRound
} from "../src/core/executors/loop/persist.js";
import {
  resolveSingleShotRoundSelection,
  singleShotInvocationId,
  singleShotRoundId,
  type SingleShotRoundRuntimeInputs
} from "../src/core/executors/single-shot/executor.js";
import { runSingleShotStep } from "../src/core/executors/single-shot/orchestrator.js";
import {
  goalLoopInvocationId,
  goalLoopRoundId,
  resolveGoalLoopRoundSelection,
  type GoalLoopRoundRuntimeInputs
} from "../src/core/executors/goal-loop/executor.js";
import { runGoalLoopStep } from "../src/core/executors/goal-loop/orchestrator.js";
import {
  noMistakesInvocationId,
  noMistakesRoundId,
  type NoMistakesExternalState,
  type NoMistakesRoundRuntimeInputs
} from "../src/adapters/no-mistakes-executor.js";
import { runNoMistakesMirrorStep } from "../src/adapters/no-mistakes-orchestrator.js";
import {
  LIVE_STEP_DEFAULT_LEASE_KIND,
  runLiveWorkflowStep
} from "../src/core/executors/live-step/orchestrator.js";
import { getWorkflowStep } from "../src/core/workflow/step/transitions.js";
import type {
  WorkflowStepExecutor,
  WorkflowStepExecutorDispatchResult,
  WorkflowStepExecutorInput
} from "../src/core/workflow/step/executor.js";
import type { WorkflowApprovalBoundary } from "../src/core/workflow/run/reducer.js";
import type { FinalizeLiveWorkflowStepFromResultFileResult } from "../src/core/executors/live-step/finalize.js";
import type { RunnerResult } from "../src/core/executors/runner/types.js";

/**
 * NGX-372 full adapter E2E proof (Adapter Test Coverage milestone).
 *
 * This is the capstone of the layered adapter-test strategy
 * (SPEC.md): isolated contract tests
 * (NGX-369 / NGX-370) and a stubbed integration smoke (NGX-371) are green, so
 * this CI-safe proof composes the *real* adapter layers through the intended
 * operator flow and records evidence of the composition. It is the test that
 * should never be the first to discover an adapter-contract bug — every layer it
 * touches is already individually pinned.
 *
 * It is CI-safe by construction: every external system is a fake or a local
 * temp dir. No `api.linear.app` call, no real agent/runner, no git remote, no
 * external write. The sole real-external-system path stays the opt-in
 * `test/real-linear-read-smoke.test.ts`, which never runs in default CI.
 *
 * Composition proven (the acceptance criterion's "adapter composition across
 * source, local persistence, workflow/executor dispatch, recovery/finalization,
 * and verification gates"):
 *
 *   source adapter read -> local reconciliation/persistence (source_* tables)
 *   -> workflow run start (built-in coding workflow definition)
 *   -> production dispatch seam -> phase-1 executor start scaffold
 *   -> landed executor adapter -> terminal finalization + passing verification
 *   -> external-write family stays policy-gated closed (scaffold only here)
 *
 * Faithfulness / phase-1 boundary: `executeWorkflowStepDispatch` is the shipped
 * production dispatch path and stops at the start *scaffold* (invocation
 * `running`, round `pending`) — driving the bounded mechanism to terminal,
 * running verification/commit finalization, and advancing the `workflow_steps`
 * row are owned by the landed `runSingleShotStep` / `runGoalLoopStep` /
 * `runNoMistakesMirrorStep` adapters, whose seam-level reconciliation with the
 * scaffold is the documented real-adapter follow-up (see the phase-1 boundary
 * note in src/core/workflow/dispatch/execute.ts). This proof therefore exercises the
 * scaffold via the production seam on one one-shot step (`preflight`) and the
 * terminal finalization via the landed adapters on distinct steps: the one-shot
 * adapter on `postflight`, the goal-loop adapter on `implementation` (the
 * goal-loop family in the real coding workflow definition), which drives a
 * bounded multi-round invocation to terminal `succeeded` with a passing
 * verification gate, and the no-mistakes mirror adapter on `no-mistakes`, which
 * settles its single long-lived mirror round to terminal `succeeded` on a
 * corroborated `completed` external review gate (the mirror's equivalent of a
 * passing verification gate). Each carries a deliberately distinct invocation id
 * (`...::dispatch` for the scaffold vs each landed adapter's own reattachable
 * id), so composing scaffold + multiple terminal families never mints two owners
 * for one step. Finally, the M9 live-wrapper managed-step adapter
 * (`runLiveWorkflowStep`) is composed on `merge-cleanup`: a genuinely distinct
 * layer from the executor-loop adapters, it drives the durable `workflow_steps`
 * row itself (approved -> running -> succeeded) under a `managed-step` lease
 * against a real repo lock, persisting terminal state before releasing the
 * lease. With the one-shot, goal-loop, no-mistakes mirror, and M9 live-wrapper
 * terminals all composed, the layered adapter-test strategy is complete.
 */

const NOW = 1_700_000_000_000;
const WORKER = "ngx-372-e2e-worker";
const SHA = "a".repeat(40);

const CODING_WORKFLOW_STEP_IDS = [
  "preflight",
  "implementation",
  "postflight",
  "no-mistakes",
  "merge-cleanup",
  "linear-refresh"
] as const;

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-ngx-372-e2e-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function makeLinearIssue(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: overrides["id"] ?? "issue-ngx-372",
    identifier: overrides["identifier"] ?? "NGX-372",
    title: overrides["title"] ?? "Opt-in real adapter smoke and full E2E proof",
    url:
      overrides["url"] ??
      "https://linear.app/ngxcalvin/issue/NGX-372/opt-in-real-adapter-smoke-and-full-e2e-proof",
    state: overrides["state"] ?? { id: "state-todo", name: "Todo" },
    project: overrides["project"] ?? {
      id: "momentum-project",
      key: "NGX",
      name: "Momentum"
    },
    projectMilestone: overrides["projectMilestone"] ?? {
      id: "adapter-test-coverage",
      name: "Adapter Test Coverage"
    },
    labels: overrides["labels"] ?? { nodes: [] },
    assignee: overrides["assignee"] ?? null,
    priority: overrides["priority"] ?? 0,
    updatedAt: overrides["updatedAt"] ?? "2026-06-11T00:00:00.000Z",
    ...overrides
  };
}

function fakeLinearClient(
  pages: readonly LinearReconciliationFetchPageResult[]
): LinearReconciliationClient & {
  readonly requests: LinearReconciliationFetchPageInput[];
} {
  const requests: LinearReconciliationFetchPageInput[] = [];
  let pageIndex = 0;
  return {
    requests,
    fetchPage(
      input: LinearReconciliationFetchPageInput
    ): LinearReconciliationFetchPageResult {
      requests.push(input);
      const page = pages[pageIndex];
      pageIndex += 1;
      return page ?? { ok: true, page: { issues: [], nextCursor: null } };
    }
  };
}

function seedCodingWorkflowRun(
  db: MomentumDb,
  input: {
    runId: string;
    repoPath: string;
    objective: string;
    approvalBoundary?: WorkflowApprovalBoundary;
  }
): void {
  persistWorkflowDefinition(db, CODING_WORKFLOW_DEFINITION, { now: NOW });
  persistWorkflowRunStart(db, {
    definition: CODING_WORKFLOW_DEFINITION,
    runId: input.runId,
    repoPath: input.repoPath,
    objective: input.objective,
    now: NOW,
    ...(input.approvalBoundary !== undefined
      ? { approvalBoundary: input.approvalBoundary }
      : {})
  });
}

function setStepState(
  db: MomentumDb,
  runId: string,
  stepId: string,
  state: string
): void {
  db.prepare(
    "UPDATE workflow_steps SET state = ? WHERE run_id = ? AND step_id = ?"
  ).run(state, runId, stepId);
}

function countRows(db: MomentumDb, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
    n: number;
  };
  return row.n;
}

function runnerResult(overrides: Partial<RunnerResult> = {}): RunnerResult {
  return {
    success: true,
    summary: "postflight review pass clean",
    key_changes_made: ["ran the bounded postflight review"],
    key_learnings: [],
    remaining_work: [],
    goal_complete: true,
    commit: {
      type: "test",
      scope: "adapter",
      subject: "full adapter e2e proof",
      body: "",
      breaking: false
    },
    ...overrides
  };
}

// A monotonic clock for deterministic timestamps: start, start+step, ...
function monotonicClock(start: number, step = 100): () => number {
  let n = start - step;
  return () => (n += step);
}

function roundInputs(artifactRoot: string): SingleShotRoundRuntimeInputs {
  return {
    inputDigest: "sha256:postflight-input",
    artifactRoot,
    logPaths: [path.join(artifactRoot, "stdout.log")]
  };
}

// The goal-loop adapter derives a round's verification/commit evidence from the
// total `finalize` outcome (mirroring the M9 repo-safety finalize) rather than a
// caller-supplied `evidence` block. A `committed` outcome with passing
// verification settles the round `succeeded` with `verificationStatus: "passed"`
// and the finalize commit's SHA — the goal-loop equivalent of the one-shot
// adapter's passing verification gate.
const PARENT_SHA = "b".repeat(40);

const GOAL_LOOP_COMMITTED: FinalizeLiveWorkflowStepFromResultFileResult = {
  outcome: "committed",
  verification: {
    ok: true,
    results: [
      {
        command: "pnpm test",
        exit_code: 0,
        signal: null,
        duration_ms: 12,
        timed_out: false,
        succeeded: true
      }
    ]
  },
  commit: {
    ok: true,
    commitSha: SHA,
    parentSha: PARENT_SHA,
    message: "feat(adapter): implementation round commit"
  },
  head: SHA
};

function goalLoopRoundInputs(
  artifactRoot: string,
  roundIndex: number
): GoalLoopRoundRuntimeInputs {
  const root = path.join(artifactRoot, `round-${roundIndex}`);
  return {
    inputDigest: `sha256:implementation-input-${roundIndex}`,
    artifactRoot: root,
    logPaths: [path.join(root, "stdout.log")]
  };
}

// The no-mistakes mirror reflects external review-gate state rather than driving
// an agent Momentum chose, so its terminal-success evidence is a *corroborated*
// `completed` external snapshot with CI passed — the mirror's equivalent of the
// one-shot / goal-loop adapters' passing verification gate. The snapshot's
// identity is corroborated against the expected identity pinned at start, and a
// completed-with-CI-passed snapshot settles the long-lived round straight to
// `succeeded` from `mirroring_external_state` (no intervening capture phase).
const NO_MISTAKES_IDENTITY = {
  externalRunId: "nm-run-ngx-372",
  branch: "feat/ngx-372",
  headSha: SHA
} as const;

function noMistakesCompletedState(): NoMistakesExternalState {
  return {
    externalRunId: NO_MISTAKES_IDENTITY.externalRunId,
    branch: NO_MISTAKES_IDENTITY.branch,
    headSha: NO_MISTAKES_IDENTITY.headSha,
    activeStep: "merge",
    stepStatus: "completed",
    findings: [],
    selectedFindingIds: [],
    decisions: [],
    prUrl: null,
    ciState: "passed"
  };
}

function noMistakesRoundInputs(
  artifactRoot: string
): NoMistakesRoundRuntimeInputs {
  const root = path.join(artifactRoot, "no-mistakes");
  return {
    inputDigest: "sha256:no-mistakes-start",
    artifactRoot: root,
    logPaths: [path.join(root, "state.json")]
  };
}

// The M9 live wrapper is the *managed-step* orchestrator: unlike the
// executor-loop adapters (one-shot / goal-loop / no-mistakes mirror) that settle
// the executor_invocations/executor_rounds layer, `runLiveWorkflowStep` drives
// the durable `workflow_steps` row itself (approved -> running -> succeeded)
// under a `managed-step` lease, and it requires a repo-backed run with an active
// worker-held repo lock plus durable approval coverage for the step kind. This
// seeds those live-execution preconditions: a goal row, the run's goal_id link,
// and an active repo lock owned by the worker for the run's repo path.
function seedLiveStepRepoLock(
  db: MomentumDb,
  input: { runId: string; goalId: string; repoPath: string; holder: string }
): void {
  db.prepare(
    `INSERT OR IGNORE INTO goals (
       id, title, repo, runner, branch, max_iterations, verification,
       verification_timeout_sec, state, artifact_dir, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.goalId,
    input.goalId,
    input.repoPath,
    "fake",
    "main",
    1,
    "[]",
    900,
    "initialized",
    path.join(input.repoPath, ".artifacts"),
    NOW,
    NOW
  );
  db.prepare("UPDATE workflow_runs SET goal_id = ? WHERE id = ?").run(
    input.goalId,
    input.runId
  );
  db.prepare(
    `INSERT INTO repo_locks (
       id, repo_root, holder, goal_id, iteration, job_id, state,
       acquired_at, heartbeat_at, lease_expires_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    `lock-${input.holder}`,
    input.repoPath,
    input.holder,
    input.goalId,
    1,
    "job-1",
    "active",
    NOW,
    NOW,
    NOW + 60_000,
    NOW
  );
}

// A deterministic M9 live wrapper for the `merge-cleanup` step that reports a
// clean terminal success — the live-wrapper equivalent of a passing gate. In
// production this is the spawned GNHF/postflight/no-mistakes/merge-cleanup
// wrapper; here it is a fake whose `WorkflowStepExecutorDispatchResult` the
// managed-step orchestrator finalizes into the durable `workflow_steps` row.
function liveMergeCleanupExecutor(resultDigest: string): WorkflowStepExecutor {
  return {
    kind: "merge-cleanup",
    executes: true,
    execute: (
      executorInput: WorkflowStepExecutorInput
    ): WorkflowStepExecutorDispatchResult => ({
      ok: true,
      result: {
        state: "succeeded",
        summary: "live merge-cleanup wrapper pass clean",
        checkpoints: [],
        artifacts: [],
        resultDigest,
        errorCode: null,
        errorMessage: null,
        retryHint: null,
        recoveryHint: null
      },
      executorLogPath: executorInput.executorLogPath,
      resultJsonPath: executorInput.resultJsonPath
    })
  };
}

/**
 * Record the composition evidence the acceptance criterion asks the E2E proof to
 * leave behind. Defaults to the disposable temp data dir (cleaned up in
 * `afterEach`) so default `pnpm test` writes no durable repo footprint; an
 * operator capturing closeout evidence sets `MOMENTUM_E2E_EVIDENCE_DIR` to a
 * durable location (e.g. gitignored `.agent-runs/full-adapter-e2e/`), mirroring
 * the opt-in real read smoke's `MOMENTUM_REAL_SMOKE_EVIDENCE_DIR` knob.
 */
function recordCompositionEvidence(
  fallbackDir: string,
  label: string,
  payload: Record<string, unknown>
): string {
  const baseDir =
    process.env["MOMENTUM_E2E_EVIDENCE_DIR"]?.trim() || fallbackDir;
  fs.mkdirSync(baseDir, { recursive: true });
  const file = path.join(baseDir, `full-adapter-e2e-${label}.json`);
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  return file;
}

describe("NGX-372 full adapter E2E proof", () => {
  it("composes source read -> reconciliation -> dispatch scaffold -> terminal finalization with a passing verification gate", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir("momentum-ngx-372-e2e-repo-");
    const artifactRoot = makeTempDir("momentum-ngx-372-e2e-artifacts-");
    const db = openDb(dataDir);
    try {
      // --- Layer 1: source adapter read -> local reconciliation / persistence ---
      const client = fakeLinearClient([
        {
          ok: true,
          page: {
            issues: [
              makeLinearIssue({
                id: "issue-ngx-372",
                identifier: "NGX-372",
                updatedAt: 1_700_000_001_000
              })
            ],
            nextCursor: null
          }
        }
      ]);

      const reconciliation = await reconcileLinearSource(
        db,
        { client, filters: { projectId: "momentum-project" } },
        { now: () => NOW + 2 }
      );

      // The adapter exposed only a read-shaped page request (no write surface).
      expect(client.requests).toEqual([
        { cursor: null, filters: { projectId: "momentum-project" } }
      ]);
      expect(reconciliation.run.state).toBe("succeeded");
      expect(reconciliation.counts).toMatchObject({
        pages: 1,
        itemsObserved: 1,
        itemsCreated: 1,
        itemsErrored: 0
      });

      const sourceItems = listSourceItems(db, { adapterKind: "linear" });
      expect(sourceItems).toHaveLength(1);
      const sourceItem = sourceItems[0];
      expect(sourceItem).toMatchObject({
        externalId: "issue-ngx-372",
        externalKey: "NGX-372",
        status: "Todo"
      });
      expect(
        listSourceSnapshotsForItem(db, sourceItem?.id ?? "")
      ).toHaveLength(1);
      expect(
        listSourceReconciliationRuns(db, { adapterKind: "linear" })
      ).toHaveLength(1);

      // --- Layer 2: workflow run start, objective threaded from the source read ---
      const runId = "ngx-372-full-e2e";
      seedCodingWorkflowRun(db, {
        runId,
        repoPath: repoDir,
        objective: `Implement ${sourceItem?.externalKey} via the coding workflow`
      });

      // --- Layer 3: production dispatch seam -> phase-1 executor start scaffold ---
      // preflight is the one-shot family; approve, claim through the real scheduler,
      // and dispatch through the shipped production seam.
      setStepState(db, runId, "preflight", "approved");
      const claim = claimRunnableWorkflowStep(db, {
        runId,
        stepId: "preflight",
        holder: WORKER,
        leaseExpiresAt: NOW + 30_000,
        now: NOW + 1
      });
      expect(claim.ok).toBe(true);
      if (!claim.ok) throw new Error(`test setup: claim failed (${claim.reason})`);

      const dispatch = executeWorkflowStepDispatch(claim.claim, {
        db,
        workerId: WORKER,
        now: NOW + 3
      });
      expect(dispatch.status).toBe(WORKFLOW_DISPATCH_RESULT_STATUS.dispatched);

      const scaffoldInvocationId = `${runId}::preflight::dispatch`;
      const scaffoldInvocation = loadExecutorInvocation(db, scaffoldInvocationId);
      expect(scaffoldInvocation?.executorFamily).toBe("one-shot");
      expect(scaffoldInvocation?.state).toBe("running");
      const scaffoldRound = loadExecutorRound(
        db,
        `${scaffoldInvocationId}::round-1`
      );
      expect(scaffoldRound?.state).toBe("pending");
      // The scaffold carries no fabricated evidence before the mechanism runs.
      expect(scaffoldRound?.verificationStatus).toBeNull();
      expect(scaffoldRound?.commitSha).toBeNull();

      // --- Layer 4: landed executor adapter -> terminal finalization + verification ---
      // postflight is also one-shot; the landed adapter drives it to a terminal
      // `succeeded` with a passing verification gate and a recorded commit.
      const finalize = runSingleShotStep({
        db,
        family: "one-shot",
        workflowRunId: runId,
        stepRunId: "postflight",
        stepKey: "postflight",
        attempt: 1,
        selection: resolveSingleShotRoundSelection({
          stepConfig: {
            agentProvider: "claude",
            model: "claude-opus-4-8",
            effort: "high"
          }
        }),
        resolveRoundInputs: () => roundInputs(artifactRoot),
        now: monotonicClock(NOW + 100),
        runRound: () => ({
          outcome: { ok: true },
          result: runnerResult(),
          resultDigest: "sha256:postflight-result",
          artifacts: {
            resultDocument: { path: path.join(artifactRoot, "result.json") },
            verificationOutput: { path: path.join(artifactRoot, "verify.log") },
            commitOrResetEvidence: {
              path: path.join(artifactRoot, "commit.txt")
            }
          },
          evidence: {
            verificationStatus: "passed",
            commitSha: SHA,
            changedFiles: ["src/feature.ts"]
          }
        })
      });

      // The invocation + round settled terminal with the verification gate passed.
      expect(finalize.invocation.state).toBe("succeeded");
      expect(finalize.invocation.finishedAt).not.toBeNull();
      expect(finalize.round.round.state).toBe("succeeded");
      expect(finalize.round.round.classification).toBe("complete");
      expect(finalize.round.round.verificationStatus).toBe("passed");
      expect(finalize.round.round.commitSha).toBe(SHA);
      expect(finalize.round.round.changedFiles).toEqual(["src/feature.ts"]);

      // Durable below StepRun: a single reattachable invocation + its one round.
      const finalizeInvocationId = singleShotInvocationId(
        runId,
        "postflight",
        "one-shot",
        1
      );
      expect(finalize.invocation.invocationId).toBe(finalizeInvocationId);
      expect(loadExecutorInvocation(db, finalizeInvocationId)).toEqual(
        finalize.invocation
      );
      const finalizeRoundId = singleShotRoundId(finalizeInvocationId);
      expect(
        listExecutorRoundsForInvocation(db, finalizeInvocationId).map(
          (r) => r.state
        )
      ).toEqual(["succeeded"]);
      // The verification-bearing capture is durable in the checkpoint stream and
      // the verification_output artifact row.
      expect(
        listExecutorCheckpointsForRound(db, finalizeRoundId).map((c) => c.stage)
      ).toEqual([
        "round_started",
        "mechanism_completed",
        "result_captured",
        "classified"
      ]);
      expect(
        listExecutorArtifactsForRound(db, finalizeRoundId).map(
          (a) => a.artifactClass
        )
      ).toContain("verification_output");

      // --- Composition evidence (acceptance criterion: the proof records it) ---
      const evidence = {
        issue: "NGX-372",
        proof: "full-adapter-e2e",
        source: {
          runState: reconciliation.run.state,
          itemsObserved: reconciliation.counts.itemsObserved,
          itemsPersisted: sourceItems.length,
          externalKey: sourceItem?.externalKey ?? null
        },
        localPersistence: {
          sourceItems: countRows(db, "source_items"),
          sourceSnapshots: countRows(db, "source_snapshots"),
          sourceReconciliationRuns: countRows(db, "source_reconciliation_runs")
        },
        workflow: {
          runId,
          definition: CODING_WORKFLOW_DEFINITION.key
        },
        dispatchScaffold: {
          invocationId: scaffoldInvocationId,
          executorFamily: scaffoldInvocation?.executorFamily ?? null,
          invocationState: scaffoldInvocation?.state ?? null,
          roundState: scaffoldRound?.state ?? null
        },
        finalization: {
          invocationId: finalizeInvocationId,
          invocationState: finalize.invocation.state,
          roundState: finalize.round.round.state,
          verificationStatus: finalize.round.round.verificationStatus,
          commitSha: finalize.round.round.commitSha
        }
      };
      const evidencePath = recordCompositionEvidence(
        dataDir,
        "happy-path",
        evidence
      );
      const recorded = JSON.parse(fs.readFileSync(evidencePath, "utf8")) as {
        source: { itemsPersisted: number };
        finalization: { verificationStatus: string | null };
      };
      expect(recorded.source.itemsPersisted).toBe(1);
      expect(recorded.finalization.verificationStatus).toBe("passed");
    } finally {
      db.close();
    }
  });

  it("composes the goal-loop landed adapter: the implementation step drives a bounded multi-round invocation to terminal succeeded with a passing verification gate", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir("momentum-ngx-372-e2e-repo-");
    const artifactRoot = makeTempDir("momentum-ngx-372-e2e-artifacts-");
    const db = openDb(dataDir);
    try {
      // --- Layer 1: source adapter read -> local reconciliation / persistence ---
      const client = fakeLinearClient([
        {
          ok: true,
          page: {
            issues: [makeLinearIssue({ updatedAt: 1_700_000_001_000 })],
            nextCursor: null
          }
        }
      ]);

      const reconciliation = await reconcileLinearSource(
        db,
        { client, filters: { projectId: "momentum-project" } },
        { now: () => NOW + 2 }
      );
      expect(reconciliation.run.state).toBe("succeeded");
      const sourceItems = listSourceItems(db, { adapterKind: "linear" });
      expect(sourceItems).toHaveLength(1);
      const sourceItem = sourceItems[0];

      // --- Layer 2: workflow run start, objective threaded from the source read ---
      const runId = "ngx-372-goal-loop-e2e";
      seedCodingWorkflowRun(db, {
        runId,
        repoPath: repoDir,
        objective: `Implement ${sourceItem?.externalKey} via the coding workflow`
      });

      // --- Layer 3: goal-loop landed adapter -> terminal finalization ---
      // `implementation` is the goal-loop family in the real coding workflow
      // definition (src/core/workflow/definition/definition.ts). The landed adapter drives a
      // bounded multi-round invocation below the StepRun: round 0 commits progress
      // but is incomplete (continue); round 1 commits and recommends completion,
      // each round gated by a passing verification finalize. `runGoalLoopStep`
      // mints its own deterministic, reattachable invocation id, distinct from the
      // one-shot scaffold's `...::dispatch` id and the one-shot adapter's id, so
      // composing the goal-loop terminal alongside them never mints two owners for
      // one step.
      const result = runGoalLoopStep({
        db,
        workflowRunId: runId,
        stepRunId: "implementation",
        stepKey: "implementation",
        attempt: 1,
        selection: resolveGoalLoopRoundSelection({
          stepConfig: {
            agentProvider: "claude",
            model: "claude-opus-4-8",
            effort: "high",
            maxRounds: 3
          }
        }),
        resolveRoundInputs: (roundIndex) =>
          goalLoopRoundInputs(artifactRoot, roundIndex),
        now: monotonicClock(NOW + 100),
        runRound: (round) =>
          round.roundIndex < 1
            ? {
                result: runnerResult({
                  summary: "implementation round: progress committed",
                  goal_complete: false,
                  remaining_work: ["finish the implementation"]
                }),
                finalize: GOAL_LOOP_COMMITTED,
                changedFiles: ["src/feature.ts"]
              }
            : {
                result: runnerResult({
                  summary: "implementation round: goal complete",
                  goal_complete: true
                }),
                finalize: GOAL_LOOP_COMMITTED,
                changedFiles: ["src/feature.ts", "test/feature.test.ts"]
              }
      });

      // The invocation is the goal-loop family and terminalized succeeded.
      expect(result.invocation.executorFamily).toBe("goal-loop");
      expect(result.invocation.state).toBe("succeeded");
      expect(result.invocation.finishedAt).not.toBeNull();

      // Two durable rounds ran in order: continue then complete.
      expect(result.rounds.map((r) => r.round.roundIndex)).toEqual([0, 1]);
      expect(result.rounds.map((r) => r.round.classification)).toEqual([
        "continue",
        "complete"
      ]);
      const lastRound = result.rounds[1]?.round;
      expect(lastRound?.state).toBe("succeeded");
      expect(lastRound?.verificationStatus).toBe("passed");
      expect(lastRound?.commitSha).toBe(SHA);
      expect(lastRound?.changedFiles).toEqual([
        "src/feature.ts",
        "test/feature.test.ts"
      ]);

      // Durable + reattachable below the StepRun: a deterministic invocation id
      // and its ordered rounds, all settled succeeded.
      const invocationId = goalLoopInvocationId(runId, "implementation", 1);
      expect(result.invocation.invocationId).toBe(invocationId);
      expect(loadExecutorInvocation(db, invocationId)).toEqual(
        result.invocation
      );
      const durableRounds = listExecutorRoundsForInvocation(db, invocationId);
      expect(durableRounds.map((r) => r.roundId)).toEqual([
        goalLoopRoundId(invocationId, 0),
        goalLoopRoundId(invocationId, 1)
      ]);
      expect(durableRounds.map((r) => r.state)).toEqual([
        "succeeded",
        "succeeded"
      ]);

      // The terminal round's verification-bearing capture is durable in its
      // lifecycle checkpoint stream.
      expect(
        listExecutorCheckpointsForRound(
          db,
          goalLoopRoundId(invocationId, 1)
        ).map((c) => c.stage)
      ).toEqual([
        "round_started",
        "mechanism_completed",
        "result_captured",
        "classified"
      ]);

      // --- Composition evidence (acceptance criterion: the proof records it) ---
      const evidence = {
        issue: "NGX-372",
        proof: "full-adapter-e2e-goal-loop",
        source: {
          runState: reconciliation.run.state,
          externalKey: sourceItem?.externalKey ?? null
        },
        workflow: { runId, definition: CODING_WORKFLOW_DEFINITION.key },
        goalLoopFinalization: {
          invocationId,
          executorFamily: result.invocation.executorFamily,
          invocationState: result.invocation.state,
          rounds: result.rounds.map((r) => r.round.classification),
          lastRoundVerification: lastRound?.verificationStatus ?? null,
          lastRoundCommitSha: lastRound?.commitSha ?? null
        }
      };
      const evidencePath = recordCompositionEvidence(
        dataDir,
        "goal-loop",
        evidence
      );
      const recorded = JSON.parse(fs.readFileSync(evidencePath, "utf8")) as {
        goalLoopFinalization: { invocationState: string; rounds: string[] };
      };
      expect(recorded.goalLoopFinalization.invocationState).toBe("succeeded");
      expect(recorded.goalLoopFinalization.rounds).toEqual([
        "continue",
        "complete"
      ]);
    } finally {
      db.close();
    }
  });

  it("composes the no-mistakes mirror landed adapter: the no-mistakes step settles its long-lived mirror round to terminal succeeded on a corroborated completed external review gate", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir("momentum-ngx-372-e2e-repo-");
    const artifactRoot = makeTempDir("momentum-ngx-372-e2e-artifacts-");
    const db = openDb(dataDir);
    try {
      // --- Layer 1: source adapter read -> local reconciliation / persistence ---
      const client = fakeLinearClient([
        {
          ok: true,
          page: {
            issues: [makeLinearIssue({ updatedAt: 1_700_000_001_000 })],
            nextCursor: null
          }
        }
      ]);

      const reconciliation = await reconcileLinearSource(
        db,
        { client, filters: { projectId: "momentum-project" } },
        { now: () => NOW + 2 }
      );
      expect(reconciliation.run.state).toBe("succeeded");
      const sourceItems = listSourceItems(db, { adapterKind: "linear" });
      expect(sourceItems).toHaveLength(1);
      const sourceItem = sourceItems[0];

      // --- Layer 2: workflow run start, objective threaded from the source read ---
      const runId = "ngx-372-no-mistakes-e2e";
      seedCodingWorkflowRun(db, {
        runId,
        repoPath: repoDir,
        objective: `Implement ${sourceItem?.externalKey} via the coding workflow`
      });

      // --- Layer 3: no-mistakes mirror landed adapter -> terminal finalization ---
      // `no-mistakes` is the no-mistakes family in the real coding workflow
      // definition (src/core/workflow/definition/definition.ts). Unlike the result-bearing
      // adapters, the mirror does not drive an agent Momentum chose: it reflects an
      // external review gate's state as untrusted evidence to classify. The landed
      // adapter materializes the durable invocation + the single long-lived mirror
      // round (born in `mirroring_external_state`), pins the expected external
      // identity, then runs the first poll. A corroborated `completed` snapshot with
      // CI passed settles the round straight to terminal `succeeded` — the mirror's
      // equivalent of the other adapters' passing verification gate. Its
      // deterministic invocation id is distinct from the one-shot scaffold's
      // `...::dispatch` id, the one-shot adapter's id, and the goal-loop adapter's
      // id, so composing a fourth terminal family never mints two owners for one
      // step.
      const result = runNoMistakesMirrorStep({
        db,
        workflowRunId: runId,
        stepRunId: "no-mistakes",
        stepKey: "no-mistakes",
        attempt: 1,
        read: () => ({
          ok: true,
          value: noMistakesCompletedState(),
          digest: "sha256:no-mistakes-poll"
        }),
        expectedExternalIdentity: NO_MISTAKES_IDENTITY,
        resolveRoundInputs: () => noMistakesRoundInputs(artifactRoot),
        now: monotonicClock(NOW + 100)
      });

      // The invocation is the no-mistakes family and terminalized succeeded.
      expect(result.invocation.executorFamily).toBe("no-mistakes");
      expect(result.invocation.state).toBe("succeeded");
      expect(result.invocation.finishedAt).not.toBeNull();

      // The single long-lived mirror round settled succeeded directly from the
      // mirror phase, gated by the corroborated completed + CI-passed snapshot.
      expect(result.round.decision.classification).toBe("complete");
      expect(result.round.round.state).toBe("succeeded");
      expect(result.round.round.finishedAt).not.toBeNull();
      // The mirror fingerprints the exact external bytes it mirrored this poll.
      expect(result.round.round.inputDigest).toBe("sha256:no-mistakes-poll");

      // Durable + reattachable below the StepRun: a deterministic invocation id and
      // its single mirror round (index 0), distinct from every other terminal
      // family's id composed in this proof.
      const invocationId = noMistakesInvocationId(runId, "no-mistakes", 1);
      expect(result.invocation.invocationId).toBe(invocationId);
      expect(invocationId).not.toBe(`${runId}::no-mistakes::dispatch`);
      expect(loadExecutorInvocation(db, invocationId)).toEqual(
        result.invocation
      );
      const roundId = noMistakesRoundId(invocationId);
      expect(result.round.round.roundId).toBe(roundId);
      expect(
        listExecutorRoundsForInvocation(db, invocationId).map((r) => r.state)
      ).toEqual(["succeeded"]);

      // The mirror's durable evidence: the expected identity pinned at start, then
      // the corroborated external state mirrored into a durable checkpoint.
      expect(
        listExecutorCheckpointsForRound(db, roundId).map((c) => c.stage)
      ).toEqual(["expected_external_identity", "external_state_mirrored"]);

      // --- Composition evidence (acceptance criterion: the proof records it) ---
      const evidence = {
        issue: "NGX-372",
        proof: "full-adapter-e2e-no-mistakes",
        source: {
          runState: reconciliation.run.state,
          externalKey: sourceItem?.externalKey ?? null
        },
        workflow: { runId, definition: CODING_WORKFLOW_DEFINITION.key },
        noMistakesFinalization: {
          invocationId,
          executorFamily: result.invocation.executorFamily,
          invocationState: result.invocation.state,
          roundState: result.round.round.state,
          classification: result.round.decision.classification,
          mirroredDigest: result.round.round.inputDigest
        }
      };
      const evidencePath = recordCompositionEvidence(
        dataDir,
        "no-mistakes",
        evidence
      );
      const recorded = JSON.parse(fs.readFileSync(evidencePath, "utf8")) as {
        noMistakesFinalization: {
          invocationState: string;
          classification: string;
        };
      };
      expect(recorded.noMistakesFinalization.invocationState).toBe("succeeded");
      expect(recorded.noMistakesFinalization.classification).toBe("complete");
    } finally {
      db.close();
    }
  });

  it("composes the M9 live-wrapper landed adapter: the merge-cleanup step drives the managed-step lifecycle (approved -> running -> succeeded) under a managed-step lease against a real repo lock", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir("momentum-ngx-372-e2e-repo-");
    const db = openDb(dataDir);
    try {
      // --- Layer 1: source adapter read -> local reconciliation / persistence ---
      const client = fakeLinearClient([
        {
          ok: true,
          page: {
            issues: [makeLinearIssue({ updatedAt: 1_700_000_001_000 })],
            nextCursor: null
          }
        }
      ]);

      const reconciliation = await reconcileLinearSource(
        db,
        { client, filters: { projectId: "momentum-project" } },
        { now: () => NOW + 2 }
      );
      expect(reconciliation.run.state).toBe("succeeded");
      const sourceItems = listSourceItems(db, { adapterKind: "linear" });
      expect(sourceItems).toHaveLength(1);
      const sourceItem = sourceItems[0];

      // --- Layer 2: workflow run start (approved through merge-cleanup), made
      // repo-backed with an active worker-held repo lock for live execution ---
      // The `merge-cleanup` approval boundary opens the run `approved` and
      // promotes preflight..merge-cleanup to `approved` through the real
      // run-start persistence path (seeding the durable approval coverage the
      // managed-step orchestrator validates for the merge-cleanup kind).
      const runId = "ngx-372-live-wrapper-e2e";
      const goalId = "ngx-372-live-wrapper-goal";
      seedCodingWorkflowRun(db, {
        runId,
        repoPath: repoDir,
        objective: `Implement ${sourceItem?.externalKey} via the coding workflow`,
        approvalBoundary: "merge-cleanup"
      });
      seedLiveStepRepoLock(db, {
        runId,
        goalId,
        repoPath: repoDir,
        holder: WORKER
      });
      // Advance merge-cleanup's required predecessors to terminal success so it
      // is the next runnable step; merge-cleanup itself stays `approved`.
      for (const stepId of [
        "preflight",
        "implementation",
        "postflight",
        "no-mistakes"
      ]) {
        setStepState(db, runId, stepId, "succeeded");
      }

      // --- Layer 3: M9 live-wrapper managed-step terminal finalization ---
      // `merge-cleanup` is the live-wrapper family in the real coding workflow
      // definition not claimed by any other terminal case in this proof.
      // `runLiveWorkflowStep` acquires the `managed-step` lease, transitions the
      // durable step approved -> running, runs the live wrapper, then persists
      // the terminal `succeeded` state BEFORE releasing the lease. This is the
      // M9 layer the executor-loop adapters never touch.
      const liveNow = NOW + 1_000;
      const executorInput: WorkflowStepExecutorInput = {
        runId,
        stepId: "merge-cleanup",
        kind: "merge-cleanup",
        attempt: 1,
        repoPath: repoDir,
        runDir: path.join(repoDir, ".momentum-run"),
        resultJsonPath: path.join(repoDir, ".momentum-run", "result.json"),
        executorLogPath: path.join(repoDir, ".momentum-run", "executor.log")
      };
      const out = runLiveWorkflowStep({
        db,
        runId,
        stepId: "merge-cleanup",
        holder: WORKER,
        leaseExpiresAt: NOW + 60_000,
        executor: liveMergeCleanupExecutor("sha256:merge-cleanup-live"),
        executorInput,
        now: liveNow
      });

      // The managed-step lifecycle ran approved -> running -> succeeded; the
      // managed-step lease was acquired then released only after terminal state.
      expect(out.ok).toBe(true);
      expect(out.stage).toBe("execute");
      expect(out.terminalState).toBe("succeeded");
      expect(out.lease.acquired).toBe(true);
      expect(out.lease.released).toBe(true);

      // The live wrapper, unlike the executor-loop adapters, advances the durable
      // `workflow_steps` row itself: merge-cleanup is terminal `succeeded` with
      // the live result digest and start/finish stamps persisted, and the M8
      // operator-override gate stays untouched (a live transition, not an
      // operator one).
      const step = getWorkflowStep(db, runId, "merge-cleanup");
      expect(step?.state).toBe("succeeded");
      expect(step?.startedAt).toBe(liveNow);
      expect(step?.finishedAt).toBe(liveNow);
      expect(step?.resultDigest).toBe("sha256:merge-cleanup-live");
      expect(step?.operatorTransitionAt).toBeNull();

      // The `managed-step` lease is the M9 layer the other terminal families do
      // not touch: it was released exactly at terminal finalization (the durable
      // proof that nothing is stranded), holder intact.
      const lease = getWorkflowLease(db, runId, LIVE_STEP_DEFAULT_LEASE_KIND);
      expect(lease?.holder).toBe(WORKER);
      expect(lease?.releasedAt).toBe(liveNow);

      // The live wrapper finalizes at the workflow_steps + lease layer, a
      // genuinely distinct terminal family from the executor-loop one-shot /
      // goal-loop / no-mistakes mirror adapters: it mints no executor-loop rows.
      expect(countRows(db, "executor_invocations")).toBe(0);
      expect(countRows(db, "executor_rounds")).toBe(0);

      // --- Composition evidence (acceptance criterion: the proof records it) ---
      const evidence = {
        issue: "NGX-372",
        proof: "full-adapter-e2e-live-wrapper",
        source: {
          runState: reconciliation.run.state,
          externalKey: sourceItem?.externalKey ?? null
        },
        workflow: { runId, definition: CODING_WORKFLOW_DEFINITION.key },
        liveWrapperFinalization: {
          stepId: "merge-cleanup",
          terminalState: out.terminalState ?? null,
          stepState: step?.state ?? null,
          resultDigest: step?.resultDigest ?? null,
          leaseAcquired: out.lease.acquired,
          leaseReleased: out.lease.released,
          leaseReleasedAt: lease?.releasedAt ?? null
        }
      };
      const evidencePath = recordCompositionEvidence(
        dataDir,
        "live-wrapper",
        evidence
      );
      const recorded = JSON.parse(fs.readFileSync(evidencePath, "utf8")) as {
        liveWrapperFinalization: { stepState: string; leaseReleased: boolean };
      };
      expect(recorded.liveWrapperFinalization.stepState).toBe("succeeded");
      expect(recorded.liveWrapperFinalization.leaseReleased).toBe(true);
    } finally {
      db.close();
    }
  });

  it("keeps the external-write family policy-gated closed: the real linear-refresh step creates only the base scaffold", () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir("momentum-ngx-372-e2e-repo-");
    const db = openDb(dataDir);
    try {
      const runId = "ngx-372-policy-gate";
      seedCodingWorkflowRun(db, {
        runId,
        repoPath: repoDir,
        objective: "Prove the external-write step scaffolds without a policy-gated write"
      });

      // Advance every step before `linear-refresh` to terminal success so the real
      // external-write step (executor family `external-apply`) becomes the next
      // runnable step — no executor advancement is wired yet, so the prior steps
      // are settled directly. linear-refresh itself is approved and claimable.
      for (const stepId of CODING_WORKFLOW_STEP_IDS) {
        if (stepId === "linear-refresh") {
          setStepState(db, runId, stepId, "approved");
        } else {
          setStepState(db, runId, stepId, "succeeded");
        }
      }

      const claim = claimRunnableWorkflowStep(db, {
        runId,
        stepId: "linear-refresh",
        holder: WORKER,
        leaseExpiresAt: NOW + 30_000,
        now: NOW + 1
      });
      expect(claim.ok).toBe(true);
      if (!claim.ok) throw new Error(`test setup: claim failed (${claim.reason})`);
      expect(claim.claim.kind).toBe("linear-refresh");

      const dispatch = executeWorkflowStepDispatch(claim.claim, {
        db,
        workerId: WORKER,
        now: NOW + 3
      });

      // The base dispatcher now scaffolds the external-apply family for its
      // dedicated daemon adapter. This proof still keeps external writes closed:
      // no policy-gated adapter execution runs here, so only the empty scaffold
      // exists and the dispatch lease remains held for the adapter lane.
      expect(dispatch.status).toBe(WORKFLOW_DISPATCH_RESULT_STATUS.dispatched);
      expect(countRows(db, "executor_invocations")).toBe(1);
      expect(countRows(db, "executor_rounds")).toBe(1);

      const gates = listWorkflowGatesForRun(db, runId);
      expect(gates).toHaveLength(0);
      expect(
        getWorkflowRunManualRecoveryState(db, runId)?.needsManualRecovery
      ).toBe(false);
      expect(getWorkflowLease(db, runId, "dispatch")?.releasedAt).toBeNull();

      // Record the policy-gate evidence alongside the happy-path composition.
      const evidencePath = recordCompositionEvidence(dataDir, "policy-gate", {
        issue: "NGX-372",
        proof: "full-adapter-e2e",
        externalWriteStep: {
          stepId: "linear-refresh",
          executorFamily: "external-apply",
          dispatchStatus: dispatch.status,
          executorRows:
            countRows(db, "executor_invocations") +
            countRows(db, "executor_rounds"),
          gateType: gates[0]?.gateType ?? null,
          needsManualRecovery:
            getWorkflowRunManualRecoveryState(db, runId)?.needsManualRecovery ??
            null
        }
      });
      const recorded = JSON.parse(fs.readFileSync(evidencePath, "utf8")) as {
        externalWriteStep: { executorRows: number; dispatchStatus: string };
      };
      expect(recorded.externalWriteStep.executorRows).toBe(2);
      expect(recorded.externalWriteStep.dispatchStatus).toBe(
        WORKFLOW_DISPATCH_RESULT_STATUS.dispatched
      );
    } finally {
      db.close();
    }
  });
});
