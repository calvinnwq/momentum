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
  const dataDir = path.join(home, ".momentum");
  const code = await runCli(args, {
    stdout: { write: (chunk: string) => ((stdout += chunk), true) },
    stderr: { write: (chunk: string) => ((stderr += chunk), true) },
    env: { ...process.env, HOME: home, MOMENTUM_HOME: dataDir }
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

  it("renders the shared Momentum help block for text-mode usage errors", async () => {
    const footer =
      "Default goal start enqueues a goal_iteration job for a worker; pass --foreground to run the iteration in the current process.";
    const cases: Array<{ args: string[]; message: string }> = [
      {
        args: ["source"],
        message:
          "Missing required subcommand for source. Expected: list, get, link, unlink, reconcile."
      },
      { args: ["project", "bogus"], message: "Unknown project subcommand: bogus" },
      { args: ["evidence", "bogus"], message: "Unknown evidence subcommand: bogus" },
      { args: ["intent", "bogus"], message: "Unknown intent subcommand: bogus" }
    ];

    for (const { args, message } of cases) {
      const result = await run(args);

      expect(result.code, `${args.join(" ")} exits 2`).toBe(2);
      expect(result.stdout).toBe("");
      expect(
        result.stderr.startsWith(`${message}\n\nMomentum\n\nUsage:\n`),
        `${args.join(" ")} renders the Momentum help header`
      ).toBe(true);
      expect(result.stderr, `${args.join(" ")} indents the command list`).toMatch(
        /\n {2}momentum goal start /
      );
      expect(
        result.stderr.trimEnd().endsWith(footer),
        `${args.join(" ")} ends with the help footer`
      ).toBe(true);
    }
  });
});
