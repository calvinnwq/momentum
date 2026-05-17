import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb } from "../src/db.js";
import {
  getEvidenceRecordById,
  getEvidenceRecordByIngestKey,
  ingestEvidenceRecord,
  listEvidenceRecords,
  listLatestEvidenceRecordsForGoal,
  type EvidenceRecordIngestInput
} from "../src/evidence-records.js";

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
      expect(result.record.id).toMatch(/^evidence_record_/);

      expect(getEvidenceRecordById(db, result.record.id)).toEqual(result.record);
      expect(
        getEvidenceRecordByIngestKey(db, result.record.ingestKey)
      ).toEqual(result.record);
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
});
