import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb } from "../src/adapters/db.js";
import { buildIterationSourceContext } from "../src/core/source/context.js";
import {
  recordSourceSnapshot,
  upsertSourceItem
} from "../src/core/source/items.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momentum-source-context-"));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

describe("buildIterationSourceContext", () => {
  it("includes every linked source item and uses each latest snapshot body", () => {
    const db = openDb(makeTempDir());
    try {
      db.prepare(
        `INSERT INTO goals
           (id, title, branch, artifact_dir, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run("goal-source-context", "Source context", "momentum/source", "/tmp/source", 1, 1);

      const first = upsertSourceItem(db, {
        adapterKind: "linear",
        externalId: "issue-1",
        externalKey: "NGX-290",
        title: "First linked issue",
        observedAt: 1,
        goalId: "goal-source-context"
      });
      const second = upsertSourceItem(db, {
        adapterKind: "linear",
        externalId: "issue-2",
        externalKey: "NGX-291",
        title: "Second linked issue",
        observedAt: 2,
        goalId: "goal-source-context"
      });

      recordSourceSnapshot(db, {
        sourceItemId: first.id,
        adapterKind: first.adapterKind,
        externalId: first.externalId,
        observedAt: 1,
        snapshot: { description: "Old first body" }
      });
      recordSourceSnapshot(db, {
        sourceItemId: first.id,
        adapterKind: first.adapterKind,
        externalId: first.externalId,
        observedAt: 3,
        snapshot: { description: "Latest first body" }
      });
      recordSourceSnapshot(db, {
        sourceItemId: second.id,
        adapterKind: second.adapterKind,
        externalId: second.externalId,
        observedAt: 2,
        snapshot: { body: "Second body" }
      });

      const context = buildIterationSourceContext(db, "goal-source-context");

      expect(context?.sourceItems).toHaveLength(2);
      expect(context?.sourceItems?.[0]).toMatchObject({
        sourceItem: { externalKey: "NGX-290" },
        body: "Latest first body"
      });
      expect(context?.sourceItems?.[1]).toMatchObject({
        sourceItem: { externalKey: "NGX-291" },
        body: "Second body"
      });
    } finally {
      db.close();
    }
  });
});
