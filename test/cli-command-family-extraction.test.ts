import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

type CliResult = { code: number; stdout: string; stderr: string };

async function run(args: string[]): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "momentum-family-cmd-home-"));
  const code = await runCli(args, {
    stdout: { write: (chunk: string) => ((stdout += chunk), true) },
    stderr: { write: (chunk: string) => ((stderr += chunk), true) },
    env: { ...process.env, HOME: home }
  });
  return { code, stdout, stderr };
}

describe("goal/source/evidence/project/intent command family extraction", () => {
  it("keeps migrated command implementation handlers out of src/cli.ts", () => {
    const cli = fs.readFileSync(path.join(repoRoot, "src/cli.ts"), "utf8");
    const expectations: Array<[string, string]> = [
      ["function goalStart(", "src/commands/goal/index.ts"],
      ["function source(", "src/commands/source/index.ts"],
      ["function project(", "src/commands/project/index.ts"],
      ["function evidence(", "src/commands/evidence/index.ts"],
      ["function intent(", "src/commands/intent/index.ts"]
    ];

    for (const [handler, modulePath] of expectations) {
      const module = fs.readFileSync(path.join(repoRoot, modulePath), "utf8");
      expect(cli, `src/cli.ts should no longer contain ${handler}`).not.toContain(handler);
      expect(module, `${modulePath} should contain ${handler}`).toContain(handler);
    }
  });

  it("preserves a healthy empty source list JSON envelope", async () => {
    const result = await run(["source", "list", "--json"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      command: "source list",
      items: [],
      count: 0
    });
  });

  it("preserves update-intent empty list JSON output", async () => {
    const result = await run(["intent", "list", "--json"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      command: "intent list",
      intents: [],
      count: 0
    });
  });

  it("preserves goal start validation without touching storage", async () => {
    const result = await run(["goal", "start", "--json"]);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      code: "usage_error",
      message: "Missing required <goal.md> for goal start."
    });
  });
});
