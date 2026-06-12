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
    env: { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), "momentum-workflow-cmd-home-")) }
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
});
