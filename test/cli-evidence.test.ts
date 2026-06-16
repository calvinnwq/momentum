import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/cli.js";
import { openDb } from "../src/adapters/db.js";
import { listEvidenceRecords } from "../src/core/evidence/records.js";
import { listUpdateIntents } from "../src/core/intent/update-intents.js";

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

function makeTempDir(prefix = "momentum-cli-evidence-"): string {
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

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function writeLedger(filePath: string, lines: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`
  );
}

function buildWorkflowFixture(rootDir: string, runId: string): string {
  const runDir = path.join(rootDir, runId);
  writeJsonFile(path.join(runDir, "plan.json"), {
    runId,
    schemaVersion: 1,
    mode: "execute-ready",
    profile: "momentum-m5",
    objective: "NGX-291 M5-04 workflow evidence ingestion",
    resolvedScope: {
      issues: ["NGX-291"],
      source: "explicit",
      status: "resolved"
    }
  });
  writeLedger(path.join(runDir, "ledger.jsonl"), [
    {
      runId,
      step: "preflight",
      status: "complete",
      ts: "2026-05-17T10:00:00Z"
    },
    {
      runId,
      step: "implementation",
      status: "started",
      ts: "2026-05-17T10:01:00Z"
    },
    {
      runId,
      step: "implementation",
      status: "complete",
      ts: "2026-05-17T10:30:00Z"
    },
    {
      runId,
      step: "merge-cleanup",
      status: "complete",
      ts: "2026-05-17T10:45:00Z",
      pr: "https://github.com/example/momentum/pull/99",
      mergeCommit: "0123456789abcdef0123456789abcdef01234567",
      branch: "gnhf/test-branch",
      linearIssue: "NGX-291",
      linearState: "Done",
      verification: ["pnpm test", "pnpm typecheck"]
    }
  ]);
  return runDir;
}

function seedGoal(
  dataDir: string,
  goalId: string,
  state: string = "queued"
): void {
  const db = openDb(dataDir);
  try {
    db.prepare(
      `INSERT INTO goals
         (id, title, branch, artifact_dir, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(goalId, "evidence goal", "momentum/test", "/tmp/test", state, 1, 1);
  } finally {
    db.close();
  }
}

function seedSourceItem(
  dataDir: string,
  sourceItemId: string,
  goalId: string | null = null
): void {
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
      "Workflow evidence ingestion",
      "open",
      "{}",
      1,
      goalId,
      1,
      1
    );
  } finally {
    db.close();
  }
}

