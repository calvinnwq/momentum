import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/db.js";
import { CODING_WORKFLOW_DEFINITION } from "../src/workflow-definition.js";
import { persistWorkflowDefinition } from "../src/workflow-definition-persist.js";
import { persistWorkflowRunStart } from "../src/workflow-run-start-persist.js";
import {
  reconcileLinearSource,
  type LinearReconciliationClient,
  type LinearReconciliationFetchPageInput,
  type LinearReconciliationFetchPageResult
} from "../src/source-reconciliation.js";
import {
  listSourceItems,
  listSourceSnapshotsForItem
} from "../src/source-items.js";
import { listSourceReconciliationRuns } from "../src/source-reconciliation-runs.js";
import { claimRunnableWorkflowStep } from "../src/workflow-scheduler.js";
import { getWorkflowLease } from "../src/workflow-leases.js";
import { listWorkflowGatesForRun } from "../src/workflow-gate-persist.js";
import { getWorkflowRunManualRecoveryState } from "../src/workflow-run-recovery.js";
import {
  executeWorkflowStepDispatch,
  WORKFLOW_DISPATCH_RESULT_STATUS
} from "../src/workflow-dispatch-execute.js";
import {
  listExecutorArtifactsForRound,
  listExecutorCheckpointsForRound,
  listExecutorRoundsForInvocation,
  loadExecutorInvocation,
  loadExecutorRound
} from "../src/executor-loop-persist.js";
import {
  resolveSingleShotRoundSelection,
  singleShotInvocationId,
  singleShotRoundId,
  type SingleShotRoundRuntimeInputs
} from "../src/single-shot-executor.js";
import { runSingleShotStep } from "../src/single-shot-orchestrator.js";
import type { RunnerResult } from "../src/runner-result.js";

/**
 * NGX-372 full adapter E2E proof (Adapter Test Coverage milestone).
 *
 * This is the capstone of the layered adapter-test strategy
 * (internal/contracts/adapter-test-coverage.md): isolated contract tests
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
 *   -> external-write family stays policy-gated closed (manual-recovery gate)
 *
 * Faithfulness / phase-1 boundary: `executeWorkflowStepDispatch` is the shipped
 * production dispatch path and stops at the start *scaffold* (invocation
 * `running`, round `pending`) — driving the bounded mechanism to terminal,
 * running verification/commit finalization, and advancing the `workflow_steps`
 * row are owned by the landed `runSingleShotStep` / `runGoalLoopStep` /
 * `runNoMistakesMirrorStep` adapters, whose seam-level reconciliation with the
 * scaffold is the documented real-adapter follow-up (see the phase-1 boundary
 * note in src/workflow-dispatch-execute.ts). This proof therefore exercises the
 * scaffold via the production seam on one one-shot step (`preflight`) and the
 * terminal finalization via the landed adapter on another one-shot step
 * (`postflight`); the two carry deliberately distinct invocation ids
 * (`...::dispatch` vs the adapter's reattachable id), so composing both never
 * mints two owners for one step.
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
  input: { runId: string; repoPath: string; objective: string }
): void {
  persistWorkflowDefinition(db, CODING_WORKFLOW_DEFINITION, { now: NOW });
  persistWorkflowRunStart(db, {
    definition: CODING_WORKFLOW_DEFINITION,
    runId: input.runId,
    repoPath: input.repoPath,
    objective: input.objective,
    now: NOW
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

  it("keeps the external-write family policy-gated closed: the real linear-refresh step fails closed into operator recovery", () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir("momentum-ngx-372-e2e-repo-");
    const db = openDb(dataDir);
    try {
      const runId = "ngx-372-policy-gate";
      seedCodingWorkflowRun(db, {
        runId,
        repoPath: repoDir,
        objective: "Prove the external-write step stays policy-gated closed"
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

      // The external-write family is not a phase-1 dispatchable family: external
      // writes stay disabled. The dispatch fails closed, creating NO executor rows
      // and instead parking the run behind an operator-visible manual-recovery gate
      // (the M6 write policy is the only thing that may ever open the write path).
      expect(dispatch.status).toBe(WORKFLOW_DISPATCH_RESULT_STATUS.failClosed);
      expect(countRows(db, "executor_invocations")).toBe(0);
      expect(countRows(db, "executor_rounds")).toBe(0);

      const gates = listWorkflowGatesForRun(db, runId);
      expect(gates).toHaveLength(1);
      expect(gates[0]).toMatchObject({
        gateType: "manual_recovery_required",
        targetScope: "step",
        stepRunId: "linear-refresh",
        resolvedAt: null
      });
      expect(gates[0]?.reason).toContain("external-apply");
      expect(
        getWorkflowRunManualRecoveryState(db, runId)?.needsManualRecovery
      ).toBe(true);
      // The dispatch lease is released, not stranded.
      expect(getWorkflowLease(db, runId, "dispatch")?.releasedAt).not.toBeNull();

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
      expect(recorded.externalWriteStep.executorRows).toBe(0);
      expect(recorded.externalWriteStep.dispatchStatus).toBe(
        WORKFLOW_DISPATCH_RESULT_STATUS.failClosed
      );
    } finally {
      db.close();
    }
  });
});
