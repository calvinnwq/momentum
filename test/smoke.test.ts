import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import {
  FAKE_RUNNER_FAIL_ENV,
  FAKE_RUNNER_FIXTURE_FILENAME,
  FAKE_RUNNER_GOAL_COMPLETE_ENV
} from "../src/fake-runner.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const CLI_BIN = path.join(REPO_ROOT, "dist", "index.js");

const SMOKE_GOAL_SPEC = `---
title: Smoke Goal
runner: fake
verification:
  - "true"
---

End-to-end smoke goal.
`;

type CliResult = {
  code: number;
  stdout: string;
  stderr: string;
};

const tempRoots: string[] = [];

beforeAll(() => {
  execFileSync("pnpm", ["build"], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (!fs.existsSync(CLI_BIN)) {
    throw new Error(`smoke: built CLI not found at ${CLI_BIN}`);
  }
}, 60_000);

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix: string): string {
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

function initDisposableRepo(): string {
  const dir = makeTempDir("momentum-smoke-repo-");
  runGit(dir, ["init", "--initial-branch=main", "--quiet"]);
  runGit(dir, ["config", "user.email", "smoke@example.com"]);
  runGit(dir, ["config", "user.name", "Smoke Tester"]);
  runGit(dir, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "README.md"), "smoke init\n", "utf-8");
  runGit(dir, ["add", "README.md"]);
  runGit(dir, ["commit", "-m", "init", "--quiet"]);
  return dir;
}

