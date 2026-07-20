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
  type LinearReconciliationFetchPageResult,
} from "../src/core/source/reconciliation.js";
import {
  listSourceItems,
  listSourceSnapshotsForItem,
} from "../src/core/source/items.js";
import { listSourceReconciliationRuns } from "../src/core/source/reconciliation-runs.js";
import { claimRunnableWorkflowStep } from "../src/core/workflow/dispatch/scheduler.js";
import { getWorkflowLease } from "../src/core/workflow/leases.js";
import { listWorkflowGatesForRun } from "../src/core/workflow/gate/persist.js";
import { getWorkflowRunManualRecoveryState } from "../src/core/workflow/run/recovery.js";
import {
  executeWorkflowStepDispatch,
  WORKFLOW_DISPATCH_RESULT_STATUS,
} from "../src/core/workflow/dispatch/execute.js";
import {
  listExecutorArtifactsForRound,
  listExecutorCheckpointsForRound,
  listExecutorRoundsForAttempt,
  loadExecutorAttempt,
  loadExecutorRound,
} from "../src/core/executors/loop/persist.js";
import {
  resolveSingleShotRoundSelection,
  singleShotAttemptId,
  singleShotRoundId,
  type SingleShotRoundRuntimeInputs,
} from "../src/core/executors/single-shot/executor.js";
import { runSingleShotStep } from "../src/core/executors/single-shot/orchestrator.js";
import {
  goalLoopAttemptId,
  goalLoopRoundId,
  resolveGoalLoopRoundSelection,
  type GoalLoopRoundRuntimeInputs,
} from "../src/core/executors/goal-loop/executor.js";
import { runGoalLoopStep } from "../src/core/executors/goal-loop/orchestrator.js";
import {
  noMistakesAttemptId,
  noMistakesRoundId,
  type NoMistakesExternalState,
  type NoMistakesRoundRuntimeInputs,
} from "../src/adapters/no-mistakes-executor.js";
import { runNoMistakesMirrorStep } from "../src/adapters/no-mistakes-orchestrator.js";
import type { WorkflowApprovalBoundary } from "../src/core/workflow/run/reducer.js";
import type { FinalizeWorkflowStepFromResultFileResult } from "../src/core/executors/shared/step-finalize.js";
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
 * production dispatch path and stops at the start *scaffold* (attempt
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
 * bounded multi-round attempt to terminal `succeeded` with a passing
 * verification gate, and the no-mistakes mirror adapter on `no-mistakes`, which
 * settles its single long-lived mirror round to terminal `succeeded` on a
 * corroborated `completed` external review gate (the mirror's equivalent of a
 * passing verification gate). Each carries a deliberately distinct attempt id
 * (`...::dispatch` for the scaffold vs each landed adapter's own reattachable
 * id), so composing scaffold + multiple terminal families never mints two owners
 * for one step. With the one-shot, goal-loop, and no-mistakes mirror terminals
 * composed, the layered adapter-test strategy is complete. (The M9 live-wrapper
 * managed-step lane that used to compose on `merge-cleanup` was deleted with
 * the rest of the M9 live-step orchestration under NGX-599; the RC-2
 * reconciliation seam owns dispatched-step finalization in production.)
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
  "linear-refresh",
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
  overrides: Record<string, unknown> = {},
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
      name: "Momentum",
    },
    projectMilestone: overrides["projectMilestone"] ?? {
      id: "adapter-test-coverage",
      name: "Adapter Test Coverage",
    },
    labels: overrides["labels"] ?? { nodes: [] },
    assignee: overrides["assignee"] ?? null,
    priority: overrides["priority"] ?? 0,
    updatedAt: overrides["updatedAt"] ?? "2026-06-11T00:00:00.000Z",
    ...overrides,
  };
}

function fakeLinearClient(
  pages: readonly LinearReconciliationFetchPageResult[],
): LinearReconciliationClient & {
  readonly requests: LinearReconciliationFetchPageInput[];
} {
  const requests: LinearReconciliationFetchPageInput[] = [];
  let pageIndex = 0;
  return {
    requests,
    fetchPage(
      input: LinearReconciliationFetchPageInput,
    ): LinearReconciliationFetchPageResult {
      requests.push(input);
      const page = pages[pageIndex];
      pageIndex += 1;
      return page ?? { ok: true, page: { issues: [], nextCursor: null } };
    },
  };
}

