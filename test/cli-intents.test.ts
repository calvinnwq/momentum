import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/cli.js";
import { openDb } from "../src/db.js";
import { createUpdateIntent } from "../src/update-intents.js";
import {
  claimIntentApply,
  finalizeIntentApply,
  type ClaimIntentApplyInput,
  type IntentApplyFinalLifecycleState
} from "../src/intent-apply-audits.js";

type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix = "momentum-cli-intent-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

async function run(argv: string[]): Promise<RunResult> {
  let stdout = "";
  let stderr = "";

  const code = await runCli(argv, {
    stdout: {
      write(chunk: string) {
        stdout += chunk;
        return true;
      }
    },
    stderr: {
      write(chunk: string) {
        stderr += chunk;
        return true;
      }
    },
    env: {}
  });

  return { code, stdout, stderr };
}

function seedGoal(dataDir: string, goalId: string): void {
  const db = openDb(dataDir);
  try {
    db.prepare(
      `INSERT INTO goals
         (id, title, branch, artifact_dir, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(goalId, "intent goal", "momentum/test", "/tmp/test", 1, 1);
  } finally {
    db.close();
  }
}

function seedSourceItem(dataDir: string, sourceItemId: string): void {
  const db = openDb(dataDir);
  try {
    db.prepare(
      `INSERT INTO source_items
         (id, adapter_kind, external_id, external_key, url, title,
          status, metadata_json, last_observed_at, goal_id,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      sourceItemId,
      "linear",
      `ext-${sourceItemId}`,
      `KEY-${sourceItemId}`,
      `https://linear.app/example/issue/${sourceItemId}`,
      "intent source item",
      "open",
      "{}",
      1,
      null,
      1,
      1
    );
  } finally {
    db.close();
  }
}

function seedEvidenceRecord(dataDir: string, evidenceRecordId: string): void {
  const db = openDb(dataDir);
  try {
    db.prepare(
      `INSERT INTO evidence_records
         (id, source, type, format_version, artifact_path, external_id,
          occurred_at, summary, metadata_json, goal_id, source_item_id,
          ingest_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      evidenceRecordId,
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
      `agent-workflow:${evidenceRecordId}:verification_passed`,
      1,
      1
    );
  } finally {
    db.close();
  }
}

function seedIntent(
  dataDir: string,
  input: {
    adapterKind: string;
    targetExternalId?: string | null;
    intentType: string;
    reason: string;
    idempotencyKey: string;
    goalId?: string | null;
    sourceItemId?: string | null;
    evidenceRecordId?: string | null;
    payload?: Record<string, unknown>;
    now?: number;
  }
): string {
  const db = openDb(dataDir);
  try {
    const { now, ...rest } = input;
    const result = createUpdateIntent(
      db,
      rest,
      now !== undefined ? { now: () => now } : {}
    );
    return result.intent.id;
  } finally {
    db.close();
  }
}

describe("momentum intent list", () => {
  it("rejects unexpected positional argument", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "intent",
      "list",
      "extra",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      "Unexpected argument for intent list: extra"
    );
  });

  it("returns an empty list with stable JSON shape when there are no intents", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "intent",
      "list",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "intent list",
      status: null,
      adapter: null,
      intentType: null,
      goalId: null,
      sourceItemId: null,
      evidenceRecordId: null,
      limit: null,
      count: 0,
      intents: []
    });
  });

  it("orders intents by created_at ascending and surfaces the JSON shape", async () => {
    const dataDir = makeTempDir();
    seedIntent(dataDir, {
      adapterKind: "linear",
      intentType: "source_satisfied",
      reason: "first",
      idempotencyKey: "linear:ext-1:source_satisfied:goal-1",
      now: 1000
    });
    seedIntent(dataDir, {
      adapterKind: "linear",
      intentType: "source_satisfied",
      reason: "second",
      idempotencyKey: "linear:ext-2:source_satisfied:goal-2",
      now: 2000
    });

    const result = await run([
      "intent",
      "list",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      count: number;
      intents: Array<{
        reason: string;
        status: string;
        createdAt: number;
        adapterKind: string;
        intentType: string;
      }>;
    };
    expect(payload.count).toBe(2);
    expect(payload.intents.map((i) => i.reason)).toEqual(["first", "second"]);
    expect(payload.intents.every((i) => i.status === "pending")).toBe(true);
    expect(payload.intents.map((i) => i.createdAt)).toEqual([1000, 2000]);
  });

  it("filters by --status and reports the status in the payload", async () => {
    const dataDir = makeTempDir();
    seedIntent(dataDir, {
      adapterKind: "linear",
      intentType: "source_satisfied",
      reason: "pending one",
      idempotencyKey: "linear:ext-1:source_satisfied:goal-1"
    });
    seedIntent(dataDir, {
      adapterKind: "linear",
      intentType: "source_satisfied",
      reason: "pending two",
      idempotencyKey: "linear:ext-2:source_satisfied:goal-2"
    });

    const result = await run([
      "intent",
      "list",
      "--status",
      "pending",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      status: string | null;
      count: number;
      intents: Array<{ status: string }>;
    };
    expect(payload.status).toBe("pending");
    expect(payload.count).toBe(2);
    expect(payload.intents.every((i) => i.status === "pending")).toBe(true);
  });

  it("rejects an unknown --status value with a stable error code", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "intent",
      "list",
      "--status",
      "bogus",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "intent list",
      code: "invalid_status",
      status: "bogus"
    });
  });

  it("filters by --adapter and --type", async () => {
    const dataDir = makeTempDir();
    seedIntent(dataDir, {
      adapterKind: "linear",
      intentType: "source_satisfied",
      reason: "linear satisfied",
      idempotencyKey: "linear:ext-1:source_satisfied:goal-1"
    });
    seedIntent(dataDir, {
      adapterKind: "linear",
      intentType: "comment_requested",
      reason: "linear comment",
      idempotencyKey: "linear:ext-1:comment_requested:goal-1"
    });
    seedIntent(dataDir, {
      adapterKind: "github",
      intentType: "source_satisfied",
      reason: "github satisfied",
      idempotencyKey: "github:ext-1:source_satisfied:goal-1"
    });

    const byAdapter = await run([
      "intent",
      "list",
      "--adapter",
      "linear",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(byAdapter.code).toBe(0);
    const byAdapterPayload = JSON.parse(byAdapter.stdout) as {
      adapter: string | null;
      count: number;
      intents: Array<{ adapterKind: string }>;
    };
    expect(byAdapterPayload.adapter).toBe("linear");
    expect(byAdapterPayload.count).toBe(2);
    expect(byAdapterPayload.intents.every((i) => i.adapterKind === "linear")).toBe(
      true
    );

    const byType = await run([
      "intent",
      "list",
      "--type",
      "source_satisfied",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(byType.code).toBe(0);
    const byTypePayload = JSON.parse(byType.stdout) as {
      intentType: string | null;
      count: number;
      intents: Array<{ intentType: string }>;
    };
    expect(byTypePayload.intentType).toBe("source_satisfied");
    expect(byTypePayload.count).toBe(2);
    expect(
      byTypePayload.intents.every((i) => i.intentType === "source_satisfied")
    ).toBe(true);
  });

  it("filters by --goal and rejects an unknown goal id", async () => {
    const dataDir = makeTempDir();
    seedGoal(dataDir, "goal-a");
    seedGoal(dataDir, "goal-b");
    seedIntent(dataDir, {
      adapterKind: "linear",
      intentType: "source_satisfied",
      reason: "goal-a",
      idempotencyKey: "linear:ext-1:source_satisfied:goal-a",
      goalId: "goal-a"
    });
    seedIntent(dataDir, {
      adapterKind: "linear",
      intentType: "source_satisfied",
      reason: "goal-b",
      idempotencyKey: "linear:ext-2:source_satisfied:goal-b",
      goalId: "goal-b"
    });

    const ok = await run([
      "intent",
      "list",
      "--goal",
      "goal-a",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(ok.code).toBe(0);
    const okPayload = JSON.parse(ok.stdout) as {
      goalId: string | null;
      count: number;
      intents: Array<{ goalId: string | null }>;
    };
    expect(okPayload.goalId).toBe("goal-a");
    expect(okPayload.count).toBe(1);
    expect(okPayload.intents[0]?.goalId).toBe("goal-a");

    const missing = await run([
      "intent",
      "list",
      "--goal",
      "ghost",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(missing.code).toBe(1);
    const missingPayload = JSON.parse(missing.stderr) as Record<string, unknown>;
    expect(missingPayload).toMatchObject({
      ok: false,
      command: "intent list",
      code: "goal_not_found",
      goalId: "ghost"
    });
  });

  it("filters by --source-item and rejects missing source items", async () => {
    const dataDir = makeTempDir();
    seedSourceItem(dataDir, "si-1");
    seedSourceItem(dataDir, "si-2");
    seedIntent(dataDir, {
      adapterKind: "linear",
      intentType: "source_satisfied",
      reason: "for si-2",
      idempotencyKey: "linear:ext-si-2:source_satisfied:goal-1",
      sourceItemId: "si-2"
    });

    const ok = await run([
      "intent",
      "list",
      "--source-item",
      "si-2",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(ok.code).toBe(0);
    const okPayload = JSON.parse(ok.stdout) as {
      sourceItemId: string | null;
      count: number;
      intents: Array<{ sourceItemId: string | null }>;
    };
    expect(okPayload.sourceItemId).toBe("si-2");
    expect(okPayload.count).toBe(1);
    expect(okPayload.intents[0]?.sourceItemId).toBe("si-2");

    const missing = await run([
      "intent",
      "list",
      "--source-item",
      "si-missing",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(missing.code).toBe(1);
    const missingPayload = JSON.parse(missing.stderr) as Record<string, unknown>;
    expect(missingPayload).toMatchObject({
      ok: false,
      command: "intent list",
      code: "source_item_not_found",
      sourceItemId: "si-missing"
    });
  });

  it("filters by --evidence-record and rejects missing evidence record ids", async () => {
    const dataDir = makeTempDir();
    seedEvidenceRecord(dataDir, "ev-1");
    seedIntent(dataDir, {
      adapterKind: "linear",
      intentType: "source_satisfied",
      reason: "with evidence",
      idempotencyKey: "linear:ext-1:source_satisfied:goal-1",
      evidenceRecordId: "ev-1"
    });

    const ok = await run([
      "intent",
      "list",
      "--evidence-record",
      "ev-1",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(ok.code).toBe(0);
    const okPayload = JSON.parse(ok.stdout) as {
      evidenceRecordId: string | null;
      count: number;
      intents: Array<{ evidenceRecordId: string | null }>;
    };
    expect(okPayload.evidenceRecordId).toBe("ev-1");
    expect(okPayload.count).toBe(1);
    expect(okPayload.intents[0]?.evidenceRecordId).toBe("ev-1");

    const missing = await run([
      "intent",
      "list",
      "--evidence-record",
      "ev-missing",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(missing.code).toBe(1);
    const missingPayload = JSON.parse(missing.stderr) as Record<string, unknown>;
    expect(missingPayload).toMatchObject({
      ok: false,
      command: "intent list",
      code: "evidence_record_not_found",
      evidenceRecordId: "ev-missing"
    });
  });

  it("respects --limit by truncating the results", async () => {
    const dataDir = makeTempDir();
    seedIntent(dataDir, {
      adapterKind: "linear",
      intentType: "source_satisfied",
      reason: "first",
      idempotencyKey: "linear:ext-1:source_satisfied:goal-1",
      now: 1000
    });
    seedIntent(dataDir, {
      adapterKind: "linear",
      intentType: "source_satisfied",
      reason: "second",
      idempotencyKey: "linear:ext-2:source_satisfied:goal-2",
      now: 2000
    });
    seedIntent(dataDir, {
      adapterKind: "linear",
      intentType: "source_satisfied",
      reason: "third",
      idempotencyKey: "linear:ext-3:source_satisfied:goal-3",
      now: 3000
    });

    const result = await run([
      "intent",
      "list",
      "--limit",
      "2",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      limit: number | null;
      count: number;
      intents: Array<{ reason: string }>;
    };
    expect(payload.limit).toBe(2);
    expect(payload.count).toBe(2);
    expect(payload.intents.map((i) => i.reason)).toEqual(["first", "second"]);
  });

  it("emits a text summary with per-record lines when --json is not supplied", async () => {
    const dataDir = makeTempDir();
    seedIntent(dataDir, {
      adapterKind: "linear",
      targetExternalId: "ext-1",
      intentType: "source_satisfied",
      reason: "wf reason",
      idempotencyKey: "linear:ext-1:source_satisfied:goal-1"
    });

    const result = await run(["intent", "list", "--data-dir", dataDir]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Update intents: 1");
    expect(result.stdout).toContain("Status: (any)");
    expect(result.stdout).toContain("Adapter: (any)");
    expect(result.stdout).toContain("Intent type: (any)");
    expect(result.stdout).toContain(`Data dir: ${dataDir}`);
    expect(result.stdout).toContain("[linear/source_satisfied]");
    expect(result.stdout).toContain("target=ext-1");
    expect(result.stdout).toContain("wf reason");
  });
});

describe("momentum intent get", () => {
  it("requires a positional <intent-id>", async () => {
    const dataDir = makeTempDir();
    const result = await run(["intent", "get", "--data-dir", dataDir, "--json"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Missing required <intent-id> for intent get.");
  });

  it("rejects unexpected positional argument after the intent id", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "intent",
      "get",
      "intent-id",
      "extra",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      "Unexpected argument for intent get: extra"
    );
  });

  it("returns intent_not_found when the id does not exist", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "intent",
      "get",
      "missing-intent",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "intent get",
      code: "intent_not_found",
      intentId: "missing-intent"
    });
  });

  it("returns the full intent JSON shape for a real id", async () => {
    const dataDir = makeTempDir();
    const intentId = seedIntent(dataDir, {
      adapterKind: "linear",
      targetExternalId: "ext-42",
      intentType: "source_satisfied",
      reason: "satisfied reason",
      idempotencyKey: "linear:ext-42:source_satisfied:goal-1",
      payload: { goalState: "completed" }
    });

    const result = await run([
      "intent",
      "get",
      intentId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: true;
      command: string;
      intent: {
        id: string;
        adapterKind: string;
        targetExternalId: string | null;
        intentType: string;
        status: string;
        payload: Record<string, unknown>;
        reason: string;
        idempotencyKey: string;
      };
    };
    expect(payload).toMatchObject({
      ok: true,
      command: "intent get"
    });
    expect(payload.intent.id).toBe(intentId);
    expect(payload.intent.adapterKind).toBe("linear");
    expect(payload.intent.targetExternalId).toBe("ext-42");
    expect(payload.intent.intentType).toBe("source_satisfied");
    expect(payload.intent.status).toBe("pending");
    expect(payload.intent.payload).toEqual({ goalState: "completed" });
    expect(payload.intent.reason).toBe("satisfied reason");
    expect(payload.intent.idempotencyKey).toBe(
      "linear:ext-42:source_satisfied:goal-1"
    );
  });

  it("emits a text summary in non-JSON mode", async () => {
    const dataDir = makeTempDir();
    const intentId = seedIntent(dataDir, {
      adapterKind: "linear",
      targetExternalId: "ext-77",
      intentType: "source_satisfied",
      reason: "satisfied",
      idempotencyKey: "linear:ext-77:source_satisfied:goal-1"
    });

    const result = await run(["intent", "get", intentId, "--data-dir", dataDir]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Update intent: ${intentId}`);
    expect(result.stdout).toContain("Adapter: linear");
    expect(result.stdout).toContain("Target external id: ext-77");
    expect(result.stdout).toContain("Intent type: source_satisfied");
    expect(result.stdout).toContain("Status: pending");
    expect(result.stdout).toContain("Reason: satisfied");
    expect(result.stdout).toContain(`Data dir: ${dataDir}`);
  });

  it("reports an empty externalApply summary when no audits exist", async () => {
    const dataDir = makeTempDir();
    const intentId = seedIntent(dataDir, {
      adapterKind: "linear",
      targetExternalId: "ext-no-audits",
      intentType: "source_satisfied",
      reason: "no attempts yet",
      idempotencyKey: "linear:ext-no-audits:source_satisfied:goal-1"
    });

    const result = await run([
      "intent",
      "get",
      intentId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      externalApply: {
        intentId: string;
        applyState: string;
        totalAttempts: number;
        counts: Record<string, number>;
        latestAttempt: unknown;
      };
    };
    expect(payload.externalApply).toEqual({
      intentId,
      applyState: "idle",
      totalAttempts: 0,
      counts: {
        claimed: 0,
        succeeded: 0,
        failed: 0,
        blocked: 0,
        audit_incomplete: 0
      },
      latestAttempt: null
    });

    const text = await run(["intent", "get", intentId, "--data-dir", dataDir]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("External apply state: idle");
    expect(text.stdout).toContain(
      "External apply attempts: total=0 succeeded=0 failed=0 claimed=0 blocked=0 audit_incomplete=0"
    );
    expect(text.stdout).toContain("External apply latest attempt: (none)");
  });

  it("surfaces the latest succeeded attempt and lifecycle counts for an applied intent", async () => {
    const dataDir = makeTempDir();
    const intentId = seedIntent(dataDir, {
      adapterKind: "linear",
      targetExternalId: "NGX-applied",
      intentType: "source_satisfied",
      reason: "verified done",
      idempotencyKey: "linear:NGX-applied:source_satisfied:goal-1"
    });
    runFailedAttempt(dataDir, intentId, 10);
    runFinalizedAttempt(dataDir, intentId, "succeeded", 20, {
      resultCode: "comment_created",
      resultMessage: "linear comment created",
      externalRefs: {
        commentId: "linear_comment_99",
        commentUrl: "https://linear.app/example/comment/99"
      }
    });

    const result = await run([
      "intent",
      "get",
      intentId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      externalApply: {
        applyState: string;
        totalAttempts: number;
        counts: Record<string, number>;
        latestAttempt: {
          lifecycleState: string;
          resultStatus: string;
          resultCode: string;
          externalRefs: {
            commentId: string | null;
            commentUrl: string | null;
            stateTransitionId: string | null;
          };
          idempotencyMarker: string;
        };
      };
    };
    expect(payload.externalApply.applyState).toBe("idle");
    expect(payload.externalApply.totalAttempts).toBe(2);
    expect(payload.externalApply.counts).toMatchObject({
      succeeded: 1,
      failed: 1
    });
    expect(payload.externalApply.latestAttempt.lifecycleState).toBe(
      "succeeded"
    );
    expect(payload.externalApply.latestAttempt.resultStatus).toBe("succeeded");
    expect(payload.externalApply.latestAttempt.resultCode).toBe(
      "comment_created"
    );
    expect(payload.externalApply.latestAttempt.externalRefs.commentId).toBe(
      "linear_comment_99"
    );
    expect(payload.externalApply.latestAttempt.externalRefs.commentUrl).toBe(
      "https://linear.app/example/comment/99"
    );
    expect(
      payload.externalApply.latestAttempt.idempotencyMarker.startsWith(
        "momentum-intent:"
      )
    ).toBe(true);
    expect(
      payload.externalApply.latestAttempt.idempotencyMarker.toLowerCase()
    ).not.toContain("token");

    const text = await run(["intent", "get", intentId, "--data-dir", dataDir]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("External apply state: idle");
    expect(text.stdout).toContain("succeeded=1 failed=1");
    expect(text.stdout).toContain(" succeeded (result=succeeded");
    expect(text.stdout).toContain(
      "External apply refs: comment=linear_comment_99"
    );
  });

  it("surfaces the latest failed attempt for a pending intent and leaves apply_state idle", async () => {
    const dataDir = makeTempDir();
    const intentId = seedIntent(dataDir, {
      adapterKind: "linear",
      targetExternalId: "NGX-failed",
      intentType: "source_satisfied",
      reason: "failed once",
      idempotencyKey: "linear:NGX-failed:source_satisfied:goal-1"
    });
    runFinalizedAttempt(dataDir, intentId, "failed", 30, {
      resultCode: "write_rejected",
      resultMessage: "Linear rejected the mutation"
    });

    const result = await run([
      "intent",
      "get",
      intentId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      intent: { status: string; appliedAt: number | null };
      externalApply: {
        applyState: string;
        totalAttempts: number;
        counts: Record<string, number>;
        latestAttempt: {
          lifecycleState: string;
          resultStatus: string;
          resultCode: string;
        };
      };
    };
    expect(payload.intent.status).toBe("pending");
    expect(payload.intent.appliedAt).toBeNull();
    expect(payload.externalApply.applyState).toBe("idle");
    expect(payload.externalApply.totalAttempts).toBe(1);
    expect(payload.externalApply.counts.failed).toBe(1);
    expect(payload.externalApply.latestAttempt.lifecycleState).toBe("failed");
    expect(payload.externalApply.latestAttempt.resultStatus).toBe("failed");
    expect(payload.externalApply.latestAttempt.resultCode).toBe(
      "write_rejected"
    );
  });

  it("surfaces an audit_incomplete latest attempt and blocked apply state", async () => {
    const dataDir = makeTempDir();
    const intentId = seedIntent(dataDir, {
      adapterKind: "linear",
      targetExternalId: "NGX-blocked",
      intentType: "source_satisfied",
      reason: "external write but audit finalize failed",
      idempotencyKey: "linear:NGX-blocked:source_satisfied:goal-1"
    });
    runFinalizedAttempt(dataDir, intentId, "audit_incomplete", 40, {
      resultCode: "audit_finalize_failed",
      resultMessage: "external write succeeded but audit finalize did not",
      externalRefs: {
        commentId: "linear_comment_late",
        commentUrl: "https://linear.app/example/comment/late"
      }
    });

    const result = await run([
      "intent",
      "get",
      intentId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      intent: { status: string };
      externalApply: {
        applyState: string;
        totalAttempts: number;
        counts: Record<string, number>;
        latestAttempt: {
          lifecycleState: string;
          resultCode: string;
          externalRefs: { commentId: string | null };
        };
      };
    };
    expect(payload.intent.status).toBe("pending");
    expect(payload.externalApply.applyState).toBe("blocked");
    expect(payload.externalApply.totalAttempts).toBe(1);
    expect(payload.externalApply.counts.audit_incomplete).toBe(1);
    expect(payload.externalApply.latestAttempt.lifecycleState).toBe(
      "audit_incomplete"
    );
    expect(payload.externalApply.latestAttempt.resultCode).toBe(
      "audit_finalize_failed"
    );
    expect(payload.externalApply.latestAttempt.externalRefs.commentId).toBe(
      "linear_comment_late"
    );

    const text = await run(["intent", "get", intentId, "--data-dir", dataDir]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("External apply state: blocked");
    expect(text.stdout).toContain("audit_incomplete=1");
    expect(text.stdout).toContain(
      "External apply refs: comment=linear_comment_late"
    );
  });
});

function baseClaim(
  intentId: string,
  now: number,
  overrides: Partial<ClaimIntentApplyInput> = {}
): ClaimIntentApplyInput {
  return {
    intentId,
    adapterKind: "linear",
    provider: "linear",
    target: {
      externalId: `NGX-${intentId}`,
      externalKey: `NGX-${intentId}`,
      url: `https://linear.app/example/issue/${intentId}`,
      title: "Example issue"
    },
    operatorReason: "verified done",
    operatorActor: "operator@example.com",
    intentApplyPolicy: "external_apply_allowed",
    allowStatusMutation: false,
    mutationKind: "comment",
    previewSummary: `Linear comment on ${intentId}: source_satisfied`,
    idempotencyMarker: `momentum-intent:linear:${intentId}:deadbeef-${now}`,
    now,
    ...overrides
  };
}

function runFailedAttempt(
  dataDir: string,
  intentId: string,
  now: number
): void {
  runFinalizedAttempt(dataDir, intentId, "failed", now, {
    resultCode: "write_rejected",
    resultMessage: "linear rejected"
  });
}

function runFinalizedAttempt(
  dataDir: string,
  intentId: string,
  lifecycleState: IntentApplyFinalLifecycleState,
  now: number,
  options: {
    resultCode?: string;
    resultMessage?: string;
    externalRefs?: {
      commentId?: string | null;
      commentUrl?: string | null;
      stateTransitionId?: string | null;
    };
  } = {}
): void {
  const db = openDb(dataDir);
  try {
    const claim = claimIntentApply(db, baseClaim(intentId, now));
    if (!claim.ok) {
      throw new Error(
        `seed: expected claim to succeed for ${intentId}, got ${claim.code}`
      );
    }
    const finalizeInput: Parameters<typeof finalizeIntentApply>[1] = {
      auditId: claim.audit.id,
      lifecycleState,
      resultCode: options.resultCode ?? null,
      resultMessage: options.resultMessage ?? null,
      now: now + 1
    };
    if (options.externalRefs) finalizeInput.externalRefs = options.externalRefs;
    const finalize = finalizeIntentApply(db, finalizeInput);
    if (!finalize.ok) {
      throw new Error(
        `seed: expected finalize to succeed for ${intentId}, got ${finalize.code}`
      );
    }
  } finally {
    db.close();
  }
}

describe.each([
  {
    action: "apply" as const,
    command: "intent apply",
    expectedStatus: "applied",
    timestampKey: "appliedAt" as const
  },
  {
    action: "skip" as const,
    command: "intent skip",
    expectedStatus: "skipped",
    timestampKey: "skippedAt" as const
  },
  {
    action: "cancel" as const,
    command: "intent cancel",
    expectedStatus: "canceled",
    timestampKey: "canceledAt" as const
  }
])("momentum $command", ({ action, command, expectedStatus, timestampKey }) => {
  it("requires a positional <intent-id>", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "intent",
      action,
      "--reason",
      "needed",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      `Missing required <intent-id> for ${command}.`
    );
  });

  it("rejects unexpected positional argument after the intent id", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "intent",
      action,
      "intent-id",
      "extra",
      "--reason",
      "needed",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      `Unexpected argument for ${command}: extra`
    );
  });

  it("requires a non-empty --reason", async () => {
    const dataDir = makeTempDir();
    const intentId = seedIntent(dataDir, {
      adapterKind: "linear",
      intentType: "source_satisfied",
      reason: "satisfied",
      idempotencyKey: `linear:ext-${action}-no-reason:source_satisfied:g`
    });
    const result = await run([
      "intent",
      action,
      intentId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command,
      code: "reason_required",
      intentId
    });
  });

  it("rejects a whitespace-only --reason value", async () => {
    const dataDir = makeTempDir();
    const intentId = seedIntent(dataDir, {
      adapterKind: "linear",
      intentType: "source_satisfied",
      reason: "satisfied",
      idempotencyKey: `linear:ext-${action}-ws-reason:source_satisfied:g`
    });
    const result = await run([
      "intent",
      action,
      intentId,
      "--reason",
      "   ",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command,
      code: "reason_required",
      intentId
    });
  });

  it("returns intent_not_found when the id does not exist", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "intent",
      action,
      "missing-intent",
      "--reason",
      "operator decision",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command,
      code: "intent_not_found",
      intentId: "missing-intent"
    });
  });

  it(`transitions a pending intent to ${expectedStatus} and surfaces previous status`, async () => {
    const dataDir = makeTempDir();
    const intentId = seedIntent(dataDir, {
      adapterKind: "linear",
      targetExternalId: "ext-42",
      intentType: "source_satisfied",
      reason: "satisfied",
      idempotencyKey: `linear:ext-42:source_satisfied:goal-${action}`,
      payload: { foo: "bar" }
    });

    const result = await run([
      "intent",
      action,
      intentId,
      "--reason",
      `operator decided to ${action}`,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: true;
      command: string;
      previousStatus: string;
      intent: {
        id: string;
        status: string;
        decisionReason: string | null;
        appliedAt: number | null;
        skippedAt: number | null;
        canceledAt: number | null;
        updatedAt: number;
      };
    };
    expect(payload).toMatchObject({
      ok: true,
      command,
      previousStatus: "pending"
    });
    expect(payload.intent.id).toBe(intentId);
    expect(payload.intent.status).toBe(expectedStatus);
    expect(payload.intent.decisionReason).toBe(`operator decided to ${action}`);
    expect(payload.intent[timestampKey]).toBeTypeOf("number");
    // Only the matching timestamp is stamped; the other two stay null.
    const others = (["appliedAt", "skippedAt", "canceledAt"] as const).filter(
      (key) => key !== timestampKey
    );
    for (const key of others) {
      expect(payload.intent[key]).toBeNull();
    }
  });

  it("refuses to overwrite a terminal intent", async () => {
    const dataDir = makeTempDir();
    const intentId = seedIntent(dataDir, {
      adapterKind: "linear",
      intentType: "source_satisfied",
      reason: "satisfied",
      idempotencyKey: `linear:ext-replay:source_satisfied:goal-${action}`
    });

    const first = await run([
      "intent",
      action,
      intentId,
      "--reason",
      "first decision",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(first.code).toBe(0);

    const second = await run([
      "intent",
      action,
      intentId,
      "--reason",
      "second decision",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(second.code).toBe(1);
    const payload = JSON.parse(second.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command,
      code: "intent_already_terminal",
      intentId,
      currentStatus: expectedStatus
    });
  });

  it("emits a text summary in non-JSON mode", async () => {
    const dataDir = makeTempDir();
    const intentId = seedIntent(dataDir, {
      adapterKind: "linear",
      targetExternalId: "ext-99",
      intentType: "source_satisfied",
      reason: "satisfied",
      idempotencyKey: `linear:ext-99:source_satisfied:goal-${action}`
    });
    const result = await run([
      "intent",
      action,
      intentId,
      "--reason",
      "operator decision",
      "--data-dir",
      dataDir
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Update intent ${intentId} ${expectedStatus}`);
    expect(result.stdout).toContain("Previous status: pending");
    expect(result.stdout).toContain(`Status: ${expectedStatus}`);
    expect(result.stdout).toContain("Decision reason: operator decision");
    expect(result.stdout).toContain(`Data dir: ${dataDir}`);
  });
});

describe("momentum intent apply policy gating", () => {
  function makeRepoWithPolicy(policyBody: string): string {
    const repo = makeTempDir("momentum-cli-intent-policy-repo-");
    fs.writeFileSync(path.join(repo, "MOMENTUM.md"), policyBody, "utf-8");
    return repo;
  }

  it("refuses --external-apply with external_apply_unsupported and surfaces applyPolicy", async () => {
    const dataDir = makeTempDir();
    const intentId = seedIntent(dataDir, {
      adapterKind: "linear",
      intentType: "source_satisfied",
      reason: "satisfied",
      idempotencyKey: "linear:ext-policy-refuse:source_satisfied:goal-policy"
    });

    const result = await run([
      "intent",
      "apply",
      intentId,
      "--reason",
      "operator decision",
      "--external-apply",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as {
      ok: false;
      command: string;
      code: string;
      intentId: string;
      applyPolicy: {
        effective: string;
        source: string;
        externalApplyRequested: boolean;
        externalApplyPerformed: boolean;
        note: string;
      };
    };
    expect(payload.ok).toBe(false);
    expect(payload.command).toBe("intent apply");
    expect(payload.code).toBe("external_apply_unsupported");
    expect(payload.intentId).toBe(intentId);
    expect(payload.applyPolicy.effective).toBe("create_intents_only");
    expect(payload.applyPolicy.source).toBe("builtin_default");
    expect(payload.applyPolicy.externalApplyRequested).toBe(true);
    expect(payload.applyPolicy.externalApplyPerformed).toBe(false);
    expect(payload.applyPolicy.note).toMatch(/Milestone 5/);

    // The intent itself must remain pending; refusal must not transition it.
    const db = openDb(dataDir);
    try {
      const row = db
        .prepare("SELECT status FROM update_intents WHERE id = ?")
        .get(intentId) as { status: string };
      expect(row.status).toBe("pending");
    } finally {
      db.close();
    }
  });

  it("usage-errors when --external-apply is paired with a non-apply command", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "intent",
      "skip",
      "some-id",
      "--reason",
      "x",
      "--external-apply",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      "--external-apply is only supported by `momentum intent apply`."
    );
  });

  it("records a manual mark and includes the built-in default applyPolicy when --repo is not set", async () => {
    const dataDir = makeTempDir();
    const intentId = seedIntent(dataDir, {
      adapterKind: "linear",
      intentType: "source_satisfied",
      reason: "satisfied",
      idempotencyKey: "linear:ext-policy-default:source_satisfied:goal-policy"
    });

    const result = await run([
      "intent",
      "apply",
      intentId,
      "--reason",
      "operator decision",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: true;
      intent: { id: string; status: string };
      applyPolicy: {
        effective: string;
        source: string;
        externalApplyRequested: boolean;
        externalApplyPerformed: boolean;
      };
    };
    expect(payload.intent.id).toBe(intentId);
    expect(payload.intent.status).toBe("applied");
    expect(payload.applyPolicy.effective).toBe("create_intents_only");
    expect(payload.applyPolicy.source).toBe("builtin_default");
    expect(payload.applyPolicy.externalApplyRequested).toBe(false);
    expect(payload.applyPolicy.externalApplyPerformed).toBe(false);
  });

  it("surfaces source=momentum_policy when --repo points at a MOMENTUM.md that sets intent_apply_policy", async () => {
    const dataDir = makeTempDir();
    const repo = makeRepoWithPolicy(
      `---\nintent_apply_policy: external_apply_allowed\n---\nrepo policy\n`
    );
    const intentId = seedIntent(dataDir, {
      adapterKind: "linear",
      intentType: "source_satisfied",
      reason: "satisfied",
      idempotencyKey: "linear:ext-policy-repo:source_satisfied:goal-policy"
    });

    const result = await run([
      "intent",
      "apply",
      intentId,
      "--reason",
      "operator decision",
      "--repo",
      repo,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: true;
      applyPolicy: { effective: string; source: string };
    };
    expect(payload.applyPolicy.effective).toBe("external_apply_allowed");
    expect(payload.applyPolicy.source).toBe("momentum_policy");
  });

  it("fails intent apply when an explicit repo policy is invalid", async () => {
    const dataDir = makeTempDir();
    const repo = makeRepoWithPolicy(
      `---\nintent_apply_policy: definitely_not_valid\n---\n`
    );
    const intentId = seedIntent(dataDir, {
      adapterKind: "linear",
      intentType: "source_satisfied",
      reason: "satisfied",
      idempotencyKey: "linear:invalid-policy:source_satisfied:goal-policy"
    });

    const result = await run([
      "intent",
      "apply",
      intentId,
      "--reason",
      "operator decision",
      "--repo",
      repo,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as {
      ok: false;
      command: string;
      code: string;
      intentId: string;
      message: string;
    };
    expect(payload.ok).toBe(false);
    expect(payload.command).toBe("intent apply");
    expect(payload.code).toBe("policy_load_failed");
    expect(payload.intentId).toBe(intentId);
    expect(payload.message).toContain("intent_apply_policy");

    const db = openDb(dataDir);
    try {
      const row = db
        .prepare("SELECT status FROM update_intents WHERE id = ?")
        .get(intentId) as { status: string };
      expect(row.status).toBe("pending");
    } finally {
      db.close();
    }
  });

  it("refuses --external-apply even when MOMENTUM.md sets external_apply_allowed (M5 trust boundary)", async () => {
    const dataDir = makeTempDir();
    const repo = makeRepoWithPolicy(
      `---\nintent_apply_policy: external_apply_allowed\n---\n`
    );
    const intentId = seedIntent(dataDir, {
      adapterKind: "linear",
      intentType: "source_satisfied",
      reason: "satisfied",
      idempotencyKey:
        "linear:ext-policy-repo-refuse:source_satisfied:goal-policy"
    });

    const result = await run([
      "intent",
      "apply",
      intentId,
      "--reason",
      "operator decision",
      "--external-apply",
      "--repo",
      repo,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as {
      code: string;
      applyPolicy: { effective: string; source: string };
    };
    expect(payload.code).toBe("external_apply_unsupported");
    expect(payload.applyPolicy.effective).toBe("external_apply_allowed");
    expect(payload.applyPolicy.source).toBe("momentum_policy");
  });

  it("keeps --external-apply refusal stable when an explicit repo policy is invalid", async () => {
    const dataDir = makeTempDir();
    const repo = makeRepoWithPolicy(
      `---\nintent_apply_policy: definitely_not_valid\n---\n`
    );
    const intentId = seedIntent(dataDir, {
      adapterKind: "linear",
      intentType: "source_satisfied",
      reason: "satisfied",
      idempotencyKey:
        "linear:invalid-policy-external:source_satisfied:goal-policy"
    });

    const result = await run([
      "intent",
      "apply",
      intentId,
      "--reason",
      "operator decision",
      "--external-apply",
      "--repo",
      repo,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as {
      code: string;
      applyPolicy: { effective: string; source: string };
    };
    expect(payload.code).toBe("external_apply_unsupported");
    expect(payload.applyPolicy.effective).toBe("create_intents_only");
    expect(payload.applyPolicy.source).toBe("builtin_default");
  });

  it("emits the apply policy line in non-JSON text mode", async () => {
    const dataDir = makeTempDir();
    const intentId = seedIntent(dataDir, {
      adapterKind: "linear",
      intentType: "source_satisfied",
      reason: "satisfied",
      idempotencyKey: "linear:ext-policy-text:source_satisfied:goal-policy"
    });

    const result = await run([
      "intent",
      "apply",
      intentId,
      "--reason",
      "operator decision",
      "--data-dir",
      dataDir
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "Apply policy: create_intents_only (builtin_default)"
    );
    expect(result.stdout).toContain("Milestone 5");
  });
});

describe("momentum intent dispatch", () => {
  it("rejects an unknown intent subcommand", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "intent",
      "bogus",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Unknown intent subcommand: bogus");
  });

  it("notes the new transition subcommands when none is supplied", async () => {
    const dataDir = makeTempDir();
    const result = await run(["intent", "--data-dir", dataDir, "--json"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("list, get, apply, skip, cancel");
  });
});
