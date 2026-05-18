import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/db.js";
import {
  DEFAULT_VERIFICATION_EVIDENCE_TYPES,
  evaluateGoalForSourceSatisfiedIntent
} from "../src/update-intent-generator.js";
import {
  getUpdateIntentById,
  listUpdateIntents
} from "../src/update-intents.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-intent-generator-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function insertGoal(
  db: MomentumDb,
  id: string,
  state: string = "completed",
  needsManualRecovery = 0
): void {
  db.prepare(
    `INSERT INTO goals
       (id, title, branch, artifact_dir, state, current_iteration,
        needs_manual_recovery, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    `Goal ${id}`,
    `momentum/${id}`,
    `/tmp/${id}`,
    state,
    1,
    needsManualRecovery,
    1,
    1
  );
}

type SourceItemSeed = {
  id: string;
  goalId?: string | null;
  status?: string | null;
  adapterKind?: string;
  externalId?: string;
};

function insertSourceItem(db: MomentumDb, seed: SourceItemSeed): void {
  db.prepare(
    `INSERT INTO source_items
       (id, adapter_kind, external_id, external_key, url, title,
        status, metadata_json, last_observed_at, goal_id,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    seed.id,
    seed.adapterKind ?? "linear",
    seed.externalId ?? `ext-${seed.id}`,
    seed.id.toUpperCase(),
    `https://linear.app/example/issue/${seed.id}`,
    `SourceItem ${seed.id}`,
    seed.status ?? "in_progress",
    "{}",
    1,
    seed.goalId ?? null,
    1,
    1
  );
}

function insertEvidenceRecord(
  db: MomentumDb,
  id: string,
  type: string,
  goalId: string | null,
  occurredAt = 1000
): void {
  db.prepare(
    `INSERT INTO evidence_records
       (id, source, type, format_version, artifact_path, external_id,
        occurred_at, summary, metadata_json, goal_id, source_item_id,
        ingest_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    "agent-workflow",
    type,
    1,
    null,
    null,
    occurredAt,
    `${type} for ${goalId ?? "(no goal)"}`,
    "{}",
    goalId,
    null,
    `ingest:${id}`,
    occurredAt,
    occurredAt
  );
}

describe("evaluateGoalForSourceSatisfiedIntent", () => {
  it("creates one source_satisfied intent for a completed Goal with verification evidence and a linked open source item", () => {
    const db = openDb(makeTempDir());
    try {
      insertGoal(db, "goal-1", "completed");
      insertSourceItem(db, {
        id: "si-1",
        goalId: "goal-1",
        status: "in_progress",
        adapterKind: "linear",
        externalId: "NGX-1"
      });
      insertEvidenceRecord(db, "ev-1", "no_mistakes_complete", "goal-1", 1000);

      const result = evaluateGoalForSourceSatisfiedIntent(
        db,
        { goalId: "goal-1" },
        { now: () => 5000 }
      );

      expect(result.outcome).toBe("intent_created");
      if (result.outcome !== "intent_created") return;

      expect(result.intent.adapterKind).toBe("linear");
      expect(result.intent.targetExternalId).toBe("NGX-1");
      expect(result.intent.intentType).toBe("source_satisfied");
      expect(result.intent.status).toBe("pending");
      expect(result.intent.goalId).toBe("goal-1");
      expect(result.intent.sourceItemId).toBe("si-1");
      expect(result.intent.evidenceRecordId).toBe("ev-1");
      expect(result.intent.reason).toContain("completed");
      expect(result.intent.reason).toContain("verification evidence");
      expect(result.intent.idempotencyKey).toBe(
        "linear:NGX-1:source_satisfied:goal-1"
      );
      expect(result.intent.payload).toMatchObject({
        evidenceType: "no_mistakes_complete",
        goalState: "completed"
      });
      expect(result.sourceItem.id).toBe("si-1");
      expect(result.verificationEvidence.id).toBe("ev-1");

      expect(listUpdateIntents(db).map((i) => i.id)).toEqual([
        result.intent.id
      ]);
    } finally {
      db.close();
    }
  });

  it("is idempotent across repeated evaluations: replay returns the same intent and does not create duplicates", () => {
    const db = openDb(makeTempDir());
    try {
      insertGoal(db, "goal-1", "completed");
      insertSourceItem(db, {
        id: "si-1",
        goalId: "goal-1",
        status: "in_progress",
        adapterKind: "linear",
        externalId: "NGX-1"
      });
      insertEvidenceRecord(db, "ev-1", "no_mistakes_complete", "goal-1", 1000);

      const first = evaluateGoalForSourceSatisfiedIntent(
        db,
        { goalId: "goal-1" },
        { now: () => 1000 }
      );
      expect(first.outcome).toBe("intent_created");
      if (first.outcome !== "intent_created") return;

      // Add additional verification evidence; the intent should not duplicate.
      insertEvidenceRecord(db, "ev-2", "verification_passed", "goal-1", 2000);

      const replay = evaluateGoalForSourceSatisfiedIntent(
        db,
        { goalId: "goal-1" },
        { now: () => 5000 }
      );
      expect(replay.outcome).toBe("intent_replayed");
      if (replay.outcome !== "intent_replayed") return;
      expect(replay.intent.id).toBe(first.intent.id);
      expect(replay.intent.createdAt).toBe(1000);

      expect(listUpdateIntents(db).map((i) => i.id)).toEqual([first.intent.id]);
      expect(getUpdateIntentById(db, first.intent.id)?.updatedAt).toBe(1000);
    } finally {
      db.close();
    }
  });

  it("returns evidence_insufficient when a completed Goal is linked to a source item but has no verification evidence", () => {
    const db = openDb(makeTempDir());
    try {
      insertGoal(db, "goal-2", "completed");
      insertSourceItem(db, {
        id: "si-2",
        goalId: "goal-2",
        status: "in_progress",
        adapterKind: "linear",
        externalId: "NGX-2"
      });
      // Insert a non-verification evidence type so we know the predicate is strict.
      insertEvidenceRecord(db, "ev-noise", "plan_created", "goal-2", 500);

      const result = evaluateGoalForSourceSatisfiedIntent(
        db,
        { goalId: "goal-2" },
        { now: () => 5000 }
      );

      expect(result.outcome).toBe("evidence_insufficient");
      if (result.outcome !== "evidence_insufficient") return;
      expect(result.warning.goalId).toBe("goal-2");
      expect(result.warning.sourceItemId).toBe("si-2");
      expect(result.warning.sourceExternalId).toBe("NGX-2");
      expect(result.warning.acceptedEvidenceTypes).toEqual(
        DEFAULT_VERIFICATION_EVIDENCE_TYPES
      );
      expect(result.warning.reason).toMatch(/verification evidence/i);

      // No intent created.
      expect(listUpdateIntents(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("returns goal_not_terminal when the goal is still queued/running", () => {
    const db = openDb(makeTempDir());
    try {
      insertGoal(db, "goal-3", "queued");
      insertSourceItem(db, {
        id: "si-3",
        goalId: "goal-3",
        status: "in_progress",
        adapterKind: "linear",
        externalId: "NGX-3"
      });
      insertEvidenceRecord(db, "ev-3", "no_mistakes_complete", "goal-3", 1000);

      const result = evaluateGoalForSourceSatisfiedIntent(
        db,
        { goalId: "goal-3" }
      );
      expect(result.outcome).toBe("goal_not_terminal");
      if (result.outcome !== "goal_not_terminal") return;
      expect(result.goalState).toBe("queued");
      expect(listUpdateIntents(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("returns goal_state_not_completed for failed / max_iterations_reached terminal states", () => {
    const db = openDb(makeTempDir());
    try {
      insertGoal(db, "goal-failed", "failed");
      insertSourceItem(db, {
        id: "si-failed",
        goalId: "goal-failed",
        status: "in_progress",
        adapterKind: "linear",
        externalId: "NGX-FAIL"
      });
      insertEvidenceRecord(
        db,
        "ev-failed",
        "no_mistakes_complete",
        "goal-failed",
        1000
      );

      const result = evaluateGoalForSourceSatisfiedIntent(db, {
        goalId: "goal-failed"
      });
      expect(result.outcome).toBe("goal_state_not_completed");
      if (result.outcome !== "goal_state_not_completed") return;
      expect(result.goalState).toBe("failed");
      expect(listUpdateIntents(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("returns no_source_link when a completed Goal has no linked SourceItem", () => {
    const db = openDb(makeTempDir());
    try {
      insertGoal(db, "goal-4", "completed");
      insertEvidenceRecord(db, "ev-4", "no_mistakes_complete", "goal-4", 1000);

      const result = evaluateGoalForSourceSatisfiedIntent(db, {
        goalId: "goal-4"
      });
      expect(result.outcome).toBe("no_source_link");
      if (result.outcome !== "no_source_link") return;
      expect(result.goalId).toBe("goal-4");
      expect(listUpdateIntents(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("returns source_already_terminal when the linked source item is already closed/done", () => {
    const db = openDb(makeTempDir());
    try {
      insertGoal(db, "goal-5", "completed");
      insertSourceItem(db, {
        id: "si-5",
        goalId: "goal-5",
        status: "Done",
        adapterKind: "linear",
        externalId: "NGX-5"
      });
      insertEvidenceRecord(db, "ev-5", "no_mistakes_complete", "goal-5", 1000);

      const result = evaluateGoalForSourceSatisfiedIntent(db, {
        goalId: "goal-5"
      });
      expect(result.outcome).toBe("source_already_terminal");
      if (result.outcome !== "source_already_terminal") return;
      expect(result.sourceItem.id).toBe("si-5");
      expect(result.sourceItem.status).toBe("Done");
      expect(listUpdateIntents(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("returns goal_not_found for unknown goal ids", () => {
    const db = openDb(makeTempDir());
    try {
      const result = evaluateGoalForSourceSatisfiedIntent(db, {
        goalId: "goal-missing"
      });
      expect(result.outcome).toBe("goal_not_found");
      if (result.outcome !== "goal_not_found") return;
      expect(result.goalId).toBe("goal-missing");
    } finally {
      db.close();
    }
  });

  it("honors an overridden verificationEvidenceTypes set", () => {
    const db = openDb(makeTempDir());
    try {
      insertGoal(db, "goal-6", "completed");
      insertSourceItem(db, {
        id: "si-6",
        goalId: "goal-6",
        status: "in_progress",
        adapterKind: "linear",
        externalId: "NGX-6"
      });
      // The default predicate would treat plan_created as non-verification,
      // but we override the accepted set to include it.
      insertEvidenceRecord(db, "ev-6", "plan_created", "goal-6", 1000);

      const result = evaluateGoalForSourceSatisfiedIntent(
        db,
        {
          goalId: "goal-6",
          verificationEvidenceTypes: ["plan_created"]
        },
        { now: () => 1000 }
      );
      expect(result.outcome).toBe("intent_created");
      if (result.outcome !== "intent_created") return;
      expect(result.verificationEvidence.id).toBe("ev-6");
    } finally {
      db.close();
    }
  });

  it("rejects an empty goalId before doing any database work", () => {
    const db = openDb(makeTempDir());
    try {
      expect(() =>
        evaluateGoalForSourceSatisfiedIntent(db, { goalId: "" })
      ).toThrowError(/goalId/);
    } finally {
      db.close();
    }
  });

  it("rejects an empty verificationEvidenceTypes override", () => {
    const db = openDb(makeTempDir());
    try {
      insertGoal(db, "goal-7", "completed");
      insertSourceItem(db, {
        id: "si-7",
        goalId: "goal-7",
        adapterKind: "linear",
        externalId: "NGX-7"
      });
      expect(() =>
        evaluateGoalForSourceSatisfiedIntent(db, {
          goalId: "goal-7",
          verificationEvidenceTypes: []
        })
      ).toThrowError(/verificationEvidenceTypes/);
    } finally {
      db.close();
    }
  });
});