describe("momentum evidence ingest", () => {
  it("rejects missing --path with a stable usage error", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "evidence",
      "ingest",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "evidence ingest",
      code: "path_required"
    });
  });

  it("rejects unknown evidence subcommand", async () => {
    const dataDir = makeTempDir();
    const result = await run(["evidence", "nope", "--data-dir", dataDir]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Unknown evidence subcommand: nope");
  });

  it("rejects unexpected positional argument", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "evidence",
      "ingest",
      "extra",
      "--path",
      "/tmp/x",
      "--data-dir",
      dataDir
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      "Unexpected argument for evidence ingest: extra"
    );
  });

  it("ingests a workflow directory and reports observed/created/skipped counts", async () => {
    const dataDir = makeTempDir();
    const workflowRoot = makeTempDir("momentum-cli-evidence-workflows-");
    const runDir = buildWorkflowFixture(workflowRoot, "cwfp-abc123def456");

    const result = await run([
      "evidence",
      "ingest",
      "--path",
      runDir,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);

    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      command: string;
      counts: {
        observed: number;
        created: number;
        skipped: number;
        diagnostics: number;
        errors: number;
      };
      created: Array<{ type: string; ingestKey: string }>;
      diagnostics: unknown[];
    };
    expect(payload.ok).toBe(true);
    expect(payload.command).toBe("evidence ingest");
    expect(payload.counts.observed).toBe(5);
    expect(payload.counts.created).toBe(5);
    expect(payload.counts.skipped).toBe(0);
    expect(payload.counts.diagnostics).toBe(0);
    expect(payload.counts.errors).toBe(0);
    expect(payload.created.map((r) => r.type)).toEqual([
      "plan_created",
      "preflight_complete",
      "implementation_started",
      "implementation_complete",
      "merge_complete"
    ]);

    const db = openDb(dataDir);
    try {
      const records = listEvidenceRecords(db, {});
      expect(records.length).toBe(5);
      expect(records.every((r) => r.source === "agent-workflow")).toBe(true);
      expect(records.every((r) => r.formatVersion === 1)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("persists typed runId/stepId linkage when ingesting a workflow directory", async () => {
    const dataDir = makeTempDir();
    const workflowRoot = makeTempDir("momentum-cli-evidence-workflows-");
    const runDir = buildWorkflowFixture(workflowRoot, "cwfp-typedlink001");

    const result = await run([
      "evidence",
      "ingest",
      "--path",
      runDir,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);

    // The ingest JSON output surfaces typed linkage on every created record.
    const payload = JSON.parse(result.stdout) as {
      created: Array<{
        type: string;
        runId: string | null;
        stepId: string | null;
      }>;
    };
    const createdByType = new Map(payload.created.map((r) => [r.type, r]));
    expect(createdByType.get("plan_created")).toMatchObject({
      runId: "cwfp-typedlink001",
      stepId: null
    });
    expect(createdByType.get("implementation_complete")).toMatchObject({
      runId: "cwfp-typedlink001",
      stepId: "implementation"
    });

    const db = openDb(dataDir);
    try {
      const records = listEvidenceRecords(db, {});
      // Every workflow-sourced row links to the owning run.
      expect(records.every((r) => r.runId === "cwfp-typedlink001")).toBe(true);

      const byType = new Map(records.map((r) => [r.type, r]));
      // Run-scoped plan record carries no step linkage.
      expect(byType.get("plan_created")!.stepId).toBeNull();
      // Ledger step events carry the durable step id (the bare step name).
      expect(byType.get("preflight_complete")!.stepId).toBe("preflight");
      expect(byType.get("implementation_started")!.stepId).toBe("implementation");
      expect(byType.get("implementation_complete")!.stepId).toBe("implementation");
      expect(byType.get("merge_complete")!.stepId).toBe("merge-cleanup");
    } finally {
      db.close();
    }
  });

  it("is idempotent across repeated ingestions of the same artifact", async () => {
    const dataDir = makeTempDir();
    const workflowRoot = makeTempDir("momentum-cli-evidence-workflows-");
    const runDir = buildWorkflowFixture(workflowRoot, "cwfp-idem001ledger");

    const first = await run([
      "evidence",
      "ingest",
      "--path",
      runDir,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(first.code).toBe(0);
    const firstPayload = JSON.parse(first.stdout) as {
      counts: { created: number; skipped: number };
    };
    expect(firstPayload.counts.created).toBe(5);
    expect(firstPayload.counts.skipped).toBe(0);

    const second = await run([
      "evidence",
      "ingest",
      "--path",
      runDir,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(second.code).toBe(0);
    const secondPayload = JSON.parse(second.stdout) as {
      counts: { observed: number; created: number; skipped: number };
    };
    expect(secondPayload.counts.observed).toBe(5);
    expect(secondPayload.counts.created).toBe(0);
    expect(secondPayload.counts.skipped).toBe(5);

    const db = openDb(dataDir);
    try {
      expect(listEvidenceRecords(db, {}).length).toBe(5);
    } finally {
      db.close();
    }
  });

  it("attaches existing unlinked records when an idempotent replay provides a goal", async () => {
    const dataDir = makeTempDir();
    const workflowRoot = makeTempDir("momentum-cli-evidence-workflows-");
    const runDir = buildWorkflowFixture(workflowRoot, "cwfp-idemlinkgoal");
    seedGoal(dataDir, "g-evidence-replay");

    const first = await run([
      "evidence",
      "ingest",
      "--path",
      runDir,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(first.code).toBe(0);

    const second = await run([
      "evidence",
      "ingest",
      "--path",
      runDir,
      "--goal",
      "g-evidence-replay",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(second.code).toBe(0);
    const payload = JSON.parse(second.stdout) as {
      goalId: string | null;
      counts: { created: number; skipped: number };
    };
    expect(payload.goalId).toBe("g-evidence-replay");
    expect(payload.counts.created).toBe(0);
    expect(payload.counts.skipped).toBe(5);

    const db = openDb(dataDir);
    try {
      const records = listEvidenceRecords(db, { goalId: "g-evidence-replay" });
      expect(records.length).toBe(5);
      expect(records.every((r) => r.goalId === "g-evidence-replay")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("returns evidence_format_unknown diagnostics for unsupported sibling files without crashing", async () => {
    const dataDir = makeTempDir();
    const workflowRoot = makeTempDir("momentum-cli-evidence-workflows-");
    const runDir = buildWorkflowFixture(workflowRoot, "cwfp-diag00unknown");
    fs.writeFileSync(path.join(runDir, "stray.txt"), "not a workflow file\n");

    const result = await run([
      "evidence",
      "ingest",
      "--path",
      runDir,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      counts: { observed: number; created: number; diagnostics: number };
      diagnostics: Array<{ code: string; reason: string }>;
    };
    expect(payload.counts.observed).toBe(5);
    expect(payload.counts.created).toBe(5);
    expect(payload.counts.diagnostics).toBe(1);
    expect(payload.diagnostics[0]).toMatchObject({
      code: "evidence_format_unknown",
      reason: "unrecognized_filename"
    });
  });

  it("links new records to a goal when --goal is provided and the goal exists", async () => {
    const dataDir = makeTempDir();
    const workflowRoot = makeTempDir("momentum-cli-evidence-workflows-");
    const runDir = buildWorkflowFixture(workflowRoot, "cwfp-goal00linked0");
    seedGoal(dataDir, "g-evidence-1");

    const result = await run([
      "evidence",
      "ingest",
      "--path",
      runDir,
      "--goal",
      "g-evidence-1",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      goalId: string | null;
      counts: { created: number };
    };
    expect(payload.goalId).toBe("g-evidence-1");
    expect(payload.counts.created).toBe(5);

    const db = openDb(dataDir);
    try {
      const records = listEvidenceRecords(db, { goalId: "g-evidence-1" });
      expect(records.length).toBe(5);
      expect(records.every((r) => r.goalId === "g-evidence-1")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("creates a pending source_satisfied intent when ingesting completed goal evidence", async () => {
    const dataDir = makeTempDir();
    const workflowRoot = makeTempDir("momentum-cli-evidence-workflows-");
    const runDir = buildWorkflowFixture(workflowRoot, "cwfp-intentgoal000");
    seedGoal(dataDir, "g-evidence-intent", "completed");
    seedSourceItem(dataDir, "si-intent-goal", "g-evidence-intent");

    const result = await run([
      "evidence",
      "ingest",
      "--path",
      runDir,
      "--goal",
      "g-evidence-intent",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      counts: { intentsCreated: number; intentsReplayed: number };
      intentEvaluations: Array<{
        outcome: string;
        intent?: { status: string; sourceItemId: string | null };
      }>;
    };
    expect(payload.counts.intentsCreated).toBe(1);
    expect(payload.counts.intentsReplayed).toBe(0);
    expect(payload.intentEvaluations[0]?.outcome).toBe("intent_created");
    expect(payload.intentEvaluations[0]?.intent).toMatchObject({
      status: "pending",
      sourceItemId: "si-intent-goal"
    });

    const db = openDb(dataDir);
    try {
      const intents = listUpdateIntents(db, {
        status: "pending",
        goalId: "g-evidence-intent"
      });
      expect(intents).toHaveLength(1);
      expect(intents[0]?.sourceItemId).toBe("si-intent-goal");
      expect(intents[0]?.intentType).toBe("source_satisfied");
    } finally {
      db.close();
    }
  });

  it("reports every pending source_satisfied intent created for a multi-source completed goal", async () => {
    const dataDir = makeTempDir();
    const workflowRoot = makeTempDir("momentum-cli-evidence-workflows-");
    const runDir = buildWorkflowFixture(workflowRoot, "cwfp-intentmulti00");
    seedGoal(dataDir, "g-evidence-multi", "completed");
    seedSourceItem(dataDir, "si-intent-a", "g-evidence-multi");
    seedSourceItem(dataDir, "si-intent-b", "g-evidence-multi");

    const result = await run([
      "evidence",
      "ingest",
      "--path",
      runDir,
      "--goal",
      "g-evidence-multi",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      counts: { intentsCreated: number };
      intentEvaluations: Array<{
        outcome: string;
        intent?: { sourceItemId: string | null };
      }>;
    };
    expect(payload.counts.intentsCreated).toBe(2);
    expect(payload.intentEvaluations.map((entry) => entry.outcome)).toEqual([
      "intent_created",
      "intent_created"
    ]);
    expect(
      payload.intentEvaluations.map((entry) => entry.intent?.sourceItemId).sort()
    ).toEqual(["si-intent-a", "si-intent-b"]);
  });

  it("reports an intent warning when multi-source evidence covers only one linked source item", async () => {
    const dataDir = makeTempDir();
    const workflowRoot = makeTempDir("momentum-cli-evidence-workflows-");
    const runDir = buildWorkflowFixture(workflowRoot, "cwfp-intentpartial");
    seedGoal(dataDir, "g-evidence-partial", "completed");
    seedSourceItem(dataDir, "si-covered", "g-evidence-partial");
    seedSourceItem(dataDir, "si-uncovered", "g-evidence-partial");

    const result = await run([
      "evidence",
      "ingest",
      "--path",
      runDir,
      "--source-item",
      "si-covered",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      counts: { intentsCreated: number; intentWarnings: number };
      intentEvaluations: Array<{
        outcome: string;
        warning?: { sourceItemId: string };
      }>;
    };
    expect(payload.counts.intentsCreated).toBe(1);
    expect(payload.counts.intentWarnings).toBe(1);
    expect(payload.intentEvaluations.map((entry) => entry.outcome)).toEqual([
      "intent_created",
      "evidence_insufficient"
    ]);
    expect(payload.intentEvaluations[1]?.warning?.sourceItemId).toBe(
      "si-uncovered"
    );
  });

  it("rejects --goal pointing at a missing goal before parsing", async () => {
    const dataDir = makeTempDir();
    const workflowRoot = makeTempDir("momentum-cli-evidence-workflows-");
    const runDir = buildWorkflowFixture(workflowRoot, "cwfp-goal00missing0");

    const result = await run([
      "evidence",
      "ingest",
      "--path",
      runDir,
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
      command: "evidence ingest",
      code: "goal_not_found",
      goalId: "missing-goal"
    });

    const db = openDb(dataDir);
    try {
      expect(listEvidenceRecords(db, {}).length).toBe(0);
    } finally {
      db.close();
    }
  });

  it("rejects --source-item pointing at a missing source item before parsing", async () => {
    const dataDir = makeTempDir();
    const workflowRoot = makeTempDir("momentum-cli-evidence-workflows-");
    const runDir = buildWorkflowFixture(workflowRoot, "cwfp-source0missing");

    const result = await run([
      "evidence",
      "ingest",
      "--path",
      runDir,
      "--source-item",
      "missing-item",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "evidence ingest",
      code: "source_item_not_found",
      sourceItemId: "missing-item"
    });

    const db = openDb(dataDir);
    try {
      expect(listEvidenceRecords(db, {}).length).toBe(0);
    } finally {
      db.close();
    }
  });

  it("links new records to a source item when --source-item is provided and exists", async () => {
    const dataDir = makeTempDir();
    const workflowRoot = makeTempDir("momentum-cli-evidence-workflows-");
    const runDir = buildWorkflowFixture(workflowRoot, "cwfp-source0linked0");
    seedSourceItem(dataDir, "si-1");

    const result = await run([
      "evidence",
      "ingest",
      "--path",
      runDir,
      "--source-item",
      "si-1",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      sourceItemId: string | null;
      counts: { created: number };
    };
    expect(payload.sourceItemId).toBe("si-1");
    expect(payload.counts.created).toBe(5);

    const db = openDb(dataDir);
    try {
      const records = listEvidenceRecords(db, { sourceItemId: "si-1" });
      expect(records.length).toBe(5);
    } finally {
      db.close();
    }
  });

  it("creates a pending source_satisfied intent from source-item-linked completed goal evidence", async () => {
    const dataDir = makeTempDir();
    const workflowRoot = makeTempDir("momentum-cli-evidence-workflows-");
    const runDir = buildWorkflowFixture(workflowRoot, "cwfp-intentsource00");
    seedGoal(dataDir, "g-source-intent", "completed");
    seedSourceItem(dataDir, "si-intent-source", "g-source-intent");

    const result = await run([
      "evidence",
      "ingest",
      "--path",
      runDir,
      "--source-item",
      "si-intent-source",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      counts: { intentsCreated: number };
      intentEvaluations: Array<{
        outcome: string;
        verificationEvidence?: { sourceItemId: string | null };
      }>;
    };
    expect(payload.counts.intentsCreated).toBe(1);
    expect(payload.intentEvaluations[0]?.outcome).toBe("intent_created");
    expect(payload.intentEvaluations[0]?.verificationEvidence).toMatchObject({
      sourceItemId: "si-intent-source"
    });

    const db = openDb(dataDir);
    try {
      const intents = listUpdateIntents(db, {
        status: "pending",
        goalId: "g-source-intent"
      });
      expect(intents).toHaveLength(1);
      expect(intents[0]?.sourceItemId).toBe("si-intent-source");
    } finally {
      db.close();
    }
  });

  it("emits a text summary in non-JSON mode that surfaces counts and the data dir", async () => {
    const dataDir = makeTempDir();
    const workflowRoot = makeTempDir("momentum-cli-evidence-workflows-");
    const runDir = buildWorkflowFixture(workflowRoot, "cwfp-text00summary");

    const result = await run([
      "evidence",
      "ingest",
      "--path",
      runDir,
      "--data-dir",
      dataDir
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Evidence ingest: ${runDir}`);
    expect(result.stdout).toContain("Observed: 5");
    expect(result.stdout).toContain("Created: 5");
    expect(result.stdout).toContain("Skipped (idempotent): 0");
    expect(result.stdout).toContain(`Data dir: ${dataDir}`);
  });

  it("surfaces evidence_format_invalid for an unreadable path without crashing", async () => {
    const dataDir = makeTempDir();
    const missingPath = path.join(
      makeTempDir("momentum-cli-evidence-missing-"),
      "does-not-exist"
    );

    const result = await run([
      "evidence",
      "ingest",
      "--path",
      missingPath,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      counts: { observed: number; diagnostics: number };
      diagnostics: Array<{ code: string; reason: string }>;
    };
    expect(payload.counts.observed).toBe(0);
    expect(payload.counts.diagnostics).toBe(1);
    expect(payload.diagnostics[0]).toMatchObject({
      code: "evidence_format_invalid",
      reason: "path_not_readable"
    });
  });
});
