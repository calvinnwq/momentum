import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import {
  claimIntentApply,
  countBlockedIntents,
  countIntentApplyAuditsByLifecycleState,
  finalizeIntentApply,
  getIntentApplyAuditById,
  getLatestIntentApplyAudit,
  listIntentApplyAudits,
  type ClaimIntentApplyInput
} from "../src/core/intent/apply-audits.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-intent-apply-audits-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function insertIntent(db: MomentumDb, id: string, payload = "{}"): void {
  db.prepare(
    `INSERT INTO update_intents
       (id, adapter_kind, target_external_id, intent_type, payload_json,
        reason, status, idempotency_key, created_at, updated_at)
     VALUES (?, 'linear', 'NGX-test', 'source_satisfied', ?,
             'goal completed with evidence', 'pending', ?, 1, 1)`
  ).run(id, payload, `idemp:${id}`);
}

function baseClaim(
  intentId: string,
  overrides: Partial<ClaimIntentApplyInput> = {}
): ClaimIntentApplyInput {
  return {
    intentId,
    adapterKind: "linear",
    provider: "linear",
    target: {
      externalId: "NGX-test",
      externalKey: "NGX-123",
      url: "https://linear.app/example/issue/NGX-123",
      title: "Example issue"
    },
    operatorReason: "verified done",
    operatorActor: "operator@example.com",
    intentApplyPolicy: "external_apply_allowed",
    allowStatusMutation: false,
    mutationKind: "comment",
    previewSummary: "Linear comment on NGX-123: source_satisfied",
    idempotencyMarker:
      "momentum-intent:linear:" + intentId + ":deadbeefcafef00d",
    now: 100,
    ...overrides
  };
}

