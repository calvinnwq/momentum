import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runCli } from "../src/cli.js";
import { openDb, type MomentumDb } from "../src/db.js";
import { persistWorkflowDefinition } from "../src/workflow-definition-persist.js";
import type { WorkflowDefinition } from "../src/workflow-definition.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readDoc(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), "utf8");
}

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

function makeTempDir(prefix = "momentum-cli-workflow-run-start-"): string {
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

type StartArgs = {
  dataDir: string;
  repoDir: string;
  runId?: string;
  objective?: string;
  extra?: string[];
};

function startArgs(input: StartArgs): string[] {
  const argv = ["workflow", "run", "start"];
  if (input.runId !== undefined) argv.push("--run-id", input.runId);
  argv.push("--repo", input.repoDir);
  if (input.objective !== undefined) argv.push("--objective", input.objective);
  argv.push("--data-dir", input.dataDir, "--json");
  if (input.extra) argv.push(...input.extra);
  return argv;
}

describe("momentum workflow run start (NGX-346)", () => {
  it("starts a run from the built-in coding workflow definition", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run(
      startArgs({ dataDir, repoDir, runId: "run-1", objective: "Ship NGX-346" })
    );
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "workflow run start",
      runId: "run-1",
      source: "workflow-definition",
      state: "pending",
      approvalBoundary: null,
      definitionKey: "coding-workflow",
      definitionVersion: 1,
      repoPath: repoDir,
      objective: "Ship NGX-346"
    });
    expect((payload["counts"] as { steps: number }).steps).toBe(6);
    expect((payload["policy"] as { present: boolean }).present).toBe(false);

    const db = openDb(dataDir);
    try {
      const runRow = db
        .prepare(
          `SELECT id, state, source, repo_path, objective,
                  workflow_definition_key, workflow_definition_version
             FROM workflow_runs WHERE id = ?`
        )
        .get("run-1") as Record<string, unknown> | undefined;
      expect(runRow).toMatchObject({
        id: "run-1",
        state: "pending",
        source: "workflow-definition",
        repo_path: repoDir,
        objective: "Ship NGX-346",
        workflow_definition_key: "coding-workflow",
        workflow_definition_version: 1
      });
      const steps = db
        .prepare(
          `SELECT step_id, kind, state, step_order
             FROM workflow_steps WHERE run_id = ? ORDER BY step_order`
        )
        .all("run-1") as Array<{ step_id: string; state: string }>;
      expect(steps.map((s) => s.step_id)).toEqual([
        "preflight",
        "implementation",
        "postflight",
        "no-mistakes",
        "merge-cleanup",
        "linear-refresh"
      ]);
      expect(steps.every((s) => s.state === "pending")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("promotes approval-covered steps and opens approved with a boundary", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run(
      startArgs({
        dataDir,
        repoDir,
        runId: "run-approved",
        objective: "Ship NGX-346",
        extra: ["--approval-boundary", "through-implementation"]
      })
    );
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      state: "approved",
      approvalBoundary: "through-implementation"
    });

    const db = openDb(dataDir);
    try {
      const approved = db
        .prepare(
          `SELECT step_id FROM workflow_steps
             WHERE run_id = ? AND state = 'approved' ORDER BY step_order`
        )
        .all("run-approved") as Array<{ step_id: string }>;
      expect(approved.map((s) => s.step_id)).toEqual([
        "preflight",
        "implementation"
      ]);
    } finally {
      db.close();
    }
  });

  it("starts from a persisted definition when one exists", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const definition: WorkflowDefinition = {
      key: "custom-flow",
      title: "Custom Flow",
      version: 2,
      steps: [
        { key: "preflight", kind: "preflight", executor: "one-shot", order: 0, required: true },
        {
          key: "implementation",
          kind: "implementation",
          executor: "goal-loop",
          order: 1,
          required: false
        }
      ]
    };
    const db = openDb(dataDir);
    try {
      persistWorkflowDefinition(db, definition, { now: 1_730_000_000_000 });
    } finally {
      db.close();
    }

    const result = await run(
      startArgs({
        dataDir,
        repoDir,
        runId: "run-custom",
        objective: "Run the custom flow",
        extra: ["--definition", "custom-flow"]
      })
    );
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      definitionKey: "custom-flow",
      definitionVersion: 2
    });
    expect((payload["counts"] as { steps: number }).steps).toBe(2);
  });

  it("refuses when --run-id is missing", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run(
      startArgs({ dataDir, repoDir, objective: "no run id" })
    );
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run start",
      code: "run_id_required"
    });
  });

  it("refuses when --repo is missing", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "run",
      "start",
      "--run-id",
      "run-x",
      "--objective",
      "no repo",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run start",
      code: "repo_required"
    });
  });

  it("refuses when --objective is missing", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run(startArgs({ dataDir, repoDir, runId: "run-y" }));
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run start",
      code: "objective_required"
    });
  });

  it("refuses unexpected positional or unknown arguments", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run(
      startArgs({
        dataDir,
        repoDir,
        runId: "run-extra",
        objective: "bad args",
        extra: ["--definiton", "custom-flow"]
      })
    );
    expect(result.code).toBe(2);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      code: "usage_error",
      message: "Unexpected argument for workflow run start: --definiton"
    });
  });

  it("refuses an unknown --definition with definition_not_found", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run(
      startArgs({
        dataDir,
        repoDir,
        runId: "run-z",
        objective: "unknown definition",
        extra: ["--definition", "does-not-exist"]
      })
    );
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run start",
      code: "definition_not_found"
    });
  });

  it("refuses a --definition-version that matches no persisted or built-in version", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run(
      startArgs({
        dataDir,
        repoDir,
        runId: "run-ver",
        objective: "pin a missing version",
        extra: ["--definition-version", "99"]
      })
    );
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run start",
      code: "definition_not_found"
    });
  });

  it("refuses a duplicate run id with run_exists and leaves the first run intact", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const first = await run(
      startArgs({ dataDir, repoDir, runId: "dup", objective: "first" })
    );
    expect(first.code).toBe(0);
    const second = await run(
      startArgs({ dataDir, repoDir, runId: "dup", objective: "second" })
    );
    expect(second.code).toBe(1);
    const payload = JSON.parse(second.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run start",
      code: "run_exists",
      runId: "dup"
    });

    const db = openDb(dataDir);
    try {
      const objective = (
        db
          .prepare("SELECT objective FROM workflow_runs WHERE id = ?")
          .get("dup") as { objective: string }
      ).objective;
      expect(objective).toBe("first");
    } finally {
      db.close();
    }
  });

  it("refuses an invalid --approval-boundary via the run-start taxonomy", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run(
      startArgs({
        dataDir,
        repoDir,
        runId: "run-bad-boundary",
        objective: "bad boundary",
        extra: ["--approval-boundary", "not-a-boundary"]
      })
    );
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as {
      ok: boolean;
      command: string;
      code: string;
      errors?: Array<{ code: string }>;
    };
    expect(payload.ok).toBe(false);
    expect(payload.command).toBe("workflow run start");
    expect(payload.code).toBe("invalid_run_start");
    expect(payload.errors?.map((e) => e.code)).toContain(
      "approval_boundary_invalid"
    );
  });

  it("refuses a malformed MOMENTUM.md repo policy with policy_invalid", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    fs.writeFileSync(
      path.join(repoDir, "MOMENTUM.md"),
      "---\nrunner: 42\n---\n",
      "utf-8"
    );
    const result = await run(
      startArgs({
        dataDir,
        repoDir,
        runId: "run-bad-policy",
        objective: "bad policy"
      })
    );
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run start",
      code: "policy_invalid"
    });

    const db = openDb(dataDir);
    try {
      const runRow = db
        .prepare("SELECT id FROM workflow_runs WHERE id = ?")
        .get("run-bad-policy");
      expect(runRow).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("emits readable text output without --json", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run([
      "workflow",
      "run",
      "start",
      "--run-id",
      "run-text",
      "--repo",
      repoDir,
      "--objective",
      "Plain text run",
      "--data-dir",
      dataDir
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("run-text");
    expect(result.stdout).toContain("coding-workflow");
  });
});

describe("workflow run start public docs (NGX-346)", () => {
  const doc = readDoc("docs/workflow-commands.md");

  it("names workflow run start in the command overview", () => {
    expect(doc).toContain("`workflow run start`");
  });

  it("documents a dedicated workflow run start section", () => {
    expect(doc).toMatch(/^## `workflow run start`$/m);
  });

  it("documents every workflow run start CLI refusal code", () => {
    for (const code of [
      "run_id_required",
      "repo_required",
      "objective_required",
      "data_dir_failed",
      "definition_not_found",
      "policy_invalid",
      "invalid_run_start",
      "run_exists"
    ]) {
      expect(doc, `docs/workflow-commands.md is missing refusal code ${code}`).toContain(
        code
      );
    }
  });

  it("documents the invalid_run_start materialization taxonomy", () => {
    for (const code of [
      "definition_invalid",
      "run_id_invalid",
      "repo_path_invalid",
      "objective_invalid",
      "approval_boundary_invalid",
      "issue_scope_invalid",
      "route_invalid"
    ]) {
      expect(doc, `docs/workflow-commands.md is missing taxonomy code ${code}`).toContain(
        code
      );
    }
  });
});
