import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

const tempRoots: string[] = [];

const GOAL_SPEC = `---
title: Read-only Status Family Goal
runner: fake
verification:
  - true
---

Goal body.
`;

type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-readonly-status-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function initRepo(): string {
  const dir = makeTempDir("momentum-readonly-status-repo-");
  runGit(dir, ["init", "--initial-branch=main", "--quiet"]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  runGit(dir, ["config", "user.name", "Test User"]);
  runGit(dir, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "README.md"), "init\n", "utf-8");
  runGit(dir, ["add", "README.md"]);
  runGit(dir, ["commit", "-m", "init", "--quiet"]);
  return dir;
}

async function run(args: string[]): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(args, {
    stdout: { write(chunk: string) { stdout += chunk; return true; } },
    stderr: { write(chunk: string) { stderr += chunk; return true; } },
    env: { ...process.env }
  });
  return { code, stdout, stderr };
}

describe("read-only status command family", () => {
  it("keeps status --json healthy output stable through the extracted command module", async () => {
    const dataDir = makeTempDir("momentum-readonly-status-data-");
    const repo = initRepo();
    const goalFile = path.join(dataDir, "goal.md");
    fs.writeFileSync(goalFile, GOAL_SPEC, "utf-8");
    const start = await run([
      "goal",
      "start",
      goalFile,
      "--repo",
      repo,
      "--foreground",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    const started = JSON.parse(start.stdout) as { goalId: string };

    const result = await run(["status", started.goalId, "--data-dir", dataDir, "--json"]);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(payload).toMatchObject({
      ok: true,
      command: "status",
      goalId: started.goalId,
      title: "Read-only Status Family Goal"
    });
  });

  it("keeps logs --json missing-goal error envelope stable through the extracted command module", async () => {
    const dataDir = makeTempDir("momentum-readonly-status-data-");

    const result = await run(["logs", "missing-goal", "--data-dir", dataDir, "--json"]);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;

    expect(result).toMatchObject({ code: 1, stdout: "" });
    expect(payload).toMatchObject({
      ok: false,
      command: "logs",
      code: "goal_not_found",
      goalId: "missing-goal"
    });
    expect(String(payload.message)).toContain("missing-goal");
  });
});
