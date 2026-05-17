import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb } from "../src/db.js";
import {
  finishSourceReconciliationRun,
  getSourceReconciliationRun,
  listSourceReconciliationRuns,
  startSourceReconciliationRun
} from "../src/source-reconciliation-runs.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-source-reconciliation-runs-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

describe("source reconciliation run storage", () => {
  it("starts and finishes a reconciliation run with durable counts and metadata", () => {
    const db = openDb(makeTempDir());
    try {
      const started = startSourceReconciliationRun(
        db,
        {
          adapterKind: "local-fixture",
          metadata: { filters: { project: "Momentum" } }
        },
        { now: () => 1_000 }
      );

      expect(started).toEqual({
        id: expect.any(String),
        adapterKind: "local-fixture",
        state: "running",
        startedAt: 1_000,
        finishedAt: null,
        error: null,
        itemsSeen: 0,
        itemsUpserted: 0,
        metadata: { filters: { project: "Momentum" } },
        createdAt: 1_000,
        updatedAt: 1_000
      });
      expect(getSourceReconciliationRun(db, started.id)).toEqual(started);

      const finished = finishSourceReconciliationRun(
        db,
        {
          runId: started.id,
          state: "succeeded",
          itemsSeen: 3,
          itemsUpserted: 2,
          metadata: { filters: { project: "Momentum" }, nextCursor: null }
        },
        { now: () => 1_500 }
      );

      expect(finished).toEqual({
        ...started,
        state: "succeeded",
        finishedAt: 1_500,
        itemsSeen: 3,
        itemsUpserted: 2,
        metadata: { filters: { project: "Momentum" }, nextCursor: null },
        updatedAt: 1_500
      });
      expect(getSourceReconciliationRun(db, started.id)).toEqual(finished);
    } finally {
      db.close();
    }
  });

  it("records failed reconciliation runs with stable error text", () => {
    const db = openDb(makeTempDir());
    try {
      const started = startSourceReconciliationRun(
        db,
        { adapterKind: "local-fixture" },
        { now: () => 2_000 }
      );

      const failed = finishSourceReconciliationRun(
        db,
        {
          runId: started.id,
          state: "failed",
          error: "adapter unavailable",
          itemsSeen: 1,
          itemsUpserted: 0
        },
        { now: () => 2_100 }
      );

      expect(failed?.state).toBe("failed");
      expect(failed?.error).toBe("adapter unavailable");
      expect(failed?.finishedAt).toBe(2_100);
      expect(failed?.itemsSeen).toBe(1);
      expect(failed?.itemsUpserted).toBe(0);
    } finally {
      db.close();
    }
  });

  it("lists reconciliation runs deterministically with optional adapter filtering", () => {
    const db = openDb(makeTempDir());
    try {
      const laterFixture = startSourceReconciliationRun(
        db,
        { adapterKind: "local-fixture" },
        { now: () => 2_000 }
      );
      const manual = startSourceReconciliationRun(
        db,
        { adapterKind: "manual" },
        { now: () => 1_500 }
      );
      const earlierFixture = startSourceReconciliationRun(
        db,
        { adapterKind: "local-fixture" },
        { now: () => 1_000 }
      );

      expect(listSourceReconciliationRuns(db).map((run) => run.id)).toEqual([
        earlierFixture.id,
        manual.id,
        laterFixture.id
      ]);
      expect(
        listSourceReconciliationRuns(db, { adapterKind: "local-fixture" }).map(
          (run) => run.id
        )
      ).toEqual([earlierFixture.id, laterFixture.id]);
    } finally {
      db.close();
    }
  });
});
