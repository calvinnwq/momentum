import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/cli.js";
import { openDb } from "../src/db.js";
import { ingestEvidenceRecord } from "../src/evidence-records.js";

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

function makeTempDir(prefix = "momentum-cli-evidence-list-"): string {
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
    ).run(goalId, "evidence list goal", "momentum/test", "/tmp/test", 1, 1);
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
      "evidence list source item",
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

function seedRecords(
  dataDir: string,
  records: Array<{
    source: string;
    type: string;
    occurredAt: number;
    summary: string;
    ingestKey: string;
    goalId?: string | null;
    sourceItemId?: string | null;
  }>
): void {
  const db = openDb(dataDir);
  try {
    for (const record of records) {
      ingestEvidenceRecord(db, {
        source: record.source,
        type: record.type,
        occurredAt: record.occurredAt,
        summary: record.summary,
        ingestKey: record.ingestKey,
        goalId: record.goalId ?? null,
        sourceItemId: record.sourceItemId ?? null
      });
    }
  } finally {
    db.close();
  }
}

describe("momentum evidence list", () => {
  it("rejects unexpected positional argument", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "evidence",
      "list",
      "extra",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      "Unexpected argument for evidence list: extra"
    );
  });

  it("returns an empty list with stable JSON shape when there are no records", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "evidence",
      "list",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "evidence list",
      goalId: null,
      sourceItemId: null,
      source: null,
      type: null,
      limit: null,
      count: 0,
      records: []
    });
  });

  it("returns records ordered by occurredAt ascending with full JSON shape", async () => {
    const dataDir = makeTempDir();
    seedRecords(dataDir, [
      {
        source: "agent-workflow",
        type: "plan_created",
        occurredAt: 1000,
        summary: "plan created",
        ingestKey: "agent-workflow:run-1:plan_created"
      },
      {
        source: "agent-workflow",
        type: "merge_complete",
        occurredAt: 3000,
        summary: "merge complete",
        ingestKey: "agent-workflow:run-1:merge-cleanup:complete"
      },
      {
        source: "agent-workflow",
        type: "implementation_complete",
        occurredAt: 2000,
        summary: "implementation complete",
        ingestKey: "agent-workflow:run-1:implementation:complete"
      }
    ]);

    const result = await run([
      "evidence",
      "list",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      count: number;
      records: Array<{ type: string; occurredAt: number; summary: string }>;
    };
    expect(payload.count).toBe(3);
    expect(payload.records.map((r) => r.type)).toEqual([
      "plan_created",
      "implementation_complete",
      "merge_complete"
    ]);
    expect(payload.records.map((r) => r.occurredAt)).toEqual([1000, 2000, 3000]);
  });

  it("filters by --goal and surfaces the goal id in the payload", async () => {
    const dataDir = makeTempDir();
    seedGoal(dataDir, "goal-a");
    seedGoal(dataDir, "goal-b");
    seedRecords(dataDir, [
      {
        source: "agent-workflow",
        type: "plan_created",
        occurredAt: 1000,
        summary: "goal-a plan",
        ingestKey: "agent-workflow:goal-a:plan_created",
        goalId: "goal-a"
      },
      {
        source: "agent-workflow",
        type: "plan_created",
        occurredAt: 1001,
        summary: "goal-b plan",
        ingestKey: "agent-workflow:goal-b:plan_created",
        goalId: "goal-b"
      },
      {
        source: "agent-workflow",
        type: "plan_created",
        occurredAt: 1002,
        summary: "unlinked plan",
        ingestKey: "agent-workflow:loose:plan_created"
      }
    ]);

    const result = await run([
      "evidence",
      "list",
      "--goal",
      "goal-a",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      goalId: string | null;
      count: number;
      records: Array<{ goalId: string | null; summary: string }>;
    };
    expect(payload.goalId).toBe("goal-a");
    expect(payload.count).toBe(1);
    expect(payload.records[0]?.goalId).toBe("goal-a");
    expect(payload.records[0]?.summary).toBe("goal-a plan");
  });

  it("rejects --goal pointing at a missing goal with a stable error code", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "evidence",
      "list",
      "--goal",
      "missing-goal",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "evidence list",
      code: "goal_not_found",
      goalId: "missing-goal"
    });
  });

  it("filters by --source-item and rejects missing source items", async () => {
    const dataDir = makeTempDir();
    seedSourceItem(dataDir, "si-1");
    seedSourceItem(dataDir, "si-2");
    seedRecords(dataDir, [
      {
        source: "agent-workflow",
        type: "plan_created",
        occurredAt: 1000,
        summary: "si-1 plan",
        ingestKey: "agent-workflow:si-1:plan_created",
        sourceItemId: "si-1"
      },
      {
        source: "agent-workflow",
        type: "plan_created",
        occurredAt: 1001,
        summary: "si-2 plan",
        ingestKey: "agent-workflow:si-2:plan_created",
        sourceItemId: "si-2"
      }
    ]);

    const ok = await run([
      "evidence",
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
      records: Array<{ sourceItemId: string | null }>;
    };
    expect(okPayload.sourceItemId).toBe("si-2");
    expect(okPayload.count).toBe(1);
    expect(okPayload.records[0]?.sourceItemId).toBe("si-2");

    const missing = await run([
      "evidence",
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
      command: "evidence list",
      code: "source_item_not_found",
      sourceItemId: "si-missing"
    });
  });

  it("filters by --source and --type to narrow records", async () => {
    const dataDir = makeTempDir();
    seedRecords(dataDir, [
      {
        source: "agent-workflow",
        type: "plan_created",
        occurredAt: 1000,
        summary: "wf plan",
        ingestKey: "agent-workflow:run-1:plan_created"
      },
      {
        source: "agent-workflow",
        type: "merge_complete",
        occurredAt: 2000,
        summary: "wf merge",
        ingestKey: "agent-workflow:run-1:merge-cleanup:complete"
      },
      {
        source: "linear",
        type: "issue_observed",
        occurredAt: 3000,
        summary: "linear observed",
        ingestKey: "linear:issue-1:observed"
      }
    ]);

    const sourceOnly = await run([
      "evidence",
      "list",
      "--source",
      "linear",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(sourceOnly.code).toBe(0);
    const sourcePayload = JSON.parse(sourceOnly.stdout) as {
      source: string | null;
      count: number;
      records: Array<{ source: string; type: string }>;
    };
    expect(sourcePayload.source).toBe("linear");
    expect(sourcePayload.count).toBe(1);
    expect(sourcePayload.records[0]?.source).toBe("linear");

    const typeOnly = await run([
      "evidence",
      "list",
      "--type",
      "plan_created",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(typeOnly.code).toBe(0);
    const typePayload = JSON.parse(typeOnly.stdout) as {
      type: string | null;
      count: number;
      records: Array<{ type: string }>;
    };
    expect(typePayload.type).toBe("plan_created");
    expect(typePayload.count).toBe(1);
    expect(typePayload.records[0]?.type).toBe("plan_created");
  });

  it("respects --limit by truncating the results", async () => {
    const dataDir = makeTempDir();
    seedRecords(dataDir, [
      {
        source: "agent-workflow",
        type: "plan_created",
        occurredAt: 1000,
        summary: "first",
        ingestKey: "agent-workflow:run-1:plan_created"
      },
      {
        source: "agent-workflow",
        type: "preflight_complete",
        occurredAt: 1100,
        summary: "second",
        ingestKey: "agent-workflow:run-1:preflight:complete"
      },
      {
        source: "agent-workflow",
        type: "implementation_complete",
        occurredAt: 1200,
        summary: "third",
        ingestKey: "agent-workflow:run-1:implementation:complete"
      }
    ]);

    const result = await run([
      "evidence",
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
      records: Array<{ summary: string }>;
    };
    expect(payload.limit).toBe(2);
    expect(payload.count).toBe(2);
    expect(payload.records.map((r) => r.summary)).toEqual(["first", "second"]);
  });

  it("rejects --limit with a non-integer value via the parse-flag layer", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "evidence",
      "list",
      "--limit",
      "abc",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Invalid value for --limit: abc");
  });

  it("emits a text summary in non-JSON mode with the per-record list", async () => {
    const dataDir = makeTempDir();
    seedRecords(dataDir, [
      {
        source: "agent-workflow",
        type: "plan_created",
        occurredAt: 1700000000000,
        summary: "wf plan",
        ingestKey: "agent-workflow:run-1:plan_created"
      }
    ]);

    const result = await run([
      "evidence",
      "list",
      "--data-dir",
      dataDir
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Evidence records: 1");
    expect(result.stdout).toContain("Goal: (any)");
    expect(result.stdout).toContain("Source item: (any)");
    expect(result.stdout).toContain("Source: (any)");
    expect(result.stdout).toContain("Type: (any)");
    expect(result.stdout).toContain(`Data dir: ${dataDir}`);
    expect(result.stdout).toContain("[agent-workflow/plan_created]");
    expect(result.stdout).toContain("wf plan");
  });
});