function seedCodingWorkflowRun(
  db: MomentumDb,
  input: {
    runId: string;
    repoPath: string;
    objective: string;
    approvalBoundary?: WorkflowApprovalBoundary;
  },
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
      : {}),
  });
}

function setStepState(
  db: MomentumDb,
  runId: string,
  stepId: string,
  state: string,
): void {
  db.prepare(
    "UPDATE workflow_steps SET state = ? WHERE run_id = ? AND step_id = ?",
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
      breaking: false,
    },
    ...overrides,
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
    logPaths: [path.join(artifactRoot, "stdout.log")],
  };
}

// The goal-loop adapter derives a round's verification/commit evidence from the
// total `finalize` outcome (mirroring the M9 repo-safety finalize) rather than a
// caller-supplied `evidence` block. A `committed` outcome with passing
// verification settles the round `succeeded` with `verificationStatus: "passed"`
// and the finalize commit's SHA — the goal-loop equivalent of the one-shot
// adapter's passing verification gate.
const PARENT_SHA = "b".repeat(40);

const GOAL_LOOP_COMMITTED: FinalizeWorkflowStepFromResultFileResult = {
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
        succeeded: true,
      },
    ],
  },
  commit: {
    ok: true,
    commitSha: SHA,
    parentSha: PARENT_SHA,
    message: "feat(adapter): implementation round commit",
  },
  head: SHA,
};

