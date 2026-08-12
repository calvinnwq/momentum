/**
 * NGX-669 final contract for the coding-door agent-config surface.
 *
 * `--agent-config-json` replaces the retired `--steps-json` flag with the same
 * accepted steps, fields, normalization, and fail-closed validation, while the
 * retired `--profile` / `--implementation-engine` flags fail as usage errors
 * before any durable write. Successful current JSON/text output carries no
 * active route, profile, or implementation-engine vocabulary, and fresh
 * databases have no `workflow_runs.route_json` column.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/cli.js";
import { openDb } from "../src/adapters/db.js";
import { readWorkflowRunCodingCompatibility } from "../src/adapters/db/route-state.js";

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

function makeTempDir(prefix = "momentum-agent-config-contract-"): string {
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

function startCodingArgs(input: {
  dataDir: string;
  repoDir: string;
  runId: string;
  extra?: string[];
}): string[] {
  return [
    "workflow",
    "run",
    "start-coding",
    "--run-id",
    input.runId,
    "--repo",
    input.repoDir,
    "--objective",
    "Prove the final agent-config contract",
    "--data-dir",
    input.dataDir,
    "--json",
    ...(input.extra ?? []),
  ];
}

function expectEmptyDataDir(dataDir: string): void {
  expect(fs.existsSync(path.join(dataDir, "momentum.db"))).toBe(false);
}

describe("workflow run start-coding --agent-config-json (NGX-669)", () => {
  it("freezes normalized per-step agent config exactly as --steps-json did", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run(
      startCodingArgs({
        dataDir,
        repoDir,
        runId: "ngx-669-agent-config-1",
        extra: [
          "--agent-config-json",
          JSON.stringify({
            implementation: {
              harness: "claude",
              model: "opus",
              effort: "high",
            },
            validate: { model: " gpt-6-codex " },
          }),
        ],
      }),
    );
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload["ok"]).toBe(true);
    // Final contract: no active route/profile/engine vocabulary in success output.
    expect(payload).not.toHaveProperty("route");
    expect(payload).not.toHaveProperty("implementationEngine");
    expect(payload).not.toHaveProperty("selectedProfile");

    const db = openDb(dataDir);
    try {
      const stepRows = db
        .prepare(
          `SELECT step_id, agent_config_json FROM workflow_steps
            WHERE run_id = ? ORDER BY step_order`,
        )
        .all("ngx-669-agent-config-1") as Array<{
        step_id: string;
        agent_config_json: string;
      }>;
      const byStep = new Map(
        stepRows.map((row) => [row.step_id, JSON.parse(row.agent_config_json)]),
      );
      // Provider alias normalization is preserved: "opus" with the claude
      // harness persists as the pinned Claude Code model string.
      const implementation = byStep.get("implementation") as Record<
        string,
        string
      >;
      expect(implementation["harness"]).toBe("claude");
      expect(implementation["effort"]).toBe("high");
      expect(implementation["model"]).not.toBe("opus");
      expect(implementation["model"]).toMatch(/opus/);
      expect(byStep.get("validate")).toMatchObject({ model: "gpt-6-codex" });

      // Fresh databases persist no route_json column at all.
      const columns = db
        .prepare("PRAGMA table_info(workflow_runs)")
        .all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).not.toContain("route_json");

      // The native-coding compatibility marker row still exists (dispatch
      // validates it fail-closed) but records no historical labels.
      const compatibility = readWorkflowRunCodingCompatibility(
        db,
        "ngx-669-agent-config-1",
      );
      expect(compatibility).toEqual({
        implementationEngine: null,
        selectedProfile: null,
      });
    } finally {
      db.close();
    }
  });

  it("fails closed on malformed --agent-config-json and writes nothing", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run(
      startCodingArgs({
        dataDir,
        repoDir,
        runId: "ngx-669-agent-config-bad",
        extra: ["--agent-config-json", "{not json"],
      }),
    );
    expect(result.code).not.toBe(0);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload["code"]).toBe("route_config_invalid");
    expectEmptyDataDir(dataDir);
  });

  it("fails closed on an unsupported step and writes nothing", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run(
      startCodingArgs({
        dataDir,
        repoDir,
        runId: "ngx-669-agent-config-step",
        extra: [
          "--agent-config-json",
          JSON.stringify({ preflight: { model: "opus" } }),
        ],
      }),
    );
    expect(result.code).not.toBe(0);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload["code"]).toBe("route_config_invalid");
    expectEmptyDataDir(dataDir);
  });

  it("refuses --agent-config-json on the generic workflow run start door", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run([
      "workflow",
      "run",
      "start",
      "--run-id",
      "ngx-669-generic",
      "--repo",
      repoDir,
      "--objective",
      "Generic start refuses coding agent config",
      "--data-dir",
      dataDir,
      "--json",
      "--agent-config-json",
      JSON.stringify({ implementation: { model: "opus" } }),
    ]);
    expect(result.code).not.toBe(0);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload["code"]).toBe("route_config_not_allowed");
    expectEmptyDataDir(dataDir);
  });
});

describe("retired route/profile flags (NGX-669)", () => {
  for (const [flag, value] of [
    ["--steps-json", '{"implementation":{"model":"opus"}}'],
    ["--profile", "coding-workflow-live-wrapper"],
    ["--implementation-engine", "gnhf"],
  ] as const) {
    it(`fails ${flag} as a usage error on start-coding before any durable write`, async () => {
      const dataDir = makeTempDir();
      const repoDir = makeTempDir();
      const result = await run(
        startCodingArgs({
          dataDir,
          repoDir,
          runId: "ngx-669-retired",
          extra: [flag, value],
        }),
      );
      expect(result.code).toBe(2);
      const payload = JSON.parse(result.stderr) as Record<string, unknown>;
      expect(payload["code"]).toBe("usage_error");
      expect(String(payload["message"])).toContain(flag);
      expectEmptyDataDir(dataDir);
    });

    it(`fails ${flag} as a usage error on preview-coding`, async () => {
      const dataDir = makeTempDir();
      const repoDir = makeTempDir();
      const result = await run([
        "workflow",
        "run",
        "preview-coding",
        "--run-id",
        "ngx-669-retired-preview",
        "--repo",
        repoDir,
        "--objective",
        "Retired flags refuse before preview",
        "--data-dir",
        dataDir,
        "--json",
        flag,
        value,
      ]);
      expect(result.code).toBe(2);
      const payload = JSON.parse(result.stderr) as Record<string, unknown>;
      expect(payload["code"]).toBe("usage_error");
      expect(String(payload["message"])).toContain(flag);
      expectEmptyDataDir(dataDir);
    });

    it(`fails ${flag} as a usage error on the generic start door`, async () => {
      const dataDir = makeTempDir();
      const repoDir = makeTempDir();
      const result = await run([
        "workflow",
        "run",
        "start",
        "--run-id",
        "ngx-669-retired-generic",
        "--repo",
        repoDir,
        "--objective",
        "Retired flags refuse on generic start",
        "--data-dir",
        dataDir,
        "--json",
        flag,
        value,
      ]);
      expect(result.code).toBe(2);
      const payload = JSON.parse(result.stderr) as Record<string, unknown>;
      expect(payload["code"]).toBe("usage_error");
      expectEmptyDataDir(dataDir);
    });
  }

  it("mentions the --agent-config-json replacement in the --steps-json diagnostic", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const result = await run(
      startCodingArgs({
        dataDir,
        repoDir,
        runId: "ngx-669-replacement-hint",
        extra: ["--steps-json", "{}"],
      }),
    );
    expect(result.code).toBe(2);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(String(payload["message"])).toContain("--agent-config-json");
  });
});

describe("final help vocabulary (NGX-669)", () => {
  it("mentions --agent-config-json and no retired flags in CLI help", async () => {
    const result = await run(["--help"]);
    expect(result.stdout).toContain("--agent-config-json");
    expect(result.stdout).not.toContain("--steps-json");
    expect(result.stdout).not.toContain("--profile");
    expect(result.stdout).not.toContain("--implementation-engine");
  });
});

describe("preview-coding final projection (NGX-669)", () => {
  it("previews per-step agent config without route/profile/engine vocabulary", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const argvBase = [
      "workflow",
      "run",
      "preview-coding",
      "--run-id",
      "ngx-669-preview",
      "--repo",
      repoDir,
      "--objective",
      "Preview the final agent-config projection",
      "--data-dir",
      dataDir,
      "--agent-config-json",
      JSON.stringify({ implementation: { harness: "codex", model: "gpt-6" } }),
    ];
    const jsonResult = await run([...argvBase, "--json"]);
    expect(jsonResult.code).toBe(0);
    const payload = JSON.parse(jsonResult.stdout) as Record<string, unknown>;
    expect(payload["ok"]).toBe(true);
    expect(payload).not.toHaveProperty("route");
    expect(payload).not.toHaveProperty("implementationEngine");
    const steps = payload["steps"] as Array<Record<string, unknown>>;
    const implementation = steps.find(
      (step) => step["stepId"] === "implementation",
    );
    expect(implementation?.["agentConfig"]).toMatchObject({
      harness: "codex",
      model: "gpt-6",
    });

    const textResult = await run(argvBase);
    expect(textResult.code).toBe(0);
    expect(textResult.stdout).not.toContain("Profile:");
    expect(textResult.stdout).not.toContain("Implementation engine:");
    expect(textResult.stdout).toContain("Per-step agent config:");
    expect(textResult.stdout).not.toContain("Per-step route:");
    // Preview writes nothing.
    expectEmptyDataDir(dataDir);
  });
});
