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

const NOW = 1_700_000_000_000;
const WORKER = "ngx-371-stub-worker";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-ngx-371-smoke-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function makeLinearIssue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: overrides["id"] ?? "issue-ngx-371",
    identifier: overrides["identifier"] ?? "NGX-371",
    title: overrides["title"] ?? "Stubbed adapter integration smoke",
    url:
      overrides["url"] ??
      "https://linear.app/ngxcalvin/issue/NGX-371/stubbed-adapter-integration-smoke",
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
): LinearReconciliationClient & { readonly requests: LinearReconciliationFetchPageInput[] } {
  const requests: LinearReconciliationFetchPageInput[] = [];
  let pageIndex = 0;
  return {
    requests,
    fetchPage(input: LinearReconciliationFetchPageInput): LinearReconciliationFetchPageResult {
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

function approveAndClaimPreflight(db: MomentumDb, runId: string) {
  db.prepare(
    "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ? AND step_id = 'preflight'"
  ).run(runId);
  const claim = claimRunnableWorkflowStep(db, {
    runId,
    stepId: "preflight",
    holder: WORKER,
    leaseExpiresAt: NOW + 30_000,
    now: NOW + 1
  });
  expect(claim.ok).toBe(true);
  if (!claim.ok) throw new Error(`test setup: claim failed (${claim.reason})`);
  return claim.claim;
}

function countRows(db: MomentumDb, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

describe("NGX-371 stubbed adapter integration smoke", () => {
  it("composes fake source reconciliation with workflow dispatch evidence in local persistence", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir("momentum-ngx-371-repo-");
    const db = openDb(dataDir);
    try {
      const client = fakeLinearClient([
        {
          ok: true,
          page: {
            issues: [
              makeLinearIssue({
                id: "issue-ngx-371",
                identifier: "NGX-371",
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

      expect(client.requests).toEqual([
        { cursor: null, filters: { projectId: "momentum-project" } }
      ]);
      expect(reconciliation.run.state).toBe("succeeded");
      expect(reconciliation.counts).toMatchObject({
        pages: 1,
        itemsObserved: 1,
        itemsCreated: 1,
        itemsUpdated: 0,
        itemsErrored: 0
      });

      const sourceItems = listSourceItems(db, { adapterKind: "linear" });
      expect(sourceItems).toHaveLength(1);
      expect(sourceItems[0]).toMatchObject({
        externalId: "issue-ngx-371",
        externalKey: "NGX-371",
        title: "Stubbed adapter integration smoke",
        status: "Todo"
      });
      expect(listSourceSnapshotsForItem(db, sourceItems[0]?.id ?? "")).toHaveLength(1);
      expect(listSourceReconciliationRuns(db, { adapterKind: "linear" })).toHaveLength(1);

      const runId = "ngx-371-stubbed-happy-path";
      seedCodingWorkflowRun(db, {
        runId,
        repoPath: repoDir,
        objective: `Dispatch workflow evidence for ${sourceItems[0]?.externalKey}`
      });
      const claim = approveAndClaimPreflight(db, runId);

      const dispatch = executeWorkflowStepDispatch(claim, {
        db,
        workerId: WORKER,
        now: NOW + 3
      });

      expect(dispatch.status).toBe(WORKFLOW_DISPATCH_RESULT_STATUS.dispatched);
      expect(countRows(db, "source_items")).toBe(1);
      expect(countRows(db, "source_snapshots")).toBe(1);
      expect(countRows(db, "source_reconciliation_runs")).toBe(1);
      expect(countRows(db, "executor_attempts")).toBe(1);
      expect(countRows(db, "executor_rounds")).toBe(1);

      const invocation = db
        .prepare(
          `SELECT workflow_run_id, step_key, executor_family, state, attempt
             FROM executor_attempts WHERE workflow_run_id = ?`
        )
        .get(runId) as Record<string, unknown>;
      expect(invocation).toEqual({
        workflow_run_id: runId,
        step_key: "preflight",
        executor_family: "one-shot",
        state: "running",
        attempt: 1
      });

      const round = db
        .prepare(
          `SELECT workflow_run_id, step_key, executor_family, state, artifact_root
             FROM executor_rounds WHERE workflow_run_id = ?`
        )
        .get(runId) as Record<string, unknown>;
      expect(round).toEqual({
        workflow_run_id: runId,
        step_key: "preflight",
        executor_family: "one-shot",
        state: "pending",
        artifact_root: null
      });

      const workflow = db
        .prepare(
          `SELECT state, monitor_last_seen_state AS monitorState,
                  monitor_step AS monitorStep, monitor_terminal AS monitorTerminal
             FROM workflow_runs WHERE id = ?`
        )
        .get(runId) as Record<string, unknown>;
      expect(workflow).toEqual({
        state: "running",
        monitorState: "running",
        monitorStep: "preflight",
        monitorTerminal: 0
      });
    } finally {
      db.close();
    }
  });

  it("keeps fake source failure local and parks unsupported workflow dispatch for operator recovery", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir("momentum-ngx-371-repo-");
    const db = openDb(dataDir);
    try {
      const client = fakeLinearClient([
        {
          ok: false,
          code: "source_auth_unavailable",
          error: "fake token expired"
        }
      ]);

      const reconciliation = await reconcileLinearSource(
        db,
        { client, filters: { projectId: "momentum-project" } },
        { now: () => NOW + 10 }
      );

      expect(reconciliation.run.state).toBe("failed");
      expect(reconciliation.run.error).toContain("fake token expired");
      expect(listSourceItems(db, { adapterKind: "linear" })).toEqual([]);
      expect(countRows(db, "source_snapshots")).toBe(0);

      const runId = "ngx-371-stubbed-failure-path";
      seedCodingWorkflowRun(db, {
        runId,
        repoPath: repoDir,
        objective: "Prove external-apply scaffold stays local"
      });
      db.prepare(
        `UPDATE step_definitions SET executor = 'external-apply'
           WHERE definition_key = ? AND definition_version = ? AND step_key = 'preflight'`
      ).run(CODING_WORKFLOW_DEFINITION.key, CODING_WORKFLOW_DEFINITION.version);
      const claim = approveAndClaimPreflight(db, runId);

      const dispatch = executeWorkflowStepDispatch(claim, {
        db,
        workerId: WORKER,
        now: NOW + 11
      });

      expect(dispatch.status).toBe(WORKFLOW_DISPATCH_RESULT_STATUS.dispatched);
      expect(countRows(db, "executor_attempts")).toBe(1);
      expect(countRows(db, "executor_rounds")).toBe(1);

      const gates = listWorkflowGatesForRun(db, runId);
      expect(gates).toHaveLength(0);
      expect(getWorkflowRunManualRecoveryState(db, runId)?.needsManualRecovery).toBe(
        false
      );
      expect(getWorkflowLease(db, runId, "dispatch")?.releasedAt).toBeNull();
    } finally {
      db.close();
    }
  });
});