function goalLoopRoundInputs(
  artifactRoot: string,
  roundIndex: number,
): GoalLoopRoundRuntimeInputs {
  const root = path.join(artifactRoot, `round-${roundIndex}`);
  return {
    inputDigest: `sha256:implementation-input-${roundIndex}`,
    artifactRoot: root,
    logPaths: [path.join(root, "stdout.log")],
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
  headSha: SHA,
} as const;

function noMistakesCompletedState(): NoMistakesExternalState {
  return {
    externalRunId: NO_MISTAKES_IDENTITY.externalRunId,
    branch: NO_MISTAKES_IDENTITY.branch,
    headSha: NO_MISTAKES_IDENTITY.headSha,
    activeStep: null,
    stepStatus: "completed",
    findings: [],
    selectedFindingIds: [],
    decisions: [],
    prUrl: null,
    ciState: "passed",
  };
}

function noMistakesRoundInputs(
  artifactRoot: string,
): NoMistakesRoundRuntimeInputs {
  const root = path.join(artifactRoot, "no-mistakes");
  return {
    inputDigest: "sha256:no-mistakes-start",
    artifactRoot: root,
    logPaths: [path.join(root, "state.json")],
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
  payload: Record<string, unknown>,
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
                updatedAt: 1_700_000_001_000,
              }),
            ],
            nextCursor: null,
          },
        },
      ]);

      const reconciliation = await reconcileLinearSource(
        db,
        { client, filters: { projectId: "momentum-project" } },
        { now: () => NOW + 2 },
      );

      // The adapter exposed only a read-shaped page request (no write surface).
      expect(client.requests).toEqual([
        { cursor: null, filters: { projectId: "momentum-project" } },
      ]);
      expect(reconciliation.run.state).toBe("succeeded");
      expect(reconciliation.counts).toMatchObject({
        pages: 1,
        itemsObserved: 1,
        itemsCreated: 1,
        itemsErrored: 0,
      });

      const sourceItems = listSourceItems(db, { adapterKind: "linear" });
      expect(sourceItems).toHaveLength(1);
      const sourceItem = sourceItems[0];
      expect(sourceItem).toMatchObject({
        externalId: "issue-ngx-372",
        externalKey: "NGX-372",
        status: "Todo",
      });
      expect(listSourceSnapshotsForItem(db, sourceItem?.id ?? "")).toHaveLength(
        1,
      );
      expect(
        listSourceReconciliationRuns(db, { adapterKind: "linear" }),
      ).toHaveLength(1);

      // --- Layer 2: workflow run start, objective threaded from the source read ---
      const runId = "ngx-372-full-e2e";
      seedCodingWorkflowRun(db, {
        runId,
        repoPath: repoDir,
        objective: `Implement ${sourceItem?.externalKey} via the coding workflow`,
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
        now: NOW + 1,
      });
      expect(claim.ok).toBe(true);
      if (!claim.ok)
        throw new Error(`test setup: claim failed (${claim.reason})`);

      const dispatch = executeWorkflowStepDispatch(claim.claim, {
        db,
        workerId: WORKER,
        now: NOW + 3,
      });
      expect(dispatch.status).toBe(WORKFLOW_DISPATCH_RESULT_STATUS.dispatched);

      const scaffoldInvocationId = `${runId}::preflight::dispatch`;
      const scaffoldInvocation = loadExecutorAttempt(
        db,
        scaffoldInvocationId,
      );
      expect(scaffoldInvocation?.executorFamily).toBe("one-shot");
      expect(scaffoldInvocation?.state).toBe("running");
      const scaffoldRound = loadExecutorRound(
        db,
        `${scaffoldInvocationId}::round-1`,
      );
      expect(scaffoldRound?.state).toBe("pending");
      // The scaffold carries no fabricated evidence before the mechanism runs.
      expect(scaffoldRound?.verificationStatus).toBeNull();
      expect(scaffoldRound?.commitSha).toBeNull();

      // --- Layer 4: landed executor adapter -> terminal finalization + verification ---
      // postflight is also one-shot; the landed adapter drives it to a terminal
      // `succeeded` with a passing verification gate and a recorded commit.
      const finalize = await runSingleShotStep({
        db,
        family: "one-shot",
        workflowRunId: runId,
        stepRunId: "postflight",
        stepKey: "postflight",
        attemptNumber: 1,
        selection: resolveSingleShotRoundSelection({
          stepConfig: {
            agentProvider: "claude",
            model: "claude-opus-4-8",
            effort: "high",
          },
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
              path: path.join(artifactRoot, "commit.txt"),
            },
          },
          evidence: {
            verificationStatus: "passed",
            commitSha: SHA,
            changedFiles: ["src/feature.ts"],
          },
        }),
      });

      // The attempt + round settled terminal with the verification gate passed.
      expect(finalize.attempt.state).toBe("succeeded");
      expect(finalize.attempt.finishedAt).not.toBeNull();
      expect(finalize.round.round.state).toBe("succeeded");
      expect(finalize.round.round.classification).toBe("complete");
      expect(finalize.round.round.verificationStatus).toBe("passed");
      expect(finalize.round.round.commitSha).toBe(SHA);
      expect(finalize.round.round.changedFiles).toEqual(["src/feature.ts"]);

      // Durable below StepRun: a single reattachable attempt + its one round.
      const finalizeInvocationId = singleShotAttemptId(
        runId,
        "postflight",
        "one-shot",
        1,
      );
      expect(finalize.attempt.attemptId).toBe(finalizeInvocationId);
      expect(loadExecutorAttempt(db, finalizeInvocationId)).toEqual(
        finalize.attempt,
      );
      const finalizeRoundId = singleShotRoundId(finalizeInvocationId);
      expect(
        listExecutorRoundsForAttempt(db, finalizeInvocationId).map(
          (r) => r.state,
        ),
      ).toEqual(["succeeded"]);
      // The verification-bearing capture is durable in the checkpoint stream and
      // the verification_output artifact row.
      expect(
        listExecutorCheckpointsForRound(db, finalizeRoundId).map(
          (c) => c.stage,
        ),
      ).toEqual([
        "round_started",
        "mechanism_completed",
        "result_captured",
        "classified",
      ]);
      expect(
        listExecutorArtifactsForRound(db, finalizeRoundId).map(
          (a) => a.artifactClass,
        ),
      ).toContain("verification_output");

      // --- Composition evidence (acceptance criterion: the proof records it) ---
      const evidence = {
        issue: "NGX-372",
        proof: "full-adapter-e2e",
        source: {
          runState: reconciliation.run.state,
          itemsObserved: reconciliation.counts.itemsObserved,
          itemsPersisted: sourceItems.length,
          externalKey: sourceItem?.externalKey ?? null,
        },
        localPersistence: {
          sourceItems: countRows(db, "source_items"),
          sourceSnapshots: countRows(db, "source_snapshots"),
          sourceReconciliationRuns: countRows(db, "source_reconciliation_runs"),
        },
        workflow: {
          runId,
          definition: CODING_WORKFLOW_DEFINITION.key,
        },
        dispatchScaffold: {
          attemptId: scaffoldInvocationId,
          executorFamily: scaffoldInvocation?.executorFamily ?? null,
          attemptState: scaffoldInvocation?.state ?? null,
          roundState: scaffoldRound?.state ?? null,
        },
        finalization: {
          attemptId: finalizeInvocationId,
          attemptState: finalize.attempt.state,
          roundState: finalize.round.round.state,
          verificationStatus: finalize.round.round.verificationStatus,
          commitSha: finalize.round.round.commitSha,
        },
      };
      const evidencePath = recordCompositionEvidence(
        dataDir,
        "happy-path",
        evidence,
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

  it("composes the goal-loop landed adapter: the implementation step drives a bounded multi-round attempt to terminal succeeded with a passing verification gate", async () => {
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
            nextCursor: null,
          },
        },
      ]);

      const reconciliation = await reconcileLinearSource(
        db,
        { client, filters: { projectId: "momentum-project" } },
        { now: () => NOW + 2 },
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
        objective: `Implement ${sourceItem?.externalKey} via the coding workflow`,
      });

      // --- Layer 3: goal-loop landed adapter -> terminal finalization ---
      // `implementation` is the goal-loop family in the real coding workflow
      // definition (src/core/workflow/definition/definition.ts). The landed adapter drives a
      // bounded multi-round attempt below the StepRun: round 0 commits progress
      // but is incomplete (continue); round 1 commits and recommends completion,
      // each round gated by a passing verification finalize. `runGoalLoopStep`
      // mints its own deterministic, reattachable attempt id, distinct from the
      // one-shot scaffold's `...::dispatch` id and the one-shot adapter's id, so
      // composing the goal-loop terminal alongside them never mints two owners for
      // one step.
      const result = runGoalLoopStep({
        db,
        workflowRunId: runId,
        stepRunId: "implementation",
        stepKey: "implementation",
        attemptNumber: 1,
        selection: resolveGoalLoopRoundSelection({
          stepConfig: {
            agentProvider: "claude",
            model: "claude-opus-4-8",
            effort: "high",
            maxRounds: 3,
          },
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
                  remaining_work: ["finish the implementation"],
                }),
                finalize: GOAL_LOOP_COMMITTED,
                changedFiles: ["src/feature.ts"],
              }
            : {
                result: runnerResult({
                  summary: "implementation round: goal complete",
                  goal_complete: true,
                }),
                finalize: GOAL_LOOP_COMMITTED,
                changedFiles: ["src/feature.ts", "test/feature.test.ts"],
              },
      });

      // The attempt is the goal-loop family and terminalized succeeded.
      expect(result.attempt.executorFamily).toBe("goal-loop");
      expect(result.attempt.state).toBe("succeeded");
      expect(result.attempt.finishedAt).not.toBeNull();

      // Two durable rounds ran in order: continue then complete.
      expect(result.rounds.map((r) => r.round.roundIndex)).toEqual([0, 1]);
      expect(result.rounds.map((r) => r.round.classification)).toEqual([
        "continue",
        "complete",
      ]);
      const lastRound = result.rounds[1]?.round;
      expect(lastRound?.state).toBe("succeeded");
      expect(lastRound?.verificationStatus).toBe("passed");
      expect(lastRound?.commitSha).toBe(SHA);
      expect(lastRound?.changedFiles).toEqual([
        "src/feature.ts",
        "test/feature.test.ts",
      ]);

      // Durable + reattachable below the StepRun: a deterministic attempt id
      // and its ordered rounds, all settled succeeded.
      const attemptId = goalLoopAttemptId(runId, "implementation", 1);
      expect(result.attempt.attemptId).toBe(attemptId);
      expect(loadExecutorAttempt(db, attemptId)).toEqual(
        result.attempt,
      );
      const durableRounds = listExecutorRoundsForAttempt(db, attemptId);
      expect(durableRounds.map((r) => r.roundId)).toEqual([
        goalLoopRoundId(attemptId, 0),
        goalLoopRoundId(attemptId, 1),
      ]);
      expect(durableRounds.map((r) => r.state)).toEqual([
        "succeeded",
        "succeeded",
      ]);

      // The terminal round's verification-bearing capture is durable in its
      // lifecycle checkpoint stream.
      expect(
        listExecutorCheckpointsForRound(
          db,
          goalLoopRoundId(attemptId, 1),
        ).map((c) => c.stage),
      ).toEqual([
        "round_started",
        "mechanism_completed",
        "result_captured",
        "classified",
      ]);

      // --- Composition evidence (acceptance criterion: the proof records it) ---
      const evidence = {
        issue: "NGX-372",
        proof: "full-adapter-e2e-goal-loop",
        source: {
          runState: reconciliation.run.state,
          externalKey: sourceItem?.externalKey ?? null,
        },
        workflow: { runId, definition: CODING_WORKFLOW_DEFINITION.key },
        goalLoopFinalization: {
          attemptId,
          executorFamily: result.attempt.executorFamily,
          attemptState: result.attempt.state,
          rounds: result.rounds.map((r) => r.round.classification),
          lastRoundVerification: lastRound?.verificationStatus ?? null,
          lastRoundCommitSha: lastRound?.commitSha ?? null,
        },
      };
      const evidencePath = recordCompositionEvidence(
        dataDir,
        "goal-loop",
        evidence,
      );
      const recorded = JSON.parse(fs.readFileSync(evidencePath, "utf8")) as {
        goalLoopFinalization: { attemptState: string; rounds: string[] };
      };
      expect(recorded.goalLoopFinalization.attemptState).toBe("succeeded");
      expect(recorded.goalLoopFinalization.rounds).toEqual([
        "continue",
        "complete",
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
            nextCursor: null,
          },
        },
      ]);

      const reconciliation = await reconcileLinearSource(
        db,
        { client, filters: { projectId: "momentum-project" } },
        { now: () => NOW + 2 },
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
        objective: `Implement ${sourceItem?.externalKey} via the coding workflow`,
      });

      // --- Layer 3: no-mistakes mirror landed adapter -> terminal finalization ---
      // `no-mistakes` is the no-mistakes family in the real coding workflow
      // definition (src/core/workflow/definition/definition.ts). Unlike the result-bearing
      // adapters, the mirror does not drive an agent Momentum chose: it reflects an
      // external review gate's state as untrusted evidence to classify. The landed
      // adapter materializes the durable attempt + the single long-lived mirror
      // round (born in `mirroring_external_state`), pins the expected external
      // identity, then runs the first poll. A corroborated `completed` snapshot with
      // CI passed settles the round straight to terminal `succeeded` — the mirror's
      // equivalent of the other adapters' passing verification gate. Its
      // deterministic attempt id is distinct from the one-shot scaffold's
      // `...::dispatch` id, the one-shot adapter's id, and the goal-loop adapter's
      // id, so composing a fourth terminal family never mints two owners for one
      // step.
      const result = runNoMistakesMirrorStep({
        db,
        workflowRunId: runId,
        stepRunId: "no-mistakes",
        stepKey: "no-mistakes",
        attemptNumber: 1,
        read: () => ({
          ok: true,
          value: noMistakesCompletedState(),
          digest: "sha256:no-mistakes-poll",
        }),
        expectedExternalIdentity: NO_MISTAKES_IDENTITY,
        resolveRoundInputs: () => noMistakesRoundInputs(artifactRoot),
        now: monotonicClock(NOW + 100),
      });

      // The attempt is the no-mistakes family and terminalized succeeded.
      expect(result.attempt.executorFamily).toBe("no-mistakes");
      expect(result.attempt.state).toBe("succeeded");
      expect(result.attempt.finishedAt).not.toBeNull();

      // The single long-lived mirror round settled succeeded directly from the
      // mirror phase, gated by the corroborated completed + CI-passed snapshot.
      expect(result.round.decision.classification).toBe("complete");
      expect(result.round.round.state).toBe("succeeded");
      expect(result.round.round.finishedAt).not.toBeNull();
      // The mirror fingerprints the exact external bytes it mirrored this poll.
      expect(result.round.round.inputDigest).toBe("sha256:no-mistakes-poll");

      // Durable + reattachable below the StepRun: a deterministic attempt id and
      // its single mirror round (index 0), distinct from every other terminal
      // family's id composed in this proof.
      const attemptId = noMistakesAttemptId(runId, "no-mistakes", 1);
      expect(result.attempt.attemptId).toBe(attemptId);
      expect(attemptId).not.toBe(`${runId}::no-mistakes::dispatch`);
      expect(loadExecutorAttempt(db, attemptId)).toEqual(
        result.attempt,
      );
      const roundId = noMistakesRoundId(attemptId);
      expect(result.round.round.roundId).toBe(roundId);
      expect(
        listExecutorRoundsForAttempt(db, attemptId).map((r) => r.state),
      ).toEqual(["succeeded"]);

      // The mirror's durable evidence: the expected identity pinned at start, then
      // the corroborated external state mirrored into a durable checkpoint.
      expect(
        listExecutorCheckpointsForRound(db, roundId).map((c) => c.stage),
      ).toEqual(["expected_external_identity", "external_state_mirrored"]);

      // --- Composition evidence (acceptance criterion: the proof records it) ---
      const evidence = {
        issue: "NGX-372",
        proof: "full-adapter-e2e-no-mistakes",
        source: {
          runState: reconciliation.run.state,
          externalKey: sourceItem?.externalKey ?? null,
        },
        workflow: { runId, definition: CODING_WORKFLOW_DEFINITION.key },
        noMistakesFinalization: {
          attemptId,
          executorFamily: result.attempt.executorFamily,
          attemptState: result.attempt.state,
          roundState: result.round.round.state,
          classification: result.round.decision.classification,
          mirroredDigest: result.round.round.inputDigest,
        },
      };
      const evidencePath = recordCompositionEvidence(
        dataDir,
        "no-mistakes",
        evidence,
      );
      const recorded = JSON.parse(fs.readFileSync(evidencePath, "utf8")) as {
        noMistakesFinalization: {
          attemptState: string;
          classification: string;
        };
      };
      expect(recorded.noMistakesFinalization.attemptState).toBe("succeeded");
      expect(recorded.noMistakesFinalization.classification).toBe("complete");
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
        objective:
          "Prove the external-write step scaffolds without a policy-gated write",
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
        now: NOW + 1,
      });
      expect(claim.ok).toBe(true);
      if (!claim.ok)
        throw new Error(`test setup: claim failed (${claim.reason})`);
      expect(claim.claim.kind).toBe("linear-refresh");

      const dispatch = executeWorkflowStepDispatch(claim.claim, {
        db,
        workerId: WORKER,
        now: NOW + 3,
      });

      // The base dispatcher now scaffolds the external-apply family for its
      // dedicated daemon adapter. This proof still keeps external writes closed:
      // no policy-gated adapter execution runs here, so only the empty scaffold
      // exists and the dispatch lease remains held for the adapter lane.
      expect(dispatch.status).toBe(WORKFLOW_DISPATCH_RESULT_STATUS.dispatched);
      expect(countRows(db, "executor_attempts")).toBe(1);
      expect(countRows(db, "executor_rounds")).toBe(1);

      const gates = listWorkflowGatesForRun(db, runId);
      expect(gates).toHaveLength(0);
      expect(
        getWorkflowRunManualRecoveryState(db, runId)?.needsManualRecovery,
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
            countRows(db, "executor_attempts") +
            countRows(db, "executor_rounds"),
          gateType: gates[0]?.gateType ?? null,
          needsManualRecovery:
            getWorkflowRunManualRecoveryState(db, runId)?.needsManualRecovery ??
            null,
        },
      });
      const recorded = JSON.parse(fs.readFileSync(evidencePath, "utf8")) as {
        externalWriteStep: { executorRows: number; dispatchStatus: string };
      };
      expect(recorded.externalWriteStep.executorRows).toBe(2);
      expect(recorded.externalWriteStep.dispatchStatus).toBe(
        WORKFLOW_DISPATCH_RESULT_STATUS.dispatched,
      );
    } finally {
      db.close();
    }
  });
});
