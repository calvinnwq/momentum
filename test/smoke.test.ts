import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import {
  FAKE_RUNNER_FAIL_ENV,
  FAKE_RUNNER_FIXTURE_FILENAME
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
        "momentum goal start <goal.md> [--repo <path>] [--foreground] [--runner <profile>] [--data-dir <path>] [--json]"
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
      expect(result.stdout).toContain("momentum doctor [--json]");
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
        "momentum goal start <goal.md> [--repo <path>] [--foreground] [--runner <profile>] [--data-dir <path>] [--json]",
        "momentum status [goal-id] [--data-dir <path>] [--json]",
        "momentum logs <goal-id> [--iteration <n>] [--data-dir <path>] [--json]",
        "momentum handoff <goal-id> [--data-dir <path>] [--json]",
        "momentum worker run [--worker-id <id>] [--data-dir <path>] [--json]",
        "momentum daemon start [--max-loop-iterations <n>] [--max-idle-cycles <n>] [--poll-interval-ms <ms>] [--data-dir <path>] [--json]",
        "momentum daemon stop [--reason <text>] [--data-dir <path>] [--json]",
        "momentum daemon status [--data-dir <path>] [--json]",
        "momentum doctor [--json]"
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
    "goal start --json surfaces init_error when the goal file does not exist and does not touch the data dir",
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
        code: "init_error"
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
    "goal start surfaces unsupported_runner without touching the repo when --runner overrides to a non-fake profile",
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
        state: "failed",
        code: "iteration_failed",
        resumed: false
      });
      const iter = payload["iteration"] as Record<string, unknown>;
      expect(iter).toMatchObject({
        ok: false,
        code: "unsupported_runner"
      });
      expect(typeof iter["error"]).toBe("string");
      expect(iter["error"] as string).toContain("custom-runner");

      expect(runGit(repo, ["rev-parse", "HEAD"]).trim()).toBe(baseHead);
      expect(runGit(repo, ["status", "--porcelain"]).trim()).toBe("");
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
          .prepare("SELECT state, runner FROM goals WHERE id = ?")
          .get(goalId) as { state: string; runner: string };
        expect(goalRow.state).toBe("failed");
        expect(goalRow.runner).toBe("custom-runner");
        const jobRow = db
          .prepare("SELECT state, error FROM jobs WHERE goal_id = ?")
          .get(goalId) as { state: string; error: string | null };
        expect(jobRow.state).toBe("failed");
        expect(jobRow.error).toContain("unsupported_runner");
      } finally {
        db.close();
      }
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
      expect(lines[6]).toBe(`Artifact dir: ${artifactDir}`);
      expect(lines[7]).toBe(
        `Job: ${jobId} (succeeded, iteration 1)`
      );
      expect(lines[8]).toBe(`Commit: ${commitSha}`);
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
