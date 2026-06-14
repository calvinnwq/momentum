import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DOCTOR_MILESTONE, runCli } from "../src/cli.js";

type CliResult = {
  code: number;
  stdout: string;
  stderr: string;
};

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-cli-architecture-smoke-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

async function run(args: string[]): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const home = makeTempDir("momentum-cli-architecture-home-");
  const code = await runCli(args, {
    stdout: { write: (chunk: string) => ((stdout += chunk), true) },
    stderr: { write: (chunk: string) => ((stderr += chunk), true) },
    env: { ...process.env, HOME: home }
  });
  return { code, stdout, stderr };
}

function dataDirArgs(dataDir: string): string[] {
  return ["--data-dir", dataDir, "--json"];
}

describe("M11 closeout command-family smoke matrix", () => {
  it("covers migrated and remaining command families with representative JSON envelopes", async () => {
    const dataDir = makeTempDir();
    const cases: Array<{
      label: string;
      args: string[];
      code: number;
      stream: "stdout" | "stderr";
      match: Record<string, unknown>;
    }> = [
      {
        label: "status family: status",
        args: ["status", ...dataDirArgs(dataDir)],
        code: 1,
        stream: "stderr",
        match: { ok: false, command: "status", code: "no_goals" }
      },
      {
        label: "status family: logs",
        args: ["logs", "missing-goal", ...dataDirArgs(dataDir)],
        code: 1,
        stream: "stderr",
        match: {
          ok: false,
          command: "logs",
          code: "goal_not_found",
          goalId: "missing-goal"
        }
      },
      {
        label: "status family: handoff",
        args: ["handoff", "missing-goal", ...dataDirArgs(dataDir)],
        code: 1,
        stream: "stderr",
        match: {
          ok: false,
          command: "handoff",
          code: "goal_not_found",
          goalId: "missing-goal"
        }
      },
      {
        label: "workflow family",
        args: ["workflow", "status", ...dataDirArgs(dataDir)],
        code: 0,
        stream: "stdout",
        match: { ok: true, command: "workflow status", count: 0, runs: [] }
      },
      {
        label: "goal family",
        args: ["goal", "start", "--json"],
        code: 2,
        stream: "stderr",
        match: {
          ok: false,
          code: "usage_error",
          message: "Missing required <goal.md> for goal start."
        }
      },
      {
        label: "source family",
        args: ["source", "list", ...dataDirArgs(dataDir)],
        code: 0,
        stream: "stdout",
        match: { ok: true, command: "source list", count: 0, items: [] }
      },
      {
        label: "evidence family",
        args: ["evidence", "list", ...dataDirArgs(dataDir)],
        code: 0,
        stream: "stdout",
        match: { ok: true, command: "evidence list", count: 0, records: [] }
      },
      {
        label: "project family",
        args: ["project", "status", ...dataDirArgs(dataDir)],
        code: 0,
        stream: "stdout",
        match: { ok: true, command: "project status" }
      },
      {
        label: "intent family",
        args: ["intent", "list", ...dataDirArgs(dataDir)],
        code: 0,
        stream: "stdout",
        match: { ok: true, command: "intent list", count: 0, intents: [] }
      },
      {
        label: "daemon compatibility surface",
        args: ["daemon", "status", ...dataDirArgs(dataDir)],
        code: 0,
        stream: "stdout",
        match: { ok: true, command: "daemon status", hasRun: false }
      },
      {
        label: "recovery compatibility surface",
        args: ["recovery", "clear", "missing-goal", ...dataDirArgs(dataDir)],
        code: 1,
        stream: "stderr",
        match: {
          ok: false,
          command: "recovery clear",
          code: "goal_not_found",
          goalId: "missing-goal"
        }
      },
      {
        label: "worker compatibility surface",
        args: ["worker", "run", ...dataDirArgs(dataDir)],
        code: 0,
        stream: "stdout",
        match: { ok: true, command: "worker run", code: "no_work" }
      },
      {
        label: "doctor compatibility surface",
        args: ["doctor", ...dataDirArgs(dataDir)],
        code: 0,
        stream: "stdout",
        match: {
          ok: true,
          command: "doctor",
          milestone: DOCTOR_MILESTONE
        }
      }
    ];

    for (const spec of cases) {
      const result = await run(spec.args);
      expect(result.code, `${spec.label} exit code`).toBe(spec.code);
      const selected = spec.stream === "stdout" ? result.stdout : result.stderr;
      const other = spec.stream === "stdout" ? result.stderr : result.stdout;
      expect(other, `${spec.label} should not write the other stream`).toBe("");
      expect(JSON.parse(selected), spec.label).toMatchObject(spec.match);
    }
  });
});
