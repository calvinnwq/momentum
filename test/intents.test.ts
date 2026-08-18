import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import {
  cancelIntent,
  createIntent,
  getIntentById,
  getIntentByIdempotencyKey,
  listIntents,
  markIntentApplied,
  markIntentSkipped,
  type CreateIntentInput,
} from "../src/core/intent/intents.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-intents-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function baseInput(
  overrides: Partial<CreateIntentInput> = {},
): CreateIntentInput {
  return {
    adapterKind: "linear",
    targetExternalId: "NGX-test",
    intentType: "source_satisfied",
    payload: { status: "Done", note: "verified" },
    reason: "Goal completed with verification evidence.",
    idempotencyKey: "linear:NGX-test:source_satisfied:goal-test:evidence-test",
    ...overrides,
  };
}

function insertGoal(db: MomentumDb, id: string): void {
  db.prepare(
    `INSERT INTO goals
       (id, title, branch, artifact_dir, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, `Goal ${id}`, `momentum/${id}`, `/tmp/${id}`, 1, 1);
}

function insertTrackerItem(db: MomentumDb, id: string): void {
  db.prepare(
    `INSERT INTO tracker_items
       (id, adapter_kind, external_id, external_key, url, title,
        status, metadata_json, last_observed_at, goal_id,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    "linear",
    `ext-${id}`,
    id,
    `https://linear.app/example/issue/${id}`,
    `TrackerItem ${id}`,
    "open",
    "{}",
    1,
    null,
    1,
    1,
  );
}

function insertEvidenceRecord(db: MomentumDb, id: string): void {
  db.prepare(
    `INSERT INTO evidence_records
       (id, source, type, format_version, artifact_path, external_id,
        occurred_at, summary, metadata_json, goal_id, tracker_item_id,
        ingest_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    "agent-workflow",
    "verification_passed",
    1,
    null,
    null,
    1000,
    "verification passed",
    "{}",
    null,
    null,
    `ingest:${id}`,
    1,
    1,
  );
}

describe("intent storage", () => {
  it("creates a pending intent with normalized fields and explicit created flag", () => {
    const db = openDb(makeTempDir());
    try {
      const result = createIntent(db, baseInput(), { now: () => 5000 });

      expect(result.created).toBe(true);
      expect(result.intent.adapterKind).toBe("linear");
      expect(result.intent.targetExternalId).toBe("NGX-test");
      expect(result.intent.intentType).toBe("source_satisfied");
      expect(result.intent.payload).toEqual({
        status: "Done",
        note: "verified",
      });
      expect(result.intent.reason).toBe(
        "Goal completed with verification evidence.",
      );
      expect(result.intent.status).toBe("pending");
      expect(result.intent.idempotencyKey).toBe(
        "linear:NGX-test:source_satisfied:goal-test:evidence-test",
      );
      expect(result.intent.decisionReason).toBeNull();
      expect(result.intent.errorCode).toBeNull();
      expect(result.intent.errorMessage).toBeNull();
      expect(result.intent.appliedAt).toBeNull();
      expect(result.intent.skippedAt).toBeNull();
      expect(result.intent.canceledAt).toBeNull();
      expect(result.intent.goalId).toBeNull();
      expect(result.intent.trackerItemId).toBeNull();
      expect(result.intent.evidenceRecordId).toBeNull();
      expect(result.intent.createdAt).toBe(5000);
      expect(result.intent.updatedAt).toBe(5000);
      expect(result.intent.id).toMatch(/^intent_/);

      expect(getIntentById(db, result.intent.id)).toEqual(result.intent);
      expect(
        getIntentByIdempotencyKey(db, result.intent.idempotencyKey),
      ).toEqual(result.intent);
    } finally {
      db.close();
    }
  });

  it("links optional goal/tracker-item/evidence ids and round-trips empty payload as {}", () => {
    const db = openDb(makeTempDir());
    try {
      insertGoal(db, "goal-A");
      insertTrackerItem(db, "si-A");
      insertEvidenceRecord(db, "evidence_record_A");

      const input = baseInput({
        goalId: "goal-A",
        trackerItemId: "si-A",
        evidenceRecordId: "evidence_record_A",
      });
      delete input.payload;
      const result = createIntent(db, input, { now: () => 1234 });

      expect(result.intent.payload).toEqual({});
      expect(result.intent.goalId).toBe("goal-A");
      expect(result.intent.trackerItemId).toBe("si-A");
      expect(result.intent.evidenceRecordId).toBe("evidence_record_A");
    } finally {
      db.close();
    }
  });

  it("is idempotent on repeated create with the same idempotency key and does not mutate the existing row", () => {
    const db = openDb(makeTempDir());
    try {
      const first = createIntent(db, baseInput(), { now: () => 5000 });
      const replay = createIntent(
        db,
        baseInput({
          reason: "Different reason on replay",
          payload: { status: "Done", note: "different" },
        }),
        { now: () => 6000 },
      );

      expect(replay.created).toBe(false);
      expect(replay.intent).toEqual(first.intent);
      expect(listIntents(db)).toEqual([first.intent]);
    } finally {
      db.close();
    }
  });

  it("rejects empty adapterKind/intentType/reason/idempotencyKey", () => {
    const db = openDb(makeTempDir());
    try {
      expect(() =>
        createIntent(db, baseInput({ adapterKind: "" })),
      ).toThrowError(/adapterKind/);
      expect(() =>
        createIntent(db, baseInput({ intentType: "" })),
      ).toThrowError(/intentType/);
      expect(() => createIntent(db, baseInput({ reason: "" }))).toThrowError(
        /reason/,
      );
      expect(() =>
        createIntent(db, baseInput({ idempotencyKey: "" })),
      ).toThrowError(/idempotencyKey/);
    } finally {
      db.close();
    }
  });

  it("returns null for unknown id/idempotency-key lookups", () => {
    const db = openDb(makeTempDir());
    try {
      expect(getIntentById(db, "intent_missing")).toBeNull();
      expect(getIntentByIdempotencyKey(db, "missing-key")).toBeNull();
    } finally {
      db.close();
    }
  });

  describe("listIntents", () => {
    it("orders by created_at ASC and filters by status/goal/tracker-item/adapter/intent_type", () => {
      const db = openDb(makeTempDir());
      try {
        insertGoal(db, "goal-x");
        insertGoal(db, "goal-y");
        insertTrackerItem(db, "si-x");
        insertTrackerItem(db, "si-y");

        const a = createIntent(
          db,
          baseInput({
            idempotencyKey: "k-a",
            targetExternalId: "NGX-A",
            intentType: "source_satisfied",
            goalId: "goal-x",
            trackerItemId: "si-x",
          }),
          { now: () => 100 },
        );
        const b = createIntent(
          db,
          baseInput({
            idempotencyKey: "k-b",
            targetExternalId: "NGX-B",
            intentType: "comment_requested",
            goalId: "goal-y",
            trackerItemId: "si-y",
          }),
          { now: () => 200 },
        );
        const c = createIntent(
          db,
          baseInput({
            idempotencyKey: "k-c",
            adapterKind: "github",
            targetExternalId: "pr-1",
            intentType: "source_satisfied",
            goalId: null,
            trackerItemId: null,
          }),
          { now: () => 300 },
        );

        expect(listIntents(db).map((i) => i.id)).toEqual([
          a.intent.id,
          b.intent.id,
          c.intent.id,
        ]);
        expect(
          listIntents(db, { adapterKind: "linear" }).map((i) => i.id),
        ).toEqual([a.intent.id, b.intent.id]);
        expect(
          listIntents(db, { intentType: "source_satisfied" }).map((i) => i.id),
        ).toEqual([a.intent.id, c.intent.id]);
        expect(listIntents(db, { goalId: "goal-x" }).map((i) => i.id)).toEqual([
          a.intent.id,
        ]);
        expect(listIntents(db, { goalId: null }).map((i) => i.id)).toEqual([
          c.intent.id,
        ]);
        expect(
          listIntents(db, { trackerItemId: "si-y" }).map((i) => i.id),
        ).toEqual([b.intent.id]);
        expect(listIntents(db, { status: "pending" }).map((i) => i.id)).toEqual(
          [a.intent.id, b.intent.id, c.intent.id],
        );
        expect(listIntents(db, { status: "applied" }).map((i) => i.id)).toEqual(
          [],
        );
        expect(listIntents(db, { limit: 2 }).map((i) => i.id)).toEqual([
          a.intent.id,
          b.intent.id,
        ]);
      } finally {
        db.close();
      }
    });

    it("filters by evidence_record_id including the null-link case", () => {
      const db = openDb(makeTempDir());
      try {
        insertEvidenceRecord(db, "evidence_record_link");
        const linked = createIntent(
          db,
          baseInput({
            idempotencyKey: "with-evidence",
            evidenceRecordId: "evidence_record_link",
          }),
          { now: () => 10 },
        );
        const unlinked = createIntent(
          db,
          baseInput({
            idempotencyKey: "without-evidence",
            evidenceRecordId: null,
          }),
          { now: () => 20 },
        );

        expect(
          listIntents(db, {
            evidenceRecordId: "evidence_record_link",
          }).map((i) => i.id),
        ).toEqual([linked.intent.id]);
        expect(
          listIntents(db, { evidenceRecordId: null }).map((i) => i.id),
        ).toEqual([unlinked.intent.id]);
      } finally {
        db.close();
      }
    });
  });

  describe("transitions", () => {
    it("marks a pending intent applied with a required decisionReason and stamps applied_at only", () => {
      const db = openDb(makeTempDir());
      try {
        const created = createIntent(db, baseInput(), {
          now: () => 1000,
        });
        const result = markIntentApplied(db, {
          intentId: created.intent.id,
          decisionReason: "Already updated upstream by hand.",
          now: 2000,
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.previousStatus).toBe("pending");
        expect(result.intent.status).toBe("applied");
        expect(result.intent.decisionReason).toBe(
          "Already updated upstream by hand.",
        );
        expect(result.intent.appliedAt).toBe(2000);
        expect(result.intent.skippedAt).toBeNull();
        expect(result.intent.canceledAt).toBeNull();
        expect(result.intent.updatedAt).toBe(2000);
        expect(result.intent.createdAt).toBe(1000);
      } finally {
        db.close();
      }
    });

    it("marks a pending intent skipped with skipped_at only", () => {
      const db = openDb(makeTempDir());
      try {
        const created = createIntent(db, baseInput(), {
          now: () => 1000,
        });
        const result = markIntentSkipped(db, {
          intentId: created.intent.id,
          decisionReason: "Source already closed by reviewer.",
          now: 3000,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.intent.status).toBe("skipped");
        expect(result.intent.skippedAt).toBe(3000);
        expect(result.intent.appliedAt).toBeNull();
        expect(result.intent.canceledAt).toBeNull();
      } finally {
        db.close();
      }
    });

    it("cancels a pending intent with canceled_at only", () => {
      const db = openDb(makeTempDir());
      try {
        const created = createIntent(db, baseInput(), {
          now: () => 1000,
        });
        const result = cancelIntent(db, {
          intentId: created.intent.id,
          decisionReason: "Goal canceled; intent no longer relevant.",
          now: 4000,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.intent.status).toBe("canceled");
        expect(result.intent.canceledAt).toBe(4000);
        expect(result.intent.appliedAt).toBeNull();
        expect(result.intent.skippedAt).toBeNull();
      } finally {
        db.close();
      }
    });

    it("refuses to re-transition a terminal intent and preserves the prior decisionReason", () => {
      const db = openDb(makeTempDir());
      try {
        const created = createIntent(db, baseInput(), {
          now: () => 1000,
        });
        const first = markIntentApplied(db, {
          intentId: created.intent.id,
          decisionReason: "Applied out-of-band by operator.",
          now: 2000,
        });
        expect(first.ok).toBe(true);

        const replay = markIntentApplied(db, {
          intentId: created.intent.id,
          decisionReason: "Trying to re-apply",
          now: 5000,
        });
        expect(replay.ok).toBe(false);
        if (replay.ok) return;
        expect(replay.code).toBe("intent_already_terminal");
        expect(replay.currentStatus).toBe("applied");

        const skip = markIntentSkipped(db, {
          intentId: created.intent.id,
          decisionReason: "Trying to skip",
          now: 5500,
        });
        expect(skip.ok).toBe(false);
        if (skip.ok) return;
        expect(skip.code).toBe("intent_already_terminal");

        const cancel = cancelIntent(db, {
          intentId: created.intent.id,
          decisionReason: "Trying to cancel",
          now: 5600,
        });
        expect(cancel.ok).toBe(false);
        if (cancel.ok) return;
        expect(cancel.code).toBe("intent_already_terminal");

        const final = getIntentById(db, created.intent.id);
        expect(final?.status).toBe("applied");
        expect(final?.decisionReason).toBe("Applied out-of-band by operator.");
        expect(final?.appliedAt).toBe(2000);
        expect(final?.updatedAt).toBe(2000);
      } finally {
        db.close();
      }
    });

    it("returns intent_not_found for unknown ids without throwing", () => {
      const db = openDb(makeTempDir());
      try {
        const result = markIntentApplied(db, {
          intentId: "intent_missing",
          decisionReason: "n/a",
          now: 1,
        });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.code).toBe("intent_not_found");
      } finally {
        db.close();
      }
    });

    it("requires a non-empty decisionReason and a finite now", () => {
      const db = openDb(makeTempDir());
      try {
        const created = createIntent(db, baseInput(), {
          now: () => 1000,
        });
        expect(() =>
          markIntentApplied(db, {
            intentId: created.intent.id,
            decisionReason: "",
            now: 1,
          }),
        ).toThrowError(/decisionReason/);
        expect(() =>
          markIntentSkipped(db, {
            intentId: created.intent.id,
            decisionReason: "valid",
            now: Number.POSITIVE_INFINITY,
          }),
        ).toThrowError(/finite/);
      } finally {
        db.close();
      }
    });
  });
});
