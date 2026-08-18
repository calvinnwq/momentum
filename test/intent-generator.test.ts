import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import {
  DEFAULT_VERIFICATION_EVIDENCE_TYPES,
  evaluateGoalForTrackerSatisfiedIntents,
} from "../src/core/tracker/intent-generator.js";
import { getIntentById, listIntents } from "../src/core/intent/intents.js";

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
  needsManualRecovery = 0,
): void {
  db.prepare(
    `INSERT INTO goals
       (id, title, branch, artifact_dir, state, current_iteration,
        needs_manual_recovery, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    `Goal ${id}`,
    `momentum/${id}`,
    `/tmp/${id}`,
    state,
    1,
    needsManualRecovery,
    1,
    1,
  );
}

type TrackerItemSeed = {
  id: string;
  goalId?: string | null;
  status?: string | null;
  adapterKind?: string;
  externalId?: string;
};

function insertTrackerItem(db: MomentumDb, seed: TrackerItemSeed): void {
  db.prepare(
    `INSERT INTO tracker_items
       (id, adapter_kind, external_id, external_key, url, title,
        status, metadata_json, last_observed_at, goal_id,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    seed.id,
    seed.adapterKind ?? "linear",
    seed.externalId ?? `ext-${seed.id}`,
    seed.id.toUpperCase(),
    `https://linear.app/example/issue/${seed.id}`,
    `TrackerItem ${seed.id}`,
    seed.status ?? "in_progress",
    "{}",
    1,
    seed.goalId ?? null,
    1,
    1,
  );
}

function insertEvidenceRecord(
  db: MomentumDb,
  id: string,
  type: string,
  goalId: string | null,
  occurredAt = 1000,
  trackerItemId: string | null = null,
): void {
  db.prepare(
    `INSERT INTO evidence_records
       (id, source, type, format_version, artifact_path, external_id,
        occurred_at, summary, metadata_json, goal_id, tracker_item_id,
        ingest_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    trackerItemId,
    `ingest:${id}`,
    occurredAt,
    occurredAt,
  );
}

describe("evaluateGoalForTrackerSatisfiedIntents", () => {
  it("creates one source_satisfied intent for a completed Goal with verification evidence and a linked open tracker item", () => {
    const db = openDb(makeTempDir());
    try {
      insertGoal(db, "goal-1", "completed");
      insertTrackerItem(db, {
        id: "si-1",
        goalId: "goal-1",
        status: "in_progress",
        adapterKind: "linear",
        externalId: "NGX-1",
      });
      insertEvidenceRecord(db, "ev-1", "validate_complete", "goal-1", 1000);

      const result = evaluateGoalForTrackerSatisfiedIntents(
        db,
        { goalId: "goal-1" },
        { now: () => 5000 },
      )[0]!;

      expect(result.outcome).toBe("intent_created");
      if (result.outcome !== "intent_created") return;

      expect(result.intent.adapterKind).toBe("linear");
      expect(result.intent.targetExternalId).toBe("NGX-1");
      expect(result.intent.intentType).toBe("source_satisfied");
      expect(result.intent.status).toBe("pending");
      expect(result.intent.goalId).toBe("goal-1");
      expect(result.intent.trackerItemId).toBe("si-1");
      expect(result.intent.evidenceRecordId).toBe("ev-1");
      expect(result.intent.reason).toContain("completed");
      expect(result.intent.reason).toContain("verification evidence");
      expect(result.intent.idempotencyKey).toBe(
        "linear:NGX-1:source_satisfied:goal-1",
      );
      expect(result.intent.payload).toMatchObject({
        evidenceType: "validate_complete",
        goalState: "completed",
        trackerItemId: "si-1",
        trackerExternalId: "NGX-1",
        trackerExternalKey: "SI-1",
        trackerCurrentStatus: "in_progress",
      });
      expect(result.intent.payload).not.toHaveProperty("sourceExternalId");
      expect(result.intent.payload).not.toHaveProperty("sourceExternalKey");
      expect(result.intent.payload).not.toHaveProperty("sourceCurrentStatus");
      expect(result.trackerItem.id).toBe("si-1");
      expect(result.verificationEvidence.id).toBe("ev-1");

      expect(listIntents(db).map((i) => i.id)).toEqual([result.intent.id]);
    } finally {
      db.close();
    }
  });

  it("is idempotent across repeated evaluations: replay returns the same intent and does not create duplicates", () => {
    const db = openDb(makeTempDir());
    try {
      insertGoal(db, "goal-1", "completed");
      insertTrackerItem(db, {
        id: "si-1",
        goalId: "goal-1",
        status: "in_progress",
        adapterKind: "linear",
        externalId: "NGX-1",
      });
      insertEvidenceRecord(db, "ev-1", "no_mistakes_complete", "goal-1", 1000);

      const first = evaluateGoalForTrackerSatisfiedIntents(
        db,
        { goalId: "goal-1" },
        { now: () => 1000 },
      )[0]!;
      expect(first.outcome).toBe("intent_created");
      if (first.outcome !== "intent_created") return;

      // Add additional verification evidence; the intent should not duplicate.
      insertEvidenceRecord(db, "ev-2", "verification_passed", "goal-1", 2000);

      const replay = evaluateGoalForTrackerSatisfiedIntents(
        db,
        { goalId: "goal-1" },
        { now: () => 5000 },
      )[0]!;
      expect(replay.outcome).toBe("intent_replayed");
      if (replay.outcome !== "intent_replayed") return;
      expect(replay.intent.id).toBe(first.intent.id);
      expect(replay.intent.createdAt).toBe(1000);

      expect(listIntents(db).map((i) => i.id)).toEqual([first.intent.id]);
      expect(getIntentById(db, first.intent.id)?.updatedAt).toBe(1000);
    } finally {
      db.close();
    }
  });

  it("uses verification evidence linked through the tracker item when goal_id is absent", () => {
    const db = openDb(makeTempDir());
    try {
      insertGoal(db, "goal-source-evidence", "completed");
      insertTrackerItem(db, {
        id: "si-source-evidence",
        goalId: "goal-source-evidence",
        status: "in_progress",
        adapterKind: "linear",
        externalId: "NGX-SOURCE-EVIDENCE",
      });
      insertEvidenceRecord(
        db,
        "ev-source-only",
        "verification_passed",
        null,
        1000,
        "si-source-evidence",
      );

      const result = evaluateGoalForTrackerSatisfiedIntents(
        db,
        { goalId: "goal-source-evidence" },
        { now: () => 5000 },
      )[0]!;

      expect(result.outcome).toBe("intent_created");
      if (result.outcome !== "intent_created") return;
      expect(result.verificationEvidence.id).toBe("ev-source-only");
      expect(result.verificationEvidence.goalId).toBeNull();
      expect(result.verificationEvidence.trackerItemId).toBe(
        "si-source-evidence",
      );
      expect(result.intent.evidenceRecordId).toBe("ev-source-only");
      expect(result.intent.trackerItemId).toBe("si-source-evidence");
    } finally {
      db.close();
    }
  });

  it("creates intents for every linked open tracker item and skips terminal tracker items", () => {
    const db = openDb(makeTempDir());
    try {
      insertGoal(db, "goal-multi-source", "completed");
      insertTrackerItem(db, {
        id: "si-closed",
        goalId: "goal-multi-source",
        status: "Done",
        adapterKind: "linear",
        externalId: "NGX-CLOSED",
      });
      insertTrackerItem(db, {
        id: "si-open-a",
        goalId: "goal-multi-source",
        status: "In Progress",
        adapterKind: "linear",
        externalId: "NGX-OPEN-A",
      });
      insertTrackerItem(db, {
        id: "si-open-b",
        goalId: "goal-multi-source",
        status: "Todo",
        adapterKind: "linear",
        externalId: "NGX-OPEN-B",
      });
      insertEvidenceRecord(
        db,
        "ev-goal-wide",
        "no_mistakes_complete",
        "goal-multi-source",
        1000,
      );

      const result = evaluateGoalForTrackerSatisfiedIntents(
        db,
        { goalId: "goal-multi-source" },
        { now: () => 5000 },
      )[0]!;

      expect(result.outcome).toBe("intent_created");
      const intents = listIntents(db).sort((a, b) =>
        (a.targetExternalId ?? "").localeCompare(b.targetExternalId ?? ""),
      );
      expect(intents.map((intent) => intent.targetExternalId)).toEqual([
        "NGX-OPEN-A",
        "NGX-OPEN-B",
      ]);
      expect(intents.map((intent) => intent.trackerItemId)).toEqual([
        "si-open-a",
        "si-open-b",
      ]);
      expect(
        intents.every((intent) => intent.evidenceRecordId === "ev-goal-wide"),
      ).toBe(true);
    } finally {
      db.close();
    }
  });

  it("returns every created or replayed intent from the plural evaluator", () => {
    const db = openDb(makeTempDir());
    try {
      insertGoal(db, "goal-plural", "completed");
      insertTrackerItem(db, {
        id: "si-plural-a",
        goalId: "goal-plural",
        status: "In Progress",
        externalId: "NGX-PLURAL-A",
      });
      insertTrackerItem(db, {
        id: "si-plural-b",
        goalId: "goal-plural",
        status: "Todo",
        externalId: "NGX-PLURAL-B",
      });
      insertEvidenceRecord(
        db,
        "ev-plural",
        "verification_passed",
        "goal-plural",
        1000,
      );

      const first = evaluateGoalForTrackerSatisfiedIntents(
        db,
        { goalId: "goal-plural" },
        { now: () => 5000 },
      );
      expect(first.map((result) => result.outcome)).toEqual([
        "intent_created",
        "intent_created",
      ]);

      const replay = evaluateGoalForTrackerSatisfiedIntents(
        db,
        { goalId: "goal-plural" },
        { now: () => 6000 },
      );
      expect(replay.map((result) => result.outcome)).toEqual([
        "intent_replayed",
        "intent_replayed",
      ]);
      expect(listIntents(db)).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("returns evidence warnings alongside created intents for partially covered tracker items", () => {
    const db = openDb(makeTempDir());
    try {
      insertGoal(db, "goal-partial", "completed");
      insertTrackerItem(db, {
        id: "si-covered",
        goalId: "goal-partial",
        status: "In Progress",
        externalId: "NGX-COVERED",
      });
      insertTrackerItem(db, {
        id: "si-uncovered",
        goalId: "goal-partial",
        status: "Todo",
        externalId: "NGX-UNCOVERED",
      });
      insertEvidenceRecord(
        db,
        "ev-covered",
        "verification_passed",
        null,
        1000,
        "si-covered",
      );

      const results = evaluateGoalForTrackerSatisfiedIntents(
        db,
        { goalId: "goal-partial" },
        { now: () => 5000 },
      );
      expect(results.map((result) => result.outcome)).toEqual([
        "intent_created",
        "evidence_insufficient",
      ]);
      const warning = results.find(
        (result) => result.outcome === "evidence_insufficient",
      );
      expect(warning?.warning.trackerItemId).toBe("si-uncovered");
      expect(listIntents(db)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("returns every evidence warning when no linked tracker item has evidence", () => {
    const db = openDb(makeTempDir());
    try {
      insertGoal(db, "goal-all-uncovered", "completed");
      insertTrackerItem(db, {
        id: "si-uncovered-a",
        goalId: "goal-all-uncovered",
        status: "In Progress",
        externalId: "NGX-UNCOVERED-A",
      });
      insertTrackerItem(db, {
        id: "si-uncovered-b",
        goalId: "goal-all-uncovered",
        status: "Todo",
        externalId: "NGX-UNCOVERED-B",
      });

      const results = evaluateGoalForTrackerSatisfiedIntents(db, {
        goalId: "goal-all-uncovered",
      });

      expect(results.map((result) => result.outcome)).toEqual([
        "evidence_insufficient",
        "evidence_insufficient",
      ]);
      expect(
        results
          .filter((result) => result.outcome === "evidence_insufficient")
          .map((result) => result.warning.trackerItemId),
      ).toEqual(["si-uncovered-a", "si-uncovered-b"]);
      expect(listIntents(db)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("returns evidence_insufficient when a completed Goal is linked to a tracker item but has no verification evidence", () => {
    const db = openDb(makeTempDir());
    try {
      insertGoal(db, "goal-2", "completed");
      insertTrackerItem(db, {
        id: "si-2",
        goalId: "goal-2",
        status: "in_progress",
        adapterKind: "linear",
        externalId: "NGX-2",
      });
      // Insert a non-verification evidence type so we know the predicate is strict.
      insertEvidenceRecord(db, "ev-noise", "plan_created", "goal-2", 500);

      const result = evaluateGoalForTrackerSatisfiedIntents(
        db,
        { goalId: "goal-2" },
        { now: () => 5000 },
      )[0]!;

      expect(result.outcome).toBe("evidence_insufficient");
      if (result.outcome !== "evidence_insufficient") return;
      expect(result.warning.goalId).toBe("goal-2");
      expect(result.warning.trackerItemId).toBe("si-2");
      expect(result.warning.trackerExternalId).toBe("NGX-2");
      expect(result.warning).not.toHaveProperty("sourceExternalId");
      expect(result.warning.acceptedEvidenceTypes).toEqual(
        DEFAULT_VERIFICATION_EVIDENCE_TYPES,
      );
      expect(result.warning.reason).toMatch(/verification evidence/i);

      // No intent created.
      expect(listIntents(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("returns goal_not_terminal when the goal is still queued/running", () => {
    const db = openDb(makeTempDir());
    try {
      insertGoal(db, "goal-3", "queued");
      insertTrackerItem(db, {
        id: "si-3",
        goalId: "goal-3",
        status: "in_progress",
        adapterKind: "linear",
        externalId: "NGX-3",
      });
      insertEvidenceRecord(db, "ev-3", "no_mistakes_complete", "goal-3", 1000);

      const result = evaluateGoalForTrackerSatisfiedIntents(db, {
        goalId: "goal-3",
      })[0]!;
      expect(result.outcome).toBe("goal_not_terminal");
      if (result.outcome !== "goal_not_terminal") return;
      expect(result.goalState).toBe("queued");
      expect(listIntents(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("returns goal_state_not_completed for failed / max_iterations_reached terminal states", () => {
    const db = openDb(makeTempDir());
    try {
      insertGoal(db, "goal-failed", "failed");
      insertTrackerItem(db, {
        id: "si-failed",
        goalId: "goal-failed",
        status: "in_progress",
        adapterKind: "linear",
        externalId: "NGX-FAIL",
      });
      insertEvidenceRecord(
        db,
        "ev-failed",
        "no_mistakes_complete",
        "goal-failed",
        1000,
      );

      const result = evaluateGoalForTrackerSatisfiedIntents(db, {
        goalId: "goal-failed",
      })[0]!;
      expect(result.outcome).toBe("goal_state_not_completed");
      if (result.outcome !== "goal_state_not_completed") return;
      expect(result.goalState).toBe("failed");
      expect(listIntents(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("returns no_tracker_link when a completed Goal has no linked TrackerItem", () => {
    const db = openDb(makeTempDir());
    try {
      insertGoal(db, "goal-4", "completed");
      insertEvidenceRecord(db, "ev-4", "no_mistakes_complete", "goal-4", 1000);

      const result = evaluateGoalForTrackerSatisfiedIntents(db, {
        goalId: "goal-4",
      })[0]!;
      expect(result.outcome).toBe("no_tracker_link");
      if (result.outcome !== "no_tracker_link") return;
      expect(result.goalId).toBe("goal-4");
      expect(listIntents(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("returns tracker_already_terminal when the linked tracker item is already closed/done", () => {
    const db = openDb(makeTempDir());
    try {
      insertGoal(db, "goal-5", "completed");
      insertTrackerItem(db, {
        id: "si-5",
        goalId: "goal-5",
        status: "Done",
        adapterKind: "linear",
        externalId: "NGX-5",
      });
      insertEvidenceRecord(db, "ev-5", "no_mistakes_complete", "goal-5", 1000);

      const result = evaluateGoalForTrackerSatisfiedIntents(db, {
        goalId: "goal-5",
      })[0]!;
      expect(result.outcome).toBe("tracker_already_terminal");
      if (result.outcome !== "tracker_already_terminal") return;
      expect(result.trackerItem.id).toBe("si-5");
      expect(result.trackerItem.status).toBe("Done");
      expect(listIntents(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("returns goal_not_found for unknown goal ids", () => {
    const db = openDb(makeTempDir());
    try {
      const result = evaluateGoalForTrackerSatisfiedIntents(db, {
        goalId: "goal-missing",
      })[0]!;
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
      insertTrackerItem(db, {
        id: "si-6",
        goalId: "goal-6",
        status: "in_progress",
        adapterKind: "linear",
        externalId: "NGX-6",
      });
      // The default predicate would treat plan_created as non-verification,
      // but we override the accepted set to include it.
      insertEvidenceRecord(db, "ev-6", "plan_created", "goal-6", 1000);

      const result = evaluateGoalForTrackerSatisfiedIntents(
        db,
        {
          goalId: "goal-6",
          verificationEvidenceTypes: ["plan_created"],
        },
        { now: () => 1000 },
      )[0]!;
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
        evaluateGoalForTrackerSatisfiedIntents(db, { goalId: "" }),
      ).toThrowError(/goalId/);
    } finally {
      db.close();
    }
  });

  it("rejects an empty verificationEvidenceTypes override", () => {
    const db = openDb(makeTempDir());
    try {
      insertGoal(db, "goal-7", "completed");
      insertTrackerItem(db, {
        id: "si-7",
        goalId: "goal-7",
        adapterKind: "linear",
        externalId: "NGX-7",
      });
      expect(() =>
        evaluateGoalForTrackerSatisfiedIntents(db, {
          goalId: "goal-7",
          verificationEvidenceTypes: [],
        }),
      ).toThrowError(/verificationEvidenceTypes/);
    } finally {
      db.close();
    }
  });
});
