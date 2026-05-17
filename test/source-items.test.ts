import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb } from "../src/db.js";
import {
  getSourceItemById,
  listSourceSnapshotsForItem,
  recordSourceSnapshot,
  listSourceItems,
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
