import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runCli } from "../src/cli.js";
import { openDb } from "../src/adapters/db.js";
import { CODING_WORKFLOW_DEFINITION } from "../src/core/workflow/definition.js";

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

function makeTempDir(prefix = "momentum-cli-preview-coding-"): string {
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

type PreviewArgs = {
  dataDir: string;
  repoDir: string;
  runId?: string;
  objective?: string;
  json?: boolean;
  extra?: string[];
};

function previewCodingArgs(input: PreviewArgs): string[] {
  const argv = ["workflow", "run", "preview-coding"];
  if (input.runId !== undefined) argv.push("--run-id", input.runId);
  argv.push("--repo", input.repoDir);
  if (input.objective !== undefined) argv.push("--objective", input.objective);
  argv.push("--data-dir", input.dataDir);
  if (input.json !== false) argv.push("--json");
  if (input.extra) argv.push(...input.extra);
  return argv;
}

describe("momentum workflow run preview-coding", () => {
  it("previews the built-in coding plan with every step and executor family", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run(
      previewCodingArgs({
        dataDir,
        repoDir,
        runId: "preview-native-1",
        objective: "Inspect before approval"
      })
    );
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "workflow run preview-coding",
      preview: true,
      runId: "preview-native-1",
      source: "momentum-native-coding",
      state: "pending",
      approvalBoundary: null,
      definitionKey: "coding-workflow",
      definitionVersion: 1,
      repoPath: repoDir,
      objective: "Inspect before approval"
    });
    expect((payload["counts"] as { steps: number }).steps).toBe(6);
    expect(payload["steps"]).toEqual([
      {
        stepId: "preflight",
        kind: "preflight",
        executor: "one-shot",
        order: 0,
        required: true,
        state: "pending"
      },
      {
        stepId: "implementation",
        kind: "implementation",
        executor: "goal-loop",
        order: 1,
        required: true,
        state: "pending"
      },
      {
        stepId: "postflight",
        kind: "postflight",
        executor: "one-shot",
        order: 2,
        required: true,
        state: "pending"
      },
      {
        stepId: "no-mistakes",
        kind: "no-mistakes",
        executor: "no-mistakes",
        order: 3,
        required: true,
        state: "pending"
      },
      {
        stepId: "merge-cleanup",
        kind: "merge-cleanup",
        executor: "script",
        order: 4,
        required: true,
        state: "pending"
      },
      {
        stepId: "linear-refresh",
        kind: "linear-refresh",
        executor: "external-apply",
        order: 5,
        required: true,
        state: "pending"
      }
    ]);
  });

  it("writes nothing durable: no run row is created by a preview", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run(
      previewCodingArgs({
        dataDir,
        repoDir,
        runId: "preview-no-write",
        objective: "Preview only"
      })
    );
    expect(result.code).toBe(0);

    const db = openDb(dataDir);
    try {
      const runRow = db
        .prepare("SELECT id FROM workflow_runs WHERE id = ?")
        .get("preview-no-write");
      expect(runRow).toBeUndefined();
      const anyRun = db
        .prepare("SELECT COUNT(*) AS n FROM workflow_runs")
        .get() as { n: number };
      expect(anyRun.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it("produces stable output across repeated previews for the same inputs", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const args = previewCodingArgs({
      dataDir,
      repoDir,
      runId: "preview-stable",
      objective: "Stable for Discord",
      extra: ["--profile", "live-wrapper", "--issue-scope", "NGX-509"]
    });
    const first = await run(args);
    const second = await run(args);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(first.stdout).toBe(second.stdout);
  });

  it("surfaces the selected runtime/profile and approval boundary", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run(
      previewCodingArgs({
        dataDir,
        repoDir,
        runId: "preview-profile",
        objective: "Capture profile and boundary",
        extra: [
          "--profile",
          "live-wrapper",
          "--approval-boundary",
          "through-implementation"
        ]
      })
    );
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      state: "approved",
      approvalBoundary: "through-implementation",
      route: { profile: "live-wrapper" }
    });
    const steps = payload["steps"] as Array<{ stepId: string; state: string }>;
    const stateByStep = Object.fromEntries(
      steps.map((step) => [step.stepId, step.state])
    );
    expect(stateByStep).toMatchObject({
      preflight: "approved",
      implementation: "approved",
      postflight: "pending"
    });
  });

  it("renders a stable human preview listing each step and executor", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run(
      previewCodingArgs({
        dataDir,
        repoDir,
        runId: "preview-human",
        objective: "Readable plan",
        json: false,
        extra: ["--profile", "live-wrapper"]
      })
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("preview-human");
    expect(result.stdout).toContain("coding-workflow v1");
    expect(result.stdout).toContain("Profile: live-wrapper");
    expect(result.stdout).toContain("implementation");
    expect(result.stdout).toContain("goal-loop");
    expect(result.stdout).toContain("external-apply");
  });

  it("refuses a run id that already exists before previewing", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const started = await run([
      "workflow",
      "run",
      "start-coding",
      "--run-id",
      "preview-existing",
      "--repo",
      repoDir,
      "--objective",
      "Existing run",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(started.code).toBe(0);

    const result = await run(
      previewCodingArgs({
        dataDir,
        repoDir,
        runId: "preview-existing",
        objective: "Preview duplicate"
      })
    );
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run preview-coding",
      code: "run_exists",
      runId: "preview-existing"
    });
  });

  it("matches the durable run a start-coding would persist from the same inputs", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const sharedExtra = [
      "--profile",
      "live-wrapper",
      "--issue-scope",
      "NGX-509",
      "--approval-boundary",
      "through-implementation"
    ];

    const preview = await run(
      previewCodingArgs({
        dataDir,
        repoDir,
        runId: "preview-equiv",
        objective: "Equivalence",
        extra: sharedExtra
      })
    );
    expect(preview.code).toBe(0);
    const previewPayload = JSON.parse(preview.stdout) as Record<string, unknown>;
    const previewSteps = previewPayload["steps"] as Array<{
      stepId: string;
      kind: string;
      executor: string;
      order: number;
      required: boolean;
      state: string;
    }>;

    const started = await run([
      "workflow",
      "run",
      "start-coding",
      "--run-id",
      "preview-equiv",
      "--repo",
      repoDir,
      "--objective",
      "Equivalence",
      "--data-dir",
      dataDir,
      "--json",
      ...sharedExtra
    ]);
    expect(started.code).toBe(0);

    const db = openDb(dataDir);
    try {
      const runRow = db
        .prepare(
          `SELECT workflow_definition_key, workflow_definition_version,
                  approval_boundary, route_json
             FROM workflow_runs WHERE id = ?`
        )
        .get("preview-equiv") as {
        workflow_definition_key: string;
        workflow_definition_version: number;
        approval_boundary: string | null;
        route_json: string;
      };
      expect(runRow.workflow_definition_key).toBe(
        previewPayload["definitionKey"]
      );
      expect(runRow.workflow_definition_version).toBe(
        previewPayload["definitionVersion"]
      );
      expect(runRow.approval_boundary).toBe(previewPayload["approvalBoundary"]);
      expect(JSON.parse(runRow.route_json)).toEqual(previewPayload["route"]);

      const persistedSteps = db
        .prepare(
          `SELECT step_id, kind, step_order, required, state
             FROM workflow_steps WHERE run_id = ? ORDER BY step_order`
        )
        .all("preview-equiv") as Array<{
        step_id: string;
        kind: string;
        step_order: number;
        required: number;
        state: string;
      }>;
      expect(
        persistedSteps.map((step) => ({
          stepId: step.step_id,
          kind: step.kind,
          order: step.step_order,
          required: step.required === 1,
          state: step.state
        }))
      ).toEqual(
        previewSteps.map((step) => ({
          stepId: step.stepId,
          kind: step.kind,
          order: step.order,
          required: step.required,
          state: step.state
        }))
      );
    } finally {
      db.close();
    }

    // Executor families in the preview are reconstructable from the durable
    // (key, version) pin alone, so dispatch/approval can reference them later.
    expect(previewSteps.map((step) => step.executor)).toEqual(
      CODING_WORKFLOW_DEFINITION.steps.map((step) => step.executor)
    );
  });

  it("refuses a run id reserved for compatibility imports", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run(
      previewCodingArgs({
        dataDir,
        repoDir,
        runId: "cwfp-should-refuse",
        objective: "Reserved"
      })
    );
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run preview-coding",
      code: "reserved_run_id",
      runId: "cwfp-should-refuse"
    });
  });

  it("refuses a conflicting --definition that is not the coding workflow", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run(
      previewCodingArgs({
        dataDir,
        repoDir,
        runId: "preview-bad-def",
        objective: "Wrong definition",
        extra: ["--definition", "custom-flow"]
      })
    );
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run preview-coding",
      code: "definition_not_allowed"
    });
  });

  it("refuses when required inputs are missing", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();

    const noRunId = await run(
      previewCodingArgs({ dataDir, repoDir, objective: "no run id" })
    );
    expect(noRunId.code).toBe(1);
    expect(JSON.parse(noRunId.stderr)).toMatchObject({
      ok: false,
      command: "workflow run preview-coding",
      code: "run_id_required"
    });

    const noObjective = await run([
      "workflow",
      "run",
      "preview-coding",
      "--run-id",
      "preview-no-objective",
      "--repo",
      repoDir,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(noObjective.code).toBe(1);
    expect(JSON.parse(noObjective.stderr)).toMatchObject({
      ok: false,
      command: "workflow run preview-coding",
      code: "objective_required"
    });
  });
});

describe("workflow run start surfaces are unchanged by preview-coding", () => {
  it("keeps the generic workflow run start envelope free of preview state", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run([
      "workflow",
      "run",
      "start",
      "--run-id",
      "generic-unchanged",
      "--repo",
      repoDir,
      "--objective",
      "Generic start path",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "workflow run start",
      source: "workflow-definition"
    });
    expect(payload["preview"]).toBeUndefined();

    const db = openDb(dataDir);
    try {
      const runRow = db
        .prepare("SELECT id FROM workflow_runs WHERE id = ?")
        .get("generic-unchanged");
      expect(runRow).toMatchObject({ id: "generic-unchanged" });
    } finally {
      db.close();
    }
  });
});

describe("workflow run preview-coding public docs", () => {
  const doc = readDoc("docs/workflow-commands.md");

  it("names workflow run preview-coding in the command overview", () => {
    expect(doc).toContain("`workflow run preview-coding`");
  });

  it("documents a dedicated workflow run preview-coding section", () => {
    expect(doc).toMatch(/^## `workflow run preview-coding`$/m);
  });
});
