import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/cli.js";
import { openDb } from "../src/db.js";

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

function makeTempDir(prefix = "momentum-cli-workflow-import-"): string {
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

function buildCompletedRunFixture(rootDir: string, runId: string): string {
  const runDir = path.join(rootDir, runId);
  writeJsonFile(path.join(runDir, "plan.json"), {
    runId,
    schemaVersion: 1,
    mode: "execute-ready",
    profile: "momentum-m7",
    objective: "NGX-314 import current agent-workflow plans",
    repo: "/Users/test/repos/momentum",
    resolvedScope: {
      issues: ["NGX-314"],
      source: "explicit",
      status: "resolved"
    },
    skillRevision: {
      contract: "coding-workflow-pipeline compact skill architecture",
      digest:
        "abc123def4560000000000000000000000000000000000000000000000000000",
      version: "2026.05.22.18",
      schemaVersion: 1
    },
    approvalsRequired: [
      "implementation",
      "postflight:1",
      "no-mistakes",
      "merge-cleanup"
    ],
    taskFlow: {
      childTasks: [
        { stepId: "preflight" },
        { stepId: "implementation" },
        { stepId: "postflight:1" },
        { stepId: "no-mistakes" },
        { stepId: "merge-cleanup" }
      ]
    }
  });
  writeLedger(path.join(runDir, "ledger.jsonl"), [
    { runId, step: "preflight", status: "complete", ts: "2026-05-17T10:00:00Z" },
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
      step: "postflight:1",
      status: "complete",
      ts: "2026-05-17T10:35:00Z"
    },
    {
      runId,
      step: "no-mistakes",
      status: "complete",
      ts: "2026-05-17T10:40:00Z"
    },
    {
      runId,
      step: "merge-cleanup",
      status: "complete",
      ts: "2026-05-17T10:45:00Z"
    }
  ]);
  return runDir;
}

describe("momentum workflow import", () => {
  it("rejects unknown workflow subcommand", async () => {
    const dataDir = makeTempDir();
    const result = await run(["workflow", "nope", "--data-dir", dataDir]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Unknown workflow subcommand: nope");
  });

  it("rejects missing --path with a stable usage error", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "import",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow import",
      code: "path_required",
      diagnostics: []
    });
  });

  it("rejects unexpected positional argument", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "import",
      "extra",
      "--path",
      "/tmp/x",
      "--data-dir",
      dataDir
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      "Unexpected argument for workflow import: extra"
    );
  });

  it("reports import_path_unreadable when --path does not exist", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "import",
      "--path",
      "/nonexistent/path/should/not/exist",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow import",
      code: "import_path_unreadable",
      diagnostics: []
    });
  });

  it("imports a completed workflow run and persists rows", async () => {
    const dataDir = makeTempDir();
    const workflowRoot = makeTempDir("momentum-cli-workflow-import-runs-");
    const runId = "cwfp-cli0011completed";
    const runDir = buildCompletedRunFixture(workflowRoot, runId);

    const result = await run([
      "workflow",
      "import",
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
      runId: string;
      source: string;
      state: string;
      inserted: boolean;
      counts: {
        steps: number;
        approvals: number;
        diagnostics: number;
      };
      diagnostics: unknown[];
      monitor: unknown;
    };
    expect(payload.ok).toBe(true);
    expect(payload.command).toBe("workflow import");
    expect(payload.runId).toBe(runId);
    expect(payload.source).toBe("agent-workflow");
    expect(payload.state).toBe("succeeded");
    expect(payload.inserted).toBe(true);
    expect(payload.counts.steps).toBe(5);
    expect(payload.counts.approvals).toBe(0);
    expect(payload.counts.diagnostics).toBe(0);
    expect(payload.monitor).toBeNull();

    const db = openDb(dataDir);
    try {
      const runRow = db
        .prepare("SELECT id, state, source FROM workflow_runs WHERE id = ?")
        .get(runId) as { id: string; state: string; source: string };
      expect(runRow.id).toBe(runId);
      expect(runRow.state).toBe("succeeded");
      expect(runRow.source).toBe("agent-workflow");
      const stepRows = db
        .prepare(
          "SELECT step_id FROM workflow_steps WHERE run_id = ? ORDER BY step_order"
        )
        .all(runId) as Array<{ step_id: string }>;
      expect(stepRows.map((r) => r.step_id)).toEqual([
        "preflight",
        "implementation",
        "postflight:1",
        "no-mistakes",
        "merge-cleanup"
      ]);
    } finally {
      db.close();
    }
  });

  it("is idempotent: a second import reports inserted=false and preserves rows", async () => {
    const dataDir = makeTempDir();
    const workflowRoot = makeTempDir("momentum-cli-workflow-import-runs-");
    const runId = "cwfp-cli0022idempotent";
    const runDir = buildCompletedRunFixture(workflowRoot, runId);

    const first = await run([
      "workflow",
      "import",
      "--path",
      runDir,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(first.code).toBe(0);
    const firstPayload = JSON.parse(first.stdout) as {
      inserted: boolean;
      counts: { steps: number };
    };
    expect(firstPayload.inserted).toBe(true);
    expect(firstPayload.counts.steps).toBe(5);

    const second = await run([
      "workflow",
      "import",
      "--path",
      runDir,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(second.code).toBe(0);
    const secondPayload = JSON.parse(second.stdout) as {
      inserted: boolean;
      counts: { steps: number; approvals: number };
    };
    expect(secondPayload.inserted).toBe(false);
    expect(secondPayload.counts.steps).toBe(5);

    const db = openDb(dataDir);
    try {
      const stepCount = db
        .prepare(
          "SELECT COUNT(*) AS count FROM workflow_steps WHERE run_id = ?"
        )
        .get(runId) as { count: number };
      expect(stepCount.count).toBe(5);
      const runCount = db
        .prepare("SELECT COUNT(*) AS count FROM workflow_runs WHERE id = ?")
        .get(runId) as { count: number };
      expect(runCount.count).toBe(1);
    } finally {
      db.close();
    }
  });

  it("surfaces unknown-sibling diagnostics without dropping the import", async () => {
    const dataDir = makeTempDir();
    const workflowRoot = makeTempDir("momentum-cli-workflow-import-runs-");
    const runId = "cwfp-cli0033diagnostics";
    const runDir = buildCompletedRunFixture(workflowRoot, runId);
    fs.writeFileSync(path.join(runDir, "stray-artifact.txt"), "not known");

    const result = await run([
      "workflow",
      "import",
      "--path",
      runDir,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);

    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      counts: { diagnostics: number };
      diagnostics: Array<{ code: string; reason: string; path: string }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.counts.diagnostics).toBe(1);
    expect(payload.diagnostics[0]?.code).toBe("evidence_format_unknown");
    expect(payload.diagnostics[0]?.reason).toBe("unrecognized_filename");
    expect(payload.diagnostics[0]?.path).toContain("stray-artifact.txt");
  });
});
