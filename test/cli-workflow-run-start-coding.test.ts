import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runCli } from "../src/cli.js";
import { openDb } from "../src/adapters/db.js";
import { persistWorkflowDefinition } from "../src/core/workflow/definition/persist.js";
import type { WorkflowDefinition } from "../src/core/workflow/definition/definition.js";

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

function makeTempDir(prefix = "momentum-cli-start-coding-"): string {
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

function startCodingArgs(input: StartArgs): string[] {
  const argv = ["workflow", "run", "start-coding"];
  if (input.runId !== undefined) argv.push("--run-id", input.runId);
  argv.push("--repo", input.repoDir);
  if (input.objective !== undefined) argv.push("--objective", input.objective);
  argv.push("--data-dir", input.dataDir, "--json");
  if (input.extra) argv.push(...input.extra);
  return argv;
}

describe("momentum workflow run start-coding (NGX-508)", () => {
  it("starts a Momentum-native coding run with the built-in definition and six steps", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run(
      startCodingArgs({
        dataDir,
        repoDir,
        runId: "ngx-508-native-1",
        objective: "Dogfood the explicit door"
      })
    );
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "workflow run start-coding",
      runId: "ngx-508-native-1",
      source: "momentum-native-coding",
      state: "pending",
      approvalBoundary: null,
      definitionKey: "coding-workflow",
      definitionVersion: 1,
      repoPath: repoDir,
      objective: "Dogfood the explicit door"
    });
    expect((payload["counts"] as { steps: number }).steps).toBe(6);

    const db = openDb(dataDir);
    try {
      const runRow = db
        .prepare(
          `SELECT id, state, source, workflow_definition_key, workflow_definition_version
             FROM workflow_runs WHERE id = ?`
        )
        .get("ngx-508-native-1") as Record<string, unknown> | undefined;
      expect(runRow).toMatchObject({
        id: "ngx-508-native-1",
        state: "pending",
        source: "momentum-native-coding",
        workflow_definition_key: "coding-workflow",
        workflow_definition_version: 1
      });
      const steps = db
        .prepare(
          `SELECT step_id FROM workflow_steps WHERE run_id = ? ORDER BY step_order`
        )
        .all("ngx-508-native-1") as Array<{ step_id: string }>;
      expect(steps.map((s) => s.step_id)).toEqual([
        "preflight",
        "implementation",
        "postflight",
        "no-mistakes",
        "merge-cleanup",
        "linear-refresh"
      ]);
    } finally {
      db.close();
    }
  });

  it("ignores persisted coding-workflow overrides and starts the built-in six-step definition", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const overrideDefinition: WorkflowDefinition = {
      key: "coding-workflow",
      title: "Persisted Coding Override",
      version: 2,
      steps: [
        {
          key: "preflight",
          kind: "preflight",
          executor: "one-shot",
          order: 0,
          required: true
        },
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
      persistWorkflowDefinition(db, overrideDefinition, {
        now: 1_730_000_000_000
      });
    } finally {
      db.close();
    }

    const result = await run(
      startCodingArgs({
        dataDir,
        repoDir,
        runId: "ngx-508-persisted-override",
        objective: "Bypass persisted definition overrides"
      })
    );
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "workflow run start-coding",
      definitionKey: "coding-workflow",
      definitionVersion: 1
    });
    expect((payload["counts"] as { steps: number }).steps).toBe(6);

    const verifyDb = openDb(dataDir);
    try {
      const steps = verifyDb
        .prepare(
          `SELECT step_id, required FROM workflow_steps
             WHERE run_id = ? ORDER BY step_order`
        )
        .all("ngx-508-persisted-override") as Array<{
        step_id: string;
        required: number;
      }>;
      expect(steps).toEqual([
        { step_id: "preflight", required: 1 },
        { step_id: "implementation", required: 1 },
        { step_id: "postflight", required: 1 },
        { step_id: "no-mistakes", required: 1 },
        { step_id: "merge-cleanup", required: 1 },
        { step_id: "linear-refresh", required: 1 }
      ]);
    } finally {
      verifyDb.close();
    }
  });

  it("leaves persisted coding-workflow definitions available to the generic start route", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const overrideDefinition: WorkflowDefinition = {
      key: "coding-workflow",
      title: "Persisted Coding Override",
      version: 1,
      steps: [
        {
          key: "preflight",
          kind: "preflight",
          executor: "one-shot",
          order: 0,
          required: true
        },
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
      persistWorkflowDefinition(db, overrideDefinition, {
        now: 1_730_000_000_000
      });
    } finally {
      db.close();
    }

    const nativeResult = await run(
      startCodingArgs({
        dataDir,
        repoDir,
        runId: "ngx-508-native-before-generic",
        objective: "Use the built-in definition"
      })
    );
    expect(nativeResult.code).toBe(0);
    const nativePayload = JSON.parse(nativeResult.stdout) as Record<
      string,
      unknown
    >;
    expect((nativePayload["counts"] as { steps: number }).steps).toBe(6);

    const genericResult = await run([
      "workflow",
      "run",
      "start",
      "--run-id",
      "generic-after-native",
      "--repo",
      repoDir,
      "--objective",
      "Use the persisted definition",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(genericResult.code).toBe(0);
    const genericPayload = JSON.parse(genericResult.stdout) as Record<
      string,
      unknown
    >;
    expect(genericPayload).toMatchObject({
      ok: true,
      command: "workflow run start",
      definitionKey: "coding-workflow",
      definitionVersion: 1
    });
    expect((genericPayload["counts"] as { steps: number }).steps).toBe(2);
  });

  it("promotes approval-covered steps and opens approved with a boundary", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run(
      startCodingArgs({
        dataDir,
        repoDir,
        runId: "ngx-508-approved",
        objective: "Approve through implementation",
        extra: ["--approval-boundary", "through-implementation"]
      })
    );
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "workflow run start-coding",
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
        .all("ngx-508-approved") as Array<{ step_id: string }>;
      expect(approved.map((s) => s.step_id)).toEqual([
        "preflight",
        "implementation"
      ]);
      const approval = db
        .prepare(
          `SELECT boundary FROM workflow_approvals WHERE run_id = ?`
        )
        .get("ngx-508-approved") as { boundary: string } | undefined;
      expect(approval?.boundary).toBe("through-implementation");
    } finally {
      db.close();
    }
  });

  it("captures issue scope and skill revision on the native run", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run(
      startCodingArgs({
        dataDir,
        repoDir,
        runId: "ngx-508-scope",
        objective: "Capture inputs",
        extra: ["--issue-scope", "NGX-508", "--skill-revision", "rev-42"]
      })
    );
    expect(result.code).toBe(0);

    const db = openDb(dataDir);
    try {
      const runRow = db
        .prepare(
          `SELECT issue_scope_json, skill_revision FROM workflow_runs WHERE id = ?`
        )
        .get("ngx-508-scope") as {
        issue_scope_json: string;
        skill_revision: string | null;
      };
      expect(JSON.parse(runRow.issue_scope_json)).toMatchObject({
        identifier: "NGX-508"
      });
      expect(runRow.skill_revision).toBe("rev-42");
    } finally {
      db.close();
    }
  });

  it("captures the selected runtime/profile into the durable run route", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run(
      startCodingArgs({
        dataDir,
        repoDir,
        runId: "ngx-508-profile",
        objective: "Capture the selected runtime profile",
        extra: ["--profile", "ngx-499-coding-workflow-live-wrapper"]
      })
    );
    expect(result.code).toBe(0);

    const db = openDb(dataDir);
    try {
      const runRow = db
        .prepare(`SELECT route_json FROM workflow_runs WHERE id = ?`)
        .get("ngx-508-profile") as { route_json: string };
      expect(JSON.parse(runRow.route_json)).toMatchObject({
        profile: "ngx-499-coding-workflow-live-wrapper"
      });
    } finally {
      db.close();
    }

    // The captured profile is explainable from Momentum state alone.
    const status = await run([
      "workflow",
      "status",
      "ngx-508-profile",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(status.code).toBe(0);
    const statusPayload = JSON.parse(status.stdout) as Record<string, unknown>;
    expect(JSON.stringify(statusPayload)).toContain(
      "ngx-499-coding-workflow-live-wrapper"
    );
  });

  it("leaves the run route empty when no runtime/profile is selected", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run(
      startCodingArgs({
        dataDir,
        repoDir,
        runId: "ngx-508-no-profile",
        objective: "No profile selected"
      })
    );
    expect(result.code).toBe(0);

    const db = openDb(dataDir);
    try {
      const runRow = db
        .prepare(`SELECT route_json FROM workflow_runs WHERE id = ?`)
        .get("ngx-508-no-profile") as { route_json: string };
      expect(runRow.route_json).toBe("{}");
    } finally {
      db.close();
    }
  });

  it("refuses a run id reserved for cwfp/cwfb/overnight compatibility imports", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    for (const runId of ["cwfp-abc123", "cwfb-xyz", "overnight-safe-99"]) {
      const result = await run(
        startCodingArgs({
          dataDir,
          repoDir,
          runId,
          objective: "Should be rejected"
        })
      );
      expect(result.code).toBe(1);
      const payload = JSON.parse(result.stderr) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: false,
        command: "workflow run start-coding",
        code: "reserved_run_id",
        runId
      });
      const db = openDb(dataDir);
      try {
        const runRow = db
          .prepare("SELECT id FROM workflow_runs WHERE id = ?")
          .get(runId);
        expect(runRow).toBeUndefined();
      } finally {
        db.close();
      }
    }
  });

  it("refuses a conflicting --definition that is not the coding workflow", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run(
      startCodingArgs({
        dataDir,
        repoDir,
        runId: "ngx-508-bad-def",
        objective: "Wrong definition",
        extra: ["--definition", "custom-flow"]
      })
    );
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run start-coding",
      code: "definition_not_allowed"
    });
  });

  it("emits structural preflight evidence for missing built-in definition versions before durable writes", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run(
      startCodingArgs({
        dataDir,
        repoDir,
        runId: "ngx-563-missing-definition-version",
        objective: "Block missing built-in definition version",
        extra: ["--definition-version", "99"]
      })
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run start-coding",
      code: "definition_not_found",
      runId: "ngx-563-missing-definition-version"
    });
    expect(payload["preflightEvidence"]).toEqual([
      {
        checkId: "workflow.definition",
        status: "failed",
        severity: "error",
        path: "workflow.definition.version",
        key: "definitionVersion",
        message: "Built-in coding workflow definition version was not found.",
        recommendedAction:
          "Use the supported built-in coding workflow definition key and version."
      }
    ]);
    expect(fs.existsSync(path.join(dataDir, "momentum.db"))).toBe(false);
  });

  it("accepts an explicit --definition coding-workflow as a no-op selector", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run(
      startCodingArgs({
        dataDir,
        repoDir,
        runId: "ngx-508-explicit-def",
        objective: "Explicit coding definition",
        extra: ["--definition", "coding-workflow"]
      })
    );
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      definitionKey: "coding-workflow"
    });
  });

  it("refuses when --run-id is missing", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run(
      startCodingArgs({ dataDir, repoDir, objective: "no run id" })
    );
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run start-coding",
      code: "run_id_required"
    });
  });

  it("emits structural preflight evidence when --objective is missing", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run([
      "workflow",
      "run",
      "start-coding",
      "--run-id",
      "ngx-563-no-objective",
      "--repo",
      repoDir,
      "--data-dir",
      dataDir,
      "--json"
    ]);

    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run start-coding",
      code: "objective_required",
      runId: "ngx-563-no-objective"
    });
    expect(payload["preflightEvidence"]).toEqual([
      {
        checkId: "workflow.run_shape",
        status: "failed",
        severity: "error",
        path: "objective",
        key: "objective",
        message: "Objective must be a non-empty string.",
        recommendedAction:
          "Set objective to a non-empty objective before starting the run."
      }
    ]);
  });

  it("emits structural preflight evidence when --repo is blank before durable writes", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "run",
      "start-coding",
      "--run-id",
      "ngx-563-blank-repo",
      "--repo",
      "   ",
      "--objective",
      "Reject blank repo",
      "--data-dir",
      dataDir,
      "--json"
    ]);

    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run start-coding",
      code: "repo_required",
      runId: "ngx-563-blank-repo"
    });
    expect(payload["preflightEvidence"]).toEqual([
      {
        checkId: "workflow.run_shape",
        status: "failed",
        severity: "error",
        path: "repoPath",
        key: "repoPath",
        message: "Repo path must be a non-empty string.",
        recommendedAction:
          "Set repoPath to a non-empty repository path before starting the run."
      }
    ]);
    expect(fs.existsSync(path.join(dataDir, "momentum.db"))).toBe(false);
  });

  it("is readable through workflow status, handoff, and monitor from Momentum state alone", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const started = await run(
      startCodingArgs({
        dataDir,
        repoDir,
        runId: "ngx-508-readable",
        objective: "Explain from state"
      })
    );
    expect(started.code).toBe(0);

    const status = await run([
      "workflow",
      "status",
      "ngx-508-readable",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(status.code).toBe(0);
    const statusPayload = JSON.parse(status.stdout) as Record<string, unknown>;
    expect(statusPayload).toMatchObject({ ok: true });
    expect(JSON.stringify(statusPayload)).toContain("ngx-508-readable");

    const handoff = await run([
      "workflow",
      "handoff",
      "ngx-508-readable",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(handoff.code).toBe(0);
    expect(JSON.stringify(JSON.parse(handoff.stdout))).toContain(
      "ngx-508-readable"
    );

    const monitor = await run([
      "workflow",
      "run",
      "monitor",
      "ngx-508-readable",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(monitor.code).toBe(0);
  });
});

describe("momentum workflow run start-coding route reconfiguration (NGX-510)", () => {
  it("captures per-step route overrides into the durable run route", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run(
      startCodingArgs({
        dataDir,
        repoDir,
        runId: "ngx-510-steps",
        objective: "Reconfigure per-step route before kickoff",
        extra: [
          "--steps-json",
          JSON.stringify({
            "no-mistakes": { effort: "high" },
            implementation: { model: "  claude-opus-4-8  ", harness: "gnhf" }
          })
        ]
      })
    );
    expect(result.code).toBe(0);

    const db = openDb(dataDir);
    try {
      const runRow = db
        .prepare(`SELECT route_json FROM workflow_runs WHERE id = ?`)
        .get("ngx-510-steps") as { route_json: string };
      // Trimmed, and normalized to canonical step + field order (byte-stable).
      expect(JSON.parse(runRow.route_json)).toEqual({
        steps: {
          implementation: { harness: "gnhf", model: "claude-opus-4-8" },
          "no-mistakes": { effort: "high" }
        }
      });
      expect(runRow.route_json).toContain(
        '"steps":{"implementation":{"harness":"gnhf","model":"claude-opus-4-8"},"no-mistakes":{"effort":"high"}}'
      );
    } finally {
      db.close();
    }

    // The selected per-step config is explainable from Momentum state alone.
    const status = await run([
      "workflow",
      "status",
      "ngx-510-steps",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(status.code).toBe(0);
    expect(JSON.stringify(JSON.parse(status.stdout))).toContain(
      '"harness":"gnhf"'
    );
  });

  it("combines --profile and --steps-json into a single durable route", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run(
      startCodingArgs({
        dataDir,
        repoDir,
        runId: "ngx-510-profile-steps",
        objective: "Profile plus per-step overrides",
        extra: [
          "--profile",
          "ngx-499-coding-workflow-live-wrapper",
          "--steps-json",
          JSON.stringify({ postflight: { harness: "claude" } })
        ]
      })
    );
    expect(result.code).toBe(0);

    const db = openDb(dataDir);
    try {
      const runRow = db
        .prepare(`SELECT route_json FROM workflow_runs WHERE id = ?`)
        .get("ngx-510-profile-steps") as { route_json: string };
      expect(JSON.parse(runRow.route_json)).toEqual({
        profile: "ngx-499-coding-workflow-live-wrapper",
        steps: { postflight: { harness: "claude" } }
      });
    } finally {
      db.close();
    }
  });

  it("persists provider-normalized model strings in route.steps", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run(
      startCodingArgs({
        dataDir,
        repoDir,
        runId: "ngx-510-model-alias",
        objective: "Normalize model aliases before dispatch",
        extra: [
          "--steps-json",
          JSON.stringify({
            implementation: {
              harness: "claude",
              model: "sonnet",
              effort: "high"
            },
            postflight: {
              harness: "opencode",
              model: "gpt-5.5"
            },
            "no-mistakes": {
              harness: "codex",
              model: "openai/gpt-5.5",
              effort: "high"
            }
          })
        ]
      })
    );
    expect(result.code).toBe(0);

    const db = openDb(dataDir);
    try {
      const runRow = db
        .prepare(`SELECT route_json FROM workflow_runs WHERE id = ?`)
        .get("ngx-510-model-alias") as { route_json: string };
      expect(JSON.parse(runRow.route_json)).toEqual({
        steps: {
          implementation: {
            harness: "claude",
            model: "claude-sonnet-4-6",
            effort: "high"
          },
          postflight: {
            harness: "opencode",
            model: "openai/gpt-5.5"
          },
          "no-mistakes": {
            harness: "codex",
            model: "gpt-5.5",
            effort: "high"
          }
        }
      });
    } finally {
      db.close();
    }
  });

  it("fails closed on a misconfigured --steps-json and writes nothing", async () => {
    const cases = [
      {
        label: "unsupported step",
        json: JSON.stringify({ preflight: { model: "opus" } })
      },
      {
        label: "unknown field",
        json: JSON.stringify({ implementation: { temperature: "hot" } })
      },
      {
        label: "blank value",
        json: JSON.stringify({ implementation: { model: "   " } })
      },
      {
        label: "non-object step",
        json: JSON.stringify({ implementation: "opus" })
      },
      { label: "malformed json", json: "{ not json" }
    ];
    for (const [index, testCase] of cases.entries()) {
      const dataDir = makeTempDir();
      const repoDir = makeTempDir();
      const runId = `ngx-510-bad-${index}`;
      const result = await run(
        startCodingArgs({
          dataDir,
          repoDir,
          runId,
          objective: testCase.label,
          extra: ["--steps-json", testCase.json]
        })
      );
      expect(result.code, testCase.label).toBe(1);
      const payload = JSON.parse(result.stderr) as Record<string, unknown>;
      expect(payload, testCase.label).toMatchObject({
        ok: false,
        command: "workflow run start-coding",
        code: "route_config_invalid",
        runId
      });

      const db = openDb(dataDir);
      try {
        const runRow = db
          .prepare("SELECT id FROM workflow_runs WHERE id = ?")
          .get(runId);
        expect(runRow, testCase.label).toBeUndefined();
      } finally {
        db.close();
      }
    }
  });

  it("refuses --steps-json on the generic workflow run start door", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run([
      "workflow",
      "run",
      "start",
      "--run-id",
      "generic-steps-refused",
      "--repo",
      repoDir,
      "--objective",
      "Generic start refuses per-step coding overrides",
      "--data-dir",
      dataDir,
      "--json",
      "--steps-json",
      JSON.stringify({ implementation: { model: "opus" } })
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run start",
      code: "route_config_not_allowed"
    });

    const db = openDb(dataDir);
    try {
      const runRow = db
        .prepare("SELECT id FROM workflow_runs WHERE id = ?")
        .get("generic-steps-refused");
      expect(runRow).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe("default workflow run start is unchanged by the explicit door (NGX-508)", () => {
  it("still records the generic workflow-definition source and command", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run([
      "workflow",
      "run",
      "start",
      "--run-id",
      "generic-run",
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
  });

  it("still allows the generic start to use a cwfp-prefixed run id", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run([
      "workflow",
      "run",
      "start",
      "--run-id",
      "cwfp-generic-allowed",
      "--repo",
      repoDir,
      "--objective",
      "Generic path is unguarded",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({ ok: true, runId: "cwfp-generic-allowed" });
  });
});

describe("workflow run start-coding public docs (NGX-508)", () => {
  const doc = readDoc("docs/workflow-commands.md");

  it("names workflow run start-coding in the command overview", () => {
    expect(doc).toContain("`workflow run start-coding`");
  });

  it("documents a dedicated workflow run start-coding section", () => {
    expect(doc).toMatch(/^## `workflow run start-coding`$/m);
  });

  it("documents the explicit-door refusal codes", () => {
    for (const code of ["reserved_run_id", "definition_not_allowed"]) {
      expect(
        doc,
        `docs/workflow-commands.md is missing refusal code ${code}`
      ).toContain(code);
    }
  });

  it("documents the --profile runtime/profile capture and its route.profile target", () => {
    expect(doc).toContain("`--profile <name>`");
    expect(doc).toContain("`route.profile`");
  });

  it("documents the --steps-json per-step route override capture and its route.steps target", () => {
    expect(doc).toContain("`--steps-json <json>`");
    expect(doc).toContain("`route.steps`");
    expect(doc).toContain("route_config_invalid");
  });
});
