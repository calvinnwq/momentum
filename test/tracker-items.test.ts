import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb } from "../src/adapters/db.js";
import {
  getTrackerItemById,
  linkGoalToTrackerItem,
  listTrackerItemSummariesForGoal,
  listTrackerSnapshotsForItem,
  recordTrackerSnapshot,
  listTrackerItems,
  unlinkGoalFromTrackerItem,
  upsertTrackerItem,
  type TrackerItemUpsertInput,
} from "../src/core/tracker/items.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-tracker-items-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function baseInput(
  overrides: Partial<TrackerItemUpsertInput> = {},
): TrackerItemUpsertInput {
  return {
    adapterKind: "manual",
    externalId: "issue-1",
    externalKey: "MAN-1",
    url: "file:///manual/MAN-1",
    title: "Original title",
    status: "Todo",
    metadata: { estimate: 2, labels: ["m5"] },
    observedAt: 1000,
    ...overrides,
  };
}

describe("source item storage", () => {
  it("upserts source items by adapter kind and external id while preserving identity", () => {
    const db = openDb(makeTempDir());
    try {
      const created = upsertTrackerItem(db, baseInput(), { now: () => 1100 });

      expect(created.adapterKind).toBe("manual");
      expect(created.externalId).toBe("issue-1");
      expect(created.externalKey).toBe("MAN-1");
      expect(created.title).toBe("Original title");
      expect(created.status).toBe("Todo");
      expect(created.metadata).toEqual({ estimate: 2, labels: ["m5"] });
      expect(created.lastObservedAt).toBe(1000);
      expect(created.createdAt).toBe(1100);
      expect(created.updatedAt).toBe(1100);

      const updated = upsertTrackerItem(
        db,
        baseInput({
          title: "Updated title",
          status: "In Progress",
          metadata: { estimate: 3, state: { type: "started" } },
          observedAt: 1200,
        }),
        { now: () => 1300 },
      );

      expect(updated.id).toBe(created.id);
      expect(updated.createdAt).toBe(1100);
      expect(updated.updatedAt).toBe(1300);
      expect(updated.title).toBe("Updated title");
      expect(updated.status).toBe("In Progress");
      expect(updated.metadata).toEqual({
        estimate: 3,
        state: { type: "started" },
      });
      expect(updated.lastObservedAt).toBe(1200);

      expect(getTrackerItemById(db, created.id)).toEqual(updated);
    } finally {
      db.close();
    }
  });

  it("allows the same external id to exist under different adapter kinds", () => {
    const db = openDb(makeTempDir());
    try {
      const manual = upsertTrackerItem(
        db,
        baseInput({ adapterKind: "manual" }),
        {
          now: () => 1,
        },
      );
      const fixture = upsertTrackerItem(
        db,
        baseInput({ adapterKind: "local-fixture" }),
        {
          now: () => 2,
        },
      );

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
      const newest = upsertTrackerItem(
        firstConnection,
        baseInput({
          title: "Newest title",
          status: "Done",
          metadata: { observed: "newest" },
          observedAt: 2000,
        }),
        { now: () => 2100 },
      );

      const stale = upsertTrackerItem(
        secondConnection,
        baseInput({
          title: "Stale title",
          status: "Todo",
          metadata: { observed: "stale" },
          observedAt: 1500,
        }),
        { now: () => 2200 },
      );

      expect(stale).toEqual(newest);
      expect(listTrackerItems(firstConnection)).toEqual([newest]);
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
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("goal-1", "Linked goal", "momentum/linked", "/tmp/linked", 1, 1);
      const linked = upsertTrackerItem(db, baseInput({ goalId: "goal-1" }), {
        now: () => 1100,
      });
      const refreshed = upsertTrackerItem(
        db,
        baseInput({
          title: "Refreshed title",
          observedAt: 1200,
        }),
        { now: () => 1300 },
      );
      const cleared = upsertTrackerItem(
        db,
        baseInput({
          title: "Cleared title",
          observedAt: 1400,
          goalId: null,
        }),
        { now: () => 1500 },
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
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        "goal-link-1",
        "Link target",
        "momentum/link-1",
        "/tmp/link-1",
        1,
        1,
      );

      const item = upsertTrackerItem(db, baseInput(), { now: () => 1100 });
      recordTrackerSnapshot(
        db,
        {
          trackerItemId: item.id,
          adapterKind: item.adapterKind,
          externalId: item.externalId,
          observedAt: 1500,
          snapshot: { description: "Initial scope" },
        },
        { now: () => 1600 },
      );

      const first = linkGoalToTrackerItem(db, {
        goalId: "goal-link-1",
        trackerItemId: item.id,
        now: 2000,
      });
      expect(first.ok).toBe(true);
      if (first.ok) {
        expect(first.changed).toBe(true);
        expect(first.skippedReason).toBeNull();
        expect(first.previousGoalId).toBeNull();
        expect(first.trackerItem.goalId).toBe("goal-link-1");
        expect(first.trackerItem.updatedAt).toBe(2000);
      }

      const second = linkGoalToTrackerItem(db, {
        goalId: "goal-link-1",
        trackerItemId: item.id,
        now: 2100,
      });
      expect(second.ok).toBe(true);
      if (second.ok) {
        expect(second.changed).toBe(false);
        expect(second.skippedReason).toBe("already_linked_to_target");
        expect(second.previousGoalId).toBe("goal-link-1");
      }

      expect(listTrackerItemSummariesForGoal(db, "goal-link-1")).toHaveLength(
        1,
      );

      const unlinkResult = unlinkGoalFromTrackerItem(db, {
        trackerItemId: item.id,
        now: 2200,
      });
      expect(unlinkResult.ok).toBe(true);
      if (unlinkResult.ok) {
        expect(unlinkResult.changed).toBe(true);
        expect(unlinkResult.previousGoalId).toBe("goal-link-1");
        expect(unlinkResult.trackerItem.goalId).toBeNull();
      }

      const unlinkIdempotent = unlinkGoalFromTrackerItem(db, {
        trackerItemId: item.id,
        now: 2300,
      });
      expect(unlinkIdempotent.ok).toBe(true);
      if (unlinkIdempotent.ok) {
        expect(unlinkIdempotent.changed).toBe(false);
        expect(unlinkIdempotent.previousGoalId).toBeNull();
      }

      const snapshots = listTrackerSnapshotsForItem(db, item.id);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]?.snapshot).toEqual({ description: "Initial scope" });
    } finally {
      db.close();
    }
  });

  it("returns goal_not_found, tracker_item_not_found, and linked_to_other_goal error codes from linkGoalToTrackerItem", () => {
    const db = openDb(makeTempDir());
    try {
      db.prepare(
        `INSERT INTO goals
           (id, title, branch, artifact_dir, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("goal-a", "A", "momentum/a", "/tmp/a", 1, 1);
      db.prepare(
        `INSERT INTO goals
           (id, title, branch, artifact_dir, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("goal-b", "B", "momentum/b", "/tmp/b", 1, 1);
      const item = upsertTrackerItem(db, baseInput(), { now: () => 100 });

      const missingGoal = linkGoalToTrackerItem(db, {
        goalId: "goal-missing",
        trackerItemId: item.id,
      });
      expect(missingGoal.ok).toBe(false);
      if (!missingGoal.ok) {
        expect(missingGoal.code).toBe("goal_not_found");
      }

      const missingItem = linkGoalToTrackerItem(db, {
        goalId: "goal-a",
        trackerItemId: "source_item_missing",
      });
      expect(missingItem.ok).toBe(false);
      if (!missingItem.ok) {
        expect(missingItem.code).toBe("tracker_item_not_found");
      }

      const linkedA = linkGoalToTrackerItem(db, {
        goalId: "goal-a",
        trackerItemId: item.id,
      });
      expect(linkedA.ok).toBe(true);

      const collision = linkGoalToTrackerItem(db, {
        goalId: "goal-b",
        trackerItemId: item.id,
      });
      expect(collision.ok).toBe(false);
      if (!collision.ok) {
        expect(collision.code).toBe("linked_to_other_goal");
        expect(collision.currentGoalId).toBe("goal-a");
      }

      const unlinkMissing = unlinkGoalFromTrackerItem(db, {
        trackerItemId: "source_item_missing",
      });
      expect(unlinkMissing.ok).toBe(false);
      if (!unlinkMissing.ok) {
        expect(unlinkMissing.code).toBe("tracker_item_not_found");
      }
    } finally {
      db.close();
    }
  });

  it("records immutable source snapshots for observed source item payloads", () => {
    const db = openDb(makeTempDir());
    try {
      const item = upsertTrackerItem(db, baseInput(), { now: () => 1100 });

      const firstSnapshot = recordTrackerSnapshot(
        db,
        {
          trackerItemId: item.id,
          adapterKind: item.adapterKind,
          externalId: item.externalId,
          observedAt: 1000,
          snapshot: { title: "Original title", nested: { status: "Todo" } },
        },
        { now: () => 1200 },
      );
      const secondSnapshot = recordTrackerSnapshot(
        db,
        {
          trackerItemId: item.id,
          adapterKind: item.adapterKind,
          externalId: item.externalId,
          observedAt: 1300,
          snapshot: { title: "Updated title", labels: ["m5"] },
        },
        { now: () => 1400 },
      );

      expect(firstSnapshot).toEqual({
        id: expect.any(String),
        trackerItemId: item.id,
        adapterKind: "manual",
        externalId: "issue-1",
        observedAt: 1000,
        snapshot: { title: "Original title", nested: { status: "Todo" } },
        createdAt: 1200,
      });
      expect(secondSnapshot.id).not.toBe(firstSnapshot.id);
      expect(listTrackerSnapshotsForItem(db, item.id)).toEqual([
        firstSnapshot,
        secondSnapshot,
      ]);
    } finally {
      db.close();
    }
  });
});
