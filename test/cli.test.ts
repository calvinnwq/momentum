import { describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { VERSION, runCli } from "../src/cli.js";

const GOAL_SPEC = `---
title: CLI Test Goal
repo: /tmp/test-repo
runner: fake
verification:
  - pnpm test
---

Goal body.
`;

type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

describe("momentum CLI scaffold", () => {
  it("prints help with the Milestone 1 public commands", async () => {
    const result = await run(["--help"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("momentum goal start <goal.md> [--repo <path>] --foreground");
    expect(result.stdout).toContain("momentum status [goal-id] [--json]");
    expect(result.stdout).toContain("momentum handoff <goal-id> [--json]");
    expect(result.stdout).toContain("momentum doctor [--json]");
    expect(result.stderr).toBe("");
  });

  it("prints the scaffold version", async () => {
    const result = await run(["--version"]);

    expect(result).toEqual({
      code: 0,
      stdout: `${VERSION}\n`,
      stderr: ""
    });
  });

  it("runs doctor in text mode", async () => {
    const result = await run(["doctor"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Momentum doctor: ok");
    expect(result.stdout).toContain("scope: NGX-236 goal-init");
    expect(result.stderr).toBe("");
  });

  it("runs doctor in json mode", async () => {
    const result = await run(["doctor", "--json"]);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(result.code).toBe(0);
    expect(payload).toMatchObject({
      ok: true,
      command: "doctor",
      version: VERSION,
      milestone: "NGX-236 goal-init"
    });
    expect(result.stderr).toBe("");
  });

  it("goal start initializes a goal and returns ok with goalId", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "momentum-cli-"));
    const goalFile = path.join(dataDir, "goal.md");
    fs.writeFileSync(goalFile, GOAL_SPEC, "utf-8");

    const result = await run([
      "goal", "start", goalFile,
      "--foreground",
      "--data-dir", dataDir,
      "--json"
    ]);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(result.code).toBe(0);
    expect(payload).toMatchObject({
      ok: true,
      command: "goal start",
      state: "initialized",
      title: "CLI Test Goal",
      resumed: false
    });
    expect(typeof payload["goalId"]).toBe("string");
    expect(typeof payload["jobId"]).toBe("string");
    expect(result.stderr).toBe("");

    fs.rmSync(dataDir, { recursive: true });
  });

  it("goal start returns init_error for a missing goal file", async () => {
    const result = await run([
      "goal", "start", "/no/such/goal.md",
      "--foreground",
      "--json"
    ]);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;

    expect(result.code).toBe(1);
    expect(payload).toMatchObject({
      ok: false,
      command: "goal start",
      code: "init_error"
    });
    expect(result.stdout).toBe("");
  });

  it("goal start text mode prints initialized goal info", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "momentum-cli-"));
    const goalFile = path.join(dataDir, "goal.md");
    fs.writeFileSync(goalFile, GOAL_SPEC, "utf-8");

    const result = await run([
      "goal", "start", goalFile,
      "--foreground",
      "--data-dir", dataDir
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Goal initialized:");
    expect(result.stdout).toContain("CLI Test Goal");
    expect(result.stderr).toBe("");

    fs.rmSync(dataDir, { recursive: true });
  });

  it("requires --foreground for goal start", async () => {
    const result = await run(["goal", "start", "goal.md", "--json"]);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;

    expect(result.code).toBe(2);
    expect(payload).toMatchObject({
      ok: false,
      code: "usage_error",
      message: "Missing required --foreground for Milestone 1 goal start."
    });
    expect(result.stdout).toBe("");
  });

  it("reserves status and handoff command shells", async () => {
    const status = await run(["status", "goal-1", "--json"]);
    const handoff = await run(["handoff", "goal-1", "--json"]);

    expect(status.code).toBe(1);
    expect(JSON.parse(status.stdout)).toMatchObject({
      command: "status",
      goalId: "goal-1",
      code: "not_implemented"
    });
    expect(handoff.code).toBe(1);
    expect(JSON.parse(handoff.stdout)).toMatchObject({
      command: "handoff",
      goalId: "goal-1",
      code: "not_implemented"
    });
  });

  it("rejects unknown commands with usage", async () => {
    const result = await run(["wat"]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Unknown command: wat");
    expect(result.stderr).toContain("Usage:");
  });
});

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