function stripNodeWarnings(text: string): string {
  const lines = text.split("\n");
  const filtered = lines.filter((line) => {
    if (/^\(node:\d+\) ExperimentalWarning:/u.test(line)) return false;
    if (/^\(Use `node --trace-warnings/.test(line)) return false;
    return true;
  });
  const result = filtered.join("\n").trim();
  return result.length === 0 ? "" : result + (text.endsWith("\n") ? "\n" : "");
}

function runCliBinary(
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {}
): CliResult {
  const env = options.env
    ? { ...process.env, ...options.env }
    : process.env;
  const result = spawnSync(process.execPath, [CLI_BIN, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: stripNodeWarnings(result.stderr ?? "")
  };
}

describe("Milestone 1 end-to-end smoke", () => {
  it(
    "doctor --json reports ok with version, node, platform, and milestone",
    () => {
      const result = runCliBinary(["doctor", "--json"]);
      expect(result.code, `doctor stderr: ${result.stderr}`).toBe(0);
      expect(result.stderr).toBe("");
      const payload = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: true,
        command: "doctor",
        platform: process.platform
      });
      expect(typeof payload["version"]).toBe("string");
      expect((payload["version"] as string).length).toBeGreaterThan(0);
      expect(typeof payload["node"]).toBe("string");
      expect(payload["node"]).toMatch(/^v\d+\./);
      expect(typeof payload["milestone"]).toBe("string");
      expect((payload["milestone"] as string).length).toBeGreaterThan(0);
    },
    60_000
  );

  it(
    "--help lists every Milestone 1 public command on stdout",
    () => {
      const result = runCliBinary(["--help"]);
      expect(result.code, `--help stderr: ${result.stderr}`).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.startsWith("Momentum\n")).toBe(true);
      expect(result.stdout).toContain("Usage:");
      expect(result.stdout).toContain(
        "momentum goal start <goal.md> [--repo <path>] [--foreground] [--runner <profile>] [--from-source <source-item-id>] [--data-dir <path>] [--json]"
      );
      expect(result.stdout).toContain(
        "momentum status [goal-id] [--data-dir <path>] [--json]"
      );
      expect(result.stdout).toContain(
        "momentum handoff <goal-id> [--data-dir <path>] [--json]"
      );
      expect(result.stdout).toContain(
        "momentum worker run [--worker-id <id>] [--data-dir <path>] [--json]"
      );
      expect(result.stdout).toContain(
        "momentum doctor [--repo <path>] [--data-dir <path>] [--json]"
      );
      expect(result.stdout).toContain(
        "Default goal start enqueues a goal_iteration job"
      );
    },
    60_000
  );

  it(
    "status --json reports no_goals when the data dir has no goals",
    () => {
      const dataDir = makeTempDir("momentum-smoke-data-");

      const result = runCliBinary([
        "status",
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      const payload = JSON.parse(result.stderr) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: false,
        command: "status",
        code: "no_goals",
        goalId: null
      });
      expect(typeof payload["message"]).toBe("string");
      expect((payload["message"] as string).length).toBeGreaterThan(0);
      expect(payload["message"]).toContain(dataDir);
    },
    60_000
  );

  it(
    "handoff --json reports goal_not_found when the goal-id is unknown in the data dir",
    () => {
      const dataDir = makeTempDir("momentum-smoke-data-");

      const result = runCliBinary([
        "handoff",
        "no-such-goal",
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      const payload = JSON.parse(result.stderr) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: false,
        command: "handoff",
        code: "goal_not_found",
        goalId: "no-such-goal"
      });
      expect(typeof payload["message"]).toBe("string");
      expect((payload["message"] as string).length).toBeGreaterThan(0);
      expect(payload["message"]).toContain("no-such-goal");
      expect(payload["message"]).toContain(dataDir);
    },
    60_000
  );

  it(
    "--json surfaces usage_error with the commands list when given an unknown command",
    () => {
      const result = runCliBinary(["bogus-command", "--json"]);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      const payload = JSON.parse(result.stderr) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: false,
        code: "usage_error",
        message: "Unknown command: bogus-command"
      });
      expect(payload).not.toHaveProperty("command");
      const commands = payload["commands"];
      expect(Array.isArray(commands)).toBe(true);
      expect(commands).toEqual([
        "momentum goal start <goal.md> [--repo <path>] [--foreground] [--runner <profile>] [--from-source <source-item-id>] [--data-dir <path>] [--json]",
        "momentum status [goal-id] [--data-dir <path>] [--json]",
        "momentum logs <goal-id> [--iteration <n>] [--data-dir <path>] [--json]",
        "momentum handoff <goal-id> [--data-dir <path>] [--json]",
        "momentum source list [--adapter <kind>] [--data-dir <path>] [--json]",
        "momentum source get <source-item-id> [--data-dir <path>] [--json]",
        "momentum source link <source-item-id> --goal <goal-id> [--data-dir <path>] [--json]",
        "momentum source unlink <source-item-id> [--data-dir <path>] [--json]",
        "momentum source reconcile linear [--project <id-or-name>] [--milestone <id-or-name>] [--dry-run] [--max-pages <n>] [--linear-endpoint <url>] [--linear-page-size <n>] [--data-dir <path>] [--json]",
        "momentum worker run [--worker-id <id>] [--data-dir <path>] [--json]",
        "momentum daemon start [--max-loop-iterations <n>] [--max-idle-cycles <n>] [--poll-interval-ms <ms>] [--data-dir <path>] [--json]",
        "momentum daemon stop [--now] [--reason <text>] [--data-dir <path>] [--json]",
        "momentum daemon status [--data-dir <path>] [--json]",
        "momentum project status [--source <adapter>] [--project <id-or-name>] [--milestone <id-or-name>] [--stale-threshold-hours <n>] [--intent-stale-threshold-days <n>] [--data-dir <path>] [--json]",
        "momentum recovery clear <goal-id> [--reason <text>] [--data-dir <path>] [--json]",
        "momentum evidence ingest --path <file-or-dir> [--goal <id>] [--source-item <id>] [--data-dir <path>] [--json]",
        "momentum evidence list [--goal <id>] [--source-item <id>] [--source <source>] [--type <type>] [--limit <n>] [--data-dir <path>] [--json]",
        "momentum intent list [--status <status>] [--adapter <kind>] [--type <intent-type>] [--goal <goal-id>] [--source-item <id>] [--evidence-record <id>] [--limit <n>] [--data-dir <path>] [--json]",
        "momentum intent get <intent-id> [--data-dir <path>] [--json]",
        "momentum intent apply <intent-id> --reason <text> [--data-dir <path>] [--json]",
        "momentum intent skip <intent-id> --reason <text> [--data-dir <path>] [--json]",
        "momentum intent cancel <intent-id> --reason <text> [--data-dir <path>] [--json]",
        "momentum doctor [--repo <path>] [--data-dir <path>] [--json]"
      ]);
    },
    60_000
  );

  it(
    "goal start --json defaults to the queued enqueue path, creates a pending goal_iteration job, and does not run the runner",
    () => {
      const repo = initDisposableRepo();
      const dataDir = makeTempDir("momentum-smoke-data-");
      const goalFile = path.join(dataDir, "goal.md");
      fs.writeFileSync(goalFile, SMOKE_GOAL_SPEC, "utf-8");

      const baseHead = runGit(repo, ["rev-parse", "HEAD"]).trim();

      const result = runCliBinary([
        "goal",
        "start",
        goalFile,
        "--repo",
        repo,
        "--data-dir",
        dataDir,
        "--runner",
        "fake",
        "--json"
      ]);

      expect(result.code, `goal start stderr: ${result.stderr}`).toBe(0);
      expect(result.stderr).toBe("");
      const payload = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: true,
        command: "goal start",
        mode: "queued",
        goalState: "queued",
        jobType: "goal_iteration",
        jobState: "pending",
        title: "Smoke Goal",
        runner: "fake",
        repo,
        baseHead: null,
        iteration: 1,
        resumed: false,
        enqueueCreated: true
      });
      const goalId = payload["goalId"] as string;
      const jobId = payload["jobId"] as string;
      expect(typeof goalId).toBe("string");
      expect(goalId.length).toBeGreaterThan(0);
      expect(typeof jobId).toBe("string");
      expect(payload["idempotencyKey"]).toBe(`goal:${goalId}:iteration:1`);
      expect(typeof payload["nextAction"]).toBe("string");

      // Runner did NOT execute in the default path: no fake fixture, no branch, no commits.
      expect(
        fs.existsSync(path.join(repo, FAKE_RUNNER_FIXTURE_FILENAME))
      ).toBe(false);
      expect(runGit(repo, ["rev-parse", "HEAD"]).trim()).toBe(baseHead);
      const branchListing = runGit(repo, ["branch", "--list", "momentum/*"]);
      expect(branchListing).toBe("");

      const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
      try {
        const goalRow = db
          .prepare("SELECT state FROM goals WHERE id = ?")
          .get(goalId) as { state: string };
        expect(goalRow.state).toBe("queued");

        const jobRows = db
          .prepare(
            "SELECT id, type, state, iteration, idempotency_key FROM jobs WHERE goal_id = ?"
          )
          .all(goalId) as Array<Record<string, unknown>>;
        expect(jobRows).toHaveLength(1);
        expect(jobRows[0]).toMatchObject({
          id: jobId,
          type: "goal_iteration",
          state: "pending",
          iteration: 1,
          idempotency_key: `goal:${goalId}:iteration:1`
        });

        const events = (
          db
            .prepare(
              "SELECT type FROM events WHERE goal_id = ? ORDER BY id ASC"
            )
            .all(goalId) as Array<{ type: string }>
        ).map((row) => row.type);
        expect(events).toEqual(["job.enqueued"]);
      } finally {
        db.close();
      }

      // Idempotent re-enqueue: rerunning the same spec returns the same goal/job and emits no new event.
      const second = runCliBinary([
        "goal",
        "start",
        goalFile,
        "--repo",
        repo,
        "--data-dir",
        dataDir,
        "--runner",
        "fake",
        "--json"
      ]);
      expect(second.code, `second goal start stderr: ${second.stderr}`).toBe(0);
      const secondPayload = JSON.parse(second.stdout) as Record<string, unknown>;
      expect(secondPayload["goalId"]).toBe(goalId);
      expect(secondPayload["jobId"]).toBe(jobId);
      expect(secondPayload["resumed"]).toBe(true);
      expect(secondPayload["enqueueCreated"]).toBe(false);

      const db2 = new DatabaseSync(path.join(dataDir, "momentum.db"));
      try {
        const enqueueCount = db2
          .prepare(
            "SELECT count(*) AS c FROM events WHERE goal_id = ? AND type = 'job.enqueued'"
          )
          .get(goalId) as { c: number };
        expect(enqueueCount.c).toBe(1);
        const jobCount = db2
          .prepare("SELECT count(*) AS c FROM jobs WHERE goal_id = ?")
          .get(goalId) as { c: number };
        expect(jobCount.c).toBe(1);
      } finally {
        db2.close();
      }
    },
    60_000
  );

  it(
    "goal start --json surfaces parse_error when the goal file does not exist and does not touch the data dir",
    () => {
      const dataDir = makeTempDir("momentum-smoke-data-");
      const missingGoalFile = path.join(dataDir, "does-not-exist.md");
      const beforeEntries = fs.readdirSync(dataDir).sort();

      const result = runCliBinary([
        "goal",
        "start",
        missingGoalFile,
        "--foreground",
        "--data-dir",
        dataDir,
        "--json"
      ]);

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      const payload = JSON.parse(result.stderr) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: false,
        command: "goal start",
        code: "parse_error"
      });
      expect(typeof payload["message"]).toBe("string");
      expect(payload["message"]).toBe(
        `Cannot read goal file: ${missingGoalFile}`
      );

      const afterEntries = fs.readdirSync(dataDir).sort();
      expect(afterEntries).toEqual(beforeEntries);
      expect(fs.existsSync(path.join(dataDir, "momentum.db"))).toBe(false);
      expect(fs.existsSync(path.join(dataDir, "goals"))).toBe(false);
    },
    60_000
  );

  it(
    "drives goal start -> status -> handoff against a fresh disposable repo",
    () => {
      const repo = initDisposableRepo();
      const dataDir = makeTempDir("momentum-smoke-data-");
      const goalFile = path.join(dataDir, "goal.md");
      fs.writeFileSync(goalFile, SMOKE_GOAL_SPEC, "utf-8");

      const baseHead = runGit(repo, ["rev-parse", "HEAD"]).trim();

      const start = runCliBinary([
        "goal",
        "start",
        goalFile,
        "--foreground",
        "--repo",
        repo,
        "--data-dir",
        dataDir,
        "--runner",
        "fake",
        "--json"
      ]);
      expect(start.code, `goal start stderr: ${start.stderr}`).toBe(0);
      const startPayload = JSON.parse(start.stdout) as Record<string, unknown>;
      expect(startPayload).toMatchObject({
        ok: true,
        command: "goal start",
        state: "iteration_complete",
        title: "Smoke Goal",
        resumed: false
      });

      const goalId = startPayload["goalId"] as string;
      expect(typeof goalId).toBe("string");
      expect(goalId.length).toBeGreaterThan(0);

      const iter = startPayload["iteration"] as Record<string, unknown>;
      expect(iter).toMatchObject({
        ok: true,
        iteration: 1,
        runnerSuccess: true,
        branchCreated: true,
        goalComplete: false
      });
      expect(iter["baseHead"]).toBe(baseHead);
      const commitSha = iter["commitSha"] as string;
      expect(commitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(commitSha).not.toBe(baseHead);

      const branch = iter["branch"] as string;
      expect(branch).toMatch(/^momentum\//);

      const branchHead = runGit(repo, ["rev-parse", branch]).trim();
      expect(branchHead).toBe(commitSha);

      const commitCount = Number(
        runGit(repo, ["rev-list", "--count", `${baseHead}..${branch}`]).trim()
      );
      expect(commitCount).toBe(1);

      const parent = runGit(repo, ["rev-parse", `${branch}^`]).trim();
      expect(parent).toBe(baseHead);

      expect(fs.existsSync(path.join(repo, FAKE_RUNNER_FIXTURE_FILENAME))).toBe(
        true
      );

      const goalDir = path.join(dataDir, "goals", goalId);
      const iterationDir = path.join(goalDir, "iterations", "1");
      const verificationLog = path.join(iterationDir, "verification.log");
      const runnerLog = path.join(iterationDir, "runner.log");
      const resultJson = path.join(iterationDir, "result.json");
      const promptMd = path.join(iterationDir, "prompt.md");
      const handoffMd = path.join(goalDir, "handoff.md");
      const handoffJson = path.join(goalDir, "handoff.json");

      for (const p of [
        verificationLog,
        runnerLog,
        resultJson,
        promptMd,
        handoffMd,
        handoffJson
      ]) {
        expect(fs.existsSync(p), `missing artifact: ${p}`).toBe(true);
      }
      expect(fs.readFileSync(verificationLog, "utf-8")).toContain("[verify]");
      expect(fs.statSync(verificationLog).size).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(dataDir, "momentum.db"))).toBe(true);

      const promptContent = fs.readFileSync(promptMd, "utf-8");
      expect(promptContent).toContain("# Momentum iteration prompt");
      expect(promptContent).toContain(`- goal_id: ${goalId}`);
      expect(promptContent).toContain("- title: Smoke Goal");
      expect(promptContent).toContain("- iteration: 1 of");
      expect(promptContent).toContain("- runner: fake");
      expect(promptContent).toContain(`- path: ${repo}`);
      expect(promptContent).toContain(`- pre_iteration_head: ${baseHead}`);
      expect(promptContent).toContain("- true");
      expect(promptContent).toContain(
        "Write a single JSON object to result.json"
      );

      const resultPayload = JSON.parse(
        fs.readFileSync(resultJson, "utf-8")
      ) as Record<string, unknown>;
      expect(resultPayload).toMatchObject({
        success: true,
        goal_complete: false
      });
      expect(typeof resultPayload["summary"]).toBe("string");
      expect(Array.isArray(resultPayload["key_changes_made"])).toBe(true);
      expect(Array.isArray(resultPayload["key_learnings"])).toBe(true);
      expect(Array.isArray(resultPayload["remaining_work"])).toBe(true);
      expect(resultPayload["commit"]).toMatchObject({
        type: "test",
        scope: "milestone-1",
        subject: "prove foreground momentum iteration",
        breaking: false
      });

      const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
      try {
        const goalRow = db
          .prepare("SELECT * FROM goals WHERE id = ?")
          .get(goalId) as Record<string, unknown>;
        expect(goalRow).toBeDefined();
        expect(goalRow["title"]).toBe("Smoke Goal");
        expect(goalRow["state"]).toBe("iteration_complete");
        expect(goalRow["runner"]).toBe("fake");
        expect(goalRow["repo"]).toBe(repo);
        expect(goalRow["artifact_dir"]).toBe(goalDir);

        const jobRow = db
          .prepare("SELECT * FROM jobs WHERE goal_id = ?")
          .get(goalId) as Record<string, unknown>;
        expect(jobRow).toBeDefined();
        expect(jobRow["state"]).toBe("succeeded");
        expect(jobRow["iteration"]).toBe(1);
        expect(jobRow["type"]).toBe("foreground_iteration");
        expect(jobRow["error"]).toBeNull();

        const eventTypes = (
          db
            .prepare(
              "SELECT type FROM events WHERE goal_id = ? ORDER BY id ASC"
            )
            .all(goalId) as Array<{ type: string }>
        ).map((row) => row.type);
        expect(eventTypes).toEqual([
          "iteration_started",
          "iteration_completed"
        ]);

        const completedEvent = db
          .prepare(
            "SELECT payload FROM events WHERE goal_id = ? AND type = 'iteration_completed'"
          )
          .get(goalId) as { payload: string };
        const completedPayload = JSON.parse(completedEvent.payload) as Record<
          string,
          unknown
        >;
        expect(completedPayload).toMatchObject({
          iteration: 1,
          commit_sha: commitSha,
          base_head: baseHead,
          branch,
          runner_success: true,
          goal_complete: false
        });
      } finally {
        db.close();
      }

      const status = runCliBinary([
        "status",
        goalId,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(status.code, `status stderr: ${status.stderr}`).toBe(0);
      const statusPayload = JSON.parse(status.stdout) as Record<string, unknown>;
      expect(statusPayload).toMatchObject({
        ok: true,
        command: "status",
        goalId,
        title: "Smoke Goal",
        state: "iteration_complete",
        repo,
        runner: "fake"
      });
      const statusIter = statusPayload["iteration"] as Record<string, unknown>;
      expect(statusIter["commitSha"]).toBe(commitSha);

      const handoff = runCliBinary([
        "handoff",
        goalId,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(handoff.code, `handoff stderr: ${handoff.stderr}`).toBe(0);
      const handoffPayload = JSON.parse(handoff.stdout) as Record<string, unknown>;
      expect(handoffPayload).toMatchObject({
        ok: true,
        command: "handoff",
        goalId,
        title: "Smoke Goal",
        state: "iteration_complete",
        schemaVersion: 1
      });

      const writtenHandoffJson = JSON.parse(
        fs.readFileSync(handoffJson, "utf-8")
      ) as Record<string, unknown>;
      expect(writtenHandoffJson).toMatchObject({
        schema_version: 1,
        goal: {
          id: goalId,
          title: "Smoke Goal",
          state: "iteration_complete",
          repo,
          runner: "fake",
          verification: ["true"],
          artifact_dir: goalDir,
          data_dir: dataDir
        },
        latest_job: {
          type: "foreground_iteration",
          iteration: 1,
          state: "succeeded",
          error: null
        },
        iteration: {
          iteration: 1,
          base_head: baseHead,
          commit_sha: commitSha,
          branch,
          runner_success: true,
          goal_complete: false,
          failure: null
        },
        runner_result: {
          success: true,
          goal_complete: false
        },
        artifacts: {
          goal_md: path.join(goalDir, "goal.md"),
          ledger_md: path.join(goalDir, "ledger.md"),
          handoff_md: handoffMd,
          handoff_json: handoffJson,
          prompt_md: promptMd,
          runner_log: runnerLog,
          verification_log: verificationLog,
          result_json: resultJson
        },
        artifact_files: {
          goal_md: true,
          ledger_md: true,
          handoff_md: true,
          handoff_json: true,
          prompt_md: true,
          runner_log: true,
          verification_log: true,
          result_json: true
        }
      });
      expect(typeof writtenHandoffJson["generated_at"]).toBe("number");
      const handoffRunner = writtenHandoffJson["runner_result"] as Record<
        string,
        unknown
      >;
      expect(handoffRunner["summary"]).toBe(resultPayload["summary"]);
      expect(handoffRunner["key_changes_made"]).toEqual(
        resultPayload["key_changes_made"]
      );
      expect(handoffRunner["key_learnings"]).toEqual(
        resultPayload["key_learnings"]
      );
      expect(handoffRunner["remaining_work"]).toEqual(
        resultPayload["remaining_work"]
      );

      const handoffMdContent = fs.readFileSync(handoffMd, "utf-8");
      expect(handoffMdContent).toContain("# Momentum handoff: Smoke Goal");
      expect(handoffMdContent).toContain(`- Goal ID: ${goalId}`);
      expect(handoffMdContent).toContain("- State: iteration_complete");
      expect(handoffMdContent).toContain(`- Repo: ${repo}`);
      expect(handoffMdContent).toContain(`- Branch: ${branch}`);
      expect(handoffMdContent).toContain("- Runner: fake");
      expect(handoffMdContent).toContain("- Schema version: 1");
      expect(handoffMdContent).toContain("## Verification commands");
      expect(handoffMdContent).toContain("- `true`");
      expect(handoffMdContent).toContain("## Iteration");
      expect(handoffMdContent).toContain(`- Iteration: 1`);
      expect(handoffMdContent).toContain(`- Base HEAD: ${baseHead}`);
      expect(handoffMdContent).toContain(`- Commit SHA: ${commitSha}`);
      expect(handoffMdContent).toContain("- Runner success: true");
      expect(handoffMdContent).toContain("- Goal complete: false");
      expect(handoffMdContent).toContain("## Latest job");
      expect(handoffMdContent).toContain("- Type: foreground_iteration");
      expect(handoffMdContent).toContain("- State: succeeded");
      expect(handoffMdContent).toContain("## Runner result");
      expect(handoffMdContent).toContain("- Success: true");
      expect(handoffMdContent).toContain("## Artifacts");
      expect(handoffMdContent).toContain(`- Artifact dir: ${goalDir}`);
      expect(handoffMdContent).toContain(`prompt.md (present)`);
      expect(handoffMdContent).toContain(`verification.log (present)`);
      expect(handoffMdContent).toContain(`result.json (present)`);

      expect(fs.readFileSync(path.join(goalDir, "goal.md"), "utf-8")).toBe(
        SMOKE_GOAL_SPEC
      );
      expect(fs.existsSync(path.join(goalDir, "ledger.md"))).toBe(true);

      const mainHead = runGit(repo, ["rev-parse", "main"]).trim();
      expect(mainHead).toBe(baseHead);
    },
    60_000
  );

  it(
    "resets the repo to base HEAD when verification fails",
    () => {
      const failingSpec = `---
title: Smoke Goal Fail
runner: fake
verification:
  - "false"
---

End-to-end smoke goal that fails verification.
`;
      const repo = initDisposableRepo();
      const dataDir = makeTempDir("momentum-smoke-data-");
      const goalFile = path.join(dataDir, "goal.md");
      fs.writeFileSync(goalFile, failingSpec, "utf-8");

      const baseHead = runGit(repo, ["rev-parse", "HEAD"]).trim();

      const start = runCliBinary([
        "goal",
        "start",
        goalFile,
        "--foreground",
        "--repo",
        repo,
        "--data-dir",
        dataDir,
        "--runner",
        "fake",
        "--json"
      ]);
      expect(start.code).toBe(1);
      const payload = JSON.parse(start.stderr) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: false,
        command: "goal start",
        state: "failed",
        code: "iteration_failed"
      });
      const iter = payload["iteration"] as Record<string, unknown>;
      expect(iter).toMatchObject({ ok: false, code: "verification_failed" });

      expect(runGit(repo, ["rev-parse", "HEAD"]).trim()).toBe(baseHead);
      expect(runGit(repo, ["status", "--porcelain"]).trim()).toBe("");
      expect(
        fs.existsSync(path.join(repo, FAKE_RUNNER_FIXTURE_FILENAME))
      ).toBe(false);

      const goalId = payload["goalId"] as string;
      const verificationLog = path.join(
        dataDir,
        "goals",
        goalId,
        "iterations",
        "1",
        "verification.log"
      );
      expect(fs.existsSync(verificationLog)).toBe(true);
      expect(fs.readFileSync(verificationLog, "utf-8")).toContain(
        "[verify] running: false"
      );

      const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
      try {
        const goalRow = db
          .prepare("SELECT state FROM goals WHERE id = ?")
          .get(goalId) as { state: string };
        expect(goalRow.state).toBe("failed");
        const jobRow = db
          .prepare("SELECT state, error FROM jobs WHERE goal_id = ?")
          .get(goalId) as { state: string; error: string | null };
        expect(jobRow.state).toBe("failed");
        expect(jobRow.error).toContain("verification_failed");
        const eventTypes = (
          db
            .prepare(
              "SELECT type FROM events WHERE goal_id = ? ORDER BY id ASC"
            )
            .all(goalId) as Array<{ type: string }>
        ).map((row) => row.type);
        expect(eventTypes).toEqual([
          "iteration_started",
          "iteration_failed"
        ]);
      } finally {
        db.close();
      }

      const status = runCliBinary([
        "status",
        goalId,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(status.code, `status stderr: ${status.stderr}`).toBe(0);
      const statusPayload = JSON.parse(status.stdout) as Record<string, unknown>;
      expect(statusPayload).toMatchObject({
        ok: true,
        command: "status",
        goalId,
        title: "Smoke Goal Fail",
        state: "failed",
        repo,
        runner: "fake"
      });
      const statusLatestJob = statusPayload["latestJob"] as Record<
        string,
        unknown
      >;
      expect(statusLatestJob).toMatchObject({
        type: "foreground_iteration",
        iteration: 1,
        state: "failed"
      });
      expect(statusLatestJob["error"]).toContain("verification_failed");
      const statusIter = statusPayload["iteration"] as Record<string, unknown>;
      expect(statusIter).toMatchObject({
        iteration: 1,
        commitSha: null,
        runnerSuccess: null,
        goalComplete: null
      });
      expect(statusIter["baseHead"]).toBeNull();
      const statusFailure = statusIter["failure"] as Record<string, unknown>;
      expect(statusFailure).toMatchObject({ code: "verification_failed" });
      expect(typeof statusFailure["error"]).toBe("string");
      const statusFiles = statusPayload["artifactFiles"] as Record<
        string,
        boolean
      >;
      expect(statusFiles).toMatchObject({
        goalMd: true,
        ledgerMd: true,
        promptMd: true,
        runnerLog: true,
        verificationLog: true,
        resultJson: true
      });

      const handoff = runCliBinary([
        "handoff",
        goalId,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(handoff.code, `handoff stderr: ${handoff.stderr}`).toBe(0);
      const handoffPayload = JSON.parse(handoff.stdout) as Record<
        string,
        unknown
      >;
      expect(handoffPayload).toMatchObject({
        ok: true,
        command: "handoff",
        goalId,
        title: "Smoke Goal Fail",
        state: "failed",
        schemaVersion: 1
      });

      const handoffJsonPath = path.join(
        dataDir,
        "goals",
        goalId,
        "handoff.json"
      );
      const handoffMdPath = path.join(dataDir, "goals", goalId, "handoff.md");
      const writtenHandoffJson = JSON.parse(
        fs.readFileSync(handoffJsonPath, "utf-8")
      ) as Record<string, unknown>;
      expect(writtenHandoffJson).toMatchObject({
        schema_version: 1,
        goal: {
          id: goalId,
          title: "Smoke Goal Fail",
          state: "failed",
          repo,
          runner: "fake",
          verification: ["false"]
        },
        latest_job: {
          type: "foreground_iteration",
          iteration: 1,
          state: "failed"
        },
        iteration: {
          iteration: 1,
          commit_sha: null,
          runner_success: null,
          goal_complete: null,
          failure: { code: "verification_failed" }
        },
        runner_result: {
          success: true,
          goal_complete: false
        }
      });
      const writtenJob = writtenHandoffJson["latest_job"] as Record<
        string,
        unknown
      >;
      expect(writtenJob["error"]).toContain("verification_failed");

      const handoffMdContent = fs.readFileSync(handoffMdPath, "utf-8");
      expect(handoffMdContent).toContain("# Momentum handoff: Smoke Goal Fail");
      expect(handoffMdContent).toContain("- State: failed");
      expect(handoffMdContent).toContain("- Commit SHA: (none)");
      expect(handoffMdContent).toContain(
        "- Failure: verification_failed - "
      );
    },
    60_000
  );

  it(
    "goal start surfaces unsupported_runner at init time without touching the repo or creating a goal row",
    () => {
      const repo = initDisposableRepo();
      const dataDir = makeTempDir("momentum-smoke-data-");
      const goalFile = path.join(dataDir, "goal.md");
      fs.writeFileSync(goalFile, SMOKE_GOAL_SPEC, "utf-8");

      const baseHead = runGit(repo, ["rev-parse", "HEAD"]).trim();

      const start = runCliBinary([
        "goal",
        "start",
        goalFile,
        "--foreground",
        "--repo",
        repo,
        "--data-dir",
        dataDir,
        "--runner",
        "custom-runner",
        "--json"
      ]);
      expect(start.code).toBe(1);
      expect(start.stdout).toBe("");
      const payload = JSON.parse(start.stderr) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: false,
        command: "goal start",
        code: "unsupported_runner"
      });
      expect(payload["message"] as string).toContain("custom-runner");

      expect(runGit(repo, ["rev-parse", "HEAD"]).trim()).toBe(baseHead);
      expect(runGit(repo, ["status", "--porcelain"]).trim()).toBe("");
      const branchListing = runGit(repo, ["branch", "--list", "momentum/*"]);
      expect(branchListing).toBe("");
      expect(
        fs.existsSync(path.join(repo, FAKE_RUNNER_FIXTURE_FILENAME))
      ).toBe(false);

      // Unsupported runner fails before the data dir / database are touched.
      expect(fs.existsSync(path.join(dataDir, "momentum.db"))).toBe(false);
      expect(fs.existsSync(path.join(dataDir, "goals"))).toBe(false);
    },
    60_000
  );

  it(
    "goal start surfaces repo_guard_failed and preserves the dirty worktree when the repo has uncommitted changes",
    () => {
      const repo = initDisposableRepo();
      const dataDir = makeTempDir("momentum-smoke-data-");
      const goalFile = path.join(dataDir, "goal.md");
      fs.writeFileSync(goalFile, SMOKE_GOAL_SPEC, "utf-8");

      const baseHead = runGit(repo, ["rev-parse", "HEAD"]).trim();
      const dirtyPath = path.join(repo, "dirty.txt");
      fs.writeFileSync(dirtyPath, "uncommitted\n", "utf-8");

      const start = runCliBinary([
        "goal",
        "start",
        goalFile,
        "--foreground",
        "--repo",
        repo,
        "--data-dir",
        dataDir,
        "--runner",
        "fake",
        "--json"
      ]);
      expect(start.code).toBe(1);
      expect(start.stdout).toBe("");
      const payload = JSON.parse(start.stderr) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: false,
        command: "goal start",
        state: "failed",
        code: "iteration_failed",
        resumed: false
      });
      const iter = payload["iteration"] as Record<string, unknown>;
      expect(iter).toMatchObject({
        ok: false,
        code: "repo_guard_failed"
      });
      expect(typeof iter["error"]).toBe("string");
      expect(iter["error"] as string).toContain("uncommitted changes");

      expect(runGit(repo, ["rev-parse", "HEAD"]).trim()).toBe(baseHead);
      expect(fs.existsSync(dirtyPath)).toBe(true);
      expect(fs.readFileSync(dirtyPath, "utf-8")).toBe("uncommitted\n");
      expect(runGit(repo, ["status", "--porcelain"]).trim()).toBe(
        "?? dirty.txt"
      );
      const branchListing = runGit(repo, ["branch", "--list", "momentum/*"]);
      expect(branchListing).toBe("");
      expect(
        fs.existsSync(path.join(repo, FAKE_RUNNER_FIXTURE_FILENAME))
      ).toBe(false);

      const goalId = payload["goalId"] as string;
      expect(typeof goalId).toBe("string");
      expect(goalId.length).toBeGreaterThan(0);

      const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
      try {
        const goalRow = db
          .prepare("SELECT state, repo FROM goals WHERE id = ?")
          .get(goalId) as { state: string; repo: string };
        expect(goalRow.state).toBe("failed");
        expect(goalRow.repo).toBe(repo);
        const jobRow = db
          .prepare("SELECT state, error FROM jobs WHERE goal_id = ?")
          .get(goalId) as { state: string; error: string | null };
        expect(jobRow.state).toBe("failed");
        expect(jobRow.error).toContain("repo_guard_failed");
      } finally {
        db.close();
      }
    },
    60_000
  );

  it(
    "goal start surfaces missing_repo when neither --repo nor frontmatter repo is set",
    () => {
      const dataDir = makeTempDir("momentum-smoke-data-");
      const goalFile = path.join(dataDir, "goal.md");
      fs.writeFileSync(goalFile, SMOKE_GOAL_SPEC, "utf-8");

      const start = runCliBinary([
        "goal",
        "start",
        goalFile,
        "--foreground",
        "--data-dir",
        dataDir,
        "--runner",
        "fake",
        "--json"
      ]);
      expect(start.code).toBe(1);
      expect(start.stdout).toBe("");
      const payload = JSON.parse(start.stderr) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: false,
        command: "goal start",
        state: "failed",
        code: "iteration_failed",
        resumed: false
      });
      const iter = payload["iteration"] as Record<string, unknown>;
      expect(iter).toMatchObject({
        ok: false,
        code: "missing_repo"
      });
      expect(typeof iter["error"]).toBe("string");
      expect(iter["error"] as string).toContain("repo");

      const goalId = payload["goalId"] as string;
      expect(typeof goalId).toBe("string");
      expect(goalId.length).toBeGreaterThan(0);

      const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
      try {
        const goalRow = db
          .prepare("SELECT state, repo FROM goals WHERE id = ?")
          .get(goalId) as { state: string; repo: string | null };
        expect(goalRow.state).toBe("failed");
        expect(goalRow.repo).toBeNull();
        const jobRow = db
          .prepare("SELECT state, error FROM jobs WHERE goal_id = ?")
          .get(goalId) as { state: string; error: string | null };
        expect(jobRow.state).toBe("failed");
        expect(jobRow.error).toContain("missing_repo");
      } finally {
        db.close();
      }
    },
    60_000
  );

  it(
    "resets the repo to base HEAD when the runner reports failure",
    () => {
      const repo = initDisposableRepo();
      const dataDir = makeTempDir("momentum-smoke-data-");
      const goalFile = path.join(dataDir, "goal.md");
      fs.writeFileSync(goalFile, SMOKE_GOAL_SPEC, "utf-8");

      const baseHead = runGit(repo, ["rev-parse", "HEAD"]).trim();

      const start = runCliBinary(
        [
          "goal",
          "start",
          goalFile,
          "--foreground",
          "--repo",
          repo,
          "--data-dir",
          dataDir,
          "--runner",
          "fake",
          "--json"
        ],
        { env: { [FAKE_RUNNER_FAIL_ENV]: "1" } }
      );
      expect(start.code).toBe(1);
      const payload = JSON.parse(start.stderr) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: false,
        command: "goal start",
        state: "failed",
        code: "iteration_failed"
      });
      const iter = payload["iteration"] as Record<string, unknown>;
      expect(iter).toMatchObject({
        ok: false,
        code: "runner_reported_failure"
      });

      expect(runGit(repo, ["rev-parse", "HEAD"]).trim()).toBe(baseHead);
      expect(runGit(repo, ["status", "--porcelain"]).trim()).toBe("");
      expect(
        fs.existsSync(path.join(repo, FAKE_RUNNER_FIXTURE_FILENAME))
      ).toBe(false);

      const goalId = payload["goalId"] as string;
      const runnerLog = path.join(
        dataDir,
        "goals",
        goalId,
        "iterations",
        "1",
        "runner.log"
      );
      const verificationLog = path.join(
        dataDir,
        "goals",
        goalId,
        "iterations",
        "1",
        "verification.log"
      );
      expect(fs.readFileSync(runnerLog, "utf-8")).toContain(
        `simulated failure via ${FAKE_RUNNER_FAIL_ENV}`
      );
      expect(fs.readFileSync(verificationLog, "utf-8")).toContain(
        "[verify] skipped: runner reported failure"
      );
    },
    60_000
  );

  it(
    "status text mode prints the documented goal summary after a successful goal start",
    () => {
      const repo = initDisposableRepo();
      const dataDir = makeTempDir("momentum-smoke-data-");
      const goalFile = path.join(dataDir, "goal.md");
      fs.writeFileSync(goalFile, SMOKE_GOAL_SPEC, "utf-8");

      const start = runCliBinary([
        "goal",
        "start",
        goalFile,
        "--foreground",
        "--repo",
        repo,
        "--data-dir",
        dataDir,
        "--runner",
        "fake",
        "--json"
      ]);
      expect(start.code, `goal start stderr: ${start.stderr}`).toBe(0);
      const startPayload = JSON.parse(start.stdout) as Record<string, unknown>;
      const goalId = startPayload["goalId"] as string;
      const jobId = startPayload["jobId"] as string;
      const artifactDir = startPayload["artifactDir"] as string;
      const iter = startPayload["iteration"] as Record<string, unknown>;
      const commitSha = iter["commitSha"] as string;
      const branch = iter["branch"] as string;

      const status = runCliBinary([
        "status",
        goalId,
        "--data-dir",
        dataDir
      ]);
      expect(status.code, `status stderr: ${status.stderr}`).toBe(0);
      expect(status.stderr).toBe("");

      const lines = status.stdout.split("\n");
      expect(lines[0]).toBe(`Goal: ${goalId}`);
      expect(lines[1]).toBe("Title: Smoke Goal");
      expect(lines[2]).toBe("State: iteration_complete");
      expect(lines[3]).toBe(`Repo: ${repo}`);
      expect(lines[4]).toBe(`Branch: ${branch}`);
      expect(lines[5]).toBe("Runner: fake");
      expect(lines[6]).toBe("Runner profile: fake (executes=true)");
      expect(lines[7]).toBe(`Artifact dir: ${artifactDir}`);
      expect(lines[8]).toMatch(
        new RegExp(`^Recovery: missing \\(.*/${goalId}/recovery\\.md\\)$`)
      );
      expect(lines[9]).toBe(
        `Job: ${jobId} (succeeded, iteration 1)`
      );
      expect(lines[10]).toBe(`Commit: ${commitSha}`);
      expect(status.stdout.endsWith("\n")).toBe(true);
      expect(status.stdout).not.toContain("{");
      expect(status.stdout).not.toContain("Failure:");
    },
    60_000
  );
});

describe("Milestone 2 queued goal_iteration end-to-end smoke (NGX-248)", () => {
  it(
    "enqueues a goal, runs the worker once, and produces exactly one verified commit with succeeded job and full event chain",
    () => {
      const repo = initDisposableRepo();
      const dataDir = makeTempDir("momentum-smoke-m2-data-");
      const goalFile = path.join(dataDir, "goal.md");
      fs.writeFileSync(goalFile, SMOKE_GOAL_SPEC, "utf-8");

      const baseHead = runGit(repo, ["rev-parse", "HEAD"]).trim();

      const start = runCliBinary([
        "goal",
        "start",
        goalFile,
        "--repo",
        repo,
        "--data-dir",
        dataDir,
        "--runner",
        "fake",
        "--json"
      ]);
      expect(start.code, `goal start stderr: ${start.stderr}`).toBe(0);
      expect(start.stderr).toBe("");
      const startPayload = JSON.parse(start.stdout) as Record<string, unknown>;
      expect(startPayload).toMatchObject({
        ok: true,
        command: "goal start",
        mode: "queued",
        goalState: "queued",
        jobType: "goal_iteration",
        jobState: "pending"
      });
      const goalId = startPayload["goalId"] as string;
      const jobId = startPayload["jobId"] as string;

      expect(runGit(repo, ["rev-parse", "HEAD"]).trim()).toBe(baseHead);
      expect(
        fs.existsSync(path.join(repo, FAKE_RUNNER_FIXTURE_FILENAME))
      ).toBe(false);

      const worker = runCliBinary([
        "worker",
        "run",
        "--data-dir",
        dataDir,
        "--worker-id",
        "smoke-worker-success",
        "--json"
      ]);
      expect(worker.code, `worker run stderr: ${worker.stderr}`).toBe(0);
      expect(worker.stderr).toBe("");
      const workerPayload = JSON.parse(worker.stdout) as Record<string, unknown>;
      expect(workerPayload).toMatchObject({
        ok: true,
        command: "worker run",
        code: "ran_job",
        outcome: "ran_job",
        workerId: "smoke-worker-success",
        goalId,
        jobId,
        repoRoot: repo,
        goalState: "iteration_complete",
        jobState: "succeeded",
        iteration: 1
      });
      const iterationResult = workerPayload["jobIterationResult"] as Record<
        string,
        unknown
      >;
      expect(iterationResult).toMatchObject({
        ok: true,
        goalState: "iteration_complete",
        jobState: "succeeded"
      });
      const iter = iterationResult["iteration"] as Record<string, unknown>;
      expect(iter).toMatchObject({
        ok: true,
        iteration: 1,
        repoPath: repo,
        branchCreated: true,
        baseHead
      });
      const branch = iter["branch"] as string;
      const commitSha = iter["commitSha"] as string;
      expect(branch).toMatch(/^momentum\//);
      expect(commitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(commitSha).not.toBe(baseHead);
      const resultPath = iter["resultJsonPath"] as string;
      expect(typeof resultPath).toBe("string");

      // Repo invariants after the queued worker run: main untouched, momentum branch holds the
      // single verified commit, worktree clean, runner fixture present on the checked-out branch.
      expect(runGit(repo, ["rev-parse", "main"]).trim()).toBe(baseHead);
      expect(runGit(repo, ["status", "--porcelain"]).trim()).toBe("");
      expect(runGit(repo, ["rev-parse", branch]).trim()).toBe(commitSha);
      const parent = runGit(repo, ["rev-parse", `${branch}^`]).trim();
      expect(parent).toBe(baseHead);
      const commitCount = Number(
        runGit(repo, ["rev-list", "--count", `${baseHead}..${branch}`]).trim()
      );
      expect(commitCount).toBe(1);
      expect(
        fs.existsSync(path.join(repo, FAKE_RUNNER_FIXTURE_FILENAME))
      ).toBe(true);

      // Artifacts written under the goal artifact directory.
      const goalDir = path.join(dataDir, "goals", goalId);
      const iterationDir = path.join(goalDir, "iterations", "1");
      const verificationLog = path.join(iterationDir, "verification.log");
      const runnerLog = path.join(iterationDir, "runner.log");
      const resultJson = path.join(iterationDir, "result.json");
      const promptMd = path.join(iterationDir, "prompt.md");
      for (const p of [verificationLog, runnerLog, resultJson, promptMd]) {
        expect(fs.existsSync(p), `missing artifact: ${p}`).toBe(true);
      }
      expect(resultPath).toBe(resultJson);
      expect(fs.readFileSync(verificationLog, "utf-8")).toContain("[verify]");

      // Queue/job/event invariants.
      const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
      try {
        const jobRow = db
          .prepare(
            "SELECT state, type, iteration, error, result_path, error_path, worker_id, attempt_count FROM jobs WHERE id = ?"
          )
          .get(jobId) as {
          state: string;
          type: string;
          iteration: number;
          error: string | null;
          result_path: string | null;
          error_path: string | null;
          worker_id: string | null;
          attempt_count: number;
        };
        expect(jobRow).toMatchObject({
          state: "succeeded",
          type: "goal_iteration",
          iteration: 1,
          error: null,
          result_path: resultJson,
          error_path: null,
          worker_id: "smoke-worker-success",
          attempt_count: 1
        });

        const goalRow = db
          .prepare("SELECT state FROM goals WHERE id = ?")
          .get(goalId) as { state: string };
        expect(goalRow.state).toBe("max_iterations_reached");

        const eventTypes = (
          db
            .prepare(
              "SELECT type FROM events WHERE goal_id = ? ORDER BY id ASC"
            )
            .all(goalId) as Array<{ type: string }>
        ).map((row) => row.type);
        expect(eventTypes).toEqual([
          "job.enqueued",
          "job.claimed",
          "job.heartbeat",
          "iteration_started",
          "iteration_completed",
          "job.succeeded",
          "goal.reduced",
          "goal.failed"
        ]);

        const succeededRow = db
          .prepare(
            "SELECT payload FROM events WHERE goal_id = ? AND type = 'job.succeeded'"
          )
          .get(goalId) as { payload: string };
        const succeededPayload = JSON.parse(
          succeededRow.payload
        ) as Record<string, unknown>;
        expect(succeededPayload).toMatchObject({
          iteration: 1,
          worker_id: "smoke-worker-success",
          repo_root: repo,
          branch,
          branch_created: true,
          base_head: baseHead,
          commit_sha: commitSha,
          goal_complete: false,
          result_path: resultJson
        });
        const succeededArtifacts = succeededPayload["artifacts"] as Record<
          string,
          unknown
        >;
        expect(succeededArtifacts).toMatchObject({
          iteration_dir: iterationDir,
          prompt: promptMd,
          runner_log: runnerLog,
          verification_log: verificationLog,
          result_json: resultJson
        });
      } finally {
        db.close();
      }

      // status --json surfaces the queued job artifact pointers.
      const status = runCliBinary([
        "status",
        goalId,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(status.code, `status stderr: ${status.stderr}`).toBe(0);
      const statusPayload = JSON.parse(status.stdout) as Record<string, unknown>;
      expect(statusPayload).toMatchObject({
        ok: true,
        command: "status",
        goalId,
        state: "max_iterations_reached"
      });
      const latestJob = statusPayload["latestJob"] as Record<string, unknown>;
      expect(latestJob).toMatchObject({
        type: "goal_iteration",
        state: "succeeded",
        iteration: 1,
        resultPath: resultJson,
        errorPath: null
      });
      const statusIter = statusPayload["iteration"] as Record<string, unknown>;
      expect(statusIter["commitSha"]).toBe(commitSha);

      // handoff --json + handoff.json + handoff.md all carry queued artifact pointers.
      const handoff = runCliBinary([
        "handoff",
        goalId,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(handoff.code, `handoff stderr: ${handoff.stderr}`).toBe(0);
      const handoffPayload = JSON.parse(handoff.stdout) as Record<
        string,
        unknown
      >;
      expect(handoffPayload).toMatchObject({
        ok: true,
        command: "handoff",
        goalId,
        state: "max_iterations_reached"
      });
      const handoffJson = path.join(goalDir, "handoff.json");
      const handoffMd = path.join(goalDir, "handoff.md");
      const writtenHandoffJson = JSON.parse(
        fs.readFileSync(handoffJson, "utf-8")
      ) as Record<string, unknown>;
      const handoffLatestJob = writtenHandoffJson["latest_job"] as Record<
        string,
        unknown
      >;
      expect(handoffLatestJob).toMatchObject({
        type: "goal_iteration",
        state: "succeeded",
        iteration: 1,
        result_path: resultJson,
        error_path: null
      });
      const handoffMdContent = fs.readFileSync(handoffMd, "utf-8");
      expect(handoffMdContent).toContain("- Type: goal_iteration");
      expect(handoffMdContent).toContain(`- Result path: ${resultJson}`);
      expect(handoffMdContent).not.toContain("- Error path:");
    },
    90_000
  );

  it(
    "fails the queued job, resets the repo, and surfaces error_path through status/handoff when the runner reports failure",
    () => {
      const repo = initDisposableRepo();
      const dataDir = makeTempDir("momentum-smoke-m2-runner-fail-data-");
      const goalFile = path.join(dataDir, "goal.md");
      fs.writeFileSync(goalFile, SMOKE_GOAL_SPEC, "utf-8");

      const baseHead = runGit(repo, ["rev-parse", "HEAD"]).trim();

      const start = runCliBinary([
        "goal",
        "start",
        goalFile,
        "--repo",
        repo,
        "--data-dir",
        dataDir,
        "--runner",
        "fake",
        "--json"
      ]);
      expect(start.code, `goal start stderr: ${start.stderr}`).toBe(0);
      const startPayload = JSON.parse(start.stdout) as Record<string, unknown>;
      const goalId = startPayload["goalId"] as string;
      const jobId = startPayload["jobId"] as string;

      const worker = runCliBinary(
        [
          "worker",
          "run",
          "--data-dir",
          dataDir,
          "--worker-id",
          "smoke-worker-runner-fail",
          "--json"
        ],
        { env: { [FAKE_RUNNER_FAIL_ENV]: "1" } }
      );
      expect(worker.code, `worker run stderr: ${worker.stderr}`).toBe(1);
      expect(worker.stderr).toBe("");
      const workerPayload = JSON.parse(worker.stdout) as Record<string, unknown>;
      expect(workerPayload).toMatchObject({
        ok: false,
        command: "worker run",
        code: "ran_job",
        outcome: "ran_job",
        goalId,
        jobId,
        goalState: "failed",
        jobState: "failed"
      });
      const iterationResult = workerPayload["jobIterationResult"] as Record<
        string,
        unknown
      >;
      expect(iterationResult).toMatchObject({
        ok: false,
        goalState: "failed",
        jobState: "failed"
      });
      const iter = iterationResult["iteration"] as Record<string, unknown>;
      expect(iter).toMatchObject({
        ok: false,
        code: "runner_reported_failure"
      });

      // Repo cleanliness invariant: HEAD reset to base, worktree clean, no fixture.
      expect(runGit(repo, ["rev-parse", "HEAD"]).trim()).toBe(baseHead);
      expect(runGit(repo, ["status", "--porcelain"]).trim()).toBe("");
      expect(runGit(repo, ["rev-parse", "main"]).trim()).toBe(baseHead);
      expect(
        fs.existsSync(path.join(repo, FAKE_RUNNER_FIXTURE_FILENAME))
      ).toBe(false);

      const goalDir = path.join(dataDir, "goals", goalId);
      const iterationDir = path.join(goalDir, "iterations", "1");
      const verificationLog = path.join(iterationDir, "verification.log");
      const runnerLog = path.join(iterationDir, "runner.log");
      expect(fs.existsSync(runnerLog)).toBe(true);
      expect(fs.readFileSync(runnerLog, "utf-8")).toContain(
        `simulated failure via ${FAKE_RUNNER_FAIL_ENV}`
      );
      expect(fs.existsSync(verificationLog)).toBe(true);
      expect(fs.readFileSync(verificationLog, "utf-8")).toContain(
        "[verify] skipped: runner reported failure"
      );

      const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
      try {
        const jobRow = db
          .prepare(
            "SELECT state, type, iteration, error, result_path, error_path, worker_id FROM jobs WHERE id = ?"
          )
          .get(jobId) as {
          state: string;
          type: string;
          iteration: number;
          error: string | null;
          result_path: string | null;
          error_path: string | null;
          worker_id: string | null;
        };
        expect(jobRow).toMatchObject({
          state: "failed",
          type: "goal_iteration",
          iteration: 1,
          result_path: null,
          error_path: verificationLog,
          worker_id: "smoke-worker-runner-fail"
        });
        expect(jobRow.error).toContain("runner_reported_failure");

        const goalRow = db
          .prepare("SELECT state FROM goals WHERE id = ?")
          .get(goalId) as { state: string };
        expect(goalRow.state).toBe("failed");

        const eventTypes = (
          db
            .prepare(
              "SELECT type FROM events WHERE goal_id = ? ORDER BY id ASC"
            )
            .all(goalId) as Array<{ type: string }>
        ).map((row) => row.type);
        expect(eventTypes).toEqual([
          "job.enqueued",
          "job.claimed",
          "job.heartbeat",
          "iteration_started",
          "iteration_failed",
          "job.failed",
          "goal.reduced",
          "goal.failed"
        ]);

        const failedRow = db
          .prepare(
            "SELECT payload FROM events WHERE goal_id = ? AND type = 'job.failed'"
          )
          .get(goalId) as { payload: string };
        const failedPayload = JSON.parse(failedRow.payload) as Record<
          string,
          unknown
        >;
        expect(failedPayload).toMatchObject({
          iteration: 1,
          worker_id: "smoke-worker-runner-fail",
          repo_root: repo
        });
        expect(failedPayload["error"]).toBe("runner_reported_failure");
        const failedArtifacts = failedPayload["artifacts"] as Record<
          string,
          unknown
        >;
        expect(failedArtifacts).toMatchObject({
          iteration_dir: iterationDir,
          runner_log: runnerLog,
          verification_log: verificationLog
        });
      } finally {
        db.close();
      }

      // status --json surfaces error_path from the queued failed job.
      const status = runCliBinary([
        "status",
        goalId,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(status.code, `status stderr: ${status.stderr}`).toBe(0);
      const statusPayload = JSON.parse(status.stdout) as Record<string, unknown>;
      const latestJob = statusPayload["latestJob"] as Record<string, unknown>;
      expect(latestJob).toMatchObject({
        type: "goal_iteration",
        state: "failed",
        iteration: 1,
        resultPath: null,
        errorPath: verificationLog
      });
      expect(latestJob["error"]).toContain("runner_reported_failure");

      // handoff JSON + markdown surface error_path = verification.log.
      const handoff = runCliBinary([
        "handoff",
        goalId,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(handoff.code, `handoff stderr: ${handoff.stderr}`).toBe(0);
      const handoffJson = path.join(goalDir, "handoff.json");
      const handoffMd = path.join(goalDir, "handoff.md");
      const writtenHandoffJson = JSON.parse(
        fs.readFileSync(handoffJson, "utf-8")
      ) as Record<string, unknown>;
      const handoffLatestJob = writtenHandoffJson["latest_job"] as Record<
        string,
        unknown
      >;
      expect(handoffLatestJob).toMatchObject({
        type: "goal_iteration",
        state: "failed",
        iteration: 1,
        result_path: null,
        error_path: verificationLog
      });
      const handoffMdContent = fs.readFileSync(handoffMd, "utf-8");
      expect(handoffMdContent).toContain("- State: failed");
      expect(handoffMdContent).toContain(`- Error path: ${verificationLog}`);
      expect(handoffMdContent).not.toContain("- Result path:");
    },
    90_000
  );

  it(
    "fails the queued job, resets the repo, and surfaces error_path through status/handoff when verification fails",
    () => {
      const failingSpec = `---
title: Smoke Queue Fail
runner: fake
verification:
  - "false"
---

Queued smoke goal that fails verification.
`;
      const repo = initDisposableRepo();
      const dataDir = makeTempDir("momentum-smoke-m2-fail-data-");
      const goalFile = path.join(dataDir, "goal.md");
      fs.writeFileSync(goalFile, failingSpec, "utf-8");

      const baseHead = runGit(repo, ["rev-parse", "HEAD"]).trim();

      const start = runCliBinary([
        "goal",
        "start",
        goalFile,
        "--repo",
        repo,
        "--data-dir",
        dataDir,
        "--runner",
        "fake",
        "--json"
      ]);
      expect(start.code, `goal start stderr: ${start.stderr}`).toBe(0);
      const startPayload = JSON.parse(start.stdout) as Record<string, unknown>;
      const goalId = startPayload["goalId"] as string;
      const jobId = startPayload["jobId"] as string;

      const worker = runCliBinary([
        "worker",
        "run",
        "--data-dir",
        dataDir,
        "--worker-id",
        "smoke-worker-fail",
        "--json"
      ]);
      expect(worker.code, `worker run stderr: ${worker.stderr}`).toBe(1);
      expect(worker.stderr).toBe("");
      const workerPayload = JSON.parse(worker.stdout) as Record<string, unknown>;
      expect(workerPayload).toMatchObject({
        ok: false,
        command: "worker run",
        code: "ran_job",
        outcome: "ran_job",
        goalId,
        jobId,
        goalState: "failed",
        jobState: "failed"
      });
      const iterationResult = workerPayload["jobIterationResult"] as Record<
        string,
        unknown
      >;
      expect(iterationResult).toMatchObject({
        ok: false,
        goalState: "failed",
        jobState: "failed"
      });
      const iter = iterationResult["iteration"] as Record<string, unknown>;
      expect(iter).toMatchObject({
        ok: false,
        code: "verification_failed"
      });

      // Repo cleanliness invariant: HEAD reset to base, worktree clean, no fixture.
      expect(runGit(repo, ["rev-parse", "HEAD"]).trim()).toBe(baseHead);
      expect(runGit(repo, ["status", "--porcelain"]).trim()).toBe("");
      expect(runGit(repo, ["rev-parse", "main"]).trim()).toBe(baseHead);
      expect(
        fs.existsSync(path.join(repo, FAKE_RUNNER_FIXTURE_FILENAME))
      ).toBe(false);

      const goalDir = path.join(dataDir, "goals", goalId);
      const iterationDir = path.join(goalDir, "iterations", "1");
      const verificationLog = path.join(iterationDir, "verification.log");
      const runnerLog = path.join(iterationDir, "runner.log");
      expect(fs.existsSync(verificationLog)).toBe(true);
      expect(fs.readFileSync(verificationLog, "utf-8")).toContain(
        "[verify] running: false"
      );
      expect(fs.existsSync(runnerLog)).toBe(true);

      const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
      try {
        const jobRow = db
          .prepare(
            "SELECT state, type, iteration, error, result_path, error_path, worker_id FROM jobs WHERE id = ?"
          )
          .get(jobId) as {
          state: string;
          type: string;
          iteration: number;
          error: string | null;
          result_path: string | null;
          error_path: string | null;
          worker_id: string | null;
        };
        expect(jobRow).toMatchObject({
          state: "failed",
          type: "goal_iteration",
          iteration: 1,
          result_path: null,
          error_path: verificationLog,
          worker_id: "smoke-worker-fail"
        });
        expect(jobRow.error).toContain("verification_failed");

        const goalRow = db
          .prepare("SELECT state FROM goals WHERE id = ?")
          .get(goalId) as { state: string };
        expect(goalRow.state).toBe("failed");

        const eventTypes = (
          db
            .prepare(
              "SELECT type FROM events WHERE goal_id = ? ORDER BY id ASC"
            )
            .all(goalId) as Array<{ type: string }>
        ).map((row) => row.type);
        expect(eventTypes).toEqual([
          "job.enqueued",
          "job.claimed",
          "job.heartbeat",
          "iteration_started",
          "iteration_failed",
          "job.failed",
          "goal.reduced",
          "goal.failed"
        ]);

        const failedRow = db
          .prepare(
            "SELECT payload FROM events WHERE goal_id = ? AND type = 'job.failed'"
          )
          .get(goalId) as { payload: string };
        const failedPayload = JSON.parse(failedRow.payload) as Record<
          string,
          unknown
        >;
        expect(failedPayload).toMatchObject({
          iteration: 1,
          worker_id: "smoke-worker-fail",
          repo_root: repo
        });
        expect(failedPayload["error"]).toBe("verification_failed");
        const failedArtifacts = failedPayload["artifacts"] as Record<
          string,
          unknown
        >;
        expect(failedArtifacts).toMatchObject({
          iteration_dir: iterationDir,
          runner_log: runnerLog,
          verification_log: verificationLog
        });
      } finally {
        db.close();
      }

      // status --json surfaces error_path from the queued failed job.
      const status = runCliBinary([
        "status",
        goalId,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(status.code, `status stderr: ${status.stderr}`).toBe(0);
      const statusPayload = JSON.parse(status.stdout) as Record<string, unknown>;
      const latestJob = statusPayload["latestJob"] as Record<string, unknown>;
      expect(latestJob).toMatchObject({
        type: "goal_iteration",
        state: "failed",
        iteration: 1,
        resultPath: null,
        errorPath: verificationLog
      });
      expect(latestJob["error"]).toContain("verification_failed");

      // handoff --json + handoff.md surface error_path.
      const handoff = runCliBinary([
        "handoff",
        goalId,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(handoff.code, `handoff stderr: ${handoff.stderr}`).toBe(0);
      const handoffJson = path.join(goalDir, "handoff.json");
      const handoffMd = path.join(goalDir, "handoff.md");
      const writtenHandoffJson = JSON.parse(
        fs.readFileSync(handoffJson, "utf-8")
      ) as Record<string, unknown>;
      const handoffLatestJob = writtenHandoffJson["latest_job"] as Record<
        string,
        unknown
      >;
      expect(handoffLatestJob).toMatchObject({
        type: "goal_iteration",
        state: "failed",
        iteration: 1,
        result_path: null,
        error_path: verificationLog
      });
      const handoffMdContent = fs.readFileSync(handoffMd, "utf-8");
      expect(handoffMdContent).toContain("- Type: goal_iteration");
      expect(handoffMdContent).toContain("- State: failed");
      expect(handoffMdContent).toContain(`- Error path: ${verificationLog}`);
      expect(handoffMdContent).not.toContain("- Result path:");
    },
    90_000
  );

  it(
    "logs <goal-id> reads the queued iteration's runner.log and verification.log via the built CLI in both text and --json modes",
    () => {
      const repo = initDisposableRepo();
      const dataDir = makeTempDir("momentum-smoke-m2-logs-data-");
      const goalFile = path.join(dataDir, "goal.md");
      fs.writeFileSync(goalFile, SMOKE_GOAL_SPEC, "utf-8");

      const start = runCliBinary([
        "goal",
        "start",
        goalFile,
        "--repo",
        repo,
        "--data-dir",
        dataDir,
        "--runner",
        "fake",
        "--json"
      ]);
      expect(start.code, `goal start stderr: ${start.stderr}`).toBe(0);
      const startPayload = JSON.parse(start.stdout) as Record<string, unknown>;
      const goalId = startPayload["goalId"] as string;

      const worker = runCliBinary([
        "worker",
        "run",
        "--data-dir",
        dataDir,
        "--worker-id",
        "smoke-worker-logs",
        "--json"
      ]);
      expect(worker.code, `worker run stderr: ${worker.stderr}`).toBe(0);
      const workerPayload = JSON.parse(worker.stdout) as Record<string, unknown>;
      expect(workerPayload).toMatchObject({
        ok: true,
        code: "ran_job",
        outcome: "ran_job",
        goalId,
        jobState: "succeeded",
        iteration: 1
      });

      const goalDir = path.join(dataDir, "goals", goalId);
      const iterationDir = path.join(goalDir, "iterations", "1");
      const runnerLogPath = path.join(iterationDir, "runner.log");
      const verificationLogPath = path.join(iterationDir, "verification.log");

      const logsText = runCliBinary([
        "logs",
        goalId,
        "--data-dir",
        dataDir
      ]);
      expect(logsText.code, `logs stderr: ${logsText.stderr}`).toBe(0);
      expect(logsText.stderr).toBe("");
      expect(logsText.stdout).toContain(`Goal: ${goalId}`);
      expect(logsText.stdout).toContain("Iteration: 1");
      expect(logsText.stdout).toContain("Available iterations: 1");
      expect(logsText.stdout).toContain(`Iteration dir: ${iterationDir}`);
      expect(logsText.stdout).toContain(
        `## runner.log (${fs.statSync(runnerLogPath).size} bytes): ${runnerLogPath}`
      );
      expect(logsText.stdout).toContain(
        `## verification.log (${fs.statSync(verificationLogPath).size} bytes): ${verificationLogPath}`
      );
      expect(logsText.stdout).toContain("[verify]");

      const logsJson = runCliBinary([
        "logs",
        goalId,
        "--iteration",
        "1",
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(logsJson.code, `logs --json stderr: ${logsJson.stderr}`).toBe(0);
      expect(logsJson.stderr).toBe("");
      const logsPayload = JSON.parse(logsJson.stdout) as Record<string, unknown>;
      expect(logsPayload).toMatchObject({
        ok: true,
        command: "logs",
        goalId,
        iteration: 1,
        availableIterations: [1],
        dataDir,
        artifactDir: goalDir,
        iterationDir
      });
      const runnerLog = logsPayload["runnerLog"] as Record<string, unknown>;
      expect(runnerLog).toMatchObject({
        path: runnerLogPath,
        exists: true
      });
      expect(typeof runnerLog["bytes"]).toBe("number");
      expect(runnerLog["bytes"]).toBe(fs.statSync(runnerLogPath).size);
      expect(runnerLog["content"]).toBe(
        fs.readFileSync(runnerLogPath, "utf-8")
      );
      const verificationLog = logsPayload["verificationLog"] as Record<
        string,
        unknown
      >;
      expect(verificationLog).toMatchObject({
        path: verificationLogPath,
        exists: true
      });
      expect(verificationLog["bytes"]).toBe(
        fs.statSync(verificationLogPath).size
      );
      expect(verificationLog["content"]).toBe(
        fs.readFileSync(verificationLogPath, "utf-8")
      );
      expect(verificationLog["content"]).toContain("[verify]");

      const missing = runCliBinary([
        "logs",
        goalId,
        "--iteration",
        "99",
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(missing.code).toBe(1);
      expect(missing.stdout).toBe("");
      const missingPayload = JSON.parse(missing.stderr) as Record<string, unknown>;
      expect(missingPayload).toMatchObject({
        ok: false,
        command: "logs",
        code: "iteration_not_found",
        goalId
      });
      expect(typeof missingPayload["message"]).toBe("string");
      expect((missingPayload["message"] as string)).toContain(goalId);
    },
    90_000
  );
});

describe("Milestone 3 daemon drain end-to-end smoke (NGX-278)", () => {
  it(
    "drains a queued goal via daemon start --max-idle-cycles and surfaces the drained run through daemon status, status, logs, and handoff",
    () => {
      const repo = initDisposableRepo();
      const dataDir = makeTempDir("momentum-smoke-m3-drain-data-");
      const goalFile = path.join(dataDir, "goal.md");
      fs.writeFileSync(goalFile, SMOKE_GOAL_SPEC, "utf-8");

      const baseHead = runGit(repo, ["rev-parse", "HEAD"]).trim();

      // 1. Enqueue the first iteration via the queued default path.
      const enqueue = runCliBinary([
        "goal",
        "start",
        goalFile,
        "--repo",
        repo,
        "--data-dir",
        dataDir,
        "--runner",
        "fake",
        "--json"
      ]);
      expect(enqueue.code, `goal start stderr: ${enqueue.stderr}`).toBe(0);
      expect(enqueue.stderr).toBe("");
      const enqueuePayload = JSON.parse(enqueue.stdout) as Record<
        string,
        unknown
      >;
      const goalId = enqueuePayload["goalId"] as string;
      const jobId = enqueuePayload["jobId"] as string;
      expect(typeof goalId).toBe("string");
      expect(goalId.length).toBeGreaterThan(0);
      expect(typeof jobId).toBe("string");
      expect(enqueuePayload).toMatchObject({
        ok: true,
        mode: "queued",
        goalState: "queued",
        jobType: "goal_iteration",
        jobState: "pending"
      });

      // No worker has run yet: HEAD untouched, no fixture, no momentum branch.
      expect(runGit(repo, ["rev-parse", "HEAD"]).trim()).toBe(baseHead);
      expect(
        fs.existsSync(path.join(repo, FAKE_RUNNER_FIXTURE_FILENAME))
      ).toBe(false);

      // 2. Drain the queue end-to-end via the bounded managed daemon loop.
      // FAKE_RUNNER_GOAL_COMPLETE makes the single iteration mark goal_complete
      // so the reducer terminates the goal cleanly without queueing a follow-up.
      const drain = runCliBinary(
        [
          "daemon",
          "start",
          "--max-idle-cycles",
          "2",
          "--poll-interval-ms",
          "0",
          "--data-dir",
          dataDir,
          "--json"
        ],
        { env: { [FAKE_RUNNER_GOAL_COMPLETE_ENV]: "1" } }
      );
      expect(drain.code, `daemon start stderr: ${drain.stderr}`).toBe(0);
      expect(drain.stderr).toBe("");
      const drainPayload = JSON.parse(drain.stdout) as Record<string, unknown>;
      expect(drainPayload).toMatchObject({
        ok: true,
        workSucceeded: true,
        command: "daemon start",
        dataDir,
        state: "stopped"
      });
      const runId = drainPayload["runId"] as string;
      expect(typeof runId).toBe("string");
      expect(runId.length).toBeGreaterThan(0);

      const loop = drainPayload["loop"] as Record<string, unknown>;
      expect(loop).toMatchObject({
        exitReason: "max_idle_cycles",
        terminalState: "stopped",
        cancelOutcome: null,
        workSucceeded: true,
        jobsRun: 1,
        jobsFailed: 0
      });
      const startupRecovery = loop["startupRecovery"] as Record<
        string,
        unknown
      >;
      expect(startupRecovery).toMatchObject({
        recoveredRepoLockCount: 0,
        recoveredClaimedJobCount: 0,
        recoveredDaemonRunCount: 0
      });

      // Repo invariants after the drained run: main untouched, momentum branch
      // holds exactly one verified commit, worktree clean, fixture present.
      expect(runGit(repo, ["rev-parse", "main"]).trim()).toBe(baseHead);
      expect(runGit(repo, ["status", "--porcelain"]).trim()).toBe("");
      const branchListing = runGit(repo, ["branch", "--list", "momentum/*"])
        .split("\n")
        .map((entry) => entry.replace(/^[\s*]+/u, "").trim())
        .filter((entry) => entry.length > 0);
      expect(branchListing).toHaveLength(1);
      const branch = branchListing[0]!;
      const commitSha = runGit(repo, ["rev-parse", branch]).trim();
      expect(commitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(commitSha).not.toBe(baseHead);
      const parent = runGit(repo, ["rev-parse", `${branch}^`]).trim();
      expect(parent).toBe(baseHead);
      const commitCount = Number(
        runGit(repo, ["rev-list", "--count", `${baseHead}..${branch}`]).trim()
      );
      expect(commitCount).toBe(1);
      expect(
        fs.existsSync(path.join(repo, FAKE_RUNNER_FIXTURE_FILENAME))
      ).toBe(true);

      // Queue / job / event / goal invariants written by the drained worker.
      const goalDir = path.join(dataDir, "goals", goalId);
      const iterationDir = path.join(goalDir, "iterations", "1");
      const verificationLog = path.join(iterationDir, "verification.log");
      const runnerLog = path.join(iterationDir, "runner.log");
      const resultJson = path.join(iterationDir, "result.json");
      const promptMd = path.join(iterationDir, "prompt.md");
      for (const p of [verificationLog, runnerLog, resultJson, promptMd]) {
        expect(fs.existsSync(p), `missing artifact: ${p}`).toBe(true);
      }

      const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
      try {
        const goalRow = db
          .prepare("SELECT state FROM goals WHERE id = ?")
          .get(goalId) as { state: string };
        expect(goalRow.state).toBe("completed");

        const jobRow = db
          .prepare(
            "SELECT state, type, iteration, error, result_path, error_path FROM jobs WHERE id = ?"
          )
          .get(jobId) as {
          state: string;
          type: string;
          iteration: number;
          error: string | null;
          result_path: string | null;
          error_path: string | null;
        };
        expect(jobRow).toMatchObject({
          state: "succeeded",
          type: "goal_iteration",
          iteration: 1,
          error: null,
          result_path: resultJson,
          error_path: null
        });

        const eventTypes = (
          db
            .prepare(
              "SELECT type FROM events WHERE goal_id = ? ORDER BY id ASC"
            )
            .all(goalId) as Array<{ type: string }>
        ).map((row) => row.type);
        expect(eventTypes).toEqual([
          "job.enqueued",
          "job.claimed",
          "job.heartbeat",
          "iteration_started",
          "iteration_completed",
          "job.succeeded",
          "goal.reduced",
          "goal.completed"
        ]);

        // The drained run is the only daemon record and is in `stopped` state.
        const daemonRows = db
          .prepare(
            "SELECT id, state, finished_at FROM daemon_runs ORDER BY started_at ASC"
          )
          .all() as Array<{
          id: string;
          state: string;
          finished_at: number | null;
        }>;
        expect(daemonRows).toHaveLength(1);
        expect(daemonRows[0]).toMatchObject({
          id: runId,
          state: "stopped"
        });
        expect(daemonRows[0]!.finished_at).not.toBeNull();
      } finally {
        db.close();
      }

      // 3. daemon status surfaces the drained terminal record without re-running anything.
      const daemonStatus = runCliBinary([
        "daemon",
        "status",
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(
        daemonStatus.code,
        `daemon status stderr: ${daemonStatus.stderr}`
      ).toBe(0);
      const daemonStatusPayload = JSON.parse(daemonStatus.stdout) as Record<
        string,
        unknown
      >;
      expect(daemonStatusPayload).toMatchObject({
        ok: true,
        command: "daemon status",
        dataDir,
        hasRun: true
      });
      const daemonRun = daemonStatusPayload["daemonRun"] as Record<
        string,
        unknown
      >;
      expect(daemonRun).toMatchObject({
        runId,
        state: "stopped",
        isActive: false,
        isTerminal: true
      });
      expect(daemonStatusPayload["staleRuns"]).toEqual([]);
      expect(daemonStatusPayload["staleRepoLocks"]).toEqual([]);
      expect(daemonStatusPayload["staleClaimedJobs"]).toEqual([]);
      expect(daemonStatusPayload["goalsNeedingRecovery"]).toEqual([]);

      // 4. status surfaces the drained goal and the daemon summary.
      const status = runCliBinary([
        "status",
        goalId,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(status.code, `status stderr: ${status.stderr}`).toBe(0);
      const statusPayload = JSON.parse(status.stdout) as Record<string, unknown>;
      expect(statusPayload).toMatchObject({
        ok: true,
        command: "status",
        goalId,
        state: "completed",
        repo,
        runner: "fake"
      });
      const statusLatestJob = statusPayload["latestJob"] as Record<
        string,
        unknown
      >;
      expect(statusLatestJob).toMatchObject({
        type: "goal_iteration",
        state: "succeeded",
        iteration: 1,
        resultPath: resultJson,
        errorPath: null
      });
      const statusIter = statusPayload["iteration"] as Record<string, unknown>;
      expect(statusIter["commitSha"]).toBe(commitSha);
      const statusDaemon = statusPayload["daemon"] as Record<string, unknown>;
      expect(statusDaemon).toMatchObject({
        runId,
        state: "stopped",
        isActive: false,
        isTerminal: true,
        stopRequest: null,
        stopNowRequest: null,
        cancelOutcome: null
      });

      // 5. logs reads the drained iteration's runner.log and verification.log
      // straight off disk (no live worker state).
      const logs = runCliBinary([
        "logs",
        goalId,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(logs.code, `logs stderr: ${logs.stderr}`).toBe(0);
      const logsPayload = JSON.parse(logs.stdout) as Record<string, unknown>;
      expect(logsPayload).toMatchObject({
        ok: true,
        command: "logs",
        goalId,
        iteration: 1,
        availableIterations: [1],
        dataDir,
        artifactDir: goalDir,
        iterationDir
      });
      const logsRunner = logsPayload["runnerLog"] as Record<string, unknown>;
      expect(logsRunner).toMatchObject({
        path: runnerLog,
        exists: true
      });
      const logsVerification = logsPayload["verificationLog"] as Record<
        string,
        unknown
      >;
      expect(logsVerification).toMatchObject({
        path: verificationLog,
        exists: true
      });
      expect(logsVerification["content"]).toContain("[verify]");

      // 6. handoff renders both artifacts; the json artifact carries the daemon block.
      const handoff = runCliBinary([
        "handoff",
        goalId,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(handoff.code, `handoff stderr: ${handoff.stderr}`).toBe(0);
      const handoffPayload = JSON.parse(handoff.stdout) as Record<
        string,
        unknown
      >;
      expect(handoffPayload).toMatchObject({
        ok: true,
        command: "handoff",
        goalId,
        state: "completed"
      });
      const handoffJsonPath = path.join(goalDir, "handoff.json");
      const handoffMdPath = path.join(goalDir, "handoff.md");
      const writtenHandoffJson = JSON.parse(
        fs.readFileSync(handoffJsonPath, "utf-8")
      ) as Record<string, unknown>;
      const handoffDaemon = writtenHandoffJson["daemon"] as Record<
        string,
        unknown
      >;
      expect(handoffDaemon).toMatchObject({
        run_id: runId,
        state: "stopped",
        is_active: false,
        is_terminal: true,
        stop_request: null,
        stop_now_request: null,
        cancel_outcome: null
      });
      const handoffMdContent = fs.readFileSync(handoffMdPath, "utf-8");
      expect(handoffMdContent).toContain("# Momentum handoff: Smoke Goal");
      expect(handoffMdContent).toContain("- State: completed");
      expect(handoffMdContent).toContain("## Daemon");
      expect(handoffMdContent).toContain(`- Run ID: ${runId}`);
      expect(handoffMdContent).toContain("- State: stopped (terminal)");
    },
    120_000
  );

  it(
    "daemon stop records a graceful stop request that surfaces through daemon status, status, and handoff",
    async () => {
      const repo = initDisposableRepo();
      const dataDir = makeTempDir("momentum-smoke-m3-graceful-stop-data-");
      const goalFile = path.join(dataDir, "goal.md");
      fs.writeFileSync(goalFile, SMOKE_GOAL_SPEC, "utf-8");

      // 1. Enqueue the goal so status / handoff have a goal to surface alongside
      // the daemon stop request.
      const enqueue = runCliBinary([
        "goal",
        "start",
        goalFile,
        "--repo",
        repo,
        "--data-dir",
        dataDir,
        "--runner",
        "fake",
        "--json"
      ]);
      expect(enqueue.code, `goal start stderr: ${enqueue.stderr}`).toBe(0);
      expect(enqueue.stderr).toBe("");
      const enqueuePayload = JSON.parse(enqueue.stdout) as Record<
        string,
        unknown
      >;
      const goalId = enqueuePayload["goalId"] as string;
      expect(typeof goalId).toBe("string");
      expect(goalId.length).toBeGreaterThan(0);

      // 2. Seed an active daemon run directly so we can exercise the operator
      // surface for graceful stop without juggling background processes. This
      // mirrors the in-process seeding pattern used by cli.test.ts daemon-stop
      // visibility tests, while keeping the operator-facing assertions on the
      // built CLI binary.
      const { openDb } = await import("../src/db.js");
      const { startDaemonRun } = await import("../src/daemon-runs.js");
      const seededDb = openDb(dataDir);
      let runId: string;
      try {
        ({ runId } = startDaemonRun(seededDb, {
          pid: 31_415,
          host: "smoke-graceful-stop",
          now: Date.now()
        }));
      } finally {
        seededDb.close();
      }

      // 3. `daemon stop --reason ...` records the stop_requested transition.
      const stopResult = runCliBinary([
        "daemon",
        "stop",
        "--reason",
        "smoke-graceful-stop",
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(
        stopResult.code,
        `daemon stop stderr: ${stopResult.stderr}`
      ).toBe(0);
      expect(stopResult.stderr).toBe("");
      const stopPayload = JSON.parse(stopResult.stdout) as Record<
        string,
        unknown
      >;
      expect(stopPayload).toMatchObject({
        ok: true,
        command: "daemon stop",
        dataDir,
        runId,
        previousState: "running",
        state: "stop_requested",
        stopReason: "smoke-graceful-stop",
        alreadyStopRequested: false,
        immediate: false
      });
      const stopRequestedAt = stopPayload["stopRequestedAt"] as number;
      expect(typeof stopRequestedAt).toBe("number");

      // 4. A repeat `daemon stop` is idempotent: the previous state stays
      // stop_requested and the original timestamp is preserved (COALESCE in
      // the daemon-runs primitive). The reason is intentionally kept identical
      // so this assertion isolates idempotency from the reason-refresh path
      // already covered by cli.test.ts.
      const repeatStop = runCliBinary([
        "daemon",
        "stop",
        "--reason",
        "smoke-graceful-stop",
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(
        repeatStop.code,
        `repeat daemon stop stderr: ${repeatStop.stderr}`
      ).toBe(0);
      const repeatPayload = JSON.parse(repeatStop.stdout) as Record<
        string,
        unknown
      >;
      expect(repeatPayload).toMatchObject({
        ok: true,
        command: "daemon stop",
        runId,
        previousState: "stop_requested",
        state: "stop_requested",
        alreadyStopRequested: true,
        immediate: false
      });
      expect(repeatPayload["stopRequestedAt"]).toBe(stopRequestedAt);

      // 5. daemon status surfaces the stop request without finalising the run.
      const daemonStatus = runCliBinary([
        "daemon",
        "status",
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(
        daemonStatus.code,
        `daemon status stderr: ${daemonStatus.stderr}`
      ).toBe(0);
      const daemonStatusPayload = JSON.parse(
        daemonStatus.stdout
      ) as Record<string, unknown>;
      expect(daemonStatusPayload).toMatchObject({
        ok: true,
        command: "daemon status",
        dataDir,
        hasRun: true
      });
      const daemonRun = daemonStatusPayload["daemonRun"] as Record<
        string,
        unknown
      >;
      expect(daemonRun).toMatchObject({
        runId,
        state: "stop_requested",
        isActive: true,
        isTerminal: false
      });
      expect(daemonRun["stopRequest"]).toEqual({
        requestedAt: stopRequestedAt,
        reason: "smoke-graceful-stop"
      });
      expect(daemonRun["stopNowRequest"]).toBeNull();
      expect(daemonRun["cancelOutcome"]).toBeNull();

      // The DB row stays in stop_requested with the seeded heartbeat untouched
      // by the stop request (the run has not finalized).
      const inspectionDb = new DatabaseSync(
        path.join(dataDir, "momentum.db")
      );
      try {
        const row = inspectionDb
          .prepare(
            "SELECT state, stop_requested_at, stop_now_requested_at, finished_at, cancel_outcome FROM daemon_runs WHERE id = ?"
          )
          .get(runId) as {
          state: string;
          stop_requested_at: number | null;
          stop_now_requested_at: number | null;
          finished_at: number | null;
          cancel_outcome: string | null;
        };
        expect(row).toMatchObject({
          state: "stop_requested",
          stop_requested_at: stopRequestedAt,
          stop_now_requested_at: null,
          finished_at: null,
          cancel_outcome: null
        });
      } finally {
        inspectionDb.close();
      }

      // 6. status --json surfaces the stop_requested daemon block alongside the
      // queued goal (whose state is unchanged because no worker has run).
      const statusJson = runCliBinary([
        "status",
        goalId,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(statusJson.code, `status stderr: ${statusJson.stderr}`).toBe(0);
      const statusPayload = JSON.parse(statusJson.stdout) as Record<
        string,
        unknown
      >;
      expect(statusPayload).toMatchObject({
        ok: true,
        command: "status",
        goalId,
        state: "queued"
      });
      const statusDaemon = statusPayload["daemon"] as Record<string, unknown>;
      expect(statusDaemon).toMatchObject({
        runId,
        state: "stop_requested",
        isActive: true,
        isTerminal: false,
        stopNowRequest: null,
        cancelOutcome: null
      });
      expect(statusDaemon["stopRequest"]).toEqual({
        requestedAt: stopRequestedAt,
        reason: "smoke-graceful-stop"
      });

      // status text mirrors the daemon block in human-readable form.
      const statusText = runCliBinary([
        "status",
        goalId,
        "--data-dir",
        dataDir
      ]);
      expect(
        statusText.code,
        `status text stderr: ${statusText.stderr}`
      ).toBe(0);
      expect(statusText.stdout).toContain(
        `Daemon: stop_requested (active) [${runId}]`
      );
      expect(statusText.stdout).toContain(
        `Daemon stop requested: ${stopRequestedAt} (smoke-graceful-stop)`
      );

      // 7. handoff persists the stop request in both the CLI payload and on disk.
      const handoff = runCliBinary([
        "handoff",
        goalId,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(handoff.code, `handoff stderr: ${handoff.stderr}`).toBe(0);
      const handoffPayload = JSON.parse(handoff.stdout) as Record<
        string,
        unknown
      >;
      const handoffDaemon = handoffPayload["daemon"] as Record<string, unknown>;
      expect(handoffDaemon).toMatchObject({
        runId,
        state: "stop_requested",
        isActive: true,
        isTerminal: false
      });
      expect(handoffDaemon["stopRequest"]).toEqual({
        requestedAt: stopRequestedAt,
        reason: "smoke-graceful-stop"
      });

      const goalDir = path.join(dataDir, "goals", goalId);
      const handoffJsonPath = path.join(goalDir, "handoff.json");
      const writtenHandoff = JSON.parse(
        fs.readFileSync(handoffJsonPath, "utf-8")
      ) as Record<string, unknown>;
      const writtenDaemon = writtenHandoff["daemon"] as Record<string, unknown>;
      expect(writtenDaemon).toMatchObject({
        run_id: runId,
        state: "stop_requested",
        is_active: true,
        is_terminal: false,
        stop_now_request: null,
        cancel_outcome: null
      });
      expect(writtenDaemon["stop_request"]).toEqual({
        requested_at: stopRequestedAt,
        reason: "smoke-graceful-stop"
      });

      const handoffMdPath = path.join(goalDir, "handoff.md");
      const handoffMdContent = fs.readFileSync(handoffMdPath, "utf-8");
      expect(handoffMdContent).toContain("## Daemon");
      expect(handoffMdContent).toContain(`- Run ID: ${runId}`);
      expect(handoffMdContent).toContain("- State: stop_requested (active)");
      expect(handoffMdContent).toContain(
        `- Stop requested at: ${stopRequestedAt} (reason: smoke-graceful-stop)`
      );
    },
    60_000
  );

  it(
    "daemon stop --now records an immediate stop request and the canceled run surfaces through daemon status, status, and handoff",
    async () => {
      const repo = initDisposableRepo();
      const dataDir = makeTempDir("momentum-smoke-m3-stop-now-data-");
      const goalFile = path.join(dataDir, "goal.md");
      fs.writeFileSync(goalFile, SMOKE_GOAL_SPEC, "utf-8");

      // 1. Enqueue a goal so status / handoff have a goal to render alongside
      // the daemon block.
      const enqueue = runCliBinary([
        "goal",
        "start",
        goalFile,
        "--repo",
        repo,
        "--data-dir",
        dataDir,
        "--runner",
        "fake",
        "--json"
      ]);
      expect(enqueue.code, `goal start stderr: ${enqueue.stderr}`).toBe(0);
      expect(enqueue.stderr).toBe("");
      const enqueuePayload = JSON.parse(enqueue.stdout) as Record<
        string,
        unknown
      >;
      const goalId = enqueuePayload["goalId"] as string;
      expect(typeof goalId).toBe("string");
      expect(goalId.length).toBeGreaterThan(0);

      // 2. Seed an active daemon run directly so `daemon stop --now` has an
      // active record to upgrade. Driving the cancellation through the daemon
      // loop binary would require background-process timing; the loop primitive
      // is unit-tested in daemon-loop.test.ts, so here we pin the operator
      // surfaces while keeping the assertions deterministic.
      const { openDb } = await import("../src/db.js");
      const { startDaemonRun, finishDaemonRun } = await import(
        "../src/daemon-runs.js"
      );
      const seededDb = openDb(dataDir);
      let runId: string;
      try {
        ({ runId } = startDaemonRun(seededDb, {
          pid: 27_182,
          host: "smoke-stop-now",
          now: Date.now()
        }));
      } finally {
        seededDb.close();
      }

      // 3. `daemon stop --now` records an immediate stop request. The shared
      // stop_requested_at marker is stamped alongside stop_now_requested_at so
      // both timestamps come back from a single call.
      const stopNow = runCliBinary([
        "daemon",
        "stop",
        "--now",
        "--reason",
        "smoke-stop-now",
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(stopNow.code, `daemon stop --now stderr: ${stopNow.stderr}`).toBe(
        0
      );
      expect(stopNow.stderr).toBe("");
      const stopNowPayload = JSON.parse(stopNow.stdout) as Record<
        string,
        unknown
      >;
      expect(stopNowPayload).toMatchObject({
        ok: true,
        command: "daemon stop",
        dataDir,
        runId,
        previousState: "running",
        state: "stop_requested",
        stopReason: "smoke-stop-now",
        immediate: true,
        alreadyStopNow: false,
        alreadyStopRequested: false
      });
      const stopNowAt = stopNowPayload["stopNowRequestedAt"] as number;
      expect(typeof stopNowAt).toBe("number");
      expect(stopNowPayload["stopRequestedAt"]).toBe(stopNowAt);

      // 4. Repeat `daemon stop --now` is idempotent: the original timestamp and
      // reason are preserved even when a different `--reason` is supplied,
      // because requestDaemonRunImmediateStop guards stop_reason behind a
      // `stop_now_requested_at IS NULL` check.
      const repeatNow = runCliBinary([
        "daemon",
        "stop",
        "--now",
        "--reason",
        "smoke-stop-now-second",
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(
        repeatNow.code,
        `repeat daemon stop --now stderr: ${repeatNow.stderr}`
      ).toBe(0);
      const repeatPayload = JSON.parse(repeatNow.stdout) as Record<
        string,
        unknown
      >;
      expect(repeatPayload).toMatchObject({
        ok: true,
        runId,
        previousState: "stop_requested",
        state: "stop_requested",
        immediate: true,
        alreadyStopNow: true,
        alreadyStopRequested: true,
        stopReason: "smoke-stop-now"
      });
      expect(repeatPayload["stopNowRequestedAt"]).toBe(stopNowAt);
      expect(repeatPayload["stopRequestedAt"]).toBe(stopNowAt);

      // 5. Finalize the run as canceled the same way the daemon loop would
      // when observing stop_now_requested_at before any work has run, so the
      // operator-facing surfaces below mirror the loop's `idle` cancel path.
      const finishAt = stopNowAt + 1_000;
      const finishDb = openDb(dataDir);
      try {
        finishDaemonRun(finishDb, {
          runId,
          terminalState: "canceled",
          cancelOutcome: "idle",
          now: finishAt
        });
      } finally {
        finishDb.close();
      }

      // 6. daemon status --json surfaces the canceled run with the stop-now /
      // shared-stop / cancel-outcome blocks all populated.
      const daemonStatus = runCliBinary([
        "daemon",
        "status",
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(
        daemonStatus.code,
        `daemon status stderr: ${daemonStatus.stderr}`
      ).toBe(0);
      const daemonStatusPayload = JSON.parse(
        daemonStatus.stdout
      ) as Record<string, unknown>;
      expect(daemonStatusPayload).toMatchObject({
        ok: true,
        command: "daemon status",
        dataDir,
        hasRun: true
      });
      const daemonRun = daemonStatusPayload["daemonRun"] as Record<
        string,
        unknown
      >;
      expect(daemonRun).toMatchObject({
        runId,
        state: "canceled",
        isActive: false,
        isTerminal: true
      });
      expect(daemonRun["stopRequest"]).toEqual({
        requestedAt: stopNowAt,
        reason: "smoke-stop-now"
      });
      expect(daemonRun["stopNowRequest"]).toEqual({
        requestedAt: stopNowAt,
        reason: "smoke-stop-now"
      });
      expect(daemonRun["cancelOutcome"]).toEqual({ outcome: "idle" });
      expect(daemonStatusPayload["staleRuns"]).toEqual([]);
      expect(daemonStatusPayload["staleRepoLocks"]).toEqual([]);
      expect(daemonStatusPayload["staleClaimedJobs"]).toEqual([]);
      expect(daemonStatusPayload["goalsNeedingRecovery"]).toEqual([]);

      // Repo-level DB invariants: state canceled, cancel_outcome idle, and the
      // shared/immediate stop timestamps survive finalization unchanged.
      const inspectionDb = new DatabaseSync(path.join(dataDir, "momentum.db"));
      try {
        const row = inspectionDb
          .prepare(
            "SELECT state, stop_requested_at, stop_now_requested_at, finished_at, cancel_outcome FROM daemon_runs WHERE id = ?"
          )
          .get(runId) as {
          state: string;
          stop_requested_at: number | null;
          stop_now_requested_at: number | null;
          finished_at: number | null;
          cancel_outcome: string | null;
        };
        expect(row).toEqual({
          state: "canceled",
          stop_requested_at: stopNowAt,
          stop_now_requested_at: stopNowAt,
          finished_at: finishAt,
          cancel_outcome: "idle"
        });
      } finally {
        inspectionDb.close();
      }

      // 7. status --json surfaces the canceled daemon block on the queued goal
      // (the goal stays queued since no worker ran before cancellation).
      const statusJson = runCliBinary([
        "status",
        goalId,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(statusJson.code, `status stderr: ${statusJson.stderr}`).toBe(0);
      const statusPayload = JSON.parse(statusJson.stdout) as Record<
        string,
        unknown
      >;
      expect(statusPayload).toMatchObject({
        ok: true,
        command: "status",
        goalId,
        state: "queued"
      });
      const statusDaemon = statusPayload["daemon"] as Record<string, unknown>;
      expect(statusDaemon).toMatchObject({
        runId,
        state: "canceled",
        isActive: false,
        isTerminal: true
      });
      expect(statusDaemon["stopRequest"]).toEqual({
        requestedAt: stopNowAt,
        reason: "smoke-stop-now"
      });
      expect(statusDaemon["stopNowRequest"]).toEqual({
        requestedAt: stopNowAt,
        reason: "smoke-stop-now"
      });
      expect(statusDaemon["cancelOutcome"]).toEqual({ outcome: "idle" });

      // status text mirrors the canceled daemon block in human-readable form,
      // including the stop-now timestamp/reason and cancel outcome lines.
      const statusText = runCliBinary([
        "status",
        goalId,
        "--data-dir",
        dataDir
      ]);
      expect(
        statusText.code,
        `status text stderr: ${statusText.stderr}`
      ).toBe(0);
      expect(statusText.stdout).toContain(
        `Daemon: canceled (terminal) [${runId}]`
      );
      expect(statusText.stdout).toContain(
        `Daemon stop requested: ${stopNowAt} (smoke-stop-now)`
      );
      expect(statusText.stdout).toContain(
        `Daemon stop-now requested: ${stopNowAt} (smoke-stop-now)`
      );
      expect(statusText.stdout).toContain("Daemon cancel outcome: idle");

      // 8. handoff renders both artifacts; the JSON payload, on-disk
      // handoff.json (snake_case), and handoff.md all carry the canceled
      // daemon block with stop-now and cancel-outcome details.
      const handoff = runCliBinary([
        "handoff",
        goalId,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(handoff.code, `handoff stderr: ${handoff.stderr}`).toBe(0);
      const handoffPayload = JSON.parse(handoff.stdout) as Record<
        string,
        unknown
      >;
      const handoffDaemon = handoffPayload["daemon"] as Record<string, unknown>;
      expect(handoffDaemon).toMatchObject({
        runId,
        state: "canceled",
        isActive: false,
        isTerminal: true
      });
      expect(handoffDaemon["stopRequest"]).toEqual({
        requestedAt: stopNowAt,
        reason: "smoke-stop-now"
      });
      expect(handoffDaemon["stopNowRequest"]).toEqual({
        requestedAt: stopNowAt,
        reason: "smoke-stop-now"
      });
      expect(handoffDaemon["cancelOutcome"]).toEqual({ outcome: "idle" });

      const goalDir = path.join(dataDir, "goals", goalId);
      const handoffJsonPath = path.join(goalDir, "handoff.json");
      const writtenHandoff = JSON.parse(
        fs.readFileSync(handoffJsonPath, "utf-8")
      ) as Record<string, unknown>;
      const writtenDaemon = writtenHandoff["daemon"] as Record<string, unknown>;
      expect(writtenDaemon).toMatchObject({
        run_id: runId,
        state: "canceled",
        is_active: false,
        is_terminal: true
      });
      expect(writtenDaemon["stop_request"]).toEqual({
        requested_at: stopNowAt,
        reason: "smoke-stop-now"
      });
      expect(writtenDaemon["stop_now_request"]).toEqual({
        requested_at: stopNowAt,
        reason: "smoke-stop-now"
      });
      expect(writtenDaemon["cancel_outcome"]).toEqual({ outcome: "idle" });

      const handoffMdPath = path.join(goalDir, "handoff.md");
      const handoffMdContent = fs.readFileSync(handoffMdPath, "utf-8");
      expect(handoffMdContent).toContain("## Daemon");
      expect(handoffMdContent).toContain(`- Run ID: ${runId}`);
      expect(handoffMdContent).toContain("- State: canceled (terminal)");
      expect(handoffMdContent).toContain(
        `- Stop requested at: ${stopNowAt} (reason: smoke-stop-now)`
      );
      expect(handoffMdContent).toContain(
        `- Stop-now requested at: ${stopNowAt} (reason: smoke-stop-now)`
      );
      expect(handoffMdContent).toContain("- Cancel outcome: idle");
    },
    60_000
  );

  it(
    "daemon start runs safe stale recovery before the loop and auto-recovers an orphan lock and a stale claim",
    async () => {
      const dataDir = makeTempDir("momentum-smoke-m3-recovery-data-");

      const { openDb } = await import("../src/db.js");
      const { acquireRepoLock } = await import("../src/repo-locks.js");
      const { enqueueGoalIterationJob, claimPendingGoalIterationJob } =
        await import("../src/queue-jobs.js");

      // Seed a goal with NO repo column so the stale-claim auto-recovery's
      // repo inspector skips the dirty/unknown-commit/unavailable guard and
      // the recovery decision is deterministic without a real git repo on
      // disk — matches the pattern in daemon-loop.test.ts.
      const goalId = "smoke-recovery-goal";
      const goalArtifactDir = path.join(dataDir, "goals", goalId);
      let lockId: string;
      let succeededJobId: string;
      let claimedJobId: string;

      const seedDb = openDb(dataDir);
      try {
        seedDb
          .prepare(
            `INSERT INTO goals
               (id, title, branch, artifact_dir, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(
            goalId,
            "Smoke Recovery Goal",
            "momentum/smoke-recovery",
            goalArtifactDir,
            1,
            1
          );

        // 1. Stale repo lock whose owning job is in `succeeded` terminal state.
        // The startup recovery pass should auto-release this with status
        // `auto_released_job_terminal` and emit `repo_lock.recovered`.
        const enqueued1 = enqueueGoalIterationJob(seedDb, {
          goalId,
          iteration: 1,
          idempotencyKey: `${goalId}:1`,
          artifactPath: path.join(goalArtifactDir, "iterations", "1"),
          now: 100
        });
        succeededJobId = enqueued1.jobId;
        const acquired = acquireRepoLock(seedDb, {
          repoRoot: "/tmp/smoke-recovery-repo",
          holder: "previous-worker",
          goalId,
          iteration: 1,
          jobId: succeededJobId,
          leaseExpiresAt: 1_000,
          now: 100
        });
        if (!acquired.ok) {
          throw new Error("seed lock acquire failed");
        }
        lockId = acquired.lockId;
        seedDb
          .prepare(
            "UPDATE jobs SET state = 'succeeded', updated_at = updated_at WHERE id = ?"
          )
          .run(succeededJobId);

        // 2. Stale claimed goal_iteration job with no live owner. The startup
        // recovery pass should re-pend it with status `auto_repended_stale_claim`
        // and emit `job.recovered`. The goal has no `repo` column, so the
        // repo-state inspector returns null and the claim is auto-recovered.
        enqueueGoalIterationJob(seedDb, {
          goalId,
          iteration: 2,
          idempotencyKey: `${goalId}:2`,
          artifactPath: path.join(goalArtifactDir, "iterations", "2"),
          now: 200
        });
        const claimed = claimPendingGoalIterationJob(seedDb, {
          workerId: "previous-worker",
          leaseDurationMs: 900,
          now: 200
        });
        if (!claimed.ok) {
          throw new Error("seed claim failed");
        }
        claimedJobId = claimed.job.id;
      } finally {
        seedDb.close();
      }

      // 3. Drive `daemon start --max-idle-cycles 0` through the built CLI. The
      // bounded loop registers a fresh daemon run, runs `runStartupRecovery`
      // before the first cycle, and exits immediately at the idle-cycles
      // bound without claiming any work — deterministic, no subprocess timing.
      const result = runCliBinary([
        "daemon",
        "start",
        "--max-idle-cycles",
        "0",
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(result.code, `daemon start stderr: ${result.stderr}`).toBe(0);
      expect(result.stderr).toBe("");
      const payload = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: true,
        workSucceeded: true,
        command: "daemon start",
        dataDir,
        state: "stopped"
      });

      const loop = payload["loop"] as Record<string, unknown>;
      expect(loop).toMatchObject({
        exitReason: "max_idle_cycles",
        terminalState: "stopped",
        jobsRun: 0,
        jobsFailed: 0
      });
      const startupRecovery = loop["startupRecovery"] as Record<string, unknown>;
      expect(startupRecovery).toMatchObject({
        recoveredRepoLockCount: 1,
        recoveredClaimedJobCount: 1,
        recoveredDaemonRunCount: 0,
        skippedRepoLocks: [],
        skippedClaimedJobs: [],
        skippedDaemonRuns: []
      });
      expect(typeof startupRecovery["observedAt"]).toBe("number");
      expect(typeof startupRecovery["graceMs"]).toBe("number");

      // 4. DB invariants land: lock released with the auto-recovery status,
      // claimed job re-pended with cleared lease, and one recovery event of
      // each type appended to the events log.
      const inspectionDb = new DatabaseSync(path.join(dataDir, "momentum.db"));
      try {
        const lockRow = inspectionDb
          .prepare(
            "SELECT state, recovery_status FROM repo_locks WHERE id = ?"
          )
          .get(lockId) as { state: string; recovery_status: string | null };
        expect(lockRow).toEqual({
          state: "released",
          recovery_status: "auto_released_job_terminal"
        });

        const jobRow = inspectionDb
          .prepare(
            "SELECT state, worker_id, lease_acquired_at, lease_expires_at FROM jobs WHERE id = ?"
          )
          .get(claimedJobId) as {
          state: string;
          worker_id: string | null;
          lease_acquired_at: number | null;
          lease_expires_at: number | null;
        };
        expect(jobRow).toEqual({
          state: "pending",
          worker_id: null,
          lease_acquired_at: null,
          lease_expires_at: null
        });

        const recoveryEvents = inspectionDb
          .prepare(
            "SELECT type, goal_id, job_id FROM events WHERE type IN ('repo_lock.recovered', 'job.recovered') ORDER BY id"
          )
          .all() as Array<{
          type: string;
          goal_id: string;
          job_id: string;
        }>;
        expect(recoveryEvents).toEqual([
          {
            type: "repo_lock.recovered",
            goal_id: goalId,
            job_id: succeededJobId
          },
          {
            type: "job.recovered",
            goal_id: goalId,
            job_id: claimedJobId
          }
        ]);
      } finally {
        inspectionDb.close();
      }

      // 5. daemon status --json reflects the post-recovery world: no stale
      // repo locks, no stale claimed jobs, no goals flagged for manual
      // recovery (the recovered paths are the safe / non-manual taxonomy).
      const daemonStatus = runCliBinary([
        "daemon",
        "status",
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(
        daemonStatus.code,
        `daemon status stderr: ${daemonStatus.stderr}`
      ).toBe(0);
      const daemonStatusPayload = JSON.parse(daemonStatus.stdout) as Record<
        string,
        unknown
      >;
      expect(daemonStatusPayload["staleRepoLocks"]).toEqual([]);
      expect(daemonStatusPayload["staleClaimedJobs"]).toEqual([]);
      expect(daemonStatusPayload["goalsNeedingRecovery"]).toEqual([]);

      // 6. Text mode of `daemon start --max-idle-cycles 0` surfaces the
      // recovery summary line so operators see what was recovered without
      // reading the JSON payload.
      const textResult = runCliBinary([
        "daemon",
        "start",
        "--max-idle-cycles",
        "0",
        "--data-dir",
        dataDir
      ]);
      expect(textResult.code, `daemon start text stderr: ${textResult.stderr}`).toBe(
        0
      );
      // The second daemon start observes a clean post-recovery world so the
      // summary line is omitted (formatStartupRecoveryLines returns [] when
      // every count is zero). Assert the no-op shape rather than the recovery
      // line, which already landed on the first invocation above.
      expect(textResult.stdout).not.toContain("Startup recovery:");
    },
    60_000
  );

  it(
    "surfaces a manual-recovery-flagged goal through daemon status, status, and handoff, and recovery clear lifts the flag while preserving recovery.md",
    async () => {
      const dataDir = makeTempDir(
        "momentum-smoke-m3-manual-recovery-data-"
      );
      const goalId = "smoke-manual-recovery-goal";
      const classifiedAt = 1_700_000_000_000;

      const { openDb } = await import("../src/db.js");
      const { markGoalNeedsManualRecovery } = await import(
        "../src/goal-recovery.js"
      );
      const { writeRecoveryArtifact } = await import(
        "../src/recovery-artifact.js"
      );

      const goalArtifactDir = path.join(dataDir, "goals", goalId);
      const iterationDir = path.join(goalArtifactDir, "iterations", "1");
      const expectedRecoveryPath = path.join(goalArtifactDir, "recovery.md");

      // 1. Seed a goal with the durable manual-recovery flag set and a
      // hand-rendered recovery.md so the blocked-claim guard, daemon status,
      // status, and handoff surfaces are exercised through the built CLI
      // without depending on a real failing iteration. The flag is the single
      // source of truth for claim eligibility, so this isolates the operator
      // surface contract from the upstream classification path that already
      // has focused unit tests.
      const seedDb = openDb(dataDir);
      try {
        seedDb
          .prepare(
            `INSERT INTO goals
               (id, title, repo, branch, artifact_dir, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            goalId,
            "Smoke Manual Recovery Goal",
            "/tmp/smoke-manual-recovery-repo",
            "momentum/smoke-manual-recovery",
            goalArtifactDir,
            1,
            1
          );
        const mark = markGoalNeedsManualRecovery(seedDb, {
          goalId,
          reason: "repo_dirty",
          now: classifiedAt
        });
        if (!mark.ok) {
          throw new Error("seed: failed to mark goal for manual recovery");
        }
      } finally {
        seedDb.close();
      }

      fs.mkdirSync(iterationDir, { recursive: true });
      const writeResult = writeRecoveryArtifact({
        dataDir,
        input: {
          goalId,
          goalTitle: "Smoke Manual Recovery Goal",
          iteration: 1,
          jobId: null,
          daemonRunId: null,
          repoPath: "/tmp/smoke-manual-recovery-repo",
          expectedCommit: null,
          currentCommit: null,
          reason: {
            code: "repo_dirty",
            message: "uncommitted changes in repo working tree"
          },
          artifactPaths: {
            iterationDir,
            promptPath: path.join(iterationDir, "prompt.md"),
            runnerLog: null,
            verificationLog: null,
            resultJson: null
          },
          safeNextSteps: [
            "Resolve dirty state and run `momentum recovery clear <goal-id>`."
          ],
          classifiedAt
        }
      });
      expect(writeResult.path).toBe(expectedRecoveryPath);
      expect(fs.existsSync(expectedRecoveryPath)).toBe(true);

      // 2. daemon status --json + text surface the flagged goal alongside the
      // recovery.md path so operators can find the artifact without running
      // status individually for every goal.
      const daemonStatusJson = runCliBinary([
        "daemon",
        "status",
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(
        daemonStatusJson.code,
        `daemon status stderr: ${daemonStatusJson.stderr}`
      ).toBe(0);
      expect(daemonStatusJson.stderr).toBe("");
      const daemonStatusPayload = JSON.parse(
        daemonStatusJson.stdout
      ) as Record<string, unknown>;
      const goalsNeedingRecovery = daemonStatusPayload[
        "goalsNeedingRecovery"
      ] as Array<Record<string, unknown>>;
      expect(goalsNeedingRecovery).toHaveLength(1);
      expect(goalsNeedingRecovery[0]).toMatchObject({
        goalId,
        title: "Smoke Manual Recovery Goal",
        goalState: "initialized",
        recoveryMdPath: expectedRecoveryPath,
        recoveryMdExists: true
      });

      const daemonStatusText = runCliBinary([
        "daemon",
        "status",
        "--data-dir",
        dataDir
      ]);
      expect(
        daemonStatusText.code,
        `daemon status text stderr: ${daemonStatusText.stderr}`
      ).toBe(0);
      expect(daemonStatusText.stdout).toContain(
        "Goals needing manual recovery: 1"
      );
      expect(daemonStatusText.stdout).toContain(goalId);
      expect(daemonStatusText.stdout).toContain(expectedRecoveryPath);

      // 3. status --json surfaces manual_recovery_required as the next action
      // and reports recovery.md as present so the goal-scoped view points at
      // the durable artifact.
      const statusJson = runCliBinary([
        "status",
        goalId,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(statusJson.code, `status stderr: ${statusJson.stderr}`).toBe(0);
      const statusPayload = JSON.parse(statusJson.stdout) as Record<
        string,
        unknown
      >;
      expect(statusPayload).toMatchObject({
        ok: true,
        command: "status",
        goalId
      });
      const artifactFiles = statusPayload["artifactFiles"] as Record<
        string,
        unknown
      >;
      expect(artifactFiles["recoveryMd"]).toBe(true);
      const artifactPaths = statusPayload["artifactPaths"] as Record<
        string,
        unknown
      >;
      expect(artifactPaths["recoveryMd"]).toBe(expectedRecoveryPath);
      const nextActionDetail = statusPayload["nextActionDetail"] as Record<
        string,
        unknown
      >;
      expect(nextActionDetail).toMatchObject({
        kind: "manual_recovery_required",
        jobId: null,
        iteration: null
      });
      expect(nextActionDetail["message"]).toBe(statusPayload["nextAction"]);
      expect(String(nextActionDetail["message"])).toContain(
        "Manual recovery required"
      );
      expect(String(nextActionDetail["message"])).toContain(
        "momentum recovery clear"
      );

      // status text mirrors the recovery surface in human-readable form.
      const statusText = runCliBinary([
        "status",
        goalId,
        "--data-dir",
        dataDir
      ]);
      expect(
        statusText.code,
        `status text stderr: ${statusText.stderr}`
      ).toBe(0);
      expect(statusText.stdout).toContain(
        `Recovery: present (${expectedRecoveryPath})`
      );
      expect(statusText.stdout).toContain("Next: Manual recovery required");

      // 4. handoff --json + on-disk handoff.json + handoff.md all surface the
      // same recovery.md presence and the manual_recovery_required next action
      // so the durable artifact bundle agrees with the live status surfaces.
      const handoff = runCliBinary([
        "handoff",
        goalId,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(handoff.code, `handoff stderr: ${handoff.stderr}`).toBe(0);
      const handoffPayload = JSON.parse(handoff.stdout) as Record<
        string,
        unknown
      >;
      const handoffNextActionDetail = handoffPayload[
        "nextActionDetail"
      ] as Record<string, unknown>;
      expect(handoffNextActionDetail).toMatchObject({
        kind: "manual_recovery_required",
        jobId: null,
        iteration: null
      });

      const handoffJsonPath = path.join(goalArtifactDir, "handoff.json");
      const writtenHandoff = JSON.parse(
        fs.readFileSync(handoffJsonPath, "utf-8")
      ) as Record<string, unknown>;
      const writtenArtifacts = writtenHandoff["artifacts"] as Record<
        string,
        unknown
      >;
      expect(writtenArtifacts["recovery_md"]).toBe(expectedRecoveryPath);
      const writtenArtifactFiles = writtenHandoff[
        "artifact_files"
      ] as Record<string, unknown>;
      expect(writtenArtifactFiles["recovery_md"]).toBe(true);

      const handoffMdPath = path.join(goalArtifactDir, "handoff.md");
      const handoffMdContent = fs.readFileSync(handoffMdPath, "utf-8");
      expect(handoffMdContent).toContain(
        `- recovery.md (present): ${expectedRecoveryPath}`
      );

      // 5. recovery clear lifts the durable flag and appends a
      // goal.recovery_cleared audit event without removing the recovery.md
      // artifact (operators delete it manually after capturing context).
      const clear = runCliBinary([
        "recovery",
        "clear",
        goalId,
        "--reason",
        "smoke-operator-cleared",
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(clear.code, `recovery clear stderr: ${clear.stderr}`).toBe(0);
      expect(clear.stderr).toBe("");
      const clearPayload = JSON.parse(clear.stdout) as Record<
        string,
        unknown
      >;
      expect(clearPayload).toMatchObject({
        ok: true,
        command: "recovery clear",
        goalId,
        previousReason: "repo_dirty",
        previousMarkedAt: classifiedAt
      });
      expect(typeof clearPayload["clearedAt"]).toBe("number");
      expect(typeof clearPayload["eventId"]).toBe("number");

      // recovery.md stays on disk after the clear; this is the documented
      // durable-audit-trail contract.
      expect(fs.existsSync(expectedRecoveryPath)).toBe(true);

      const inspectionDb = new DatabaseSync(path.join(dataDir, "momentum.db"));
      try {
        const goalRow = inspectionDb
          .prepare(
            "SELECT needs_manual_recovery, manual_recovery_reason, manual_recovery_at FROM goals WHERE id = ?"
          )
          .get(goalId) as {
          needs_manual_recovery: number;
          manual_recovery_reason: string | null;
          manual_recovery_at: number | null;
        };
        expect(goalRow).toEqual({
          needs_manual_recovery: 0,
          manual_recovery_reason: null,
          manual_recovery_at: null
        });

        const events = inspectionDb
          .prepare(
            "SELECT type, goal_id FROM events WHERE type = 'goal.recovery_cleared' ORDER BY id"
          )
          .all() as Array<{ type: string; goal_id: string }>;
        expect(events).toEqual([
          { type: "goal.recovery_cleared", goal_id: goalId }
        ]);
      } finally {
        inspectionDb.close();
      }

      // 6. After clear: daemon status reports no goals needing manual recovery,
      // and status no longer surfaces manual_recovery_required as the next
      // action — but artifactFiles.recoveryMd remains true because the file is
      // intentionally preserved.
      const postDaemonStatus = runCliBinary([
        "daemon",
        "status",
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(postDaemonStatus.code).toBe(0);
      const postDaemonPayload = JSON.parse(
        postDaemonStatus.stdout
      ) as Record<string, unknown>;
      expect(postDaemonPayload["goalsNeedingRecovery"]).toEqual([]);

      const postStatus = runCliBinary([
        "status",
        goalId,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(postStatus.code).toBe(0);
      const postStatusPayload = JSON.parse(postStatus.stdout) as Record<
        string,
        unknown
      >;
      const postArtifactFiles = postStatusPayload["artifactFiles"] as Record<
        string,
        unknown
      >;
      expect(postArtifactFiles["recoveryMd"]).toBe(true);
      const postNextActionDetail = postStatusPayload["nextActionDetail"];
      if (postNextActionDetail !== null && postNextActionDetail !== undefined) {
        expect(
          (postNextActionDetail as Record<string, unknown>)["kind"]
        ).not.toBe("manual_recovery_required");
      }

      // A repeat clear refuses with not_flagged so operators cannot accidentally
      // double-clear and append spurious audit events.
      const repeatClear = runCliBinary([
        "recovery",
        "clear",
        goalId,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(repeatClear.code).toBe(1);
      const repeatPayload = JSON.parse(repeatClear.stderr) as Record<
        string,
        unknown
      >;
      expect(repeatPayload).toMatchObject({
        ok: false,
        command: "recovery clear",
        goalId,
        code: "not_flagged"
      });
    },
    60_000
  );
});

const TRUSTED_SHELL_RESULT_JSON = JSON.stringify({
  success: true,
  summary: "Trusted shell wrote smoke-fixture.txt.",
  key_changes_made: ["Wrote smoke-fixture.txt"],
  key_learnings: [],
  remaining_work: [],
  goal_complete: false,
  commit: {
    type: "test",
    scope: "milestone-4",
    subject: "trusted-shell smoke",
    body: "",
    breaking: false
  }
});

describe("Milestone 4 real-runner end-to-end smoke (NGX-286)", () => {
  it(
    "doctor --json reports the M4 closeout milestone marker",
    () => {
      const result = runCliBinary(["doctor", "--json"]);
      expect(result.code, `doctor stderr: ${result.stderr}`).toBe(0);
      const payload = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(payload["milestone"]).toBe(
        "Milestone 4: real runner profiles (NGX-279, NGX-280, NGX-281, NGX-282, NGX-283, NGX-284, NGX-285, NGX-286) complete"
      );
    },
    60_000
  );

  it(
    "runs a trusted-shell happy-path goal end-to-end through the built CLI and surfaces commit/logs/handoff",
    () => {
      if (process.platform === "win32") return;

      const repo = initDisposableRepo();
      const dataDir = makeTempDir("momentum-smoke-m4-ok-data-");
      const goalFile = path.join(dataDir, "goal.md");
      const fixturePath = path.join(repo, "smoke-fixture.txt");
      const scriptPath = path.join(dataDir, "trusted-shell-success.sh");
      fs.writeFileSync(
        scriptPath,
        [
          "#!/bin/sh",
          "set -eu",
          `printf 'hello smoke trusted-shell\\n' > "${fixturePath}"`,
          `cat > "$MOMENTUM_RESULT_PATH" <<'JSON'`,
          TRUSTED_SHELL_RESULT_JSON,
          "JSON",
          "echo trusted-shell-stdout-marker",
          "echo trusted-shell-stderr-marker >&2"
        ].join("\n") + "\n",
        { encoding: "utf-8", mode: 0o755 }
      );
      const goalSpec = `---\ntitle: M4 Trusted Shell Smoke\nrunner: trusted-shell\nverification:\n  - "true"\ntrusted_shell:\n  command: /bin/sh\n  args: [${JSON.stringify(scriptPath)}]\n---\n\nApply the fixture via trusted-shell.\n`;
      fs.writeFileSync(goalFile, goalSpec, "utf-8");

      const baseHead = runGit(repo, ["rev-parse", "HEAD"]).trim();

      const start = runCliBinary([
        "goal",
        "start",
        goalFile,
        "--foreground",
        "--repo",
        repo,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(start.code, `goal start stderr: ${start.stderr}`).toBe(0);
      const startPayload = JSON.parse(start.stdout) as Record<string, unknown>;
      expect(startPayload).toMatchObject({
        ok: true,
        command: "goal start",
        state: "iteration_complete",
        runner: "trusted-shell"
      });
      const profile = startPayload["runnerProfile"] as Record<string, unknown>;
      expect(profile).toMatchObject({
        kind: "trusted-shell",
        executes: true
      });
      expect(startPayload["runnerProfileSource"]).toBe("goal_frontmatter");

      const goalId = startPayload["goalId"] as string;
      const iter = startPayload["iteration"] as Record<string, unknown>;
      const commitSha = iter["commitSha"] as string;
      expect(commitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(commitSha).not.toBe(baseHead);
      expect(iter).toMatchObject({
        ok: true,
        runnerSuccess: true,
        goalComplete: false
      });

      expect(fs.existsSync(fixturePath)).toBe(true);
      expect(fs.readFileSync(fixturePath, "utf-8")).toContain(
        "hello smoke trusted-shell"
      );

      const goalDir = path.join(dataDir, "goals", goalId);
      const runnerLog = fs.readFileSync(
        path.join(goalDir, "iterations", "1", "runner.log"),
        "utf-8"
      );
      expect(runnerLog).toContain("[trusted-shell] start");
      expect(runnerLog).toContain("trusted-shell-stdout-marker");
      expect(runnerLog).toContain("trusted-shell-stderr-marker");
      expect(runnerLog).toContain("[trusted-shell] runner_success: true");

      const logs = runCliBinary([
        "logs",
        goalId,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(logs.code, `logs stderr: ${logs.stderr}`).toBe(0);
      const logsPayload = JSON.parse(logs.stdout) as Record<string, unknown>;
      const resultJsonField = logsPayload["resultJson"] as Record<
        string,
        unknown
      >;
      expect(resultJsonField).toMatchObject({
        exists: true,
        readable: true
      });
      expect(resultJsonField["parseError"]).toBeFalsy();

      const handoff = runCliBinary([
        "handoff",
        goalId,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(handoff.code, `handoff stderr: ${handoff.stderr}`).toBe(0);
      const handoffPayload = JSON.parse(handoff.stdout) as Record<
        string,
        unknown
      >;
      expect(handoffPayload).toMatchObject({
        ok: true,
        command: "handoff",
        goalId,
        state: "iteration_complete"
      });
      const handoffMd = fs.readFileSync(
        path.join(goalDir, "handoff.md"),
        "utf-8"
      );
      expect(handoffMd).toContain("- Runner: trusted-shell");
      expect(handoffMd).toContain(`- Commit SHA: ${commitSha}`);
    },
    120_000
  );

  it(
    "surfaces trusted-shell command_failed through built CLI and resets the worktree to base HEAD",
    () => {
      if (process.platform === "win32") return;

      const repo = initDisposableRepo();
      const dataDir = makeTempDir("momentum-smoke-m4-fail-data-");
      const goalFile = path.join(dataDir, "goal.md");
      const dirtyPath = path.join(repo, "smoke-half-done.txt");
      const scriptPath = path.join(dataDir, "trusted-shell-failure.sh");
      fs.writeFileSync(
        scriptPath,
        [
          "#!/bin/sh",
          `printf 'partial-write\\n' > "${dirtyPath}"`,
          "echo trusted-shell-fail-stderr >&2",
          "exit 17"
        ].join("\n") + "\n",
        { encoding: "utf-8", mode: 0o755 }
      );
      const goalSpec = `---\ntitle: M4 Trusted Shell Failure Smoke\nrunner: trusted-shell\nverification:\n  - "true"\ntrusted_shell:\n  command: /bin/sh\n  args: [${JSON.stringify(scriptPath)}]\n---\n\nFail the iteration deterministically with a non-zero exit.\n`;
      fs.writeFileSync(goalFile, goalSpec, "utf-8");

      const baseHead = runGit(repo, ["rev-parse", "HEAD"]).trim();

      const start = runCliBinary([
        "goal",
        "start",
        goalFile,
        "--foreground",
        "--repo",
        repo,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(start.code).toBe(1);
      expect(start.stdout).toBe("");
      const payload = JSON.parse(start.stderr) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: false,
        command: "goal start",
        state: "failed",
        code: "iteration_failed",
        runner: "trusted-shell"
      });
      const iter = payload["iteration"] as Record<string, unknown>;
      expect(iter).toMatchObject({ ok: false, code: "command_failed" });
      const goalId = payload["goalId"] as string;

      expect(runGit(repo, ["rev-parse", "HEAD"]).trim()).toBe(baseHead);
      expect(runGit(repo, ["status", "--porcelain"]).trim()).toBe("");
      expect(fs.existsSync(dirtyPath)).toBe(false);

      const status = runCliBinary([
        "status",
        goalId,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(status.code, `status stderr: ${status.stderr}`).toBe(0);
      const statusPayload = JSON.parse(status.stdout) as Record<string, unknown>;
      expect(statusPayload).toMatchObject({
        ok: true,
        command: "status",
        goalId,
        state: "failed",
        runner: "trusted-shell"
      });
      const statusIter = statusPayload["iteration"] as Record<string, unknown>;
      const statusFailure = statusIter["failure"] as Record<string, unknown>;
      expect(statusFailure).toMatchObject({ code: "command_failed" });

      const logs = runCliBinary([
        "logs",
        goalId,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(logs.code, `logs stderr: ${logs.stderr}`).toBe(0);
      const logsPayload = JSON.parse(logs.stdout) as Record<string, unknown>;
      const runnerLogField = logsPayload["runnerLog"] as Record<string, unknown>;
      expect(runnerLogField["readable"]).toBe(true);
      expect(runnerLogField["content"]).toContain("[trusted-shell] exit_code: 17");
      expect(runnerLogField["content"]).toContain("trusted-shell-fail-stderr");

      const handoff = runCliBinary([
        "handoff",
        goalId,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(handoff.code, `handoff stderr: ${handoff.stderr}`).toBe(0);
      const handoffPayload = JSON.parse(handoff.stdout) as Record<
        string,
        unknown
      >;
      expect(handoffPayload).toMatchObject({
        ok: true,
        command: "handoff",
        goalId,
        state: "failed"
      });
      const handoffMdContent = fs.readFileSync(
        path.join(dataDir, "goals", goalId, "handoff.md"),
        "utf-8"
      );
      expect(handoffMdContent).toContain("- Failure: command_failed - ");
    },
    120_000
  );

  it(
    "loads MOMENTUM.md defaults and respects CLI --runner override (precedence: CLI > frontmatter > MOMENTUM.md)",
    () => {
      if (process.platform === "win32") return;

      const repo = initDisposableRepo();
      fs.writeFileSync(
        path.join(repo, "MOMENTUM.md"),
        `---\nrunner: trusted-shell\nverification:\n  - "true"\nverification_timeout_sec: 1200\n---\nSmoke policy notes body.\n`,
        "utf-8"
      );
      runGit(repo, ["add", "MOMENTUM.md"]);
      runGit(repo, ["commit", "-m", "add MOMENTUM.md", "--quiet"]);

      const dataDir = makeTempDir("momentum-smoke-m4-policy-data-");
      const goalFile = path.join(dataDir, "goal.md");
      const policyGoalSpec = `---\ntitle: M4 Policy Smoke\nverification:\n  - "true"\n---\n\nLoads runner from MOMENTUM.md unless overridden by CLI.\n`;
      fs.writeFileSync(goalFile, policyGoalSpec, "utf-8");

      // Default path (no --runner override): runner comes from MOMENTUM.md.
      const queued = runCliBinary([
        "goal",
        "start",
        goalFile,
        "--repo",
        repo,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(queued.code, `goal start stderr: ${queued.stderr}`).toBe(0);
      const queuedPayload = JSON.parse(queued.stdout) as Record<
        string,
        unknown
      >;
      expect(queuedPayload).toMatchObject({
        ok: true,
        mode: "queued",
        runner: "trusted-shell"
      });
      expect(queuedPayload["runnerProfileSource"]).toBe("momentum_policy");
      const queuedPolicy = queuedPayload["policy"] as Record<string, unknown>;
      expect(queuedPolicy).toMatchObject({
        present: true,
        path: path.join(repo, "MOMENTUM.md")
      });
      const queuedConfig = queuedPolicy["config"] as Record<string, unknown>;
      expect(queuedConfig).toMatchObject({
        runner: "trusted-shell",
        verificationTimeoutSec: 1200
      });

      const queuedGoalId = queuedPayload["goalId"] as string;

      // CLI override: --runner fake beats both frontmatter and MOMENTUM.md.
      const overrideDataDir = makeTempDir("momentum-smoke-m4-policy-override-");
      const override = runCliBinary([
        "goal",
        "start",
        goalFile,
        "--repo",
        repo,
        "--runner",
        "fake",
        "--data-dir",
        overrideDataDir,
        "--json"
      ]);
      expect(override.code, `override stderr: ${override.stderr}`).toBe(0);
      const overridePayload = JSON.parse(override.stdout) as Record<
        string,
        unknown
      >;
      expect(overridePayload).toMatchObject({
        ok: true,
        mode: "queued",
        runner: "fake"
      });
      expect(overridePayload["runnerProfileSource"]).toBe("cli_override");
      const overridePolicy = overridePayload["policy"] as Record<
        string,
        unknown
      >;
      expect(overridePolicy).toMatchObject({
        present: true,
        path: path.join(repo, "MOMENTUM.md")
      });

      // status surfaces the loaded policy fields too.
      const statusOut = runCliBinary([
        "status",
        queuedGoalId,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(statusOut.code, `status stderr: ${statusOut.stderr}`).toBe(0);
      const statusPayload = JSON.parse(statusOut.stdout) as Record<
        string,
        unknown
      >;
      const statusPolicy = statusPayload["policy"] as Record<string, unknown>;
      expect(statusPolicy).toMatchObject({
        configured: true,
        present: true
      });

      // doctor --repo surfaces the same MOMENTUM.md.
      const doctor = runCliBinary([
        "doctor",
        "--repo",
        repo,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(doctor.code, `doctor stderr: ${doctor.stderr}`).toBe(0);
      const doctorPayload = JSON.parse(doctor.stdout) as Record<string, unknown>;
      const doctorPolicy = doctorPayload["policy"] as Record<string, unknown>;
      expect(doctorPolicy).toMatchObject({
        repoConfigured: true,
        present: true,
        path: path.join(repo, "MOMENTUM.md")
      });
    },
    60_000
  );

  it(
    "surfaces acp runtime_unavailable cleanly through the built CLI when the configured runtime binary is missing",
    () => {
      if (process.platform === "win32") return;

      const repo = initDisposableRepo();
      const dataDir = makeTempDir("momentum-smoke-m4-acp-data-");
      const goalFile = path.join(dataDir, "goal.md");
      const goalSpec = `---\ntitle: M4 ACP Smoke (runtime_unavailable)\nrunner: acp\nverification:\n  - "true"\nacp:\n  command: /definitely-missing-acp-runtime-for-smoke\n---\n\nACP runner that exercises the runtime_unavailable taxonomy when the runtime binary is missing.\n`;
      fs.writeFileSync(goalFile, goalSpec, "utf-8");

      const baseHead = runGit(repo, ["rev-parse", "HEAD"]).trim();

      const start = runCliBinary([
        "goal",
        "start",
        goalFile,
        "--foreground",
        "--repo",
        repo,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(start.code).toBe(1);
      expect(start.stdout).toBe("");
      const payload = JSON.parse(start.stderr) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: false,
        command: "goal start",
        state: "failed",
        code: "iteration_failed",
        runner: "acp"
      });
      const iter = payload["iteration"] as Record<string, unknown>;
      expect(iter).toMatchObject({ ok: false, code: "runtime_unavailable" });
      const goalId = payload["goalId"] as string;

      // Repo state untouched.
      expect(runGit(repo, ["rev-parse", "HEAD"]).trim()).toBe(baseHead);
      expect(runGit(repo, ["status", "--porcelain"]).trim()).toBe("");

      const status = runCliBinary([
        "status",
        goalId,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(status.code, `status stderr: ${status.stderr}`).toBe(0);
      const statusPayload = JSON.parse(status.stdout) as Record<string, unknown>;
      const statusIter = statusPayload["iteration"] as Record<string, unknown>;
      const statusFailure = statusIter["failure"] as Record<string, unknown>;
      expect(statusFailure).toMatchObject({ code: "runtime_unavailable" });
      expect(statusPayload["runner"]).toBe("acp");

      const logs = runCliBinary([
        "logs",
        goalId,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(logs.code, `logs stderr: ${logs.stderr}`).toBe(0);
      const logsPayload = JSON.parse(logs.stdout) as Record<string, unknown>;
      const runnerLogField = logsPayload["runnerLog"] as Record<string, unknown>;
      expect(runnerLogField["readable"]).toBe(true);
      expect(runnerLogField["content"]).toContain("[acp] runtime_unavailable");
    },
    120_000
  );
});