describe("intent apply audit ledger", () => {
  it("claims an intent, persists the audit row, and finalizes succeeded", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      insertIntent(db, "intent_a");
      const claim = claimIntentApply(db, baseClaim("intent_a"));
      if (!claim.ok) throw new Error(`expected ok claim, got ${claim.code}`);
      expect(claim.audit.lifecycleState).toBe("claimed");
      expect(claim.audit.requestedAt).toBe(100);
      expect(claim.audit.finishedAt).toBeNull();
      expect(claim.audit.idempotencyMarker).toContain(
        "momentum-intent:linear:intent_a:"
      );

      const intentRow = db
        .prepare(
          "SELECT apply_state FROM update_intents WHERE id = 'intent_a'"
        )
        .get() as { apply_state: string };
      expect(intentRow.apply_state).toBe("in_flight");

      const finalize = finalizeIntentApply(db, {
        auditId: claim.audit.id,
        lifecycleState: "succeeded",
        resultCode: "comment_created",
        resultMessage: "ok",
        externalRefs: {
          commentId: "comment_1",
          commentUrl: "https://linear.app/example/comment/1"
        },
        now: 200
      });
      if (!finalize.ok) {
        throw new Error(`expected ok finalize, got ${finalize.code}`);
      }
      expect(finalize.audit.lifecycleState).toBe("succeeded");
      expect(finalize.audit.finishedAt).toBe(200);
      expect(finalize.audit.resultStatus).toBe("succeeded");
      expect(finalize.audit.externalRefs.commentId).toBe("comment_1");
      expect(finalize.audit.externalRefs.commentUrl).toBe(
        "https://linear.app/example/comment/1"
      );

      const after = db
        .prepare(
          "SELECT apply_state FROM update_intents WHERE id = 'intent_a'"
        )
        .get() as { apply_state: string };
      expect(after.apply_state).toBe("idle");
    } finally {
      db.close();
    }
  });

  it("releases the intent back to idle when finalized as failed", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      insertIntent(db, "intent_b");
      const claim = claimIntentApply(db, baseClaim("intent_b"));
      if (!claim.ok) throw new Error("claim must succeed");
      const finalize = finalizeIntentApply(db, {
        auditId: claim.audit.id,
        lifecycleState: "failed",
        resultCode: "write_rejected",
        resultMessage: "Linear rejected the mutation",
        now: 250
      });
      if (!finalize.ok) throw new Error("finalize must succeed");
      expect(finalize.audit.lifecycleState).toBe("failed");
      const row = db
        .prepare(
          "SELECT apply_state FROM update_intents WHERE id = 'intent_b'"
        )
        .get() as { apply_state: string };
      expect(row.apply_state).toBe("idle");
    } finally {
      db.close();
    }
  });

  it("represents the external-write-succeeded but audit-finalize-failed case as audit_incomplete and blocks replay", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      insertIntent(db, "intent_c");
      const claim = claimIntentApply(db, baseClaim("intent_c"));
      if (!claim.ok) throw new Error("claim must succeed");
      const finalize = finalizeIntentApply(db, {
        auditId: claim.audit.id,
        lifecycleState: "audit_incomplete",
        resultCode: "audit_finalize_failed",
        resultMessage:
          "external write succeeded but audit finalize did not complete",
        externalRefs: {
          commentId: "comment_late",
          commentUrl: "https://linear.app/example/comment/late"
        },
        now: 300
      });
      if (!finalize.ok) throw new Error("finalize must succeed");
      expect(finalize.audit.lifecycleState).toBe("audit_incomplete");
      expect(finalize.audit.externalRefs.commentId).toBe("comment_late");

      const intent = db
        .prepare(
          "SELECT apply_state FROM update_intents WHERE id = 'intent_c'"
        )
        .get() as { apply_state: string };
      expect(intent.apply_state).toBe("blocked");

      const replay = claimIntentApply(db, baseClaim("intent_c", { now: 400 }));
      if (replay.ok) {
        throw new Error("replay against blocked intent must refuse");
      }
      expect(replay.code).toBe("intent_blocked");
      expect(replay.currentApplyState).toBe("blocked");
      expect(replay.latestAuditId).toBe(claim.audit.id);
      expect(countBlockedIntents(db)).toBe(1);
    } finally {
      db.close();
    }
  });

  it("refuses a concurrent claim with stable intent_apply_in_progress and does not insert a second audit row", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      insertIntent(db, "intent_d");
      const first = claimIntentApply(db, baseClaim("intent_d"));
      if (!first.ok) throw new Error("first claim must succeed");
      const second = claimIntentApply(
        db,
        baseClaim("intent_d", { now: 110 })
      );
      if (second.ok) throw new Error("second claim must refuse");
      expect(second.code).toBe("intent_apply_in_progress");
      expect(second.currentApplyState).toBe("in_flight");
      expect(second.latestAuditId).toBe(first.audit.id);

      const audits = listIntentApplyAudits(db, { intentId: "intent_d" });
      expect(audits).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("refuses claim when the intent does not exist", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const result = claimIntentApply(db, baseClaim("missing_intent"));
      if (result.ok) throw new Error("expected refusal");
      expect(result.code).toBe("intent_not_found");
    } finally {
      db.close();
    }
  });

  it("refuses to finalize an unknown audit id and refuses to finalize twice", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      insertIntent(db, "intent_e");
      const missing = finalizeIntentApply(db, {
        auditId: "unknown_audit",
        lifecycleState: "failed"
      });
      if (missing.ok) throw new Error("expected refusal");
      expect(missing.code).toBe("audit_not_found");

      const claim = claimIntentApply(db, baseClaim("intent_e"));
      if (!claim.ok) throw new Error("claim must succeed");
      const first = finalizeIntentApply(db, {
        auditId: claim.audit.id,
        lifecycleState: "succeeded"
      });
      if (!first.ok) throw new Error("first finalize must succeed");
      const second = finalizeIntentApply(db, {
        auditId: claim.audit.id,
        lifecycleState: "failed"
      });
      if (second.ok) throw new Error("second finalize must refuse");
      expect(second.code).toBe("audit_already_finalized");
      expect(second.currentLifecycleState).toBe("succeeded");
    } finally {
      db.close();
    }
  });

  it("allows a new claim against the same intent after a successful finalize", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      insertIntent(db, "intent_f");
      const first = claimIntentApply(db, baseClaim("intent_f"));
      if (!first.ok) throw new Error("first claim must succeed");
      const done = finalizeIntentApply(db, {
        auditId: first.audit.id,
        lifecycleState: "failed"
      });
      if (!done.ok) throw new Error("finalize must succeed");
      const second = claimIntentApply(
        db,
        baseClaim("intent_f", { now: 500 })
      );
      if (!second.ok) {
        throw new Error("second claim should succeed after release");
      }
      expect(second.audit.id).not.toBe(first.audit.id);
    } finally {
      db.close();
    }
  });

  it("lists and counts audits and resolves the latest attempt per intent", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      insertIntent(db, "intent_g");
      insertIntent(db, "intent_h");

      const claim1 = claimIntentApply(db, baseClaim("intent_g", { now: 10 }));
      if (!claim1.ok) throw new Error("claim must succeed");
      finalizeIntentApply(db, {
        auditId: claim1.audit.id,
        lifecycleState: "failed",
        now: 20
      });

      const claim2 = claimIntentApply(db, baseClaim("intent_g", { now: 30 }));
      if (!claim2.ok) throw new Error("claim must succeed");
      finalizeIntentApply(db, {
        auditId: claim2.audit.id,
        lifecycleState: "succeeded",
        now: 40
      });

      const claim3 = claimIntentApply(db, baseClaim("intent_h", { now: 50 }));
      if (!claim3.ok) throw new Error("claim must succeed");

      const byId = getIntentApplyAuditById(db, claim2.audit.id);
      expect(byId?.lifecycleState).toBe("succeeded");

      const latestG = getLatestIntentApplyAudit(db, "intent_g");
      expect(latestG?.id).toBe(claim2.audit.id);
      expect(latestG?.lifecycleState).toBe("succeeded");

      const allG = listIntentApplyAudits(db, { intentId: "intent_g" });
      expect(allG.map((row) => row.id)).toEqual([
        claim2.audit.id,
        claim1.audit.id
      ]);

      const claimedOnly = listIntentApplyAudits(db, {
        lifecycleState: "claimed"
      });
      expect(claimedOnly.map((row) => row.id)).toEqual([claim3.audit.id]);

      const counts = countIntentApplyAuditsByLifecycleState(db);
      expect(counts.claimed).toBe(1);
      expect(counts.succeeded).toBe(1);
      expect(counts.failed).toBe(1);
      expect(counts.blocked).toBe(0);
      expect(counts.audit_incomplete).toBe(0);
    } finally {
      db.close();
    }
  });

  it("rejects an invalid finalize lifecycle state", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      insertIntent(db, "intent_i");
      const claim = claimIntentApply(db, baseClaim("intent_i"));
      if (!claim.ok) throw new Error("claim must succeed");
      expect(() =>
        finalizeIntentApply(db, {
          auditId: claim.audit.id,
          // @ts-expect-error - exercising runtime validation
          lifecycleState: "claimed"
        })
      ).toThrow(/finalizeIntentApply/);
    } finally {
      db.close();
    }
  });

  it("requires non-empty operator reason and idempotency marker on claim", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      insertIntent(db, "intent_j");
      expect(() =>
        claimIntentApply(db, baseClaim("intent_j", { operatorReason: "" }))
      ).toThrow(/operatorReason/);
      expect(() =>
        claimIntentApply(
          db,
          baseClaim("intent_j", { idempotencyMarker: "" })
        )
      ).toThrow(/idempotencyMarker/);
    } finally {
      db.close();
    }
  });
});
