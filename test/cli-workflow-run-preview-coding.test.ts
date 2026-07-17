import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runCli } from "../src/cli.js";
import { openDb } from "../src/adapters/db.js";
import { CODING_WORKFLOW_DEFINITION } from "../src/core/workflow/definition/definition.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

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
      },
    },
    stderr: {
      write(chunk: string) {
        stderr += chunk;
        return true;
      },
    },
    env: {},
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
        objective: "Inspect before approval",
      }),
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
      definitionVersion: 2,
      repoPath: repoDir,
      objective: "Inspect before approval",
    });
    expect((payload["counts"] as { steps: number }).steps).toBe(6);
    expect(payload["steps"]).toEqual([
      {
        stepId: "preflight",
        kind: "preflight",
        executor: "one-shot",
        order: 0,
        required: true,
        state: "pending",
      },
      {
        stepId: "implementation",
        kind: "implementation",
        executor: "delegate-supervisor",
        config: { tool: "gnhf" },
        order: 1,
        required: true,
        state: "pending",
      },
      {
        stepId: "postflight",
        kind: "postflight",
        executor: "one-shot",
        order: 2,
        required: true,
        state: "pending",
      },
      {
        stepId: "no-mistakes",
        kind: "no-mistakes",
        executor: "delegate-supervisor",
        config: { tool: "no-mistakes" },
        order: 3,
        required: true,
        state: "pending",
      },
      {
        stepId: "merge-cleanup",
        kind: "merge-cleanup",
        executor: "script",
        config: { command: "merge-cleanup" },
        order: 4,
        required: true,
        state: "pending",
      },
      {
        stepId: "linear-refresh",
        kind: "linear-refresh",
        executor: "external-apply",
        order: 5,
        required: true,
        state: "pending",
      },
    ]);
  });

  it("previews the current GNHF/CWFP implementation engine as an explicit route choice", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run(
      previewCodingArgs({
        dataDir,
        repoDir,
        runId: "preview-current-engine",
        objective: "Inspect the current fallback route",
        extra: ["--implementation-engine", "current-gnhf-cwfp"],
      }),
    );

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "workflow run preview-coding",
      runId: "preview-current-engine",
      implementationEngine: "current-gnhf-cwfp",
      route: {
        implementationEngine: "current-gnhf-cwfp",
      },
    });
    expect(payload["steps"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepId: "implementation",
          executor: "delegate-supervisor",
          config: { tool: "gnhf" },
        }),
        expect.objectContaining({
          stepId: "no-mistakes",
          executor: "delegate-supervisor",
          config: { tool: "no-mistakes" },
        }),
      ]),
    );
  });

  it("emits structural preflight evidence for invalid route steps", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run(
      previewCodingArgs({
        dataDir,
        repoDir,
        runId: "preview-invalid-route-steps",
        objective: "Block bad route config",
        extra: [
          "--steps-json",
          JSON.stringify({ "linear-refresh": { model: "opus" } }),
        ],
      }),
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run preview-coding",
      code: "route_config_invalid",
      runId: "preview-invalid-route-steps",
    });
    expect(payload["preflightEvidence"]).toEqual([
      {
        checkId: "route.steps",
        status: "failed",
        severity: "error",
        path: "route.steps.linear-refresh",
        key: "linear-refresh",
        message:
          'Coding route step "linear-refresh" is not configurable; supported steps: implementation, postflight, no-mistakes, merge-cleanup.',
        recommendedAction:
          "Use route.steps only for implementation, postflight, no-mistakes, or merge-cleanup, or remove the unsupported step key.",
      },
    ]);
  });

  it("emits structural preflight evidence for malformed route steps before durable writes", async () => {
    const commands = [
      {
        name: "preview-coding",
        buildArgs: (dataDir: string, repoDir: string) =>
          previewCodingArgs({
            dataDir,
            repoDir,
            runId: "readiness-preview-malformed-steps",
            objective: "Block malformed preview route config",
            extra: ["--steps-json", "{ not json"],
          }),
      },
      {
        name: "start-coding",
        buildArgs: (dataDir: string, repoDir: string) => [
          "workflow",
          "run",
          "start-coding",
          "--run-id",
          "readiness-start-malformed-steps",
          "--repo",
          repoDir,
          "--objective",
          "Block malformed start route config",
          "--data-dir",
          dataDir,
          "--json",
          "--steps-json",
          "{ not json",
        ],
      },
    ];

    for (const command of commands) {
      const dataDir = makeTempDir();
      const repoDir = makeTempDir();
      const result = await run(command.buildArgs(dataDir, repoDir));

      expect(result.code, command.name).toBe(1);
      expect(result.stdout, command.name).toBe("");
      const payload = JSON.parse(result.stderr) as Record<string, unknown>;
      expect(payload, command.name).toMatchObject({
        ok: false,
        command: `workflow run ${command.name}`,
        code: "route_config_invalid",
      });
      expect(payload["preflightEvidence"], command.name).toEqual([
        {
          checkId: "route.steps",
          status: "failed",
          severity: "error",
          path: "route.steps",
          key: "steps",
          message: "Coding route steps must be valid JSON.",
          recommendedAction:
            "Pass --steps-json as a JSON object keyed by configurable coding steps, or remove it to use the default route.",
        },
      ]);
      expect(
        fs.existsSync(path.join(dataDir, "momentum.db")),
        command.name,
      ).toBe(false);
    }
  });

  it("emits structural preflight evidence for blank route profiles", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run(
      previewCodingArgs({
        dataDir,
        repoDir,
        runId: "preview-invalid-profile",
        objective: "Block blank profile",
        extra: ["--profile", "   "],
      }),
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run preview-coding",
      code: "route_config_invalid",
      runId: "preview-invalid-profile",
    });
    expect(payload["preflightEvidence"]).toEqual([
      {
        checkId: "route.profile",
        status: "failed",
        severity: "error",
        path: "route.profile",
        key: "profile",
        message:
          "Coding route profile must be a non-empty string when provided.",
        recommendedAction:
          "Set route.profile to a non-empty runtime/profile name, or remove --profile to use the default route.",
      },
    ]);

    const db = openDb(dataDir);
    try {
      const runRow = db
        .prepare("SELECT id FROM workflow_runs WHERE id = ?")
        .get("preview-invalid-profile");
      expect(runRow).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("emits structural preflight evidence for invalid approval boundaries", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run(
      previewCodingArgs({
        dataDir,
        repoDir,
        runId: "preview-invalid-approval",
        objective: "Block bad approval boundary",
        extra: ["--approval-boundary", "through-linear-refresh"],
      }),
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run preview-coding",
      code: "invalid_run_start",
      runId: "preview-invalid-approval",
    });
    expect(payload["preflightEvidence"]).toEqual([
      {
        checkId: "workflow.run_shape",
        status: "failed",
        severity: "error",
        path: "approvalBoundary",
        key: "approvalBoundary",
        message: "Approval boundary is not a known workflow approval boundary.",
        recommendedAction:
          "Set approvalBoundary to a supported workflow approval boundary or omit it for manual approval.",
      },
    ]);

    const db = openDb(dataDir);
    try {
      const runRow = db
        .prepare("SELECT id FROM workflow_runs WHERE id = ?")
        .get("preview-invalid-approval");
      expect(runRow).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("writes nothing durable: no run row is created by a preview", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run(
      previewCodingArgs({
        dataDir,
        repoDir,
        runId: "preview-no-write",
        objective: "Preview only",
      }),
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
      extra: ["--profile", "live-wrapper", "--issue-scope", "NGX-509"],
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
          "through-implementation",
        ],
      }),
    );
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      state: "approved",
      approvalBoundary: "through-implementation",
      route: {
        profile: "live-wrapper",
        implementationEngine: "gnhf",
      },
      implementationEngine: "gnhf",
    });
    const steps = payload["steps"] as Array<{ stepId: string; state: string }>;
    const stateByStep = Object.fromEntries(
      steps.map((step) => [step.stepId, step.state]),
    );
    expect(stateByStep).toMatchObject({
      preflight: "approved",
      implementation: "approved",
      postflight: "pending",
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
        extra: ["--profile", "live-wrapper"],
      }),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("preview-human");
    expect(result.stdout).toContain("coding-workflow v2");
    expect(result.stdout).toContain("Profile: live-wrapper");
    expect(result.stdout).toContain("Implementation engine: gnhf");
    expect(result.stdout).toContain("implementation");
    expect(result.stdout).toContain("delegate-supervisor");
    expect(result.stdout).toContain('config={"tool":"gnhf"}');
    expect(result.stdout).toContain("external-apply");
  });

  it("surfaces per-step route selections in the human preview text (NGX-510)", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run(
      previewCodingArgs({
        dataDir,
        repoDir,
        runId: "preview-steps-text",
        objective: "Audit per-step route in text",
        json: false,
        extra: [
          "--steps-json",
          JSON.stringify({
            implementation: { harness: "gnhf", model: "opus" },
            "merge-cleanup": { effort: "low" },
          }),
        ],
      }),
    );
    expect(result.code).toBe(0);
    // The run-level profile line stays, and the per-step selections are now
    // auditable in the default (non-JSON) preview alongside it.
    expect(result.stdout).toContain("Per-step route:");
    expect(result.stdout).toContain(
      "implementation: harness=gnhf, model=opus, effort=(default)",
    );
    expect(result.stdout).toContain(
      "merge-cleanup: harness=(default), model=(default), effort=low",
    );
    // Unconfigured steps still render so defaults are visible before approval.
    expect(result.stdout).toContain(
      "postflight: harness=(default), model=(default), effort=(default)",
    );
  });

  it("surfaces per-step route overrides in the preview route (NGX-510)", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run(
      previewCodingArgs({
        dataDir,
        repoDir,
        runId: "preview-steps",
        objective: "Preview reconfigured per-step route",
        extra: [
          "--steps-json",
          JSON.stringify({
            "merge-cleanup": { effort: "low" },
            implementation: { harness: "gnhf", model: "opus" },
          }),
        ],
      }),
    );
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "workflow run preview-coding",
      preview: true,
      route: {
        steps: {
          implementation: { harness: "gnhf", model: "opus" },
          "merge-cleanup": { effort: "low" },
        },
      },
    });

    // A preview still writes nothing durable.
    const db = openDb(dataDir);
    try {
      const runRow = db
        .prepare("SELECT id FROM workflow_runs WHERE id = ?")
        .get("preview-steps");
      expect(runRow).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("shows provider-normalized model strings in preview output", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run(
      previewCodingArgs({
        dataDir,
        repoDir,
        runId: "preview-model-alias",
        objective: "Preview exact model strings",
        json: false,
        extra: [
          "--steps-json",
          JSON.stringify({
            implementation: {
              harness: "claude",
              model: "sonnet",
              effort: "high",
            },
            "no-mistakes": {
              harness: "codex",
              model: "openai/gpt-5.5",
              effort: "high",
            },
            postflight: {
              harness: "opencode",
              model: "glm-5.2",
            },
          }),
        ],
      }),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "implementation: harness=claude, model=claude-sonnet-4-6, effort=high",
    );
    expect(result.stdout).not.toContain(
      "implementation: harness=claude, model=sonnet, effort=high",
    );
    expect(result.stdout).toContain(
      "postflight: harness=opencode, model=opencode-go/glm-5.2, effort=(default)",
    );
    expect(result.stdout).toContain(
      "no-mistakes: harness=codex, model=gpt-5.5, effort=high",
    );

    const jsonResult = await run(
      previewCodingArgs({
        dataDir,
        repoDir,
        runId: "preview-model-alias-json",
        objective: "Preview exact model strings",
        extra: [
          "--steps-json",
          JSON.stringify({
            implementation: {
              harness: "claude",
              model: "sonnet",
              effort: "high",
            },
            "no-mistakes": {
              harness: "codex",
              model: "openai/gpt-5.5",
              effort: "high",
            },
            postflight: {
              harness: "opencode",
              model: "glm-5.2",
            },
          }),
        ],
      }),
    );
    expect(jsonResult.code).toBe(0);
    const payload = JSON.parse(jsonResult.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      route: {
        steps: {
          implementation: {
            harness: "claude",
            model: "claude-sonnet-4-6",
            effort: "high",
          },
          postflight: {
            harness: "opencode",
            model: "opencode-go/glm-5.2",
          },
          "no-mistakes": {
            harness: "codex",
            model: "gpt-5.5",
            effort: "high",
          },
        },
      },
    });
  });

  it("fails closed on a misconfigured --steps-json before previewing (NGX-510)", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run(
      previewCodingArgs({
        dataDir,
        repoDir,
        runId: "preview-bad-steps",
        objective: "Reject unsupported step",
        extra: [
          "--steps-json",
          JSON.stringify({ preflight: { model: "opus" } }),
        ],
      }),
    );
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run preview-coding",
      code: "route_config_invalid",
      runId: "preview-bad-steps",
    });
    // The refusal is actionable: it names the offending step and the supported set.
    expect(payload["message"]).toContain("preflight");
    expect(payload["message"]).toContain("supported steps");
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
      "--json",
    ]);
    expect(started.code).toBe(0);

    const result = await run(
      previewCodingArgs({
        dataDir,
        repoDir,
        runId: "preview-existing",
        objective: "Preview duplicate",
      }),
    );
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run preview-coding",
      code: "run_exists",
      runId: "preview-existing",
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
      "through-implementation",
    ];

    const preview = await run(
      previewCodingArgs({
        dataDir,
        repoDir,
        runId: "preview-equiv",
        objective: "Equivalence",
        extra: sharedExtra,
      }),
    );
    expect(preview.code).toBe(0);
    const previewPayload = JSON.parse(preview.stdout) as Record<
      string,
      unknown
    >;
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
      ...sharedExtra,
    ]);
    expect(started.code).toBe(0);

    const db = openDb(dataDir);
    try {
      const runRow = db
        .prepare(
          `SELECT workflow_definition_key, workflow_definition_version,
                  approval_boundary, route_json
             FROM workflow_runs WHERE id = ?`,
        )
        .get("preview-equiv") as {
        workflow_definition_key: string;
        workflow_definition_version: number;
        approval_boundary: string | null;
        route_json: string;
      };
      expect(runRow.workflow_definition_key).toBe(
        previewPayload["definitionKey"],
      );
      expect(runRow.workflow_definition_version).toBe(
        previewPayload["definitionVersion"],
      );
      expect(runRow.approval_boundary).toBe(previewPayload["approvalBoundary"]);
      expect(JSON.parse(runRow.route_json)).toEqual(previewPayload["route"]);

      const persistedSteps = db
        .prepare(
          `SELECT step_id, kind, step_order, required, state
             FROM workflow_steps WHERE run_id = ? ORDER BY step_order`,
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
          state: step.state,
        })),
      ).toEqual(
        previewSteps.map((step) => ({
          stepId: step.stepId,
          kind: step.kind,
          order: step.order,
          required: step.required,
          state: step.state,
        })),
      );
    } finally {
      db.close();
    }

    // Executor families in the preview are reconstructable from the durable
    // (key, version) pin alone, so dispatch/approval can reference them later.
    expect(previewSteps.map((step) => step.executor)).toEqual(
      CODING_WORKFLOW_DEFINITION.steps.map((step) => step.executor),
    );
  });

  it("provides an NGX-575 preview-to-start readiness fixture with approval and route readback", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const runId = "ngx-575-readiness-preview-start";
    const objective = "Dogfood the native workflow readiness fixture";
    const stepsJson = JSON.stringify({
      implementation: {
        harness: "codex",
        model: "openai/gpt-5.5",
        effort: "high",
      },
      postflight: { harness: "opencode", model: "glm-5.2" },
    });
    const sharedExtra = [
      "--profile",
      "ngx-575-dogfood-live-wrapper",
      "--issue-scope",
      "NGX-575",
      "--approval-boundary",
      "through-implementation",
      "--steps-json",
      stepsJson,
    ];

    const preview = await run(
      previewCodingArgs({
        dataDir,
        repoDir,
        runId,
        objective,
        extra: sharedExtra,
      }),
    );
    expect(preview.code).toBe(0);
    const previewPayload = JSON.parse(preview.stdout) as Record<
      string,
      unknown
    >;
    const previewSteps = previewPayload["steps"] as Array<{
      stepId: string;
      state: string;
    }>;
    expect(previewPayload).toMatchObject({
      ok: true,
      command: "workflow run preview-coding",
      preview: true,
      runId,
      state: "approved",
      approvalBoundary: "through-implementation",
      issueScope: { identifier: "NGX-575" },
      route: {
        profile: "ngx-575-dogfood-live-wrapper",
        steps: {
          implementation: {
            harness: "codex",
            model: "gpt-5.5",
            effort: "high",
          },
          postflight: { harness: "opencode", model: "opencode-go/glm-5.2" },
        },
      },
    });
    expect(
      Object.fromEntries(previewSteps.map((step) => [step.stepId, step.state])),
    ).toMatchObject({
      preflight: "approved",
      implementation: "approved",
      postflight: "pending",
    });

    expect(fs.existsSync(path.join(dataDir, "momentum.db"))).toBe(false);

    const started = await run([
      "workflow",
      "run",
      "start-coding",
      "--run-id",
      runId,
      "--repo",
      repoDir,
      "--objective",
      objective,
      "--data-dir",
      dataDir,
      "--json",
      ...sharedExtra,
    ]);
    expect(started.code).toBe(0);
    expect(JSON.parse(started.stdout)).toMatchObject({
      ok: true,
      command: "workflow run start-coding",
      runId,
      state: "approved",
      approvalBoundary: "through-implementation",
    });

    const db = openDb(dataDir);
    try {
      const runRow = db
        .prepare(
          `SELECT approval_boundary, issue_scope_json, route_json
             FROM workflow_runs WHERE id = ?`,
        )
        .get(runId) as {
        approval_boundary: string | null;
        issue_scope_json: string;
        route_json: string;
      };
      expect(runRow.approval_boundary).toBe("through-implementation");
      expect(JSON.parse(runRow.issue_scope_json)).toEqual({
        identifier: "NGX-575",
      });
      expect(JSON.parse(runRow.route_json)).toEqual(previewPayload["route"]);

      const persistedStepStates = db
        .prepare(
          `SELECT step_id, state
             FROM workflow_steps WHERE run_id = ? ORDER BY step_order`,
        )
        .all(runId) as Array<{ step_id: string; state: string }>;
      expect(
        Object.fromEntries(
          persistedStepStates.map((step) => [step.step_id, step.state]),
        ),
      ).toMatchObject({
        preflight: "approved",
        implementation: "approved",
        postflight: "pending",
      });

      const approval = db
        .prepare(
          `SELECT boundary, actor FROM workflow_approvals WHERE run_id = ?`,
        )
        .get(runId) as { boundary: string; actor: string } | undefined;
      expect(approval).toEqual({
        boundary: "through-implementation",
        actor: "momentum-native-coding",
      });
    } finally {
      db.close();
    }
  });

  it("refuses a run id reserved for compatibility imports", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run(
      previewCodingArgs({
        dataDir,
        repoDir,
        runId: "cwfp-should-refuse",
        objective: "Reserved",
      }),
    );
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run preview-coding",
      code: "reserved_run_id",
      runId: "cwfp-should-refuse",
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
        extra: ["--definition", "custom-flow"],
      }),
    );
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run preview-coding",
      code: "definition_not_allowed",
    });
  });

  it("refuses when required inputs are missing", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();

    const noRunId = await run(
      previewCodingArgs({ dataDir, repoDir, objective: "no run id" }),
    );
    expect(noRunId.code).toBe(1);
    expect(JSON.parse(noRunId.stderr)).toMatchObject({
      ok: false,
      command: "workflow run preview-coding",
      code: "run_id_required",
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
      "--json",
    ]);
    expect(noObjective.code).toBe(1);
    const noObjectivePayload = JSON.parse(noObjective.stderr) as Record<
      string,
      unknown
    >;
    expect(noObjectivePayload).toMatchObject({
      ok: false,
      command: "workflow run preview-coding",
      code: "objective_required",
    });
    expect(noObjectivePayload["preflightEvidence"]).toEqual([
      {
        checkId: "workflow.run_shape",
        status: "failed",
        severity: "error",
        path: "objective",
        key: "objective",
        message: "Objective must be a non-empty string.",
        recommendedAction:
          "Set objective to a non-empty objective before starting the run.",
      },
    ]);
  });

  it("emits structural preflight evidence when --repo is blank", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "run",
      "preview-coding",
      "--run-id",
      "preview-blank-repo",
      "--repo",
      "   ",
      "--objective",
      "Reject blank repo",
      "--data-dir",
      dataDir,
      "--json",
    ]);

    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run preview-coding",
      code: "repo_required",
      runId: "preview-blank-repo",
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
          "Set repoPath to a non-empty repository path before starting the run.",
      },
    ]);
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
      "--json",
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      command: "workflow run start",
      source: "workflow-definition",
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
