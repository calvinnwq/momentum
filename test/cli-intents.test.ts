import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/cli.js";
import { openDb } from "../src/db.js";
import { createUpdateIntent } from "../src/update-intents.js";

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
});
