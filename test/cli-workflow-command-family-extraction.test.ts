import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

type CliResult = {
  code: number;
  stdout: string;
  stderr: string;
};

async function run(args: string[]): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(args, {
    stdout: { write: (chunk: string) => ((stdout += chunk), true) },
    stderr: { write: (chunk: string) => ((stderr += chunk), true) },
    env: {
      ...process.env,
      HOME: fs.mkdtempSync(path.join(os.tmpdir(), "momentum-workflow-cmd-home-"))
    }
  });
  return { code, stdout, stderr };
}

describe("workflow command family extraction", () => {
  it("keeps workflow implementation handlers out of src/cli.ts and under src/commands/workflow", () => {
    const cli = fs.readFileSync(path.join(repoRoot, "src/cli.ts"), "utf8");
    const workflowModule = fs.readFileSync(
      path.join(repoRoot, "src/commands/workflow/index.ts"),
      "utf8"
    );

    for (const handler of [
      "function workflow(",
      "function workflowRun(",
      "function workflowRunStart(",
      "function workflowRunMonitor("
    ]) {
      expect(cli, `src/cli.ts should no longer contain ${handler}`).not.toContain(handler);
      expect(workflowModule, `workflow command module should contain ${handler}`).toContain(handler);
    }
  });

  it("preserves workflow run start validation and JSON envelope shape", async () => {
    const result = await run(["workflow", "run", "start", "--json"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      command: "workflow run start",
      code: "run_id_required",
      message: "Missing required --run-id <id> for workflow run start."
    });
  });

  it("prints top-level help for workflow run --help", async () => {
    const result = await run(["workflow", "run", "--help"]);

    expect(result.code).toBe(0);
    expect(result.stdout.startsWith("Momentum\n\nUsage:\n")).toBe(true);
    expect(result.stdout).toContain("momentum workflow run start");
    expect(result.stderr).toBe("");
  });

  it("prints top-level help for workflow run preview-coding --help", async () => {
    const result = await run(["workflow", "run", "preview-coding", "--help"]);

    expect(result.code).toBe(0);
    expect(result.stdout.startsWith("Momentum\n\nUsage:\n")).toBe(true);
    expect(result.stdout).toContain("momentum workflow run preview-coding");
    expect(result.stderr).toBe("");
  });

  it("preserves workflow gate decision validation before storage access", async () => {
    const result = await run(["workflow", "run", "decide", "gate-1", "--json"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      command: "workflow run decide",
      code: "action_required",
      gateId: "gate-1",
      message: "Missing required --action <action> for workflow run decide."
    });
  });

  it("renders the shared Momentum help block for text-mode usage errors", async () => {
    const result = await run(["workflow", "bogus"]);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(
      result.stderr.startsWith(
        "Unknown workflow subcommand: bogus\n\nMomentum\n\nUsage:\n"
      )
    ).toBe(true);
    expect(result.stderr).toMatch(/\n {2}momentum goal start /);
    expect(
      result.stderr
        .trimEnd()
        .endsWith(
          "Default goal start enqueues a goal_iteration job for a future worker; pass --foreground to keep the Milestone 1 inline iteration."
        )
    ).toBe(true);
  });
});
