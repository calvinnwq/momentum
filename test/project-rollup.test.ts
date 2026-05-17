import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/db.js";
import {
  DEFAULT_RECONCILIATION_STALE_THRESHOLD_MS,
  PROJECT_ROLLUP_ITEM_LIST_TRUNCATION_LIMIT,
  buildProjectRollup,
  type ProjectRollupMismatchKind
} from "../src/project-rollup.js";
import { ingestEvidenceRecord } from "../src/evidence-records.js";
import {
  finishSourceReconciliationRun,
  startSourceReconciliationRun
} from "../src/source-reconciliation-runs.js";
import { upsertSourceItem } from "../src/source-items.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momentum-project-rollup-"));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

type GoalSeed = {
  id: string;
  state?: string;
  needsManualRecovery?: boolean;
};

function seedGoal(db: MomentumDb, seed: GoalSeed): void {
  db.prepare(
    `INSERT INTO goals
       (id, title, branch, artifact_dir, state, current_iteration,
        needs_manual_recovery, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    seed.id,
    `Goal ${seed.id}`,
    `momentum/${seed.id}`,
    `/tmp/${seed.id}`,
    seed.state ?? "queued",
    1,
    seed.needsManualRecovery ? 1 : 0,
    1000,
    1000
  );
}

type SourceItemSeed = {
  externalId: string;
  externalKey?: string;
  title?: string;
  status?: string | null;
  goalId?: string | null;
  projectId?: string;
  projectName?: string;
  milestoneId?: string;
  milestoneName?: string;
  observedAt?: number;
  adapterKind?: string;
};

function seedSourceItem(db: MomentumDb, seed: SourceItemSeed): string {
  const metadata: Record<string, unknown> = {};
  if (seed.projectId || seed.projectName) {
    metadata["project"] = {
      id: seed.projectId ?? null,
      name: seed.projectName ?? null
    };
  }
  if (seed.milestoneId || seed.milestoneName) {
    metadata["milestone"] = {
      id: seed.milestoneId ?? null,
      name: seed.milestoneName ?? null
    };
  }
  const created = upsertSourceItem(db, {
    adapterKind: seed.adapterKind ?? "linear",
    externalId: seed.externalId,
    externalKey: seed.externalKey ?? null,
    title: seed.title ?? `Source ${seed.externalId}`,
    status: seed.status ?? "Todo",
    metadata,
    observedAt: seed.observedAt ?? 1000,
    goalId: seed.goalId ?? null
  });
  return created.id;
}

describe("buildProjectRollup", () => {
  it("returns empty rollup with stable shape when no source items exist", () => {
    const db = openDb(makeTempDir());
    try {
      const rollup = buildProjectRollup(db, { now: 2_000_000 });
      expect(rollup.counts.sourceItems.total).toBe(0);
      expect(rollup.counts.sourceItems.byStatus).toEqual({});
      expect(rollup.counts.goals.total).toBe(0);
      expect(rollup.counts.goals.byState).toEqual({});
      expect(rollup.sourceItems).toEqual([]);
      expect(rollup.mismatches).toEqual([]);
      expect(rollup.reconciliationStaleThresholdMs).toBe(
        DEFAULT_RECONCILIATION_STALE_THRESHOLD_MS
      );
      expect(rollup.reconciliationWarnings).toEqual([]);
      expect(rollup.pendingUpdateIntents).toEqual([]);
      expect(rollup.counts.pendingUpdateIntents).toBe(0);
      expect(rollup.nextAction.kind).toBe("no_action_required");
    } finally {
      db.close();
    }
  });

  it("counts SourceItems by observed state and linked Goal state", () => {
    const db = openDb(makeTempDir());
    try {
      seedGoal(db, { id: "goal-a", state: "completed" });
      seedGoal(db, { id: "goal-b", state: "queued" });
      seedSourceItem(db, {
        externalId: "issue-1",
        status: "Done",
        goalId: "goal-a"
      });
      seedSourceItem(db, {
        externalId: "issue-2",
        status: "In Progress",
        goalId: "goal-b"
      });
      seedSourceItem(db, {
        externalId: "issue-3",
        status: "Todo",
        goalId: null
      });

      const rollup = buildProjectRollup(db, { now: 2_000_000 });
      expect(rollup.counts.sourceItems.total).toBe(3);
      expect(rollup.counts.sourceItems.byStatus).toEqual({
        Done: 1,
        "In Progress": 1,
        Todo: 1
      });
      expect(rollup.counts.sourceItems.linkedToGoal).toBe(2);
      expect(rollup.counts.sourceItems.unlinked).toBe(1);
      expect(rollup.counts.goals.total).toBe(2);
      expect(rollup.counts.goals.byState).toEqual({
        completed: 1,
        queued: 1
      });
    } finally {
      db.close();
    }
  });

  it("filters source items by project id, project name, milestone id, and milestone name", () => {
    const db = openDb(makeTempDir());
    try {
      seedSourceItem(db, {
        externalId: "issue-a1",
        projectId: "proj-1",
        projectName: "Alpha",
        milestoneId: "ms-1",
        milestoneName: "Mile 1"
      });
      seedSourceItem(db, {
        externalId: "issue-a2",
        projectId: "proj-1",
        projectName: "Alpha",
        milestoneId: "ms-2",
        milestoneName: "Mile 2"
      });
      seedSourceItem(db, {
        externalId: "issue-b1",
        projectId: "proj-2",
        projectName: "Beta",
        milestoneId: "ms-3",
        milestoneName: "Mile 3"
      });

      const byProjectId = buildProjectRollup(db, {
        filters: { projectId: "proj-1" },
        now: 2_000_000
      });
      expect(byProjectId.counts.sourceItems.total).toBe(2);

      const byProjectName = buildProjectRollup(db, {
        filters: { projectName: "Beta" },
        now: 2_000_000
      });
      expect(byProjectName.counts.sourceItems.total).toBe(1);

      const byMilestoneId = buildProjectRollup(db, {
        filters: { projectId: "proj-1", milestoneId: "ms-2" },
        now: 2_000_000
      });
      expect(byMilestoneId.counts.sourceItems.total).toBe(1);
      expect(byMilestoneId.sourceItems[0]?.externalId).toBe("issue-a2");

      const byMilestoneName = buildProjectRollup(db, {
        filters: { milestoneName: "Mile 3" },
        now: 2_000_000
      });
      expect(byMilestoneName.counts.sourceItems.total).toBe(1);
    } finally {
      db.close();
    }
  });

  it("flags source-done/goal-not-terminal and goal-done/source-not-done mismatches", () => {
    const db = openDb(makeTempDir());
    try {
      seedGoal(db, { id: "goal-open", state: "queued" });
      seedGoal(db, { id: "goal-done", state: "completed" });
      seedSourceItem(db, {
        externalId: "issue-mismatch-a",
        status: "Done",
        goalId: "goal-open"
      });
      seedSourceItem(db, {
        externalId: "issue-mismatch-b",
        status: "In Progress",
        goalId: "goal-done"
      });

      const rollup = buildProjectRollup(db, { now: 2_000_000 });
      const kinds = rollup.mismatches.map((m) => m.kind).sort();
      expect(kinds).toContain("source_done_goal_not_terminal");
      expect(kinds).toContain("goal_done_source_not_done");
      expect(rollup.counts.mismatches.source_done_goal_not_terminal).toBe(1);
      expect(rollup.counts.mismatches.goal_done_source_not_done).toBe(1);
    } finally {
      db.close();
    }
  });

  it("flags evidence-missing-after-completion when terminal goals lack evidence", () => {
    const db = openDb(makeTempDir());
    try {
      seedGoal(db, { id: "goal-missing-evidence", state: "completed" });
      seedGoal(db, { id: "goal-has-evidence", state: "completed" });
      seedSourceItem(db, {
        externalId: "issue-missing",
        status: "Done",
        goalId: "goal-missing-evidence"
      });
      seedSourceItem(db, {
        externalId: "issue-has",
        status: "Done",
        goalId: "goal-has-evidence"
      });
      ingestEvidenceRecord(db, {
        source: "workflow",
        type: "verification",
        occurredAt: 1_500,
        summary: "verification passed",
        goalId: "goal-has-evidence",
        ingestKey: "ingest-has-evidence-1"
      });
      ingestEvidenceRecord(db, {
        source: "workflow",
        type: "plan",
        occurredAt: 1_400,
        summary: "plan recorded",
        goalId: "goal-has-evidence",
        ingestKey: "ingest-has-evidence-2"
      });

      const rollup = buildProjectRollup(db, { now: 2_000_000 });
      const missingMismatches = rollup.mismatches.filter(
        (m) => m.kind === "evidence_missing_after_completion"
      );
      expect(missingMismatches).toHaveLength(1);
      expect(missingMismatches[0]?.goalId).toBe("goal-missing-evidence");
      expect(rollup.counts.evidence.goalsWithEvidence).toBe(1);
      expect(rollup.counts.evidence.goalsWithoutEvidence).toBe(1);
      expect(rollup.counts.evidence.totalRecords).toBe(2);
    } finally {
      db.close();
    }
  });

  it("counts source-item-linked evidence for completed linked goals", () => {
    const db = openDb(makeTempDir());
    try {
      seedGoal(db, { id: "goal-source-evidence", state: "completed" });
      const sourceItemId = seedSourceItem(db, {
        externalId: "issue-source-evidence",
        status: "Done",
        goalId: "goal-source-evidence"
      });
      ingestEvidenceRecord(db, {
        source: "workflow",
        type: "verification",
        occurredAt: 1_500,
        summary: "verification passed",
        sourceItemId,
        ingestKey: "ingest-source-evidence-1"
      });

      const rollup = buildProjectRollup(db, { now: 2_000_000 });
      expect(
        rollup.mismatches.filter((m) => m.kind === "evidence_missing_after_completion")
      ).toEqual([]);
      expect(rollup.counts.evidence.goalsWithEvidence).toBe(1);
      expect(rollup.counts.evidence.goalsWithoutEvidence).toBe(0);
      expect(rollup.counts.evidence.totalRecords).toBe(1);
    } finally {
      db.close();
    }
  });

  it("flags manual recovery required goals as a mismatch and counts them", () => {
    const db = openDb(makeTempDir());
    try {
      seedGoal(db, {
        id: "goal-recover",
        state: "queued",
        needsManualRecovery: true
      });
      seedSourceItem(db, {
        externalId: "issue-recover",
        status: "Todo",
        goalId: "goal-recover"
      });

      const rollup = buildProjectRollup(db, { now: 2_000_000 });
      expect(rollup.counts.goals.needingManualRecovery).toBe(1);
      const kinds = rollup.mismatches.map((m) => m.kind);
      expect(kinds).toContain("manual_recovery_required");
      expect(rollup.nextAction.kind).toBe("manual_recovery_required");
    } finally {
      db.close();
    }
  });

  it("emits a stale reconciliation warning when last run is older than the threshold", () => {
    const db = openDb(makeTempDir());
    try {
      seedSourceItem(db, { externalId: "issue-stale" });
      const oldRunStartedAt = 0;
      const run = startSourceReconciliationRun(
        db,
        { adapterKind: "linear" },
        { now: () => oldRunStartedAt }
      );
      finishSourceReconciliationRun(
        db,
        {
          runId: run.id,
          state: "succeeded",
          itemsSeen: 1,
          itemsUpserted: 1
        },
        { now: () => oldRunStartedAt + 1 }
      );

      const now = oldRunStartedAt + DEFAULT_RECONCILIATION_STALE_THRESHOLD_MS + 60_000;
      const rollup = buildProjectRollup(db, { now });
      expect(rollup.reconciliationWarnings).toHaveLength(1);
      expect(rollup.reconciliationWarnings[0]?.reason).toBe("stale");
      expect(rollup.reconciliationWarnings[0]?.adapterKind).toBe("linear");
    } finally {
      db.close();
    }
  });

  it("respects a custom reconciliation stale threshold", () => {
    const db = openDb(makeTempDir());
    try {
      seedSourceItem(db, { externalId: "issue-stale-custom" });
      const run = startSourceReconciliationRun(
        db,
        { adapterKind: "linear" },
        { now: () => 1_000 }
      );
      finishSourceReconciliationRun(
        db,
        {
          runId: run.id,
          state: "succeeded",
          itemsSeen: 0,
          itemsUpserted: 0
        },
        { now: () => 2_000 }
      );

      const withGenerousThreshold = buildProjectRollup(db, {
        now: 100_000,
        reconciliationStaleThresholdMs: 10_000_000
      });
      expect(withGenerousThreshold.reconciliationWarnings).toEqual([]);

      const withTightThreshold = buildProjectRollup(db, {
        now: 100_000,
        reconciliationStaleThresholdMs: 1_000
      });
      expect(withTightThreshold.reconciliationWarnings[0]?.reason).toBe("stale");
    } finally {
      db.close();
    }
  });

  it("warns when reconciliation has never run and source items exist", () => {
    const db = openDb(makeTempDir());
    try {
      seedSourceItem(db, { externalId: "issue-no-recon" });

      const rollup = buildProjectRollup(db, { now: 2_000_000 });
      const warning = rollup.reconciliationWarnings[0];
      expect(warning?.reason).toBe("never_run");
      expect(warning?.adapterKind).toBe("linear");
      expect(warning?.lastRunFinishedAt).toBeNull();
    } finally {
      db.close();
    }
  });

  it("does not warn for empty filtered source sets", () => {
    const db = openDb(makeTempDir());
    try {
      const rollup = buildProjectRollup(db, {
        filters: { adapterKind: "linear" },
        now: 2_000_000
      });
      expect(rollup.counts.sourceItems.total).toBe(0);
      expect(rollup.reconciliationWarnings).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("reports never-run warnings per adapter represented in the filtered source items", () => {
    const db = openDb(makeTempDir());
    try {
      seedSourceItem(db, { externalId: "issue-linear", adapterKind: "linear" });
      seedSourceItem(db, { externalId: "issue-gh", adapterKind: "github" });

      const rollup = buildProjectRollup(db, { now: 2_000_000 });
      expect(rollup.reconciliationWarnings.map((warning) => warning.adapterKind)).toEqual([
        "github",
        "linear"
      ]);
      expect(
        rollup.reconciliationWarnings.map((warning) => warning.reason)
      ).toEqual(["never_run", "never_run"]);
    } finally {
      db.close();
    }
  });

  it("warns when the last reconciliation failed", () => {
    const db = openDb(makeTempDir());
    try {
      seedSourceItem(db, { externalId: "issue-failed" });
      const run = startSourceReconciliationRun(
        db,
        { adapterKind: "linear" },
        { now: () => 1_000 }
      );
      finishSourceReconciliationRun(
        db,
        {
          runId: run.id,
          state: "failed",
          itemsSeen: 0,
          itemsUpserted: 0,
          error: "source_auth_unavailable: no token"
        },
        { now: () => 2_000 }
      );

      const rollup = buildProjectRollup(db, { now: 3_000 });
      const warning = rollup.reconciliationWarnings[0];
      expect(warning?.reason).toBe("last_failed");
      expect(warning?.error).toBe("source_auth_unavailable: no token");
    } finally {
      db.close();
    }
  });

  it("falls back past stale running reconciliation runs when checking freshness", () => {
    const db = openDb(makeTempDir());
    try {
      seedSourceItem(db, { externalId: "issue-running-stale" });
      const succeeded = startSourceReconciliationRun(
        db,
        { adapterKind: "linear" },
        { now: () => 1_000 }
      );
      finishSourceReconciliationRun(
        db,
        {
          runId: succeeded.id,
          state: "succeeded",
          itemsSeen: 1,
          itemsUpserted: 1
        },
        { now: () => 2_000 }
      );
      startSourceReconciliationRun(
        db,
        { adapterKind: "linear" },
        { now: () => 3_000 }
      );

      const rollup = buildProjectRollup(db, {
        now: 3_000 + DEFAULT_RECONCILIATION_STALE_THRESHOLD_MS + 60_000
      });
      expect(rollup.reconciliationWarnings).toMatchObject([
        { adapterKind: "linear", reason: "stale", lastRunState: "succeeded" }
      ]);
    } finally {
      db.close();
    }
  });

  it("marks stale running reconciliation runs when no terminal run exists", () => {
    const db = openDb(makeTempDir());
    try {
      seedSourceItem(db, { externalId: "issue-running-only" });
      startSourceReconciliationRun(
        db,
        { adapterKind: "linear" },
        { now: () => 3_000 }
      );

      const rollup = buildProjectRollup(db, {
        now: 3_000 + DEFAULT_RECONCILIATION_STALE_THRESHOLD_MS + 60_000
      });
      expect(rollup.reconciliationWarnings).toMatchObject([
        { adapterKind: "linear", reason: "stale", lastRunState: "running" }
      ]);
      expect(rollup.nextAction.kind).toBe("reconcile_stale_source");
    } finally {
      db.close();
    }
  });

  it("scopes reconciliation warnings to runs covering filtered source items", () => {
    const db = openDb(makeTempDir());
    try {
      seedSourceItem(db, {
        externalId: "issue-alpha",
        projectId: "proj-alpha",
        projectName: "Alpha"
      });
      const alphaRun = startSourceReconciliationRun(
        db,
        { adapterKind: "linear", metadata: { filters: { projectName: "Alpha" } } },
        { now: () => 1_000 }
      );
      finishSourceReconciliationRun(
        db,
        {
          runId: alphaRun.id,
          state: "succeeded",
          itemsSeen: 1,
          itemsUpserted: 1
        },
        { now: () => 2_000 }
      );
      const betaRun = startSourceReconciliationRun(
        db,
        { adapterKind: "linear", metadata: { filters: { projectName: "Beta" } } },
        { now: () => 3_000 }
      );
      finishSourceReconciliationRun(
        db,
        {
          runId: betaRun.id,
          state: "failed",
          itemsSeen: 0,
          itemsUpserted: 0,
          error: "source_auth_unavailable: beta token"
        },
        { now: () => 4_000 }
      );

      const rollup = buildProjectRollup(db, {
        filters: { projectName: "Alpha" },
        now: 5_000
      });
      expect(rollup.reconciliationWarnings).toEqual([]);
      expect(rollup.nextAction.kind).toBe("no_action_required");
    } finally {
      db.close();
    }
  });

  it("reports never-run when scoped source items have no compatible reconciliation run", () => {
    const db = openDb(makeTempDir());
    try {
      seedSourceItem(db, {
        externalId: "issue-alpha-never",
        projectId: "proj-alpha",
        projectName: "Alpha"
      });
      const betaRun = startSourceReconciliationRun(
        db,
        { adapterKind: "linear", metadata: { filters: { projectName: "Beta" } } },
        { now: () => 1_000 }
      );
      finishSourceReconciliationRun(
        db,
        {
          runId: betaRun.id,
          state: "succeeded",
          itemsSeen: 1,
          itemsUpserted: 1
        },
        { now: () => 2_000 }
      );

      const rollup = buildProjectRollup(db, {
        filters: { projectName: "Alpha" },
        now: 3_000
      });
      expect(rollup.reconciliationWarnings).toMatchObject([
        { adapterKind: "linear", reason: "never_run" }
      ]);
      expect(rollup.nextAction.kind).toBe("reconcile_stale_source");
    } finally {
      db.close();
    }
  });

  it("matches stored reconciliation filter names against source metadata ids", () => {
    const db = openDb(makeTempDir());
    try {
      seedSourceItem(db, {
        externalId: "issue-proj-id",
        projectId: "proj-1",
        projectName: "Alpha"
      });
      const run = startSourceReconciliationRun(
        db,
        { adapterKind: "linear", metadata: { filters: { projectName: "proj-1" } } },
        { now: () => 1_000 }
      );
      finishSourceReconciliationRun(
        db,
        {
          runId: run.id,
          state: "succeeded",
          itemsSeen: 1,
          itemsUpserted: 1
        },
        { now: () => 2_000 }
      );

      const rollup = buildProjectRollup(db, {
        filters: { projectId: "proj-1", projectName: "proj-1" },
        now: 3_000
      });
      expect(rollup.reconciliationWarnings).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("truncates large source item lists to the bounded limit with deterministic ordering", () => {
    const db = openDb(makeTempDir());
    try {
      const total = 105;
      for (let i = 0; i < total; i += 1) {
        const ext = `issue-${String(i).padStart(4, "0")}`;
        seedSourceItem(db, { externalId: ext, externalKey: ext, status: "Todo" });
      }

      const rollup = buildProjectRollup(db, { now: 2_000_000 });
      expect(rollup.counts.sourceItems.total).toBe(total);
      expect(rollup.totalSourceItemCount).toBe(total);
      expect(rollup.sourceItems).toHaveLength(
        PROJECT_ROLLUP_ITEM_LIST_TRUNCATION_LIMIT
      );
      expect(rollup.truncatedSourceItems).toBe(true);
      const first = rollup.sourceItems[0];
      const last = rollup.sourceItems.at(-1);
      expect(first?.externalKey).toBe("issue-0000");
      expect(last?.externalKey).toBe(
        `issue-${String(PROJECT_ROLLUP_ITEM_LIST_TRUNCATION_LIMIT - 1).padStart(4, "0")}`
      );
    } finally {
      db.close();
    }
  });

  it("picks manual recovery as the highest-priority next action when present", () => {
    const db = openDb(makeTempDir());
    try {
      seedGoal(db, {
        id: "goal-recover",
        state: "queued",
        needsManualRecovery: true
      });
      seedSourceItem(db, {
        externalId: "issue-recover",
        status: "Done",
        goalId: "goal-recover"
      });

      const rollup = buildProjectRollup(db, { now: 2_000_000 });
      expect(rollup.nextAction.kind).toBe("manual_recovery_required");
    } finally {
      db.close();
    }
  });

  it("picks reconcile_failed next action when the last reconciliation failed", () => {
    const db = openDb(makeTempDir());
    try {
      seedSourceItem(db, { externalId: "issue-failed" });
      const run = startSourceReconciliationRun(
        db,
        { adapterKind: "linear" },
        { now: () => 1_000 }
      );
      finishSourceReconciliationRun(
        db,
        {
          runId: run.id,
          state: "failed",
          itemsSeen: 0,
          itemsUpserted: 0,
          error: "boom"
        },
        { now: () => 2_000 }
      );
      const rollup = buildProjectRollup(db, { now: 3_000 });
      expect(rollup.nextAction.kind).toBe("reconcile_failed");
    } finally {
      db.close();
    }
  });

  it("reports a stable pendingUpdateIntents block reserved for NGX-293", () => {
    const db = openDb(makeTempDir());
    try {
      seedSourceItem(db, { externalId: "issue-intent" });
      const rollup = buildProjectRollup(db, { now: 2_000_000 });
      expect(rollup.pendingUpdateIntents).toEqual([]);
      expect(rollup.counts.pendingUpdateIntents).toBe(0);
    } finally {
      db.close();
    }
  });

  it("exposes ProjectRollupMismatchKind values consistently", () => {
    const allowed: ProjectRollupMismatchKind[] = [
      "source_done_goal_not_terminal",
      "goal_done_source_not_done",
      "evidence_missing_after_completion",
      "manual_recovery_required"
    ];
    expect(allowed).toHaveLength(4);
  });
});
