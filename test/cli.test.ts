import { describe, expect, it } from "vitest";
import { VERSION, runCli } from "../src/cli.js";

type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

describe("momentum CLI scaffold", () => {
  it("prints help with the Milestone 1 public commands", async () => {
    const result = await run(["--help"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("momentum goal start <goal.md> --repo <path> --foreground");
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
    expect(result.stdout).toContain("scope: NGX-235 scaffold");
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
      milestone: "NGX-235 scaffold"
    });
    expect(result.stderr).toBe("");
  });

  it("reserves the goal start command shape", async () => {
    const result = await run([
      "goal",
      "start",
      "goal.md",
      "--repo",
      "/tmp/example",
      "--foreground",
      "--runner",
      "fake",
      "--json"
    ]);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(result.code).toBe(1);
    expect(payload).toMatchObject({
      ok: false,
      command: "goal start",
      code: "not_implemented",
      goalPath: "goal.md",
      repo: "/tmp/example",
      foreground: true,
      runner: "fake"
    });
    expect(result.stderr).toBe("");
  });

  it("validates Milestone 1 goal start flags before later behavior exists", async () => {
    const result = await run(["goal", "start", "goal.md", "--repo", "/tmp/example", "--json"]);
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
