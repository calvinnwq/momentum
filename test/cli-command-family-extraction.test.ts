import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

type CliResult = { code: number; stdout: string; stderr: string };

async function run(args: string[]): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const home = fs.mkdtempSync(
    path.join(os.tmpdir(), "momentum-family-cmd-home-"),
  );
  tempRoots.push(home);
  const dataDir = path.join(home, ".momentum");
  const code = await runCli(args, {
    stdout: { write: (chunk: string) => ((stdout += chunk), true) },
    stderr: { write: (chunk: string) => ((stderr += chunk), true) },
    env: { ...process.env, HOME: home, MOMENTUM_HOME: dataDir },
  });
  return { code, stdout, stderr };
}

describe("source/evidence/project/intent command family extraction", () => {
  it("routes migrated project and evidence families through public CLI behavior", async () => {
    const cases = [
      {
        args: ["project", "status", "--json"],
        expected: { ok: true, command: "project status" },
      },
      {
        args: ["evidence", "list", "--json"],
        expected: {
          ok: true,
          command: "evidence list",
          count: 0,
          records: [],
        },
      },
    ];

    for (const { args, expected } of cases) {
      const result = await run(args);
      expect(result.code, args.join(" ")).toBe(0);
      expect(result.stderr, args.join(" ")).toBe("");
      expect(JSON.parse(result.stdout), args.join(" ")).toMatchObject(expected);
    }
  });

  it("preserves a healthy empty tracker list JSON envelope", async () => {
    const result = await run(["tracker", "list", "--json"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      command: "tracker list",
      items: [],
      count: 0,
    });
  });

  it("preserves intent empty list JSON output", async () => {
    const result = await run(["intent", "list", "--json"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      command: "intent list",
      intents: [],
      count: 0,
    });
  });

  it("refuses the retired goal start command with an unknown-command usage error", async () => {
    const result = await run(["goal", "start", "--json"]);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      code: "usage_error",
      message: "Unknown command: goal",
    });
  });

  it("renders the shared Momentum help block for text-mode usage errors", async () => {
    const cases: Array<{ args: string[]; message: string }> = [
      {
        args: ["tracker"],
        message:
          "Missing required subcommand for tracker. Expected: list, get, link, unlink, reconcile.",
      },
      {
        args: ["project", "bogus"],
        message: "Unknown project subcommand: bogus",
      },
      {
        args: ["evidence", "bogus"],
        message: "Unknown evidence subcommand: bogus",
      },
      {
        args: ["intent", "bogus"],
        message: "Unknown intent subcommand: bogus",
      },
    ];

    for (const { args, message } of cases) {
      const result = await run(args);

      expect(result.code, `${args.join(" ")} exits 2`).toBe(2);
      expect(result.stdout).toBe("");
      expect(
        result.stderr.startsWith(`${message}\n\nMomentum\n\nUsage:\n`),
        `${args.join(" ")} renders the Momentum help header`,
      ).toBe(true);
      expect(
        result.stderr,
        `${args.join(" ")} indents the command list`,
      ).toMatch(/\n {2}momentum workflow status /);
      expect(
        result.stderr,
        `${args.join(" ")} omits retired goal-first commands`,
      ).not.toContain("momentum goal start");
    }
  });
});
