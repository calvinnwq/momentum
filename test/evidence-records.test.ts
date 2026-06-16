import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb } from "../src/adapters/db.js";
import {
  getEvidenceRecordById,
  getEvidenceRecordByIngestKey,
  ingestEvidenceRecord,
  listEvidenceRecords,
  listLatestEvidenceRecordsForGoal,
  summarizeEvidenceRecords,
  type EvidenceRecordIngestInput
} from "../src/core/evidence/records.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-evidence-records-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function baseInput(
  overrides: Partial<EvidenceRecordIngestInput> = {}
): EvidenceRecordIngestInput {
  return {
    source: "agent-workflow",
    type: "plan_created",
    formatVersion: 1,
    artifactPath: "/tmp/.agent-workflows/cwfp-test/plan.json",
    externalId: "cwfp-test",
    occurredAt: 2000,
    summary: "Plan created for NGX-test",
    metadata: { mode: "execute-ready" },
    ingestKey: "agent-workflow:cwfp-test:plan_created",
    ...overrides
  };
}

function insertGoal(db: ReturnType<typeof openDb>, id: string): void {
  db.prepare(
    `INSERT INTO goals
       (id, title, branch, artifact_dir, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, `Goal ${id}`, `momentum/${id}`, `/tmp/${id}`, 1, 1);
}

function insertSourceItem(
  db: ReturnType<typeof openDb>,
  id: string,
  externalKey = id
): void {
  db.prepare(
    `INSERT INTO source_items
       (id, adapter_kind, external_id, external_key, url, title,
        status, metadata_json, last_observed_at, goal_id,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    "linear",
    `ext-${id}`,
    externalKey,
    `https://linear.app/example/issue/${externalKey}`,
    `SourceItem ${id}`,
    "open",
    "{}",
    1,
    null,
    1,
    1
  );
}

describe("evidence record storage", () => {
  it("inserts a new evidence record with normalized fields and explicit created flag", () => {
    const db = openDb(makeTempDir());
    try {
      const result = ingestEvidenceRecord(db, baseInput(), { now: () => 2100 });

      expect(result.created).toBe(true);
      expect(result.record.source).toBe("agent-workflow");
      expect(result.record.type).toBe("plan_created");
      expect(result.record.formatVersion).toBe(1);
      expect(result.record.artifactPath).toBe(
        "/tmp/.agent-workflows/cwfp-test/plan.json"
      );
      expect(result.record.externalId).toBe("cwfp-test");
      expect(result.record.occurredAt).toBe(2000);
      expect(result.record.summary).toBe("Plan created for NGX-test");
      expect(result.record.metadata).toEqual({ mode: "execute-ready" });
      expect(result.record.ingestKey).toBe(
        "agent-workflow:cwfp-test:plan_created"
      );
      expect(result.record.createdAt).toBe(2100);
      expect(result.record.updatedAt).toBe(2100);
      expect(result.record.goalId).toBeNull();
      expect(result.record.sourceItemId).toBeNull();
      expect(result.record.runId).toBeNull();
      expect(result.record.stepId).toBeNull();
      expect(result.record.id).toMatch(/^evidence_record_/);

      expect(getEvidenceRecordById(db, result.record.id)).toEqual(result.record);
      expect(
        getEvidenceRecordByIngestKey(db, result.record.ingestKey)
      ).toEqual(result.record);
    } finally {
      db.close();
    }
  });

  it("stores and reads back typed run/step linkage when provided", () => {
    const db = openDb(makeTempDir());
    try {
      const result = ingestEvidenceRecord(
        db,
        baseInput({ runId: "cwfp-test", stepId: "implementation" }),
        { now: () => 2100 }
      );

      expect(result.created).toBe(true);
      expect(result.record.runId).toBe("cwfp-test");
      expect(result.record.stepId).toBe("implementation");
      expect(getEvidenceRecordById(db, result.record.id)).toEqual(result.record);
    } finally {
      db.close();
    }
  });

  it("links a run without a step when only runId is known", () => {
    const db = openDb(makeTempDir());
    try {
      const result = ingestEvidenceRecord(
        db,
        baseInput({ runId: "cwfp-test" }),
        { now: () => 2100 }
      );

      expect(result.record.runId).toBe("cwfp-test");
      expect(result.record.stepId).toBeNull();
    } finally {
      db.close();
    }
  });

  it("attaches missing run/step linkage on idempotent replay without rebinding existing linkage", () => {
    const db = openDb(makeTempDir());
    try {
      const first = ingestEvidenceRecord(db, baseInput(), { now: () => 2100 });
      expect(first.record.runId).toBeNull();
      expect(first.record.stepId).toBeNull();

      const linked = ingestEvidenceRecord(
        db,
        baseInput({ runId: "cwfp-test", stepId: "implementation" }),
        { now: () => 2200 }
      );

      expect(linked.created).toBe(false);
      expect(linked.record.id).toBe(first.record.id);
      expect(linked.record.runId).toBe("cwfp-test");
      expect(linked.record.stepId).toBe("implementation");
      expect(linked.record.updatedAt).toBe(2200);

      const rebound = ingestEvidenceRecord(
        db,
        baseInput({ runId: "cwfp-other", stepId: "no-mistakes" }),
        { now: () => 2300 }
      );

      expect(rebound.created).toBe(false);
      expect(rebound.record.runId).toBe("cwfp-test");
      expect(rebound.record.stepId).toBe("implementation");
      expect(rebound.record.updatedAt).toBe(2200);
    } finally {
      db.close();
    }
  });

  it("is idempotent on repeated ingestion of the same ingest key without mutating the existing record", () => {
    const db = openDb(makeTempDir());
    try {
      const first = ingestEvidenceRecord(db, baseInput(), { now: () => 2100 });
      const second = ingestEvidenceRecord(
        db,
        baseInput({
          summary: "Different summary on replay",
          metadata: { mode: "execute-ready", replay: true },
          occurredAt: 3000
        }),
        { now: () => 3300 }
      );

      expect(second.created).toBe(false);
      expect(second.record).toEqual(first.record);
      expect(listEvidenceRecords(db)).toEqual([first.record]);
    } finally {
      db.close();
    }
  });

  it("attaches missing goal and source-item links on idempotent replay without rebinding existing links", () => {
    const db = openDb(makeTempDir());
    try {
      insertGoal(db, "goal-linked");
      insertGoal(db, "goal-other");
      insertSourceItem(db, "si-linked");
      insertSourceItem(db, "si-other");

      const first = ingestEvidenceRecord(db, baseInput(), { now: () => 2100 });
      expect(first.record.goalId).toBeNull();
      expect(first.record.sourceItemId).toBeNull();

      const linked = ingestEvidenceRecord(
        db,
        baseInput({
          goalId: "goal-linked",
          sourceItemId: "si-linked"
        }),
        { now: () => 2200 }
      );

      expect(linked.created).toBe(false);
      expect(linked.record.id).toBe(first.record.id);
      expect(linked.record.goalId).toBe("goal-linked");
      expect(linked.record.sourceItemId).toBe("si-linked");
      expect(linked.record.updatedAt).toBe(2200);

      const rebound = ingestEvidenceRecord(
        db,
        baseInput({
          goalId: "goal-other",
          sourceItemId: "si-other"
        }),
        { now: () => 2300 }
      );

      expect(rebound.created).toBe(false);
      expect(rebound.record.goalId).toBe("goal-linked");
      expect(rebound.record.sourceItemId).toBe("si-linked");
      expect(rebound.record.updatedAt).toBe(2200);
    } finally {
      db.close();
    }
  });

  it("allows distinct ingest keys for separate events from the same workflow", () => {
    const db = openDb(makeTempDir());
    try {
      const plan = ingestEvidenceRecord(
        db,
        baseInput({
          ingestKey: "agent-workflow:cwfp-test:plan_created",
          type: "plan_created",
          occurredAt: 2000
        }),
        { now: () => 2100 }
      );
      const impl = ingestEvidenceRecord(
        db,
        baseInput({
          ingestKey: "agent-workflow:cwfp-test:implementation_complete",
          type: "implementation_complete",
          summary: "Implementation complete",
          occurredAt: 2500
        }),
        { now: () => 2600 }
      );

      expect(plan.created).toBe(true);
      expect(impl.created).toBe(true);
      expect(impl.record.id).not.toBe(plan.record.id);
      const all = listEvidenceRecords(db);
      expect(all).toHaveLength(2);
      expect(all[0]?.id).toBe(plan.record.id);
      expect(all[1]?.id).toBe(impl.record.id);
    } finally {
      db.close();
    }
  });

  it("links evidence to a goal when provided and filters listings by goal", () => {
    const db = openDb(makeTempDir());
    try {
      insertGoal(db, "goal-a");
      insertGoal(db, "goal-b");

      const linked = ingestEvidenceRecord(
        db,
        baseInput({
          ingestKey: "agent-workflow:cwfp-a:plan_created",
          externalId: "cwfp-a",
          goalId: "goal-a"
        }),
        { now: () => 2100 }
      );
      const otherGoal = ingestEvidenceRecord(
        db,
        baseInput({
          ingestKey: "agent-workflow:cwfp-b:plan_created",
          externalId: "cwfp-b",
          goalId: "goal-b"
        }),
        { now: () => 2200 }
      );
      const unlinked = ingestEvidenceRecord(
        db,
        baseInput({
          ingestKey: "agent-workflow:cwfp-c:plan_created",
          externalId: "cwfp-c"
        }),
        { now: () => 2300 }
      );

      expect(listEvidenceRecords(db, { goalId: "goal-a" })).toEqual([
        linked.record
      ]);
      expect(listEvidenceRecords(db, { goalId: null })).toEqual([
        unlinked.record
      ]);
      expect(listEvidenceRecords(db)).toHaveLength(3);
      expect(otherGoal.record.goalId).toBe("goal-b");
    } finally {
      db.close();
    }
  });

  it("orders evidence by occurred_at ascending for normal listing and descending for latest-for-goal", () => {
    const db = openDb(makeTempDir());
    try {
      insertGoal(db, "goal-order");
      const oldest = ingestEvidenceRecord(
        db,
        baseInput({
          ingestKey: "agent-workflow:cwfp-order:plan_created",
          type: "plan_created",
          occurredAt: 1000,
          goalId: "goal-order"
        }),
        { now: () => 1100 }
      );
      const middle = ingestEvidenceRecord(
        db,
        baseInput({
          ingestKey: "agent-workflow:cwfp-order:implementation_complete",
          type: "implementation_complete",
          occurredAt: 2000,
          goalId: "goal-order"
        }),
        { now: () => 2100 }
      );
      const newest = ingestEvidenceRecord(
        db,
        baseInput({
          ingestKey: "agent-workflow:cwfp-order:merge_complete",
          type: "merge_complete",
          occurredAt: 3000,
          goalId: "goal-order"
        }),
        { now: () => 3100 }
      );

      expect(
        listEvidenceRecords(db, { goalId: "goal-order" }).map((r) => r.id)
      ).toEqual([oldest.record.id, middle.record.id, newest.record.id]);

      const latest = listLatestEvidenceRecordsForGoal(db, "goal-order", 2);
      expect(latest.map((r) => r.id)).toEqual([
        newest.record.id,
        middle.record.id
      ]);
    } finally {
      db.close();
    }
  });

  it("filters by source and type", () => {
    const db = openDb(makeTempDir());
    try {
      ingestEvidenceRecord(
        db,
        baseInput({
          ingestKey: "agent-workflow:cwfp-x:plan_created",
          source: "agent-workflow",
          type: "plan_created"
        }),
        { now: () => 1 }
      );
      ingestEvidenceRecord(
        db,
        baseInput({
          ingestKey: "agent-workflow:cwfp-x:verification_passed",
          source: "agent-workflow",
          type: "verification_passed",
          occurredAt: 4000,
          summary: "verification passed"
        }),
        { now: () => 2 }
      );
      ingestEvidenceRecord(
        db,
        baseInput({
          ingestKey: "manual:note-1:note",
          source: "manual",
          type: "note",
          occurredAt: 5000,
          summary: "manual note"
        }),
        { now: () => 3 }
      );

      expect(listEvidenceRecords(db, { source: "manual" })).toHaveLength(1);
      expect(
        listEvidenceRecords(db, { type: "verification_passed" })
      ).toHaveLength(1);
      expect(
        listEvidenceRecords(db, { source: "agent-workflow", type: "plan_created" })
      ).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("rejects empty source/type/summary/ingestKey, non-integer occurredAt, and invalid formatVersion", () => {
    const db = openDb(makeTempDir());
    try {
      expect(() =>
        ingestEvidenceRecord(db, baseInput({ source: "" }))
      ).toThrowError(/source/);
      expect(() =>
        ingestEvidenceRecord(db, baseInput({ type: "" }))
      ).toThrowError(/type/);
      expect(() =>
        ingestEvidenceRecord(db, baseInput({ summary: "" }))
      ).toThrowError(/summary/);
      expect(() =>
        ingestEvidenceRecord(db, baseInput({ ingestKey: "" }))
      ).toThrowError(/ingestKey/);
      expect(() =>
        ingestEvidenceRecord(db, baseInput({ occurredAt: 1.5 }))
      ).toThrowError(/occurredAt/);
      expect(() =>
        ingestEvidenceRecord(db, baseInput({ formatVersion: 0 }))
      ).toThrowError(/formatVersion/);
    } finally {
      db.close();
    }
  });

  it("returns null for unknown id/ingest key lookups", () => {
    const db = openDb(makeTempDir());
    try {
      expect(getEvidenceRecordById(db, "evidence_record_missing")).toBeNull();
      expect(getEvidenceRecordByIngestKey(db, "missing-key")).toBeNull();
    } finally {
      db.close();
    }
  });

  describe("summarizeEvidenceRecords", () => {
    it("returns zero counts and null last record for an empty database", () => {
      const db = openDb(makeTempDir());
      try {
        const summary = summarizeEvidenceRecords(db);
        expect(summary).toEqual({
          totalRecords: 0,
          goalLinkedRecords: 0,
          sourceItemLinkedRecords: 0,
          lastRecord: null
        });
      } finally {
        db.close();
      }
    });

    it("counts goal and source-item linkage independently and picks the newest record", () => {
      const db = openDb(makeTempDir());
      try {
        insertGoal(db, "goal-sum-a");
        insertSourceItem(db, "si-sum-a");

        ingestEvidenceRecord(
          db,
          baseInput({
            ingestKey: "agent-workflow:cwfp-sum-1:plan_created",
            externalId: "cwfp-sum-1",
            type: "plan_created",
            occurredAt: 1000
          }),
          { now: () => 1100 }
        );
        ingestEvidenceRecord(
          db,
          baseInput({
            ingestKey: "agent-workflow:cwfp-sum-2:implementation_complete",
            externalId: "cwfp-sum-2",
            type: "implementation_complete",
            summary: "Implementation complete",
            occurredAt: 2000,
            goalId: "goal-sum-a"
          }),
          { now: () => 2100 }
        );
        const newest = ingestEvidenceRecord(
          db,
          baseInput({
            ingestKey: "agent-workflow:cwfp-sum-3:merge_complete",
            externalId: "cwfp-sum-3",
            type: "merge_complete",
            summary: "Merge complete",
            occurredAt: 3000,
            goalId: "goal-sum-a",
            sourceItemId: "si-sum-a"
          }),
          { now: () => 3100 }
        );

        const summary = summarizeEvidenceRecords(db);
        expect(summary.totalRecords).toBe(3);
        expect(summary.goalLinkedRecords).toBe(2);
        expect(summary.sourceItemLinkedRecords).toBe(1);
        expect(summary.lastRecord?.id).toBe(newest.record.id);
        expect(summary.lastRecord?.type).toBe("merge_complete");
        expect(summary.lastRecord?.goalId).toBe("goal-sum-a");
        expect(summary.lastRecord?.sourceItemId).toBe("si-sum-a");
      } finally {
        db.close();
      }
    });
  });
});
