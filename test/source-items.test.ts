import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb } from "../src/adapters/db.js";
import {
  getSourceItemById,
  linkGoalToSourceItem,
  listSourceItemSummariesForGoal,
  listSourceSnapshotsForItem,
  recordSourceSnapshot,
  listSourceItems,
  unlinkGoalFromSourceItem,
  upsertSourceItem,
  type SourceItemUpsertInput
} from "../src/source-items.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-source-items-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function baseInput(overrides: Partial<SourceItemUpsertInput> = {}): SourceItemUpsertInput {
  return {
    adapterKind: "manual",
    externalId: "issue-1",
    externalKey: "MAN-1",
    url: "file:///manual/MAN-1",
    title: "Original title",
    status: "Todo",
    metadata: { estimate: 2, labels: ["m5"] },
    observedAt: 1000,
    ...overrides
  };
}

describe("source item storage", () => {
  it("upserts source items by adapter kind and external id while preserving identity", () => {
    const db = openDb(makeTempDir());
    try {
      const created = upsertSourceItem(db, baseInput(), { now: () => 1100 });

      expect(created.adapterKind).toBe("manual");
      expect(created.externalId).toBe("issue-1");
      expect(created.externalKey).toBe("MAN-1");
      expect(created.title).toBe("Original title");
      expect(created.status).toBe("Todo");
      expect(created.metadata).toEqual({ estimate: 2, labels: ["m5"] });
      expect(created.lastObservedAt).toBe(1000);
      expect(created.createdAt).toBe(1100);
      expect(created.updatedAt).toBe(1100);

      const updated = upsertSourceItem(
        db,
        baseInput({
          title: "Updated title",
          status: "In Progress",
          metadata: { estimate: 3, state: { type: "started" } },
          observedAt: 1200
        }),
        { now: () => 1300 }
      );

      expect(updated.id).toBe(created.id);
      expect(updated.createdAt).toBe(1100);
      expect(updated.updatedAt).toBe(1300);
      expect(updated.title).toBe("Updated title");
      expect(updated.status).toBe("In Progress");
      expect(updated.metadata).toEqual({ estimate: 3, state: { type: "started" } });
      expect(updated.lastObservedAt).toBe(1200);

      expect(getSourceItemById(db, created.id)).toEqual(updated);
    } finally {
      db.close();
    }
  });

  it("allows the same external id to exist under different adapter kinds", () => {
    const db = openDb(makeTempDir());
    try {
      const manual = upsertSourceItem(db, baseInput({ adapterKind: "manual" }), {
        now: () => 1
      });
      const fixture = upsertSourceItem(db, baseInput({ adapterKind: "local-fixture" }), {
        now: () => 2
      });

      expect(fixture.id).not.toBe(manual.id);
      expect(fixture.externalId).toBe(manual.externalId);
      expect(fixture.adapterKind).toBe("local-fixture");
    } finally {
      db.close();
    }
  });

  it("keeps the newest observation when out-of-order upserts race for the same source item", () => {
    const dataDir = makeTempDir();
    const firstConnection = openDb(dataDir);
    const secondConnection = openDb(dataDir);
    try {
      const newest = upsertSourceItem(
        firstConnection,
        baseInput({
          title: "Newest title",
          status: "Done",
          metadata: { observed: "newest" },
          observedAt: 2000
        }),
        { now: () => 2100 }
      );

      const stale = upsertSourceItem(
        secondConnection,
        baseInput({
          title: "Stale title",
          status: "Todo",
          metadata: { observed: "stale" },
          observedAt: 1500
        }),
        { now: () => 2200 }
      );

      expect(stale).toEqual(newest);
      expect(listSourceItems(firstConnection)).toEqual([newest]);
    } finally {
      firstConnection.close();
      secondConnection.close();
    }
  });

  it("preserves goal linkage on refresh unless goalId is explicitly supplied", () => {
    const db = openDb(makeTempDir());
    try {
      db.prepare(
        `INSERT INTO goals
           (id, title, branch, artifact_dir, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run("goal-1", "Linked goal", "momentum/linked", "/tmp/linked", 1, 1);
      const linked = upsertSourceItem(
        db,
        baseInput({ goalId: "goal-1" }),
        { now: () => 1100 }
      );
      const refreshed = upsertSourceItem(
        db,
        baseInput({
          title: "Refreshed title",
          observedAt: 1200
        }),
        { now: () => 1300 }
      );
      const cleared = upsertSourceItem(
        db,
        baseInput({
          title: "Cleared title",
          observedAt: 1400,
          goalId: null
        }),
        { now: () => 1500 }
      );

      expect(linked.goalId).toBe("goal-1");
      expect(refreshed.goalId).toBe("goal-1");
      expect(cleared.goalId).toBeNull();
    } finally {
      db.close();
    }
  });

  it("links and unlinks a source item to a goal idempotently and preserves snapshot history on unlink", () => {
    const db = openDb(makeTempDir());
    try {
      db.prepare(
        `INSERT INTO goals
           (id, title, branch, artifact_dir, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run("goal-link-1", "Link target", "momentum/link-1", "/tmp/link-1", 1, 1);

      const item = upsertSourceItem(db, baseInput(), { now: () => 1100 });
      recordSourceSnapshot(
        db,
        {
          sourceItemId: item.id,
          adapterKind: item.adapterKind,
          externalId: item.externalId,
          observedAt: 1500,
          snapshot: { description: "Initial scope" }
        },
        { now: () => 1600 }
      );

      const first = linkGoalToSourceItem(db, {
        goalId: "goal-link-1",
        sourceItemId: item.id,
        now: 2000
      });
      expect(first.ok).toBe(true);
      if (first.ok) {
        expect(first.changed).toBe(true);
        expect(first.skippedReason).toBeNull();
        expect(first.previousGoalId).toBeNull();
        expect(first.sourceItem.goalId).toBe("goal-link-1");
        expect(first.sourceItem.updatedAt).toBe(2000);
      }

      const second = linkGoalToSourceItem(db, {
        goalId: "goal-link-1",
        sourceItemId: item.id,
        now: 2100
      });
      expect(second.ok).toBe(true);
      if (second.ok) {
        expect(second.changed).toBe(false);
        expect(second.skippedReason).toBe("already_linked_to_target");
        expect(second.previousGoalId).toBe("goal-link-1");
      }

      expect(listSourceItemSummariesForGoal(db, "goal-link-1")).toHaveLength(1);

      const unlinkResult = unlinkGoalFromSourceItem(db, {
        sourceItemId: item.id,
        now: 2200
      });
      expect(unlinkResult.ok).toBe(true);
      if (unlinkResult.ok) {
        expect(unlinkResult.changed).toBe(true);
        expect(unlinkResult.previousGoalId).toBe("goal-link-1");
        expect(unlinkResult.sourceItem.goalId).toBeNull();
      }

      const unlinkIdempotent = unlinkGoalFromSourceItem(db, {
        sourceItemId: item.id,
        now: 2300
      });
      expect(unlinkIdempotent.ok).toBe(true);
      if (unlinkIdempotent.ok) {
        expect(unlinkIdempotent.changed).toBe(false);
        expect(unlinkIdempotent.previousGoalId).toBeNull();
      }

      const snapshots = listSourceSnapshotsForItem(db, item.id);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]?.snapshot).toEqual({ description: "Initial scope" });
    } finally {
      db.close();
    }
  });

  it("returns goal_not_found, source_item_not_found, and linked_to_other_goal error codes from linkGoalToSourceItem", () => {
    const db = openDb(makeTempDir());
    try {
      db.prepare(
        `INSERT INTO goals
           (id, title, branch, artifact_dir, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run("goal-a", "A", "momentum/a", "/tmp/a", 1, 1);
      db.prepare(
        `INSERT INTO goals
           (id, title, branch, artifact_dir, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run("goal-b", "B", "momentum/b", "/tmp/b", 1, 1);
      const item = upsertSourceItem(db, baseInput(), { now: () => 100 });

      const missingGoal = linkGoalToSourceItem(db, {
        goalId: "goal-missing",
        sourceItemId: item.id
      });
      expect(missingGoal.ok).toBe(false);
      if (!missingGoal.ok) {
        expect(missingGoal.code).toBe("goal_not_found");
      }

      const missingItem = linkGoalToSourceItem(db, {
        goalId: "goal-a",
        sourceItemId: "source_item_missing"
      });
      expect(missingItem.ok).toBe(false);
      if (!missingItem.ok) {
        expect(missingItem.code).toBe("source_item_not_found");
      }

      const linkedA = linkGoalToSourceItem(db, {
        goalId: "goal-a",
        sourceItemId: item.id
      });
      expect(linkedA.ok).toBe(true);

      const collision = linkGoalToSourceItem(db, {
        goalId: "goal-b",
        sourceItemId: item.id
      });
      expect(collision.ok).toBe(false);
      if (!collision.ok) {
        expect(collision.code).toBe("linked_to_other_goal");
        expect(collision.currentGoalId).toBe("goal-a");
      }

      const unlinkMissing = unlinkGoalFromSourceItem(db, {
        sourceItemId: "source_item_missing"
      });
      expect(unlinkMissing.ok).toBe(false);
      if (!unlinkMissing.ok) {
        expect(unlinkMissing.code).toBe("source_item_not_found");
      }
    } finally {
      db.close();
    }
  });

  it("records immutable source snapshots for observed source item payloads", () => {
    const db = openDb(makeTempDir());
    try {
      const item = upsertSourceItem(db, baseInput(), { now: () => 1100 });

      const firstSnapshot = recordSourceSnapshot(
        db,
        {
          sourceItemId: item.id,
          adapterKind: item.adapterKind,
          externalId: item.externalId,
          observedAt: 1000,
          snapshot: { title: "Original title", nested: { status: "Todo" } }
        },
        { now: () => 1200 }
      );
      const secondSnapshot = recordSourceSnapshot(
        db,
        {
          sourceItemId: item.id,
          adapterKind: item.adapterKind,
          externalId: item.externalId,
          observedAt: 1300,
          snapshot: { title: "Updated title", labels: ["m5"] }
        },
        { now: () => 1400 }
      );

      expect(firstSnapshot).toEqual({
        id: expect.any(String),
        sourceItemId: item.id,
        adapterKind: "manual",
        externalId: "issue-1",
        observedAt: 1000,
        snapshot: { title: "Original title", nested: { status: "Todo" } },
        createdAt: 1200
      });
      expect(secondSnapshot.id).not.toBe(firstSnapshot.id);
      expect(listSourceSnapshotsForItem(db, item.id)).toEqual([
        firstSnapshot,
        secondSnapshot
      ]);
    } finally {
      db.close();
    }
  });
});
