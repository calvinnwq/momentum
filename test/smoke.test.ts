import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import {
  FAKE_RUNNER_FAIL_ENV,
  FAKE_RUNNER_FIXTURE_FILENAME,
  FAKE_RUNNER_GOAL_COMPLETE_ENV
} from "../src/fake-runner.js";
import {
  dispatchWorkflowStepExecutor,
  type FakeWorkflowStepExecutorOutcome,
  type WorkflowStepExecutorInput
} from "../src/workflow-step-executor.js";
import type { WorkflowStepKind } from "../src/workflow-run-reducer.js";

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

async function runCliBinaryAsync(
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {}
): Promise<CliResult> {
  const env = options.env
    ? { ...process.env, ...options.env }
    : process.env;
  return await new Promise<CliResult>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: stripNodeWarnings(Buffer.concat(stderrChunks).toString("utf-8"))
      });
    });
  });
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
        "momentum workflow import --path <run-dir> [--data-dir <path>] [--json]",
        "momentum workflow status [<run-id>] [--state <state>] [--filter <active|blocked|completed|imported>] [--limit <n>] [--data-dir <path>] [--json]",
        "momentum workflow handoff <run-id> [--data-dir <path>] [--json]",
        "momentum workflow run approve <run-id> --approval-boundary <boundary> --phrase <text> [--actor <name>] [--artifact-path <path>] [--artifact-digest <sha256>] [--data-dir <path>] [--json]",
        "momentum workflow run list [--state <state>] [--filter <active|blocked|completed|imported>] [--approval-boundary <boundary>] [--repo <path>] [--issue-scope <identifier>] [--updated-since <ms>] [--updated-until <ms>] [--limit <n>] [--data-dir <path>] [--json]",
        "momentum workflow run update-step <run-id> --step <step-id> --state <succeeded|skipped|failed|blocked> --reason <text> [--actor <name>] [--evidence-pointer <ref>] [--ledger-pointer <ref>] [--data-dir <path>] [--json]",
        "momentum intent list [--status <status>] [--adapter <kind>] [--type <intent-type>] [--goal <goal-id>] [--source-item <id>] [--evidence-record <id>] [--limit <n>] [--data-dir <path>] [--json]",
        "momentum intent get <intent-id> [--data-dir <path>] [--json]",
        "momentum intent apply <intent-id> --reason <text> [--repo <path>] [--external-apply] [--data-dir <path>] [--json]",
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

const M5_SMOKE_RUN_ID = "smoke-m5-workflow-run-1";

function writeM5WorkflowFixture(rootDir: string): string {
  const runDir = path.join(rootDir, ".agent-workflows", M5_SMOKE_RUN_ID);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "plan.json"),
    JSON.stringify(
      {
        runId: M5_SMOKE_RUN_ID,
        schemaVersion: 1,
        mode: "execute-ready",
        profile: "momentum-m5-smoke",
        objective: "NGX-294 smoke fixture for evidence ingestion",
        resolvedScope: {
          issues: ["NGX-294"],
          source: "explicit",
          status: "resolved"
        }
      },
      null,
      2
    )
  );
  const ledgerLines = [
    {
      runId: M5_SMOKE_RUN_ID,
      step: "preflight",
      status: "complete",
      ts: "2026-05-18T09:00:00Z"
    },
    {
      runId: M5_SMOKE_RUN_ID,
      step: "implementation",
      status: "started",
      ts: "2026-05-18T09:01:00Z"
    },
    {
      runId: M5_SMOKE_RUN_ID,
      step: "implementation",
      status: "complete",
      ts: "2026-05-18T09:30:00Z"
    }
  ];
  fs.writeFileSync(
    path.join(runDir, "ledger.jsonl"),
    `${ledgerLines.map((line) => JSON.stringify(line)).join("\n")}\n`
  );
  return runDir;
}

type LinearMockServer = {
  endpoint: string;
  bodies: Array<Record<string, unknown>>;
  close: () => Promise<void>;
};

async function startLinearMockServer(
  issues: Array<Record<string, unknown>>
): Promise<LinearMockServer> {
  const bodies: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      try {
        bodies.push(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        bodies.push({ rawBody: raw });
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          data: {
            issues: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: issues
            }
          }
        })
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const endpoint = `http://127.0.0.1:${address.port}/graphql`;
  return {
    endpoint,
    bodies,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      })
  };
}

describe("Milestone 5 evidence + intent + project status smoke (NGX-294)", () => {
  it(
    "doctor --json reports the M7 closeout milestone marker",
    () => {
      const result = runCliBinary(["doctor", "--json"]);
      expect(result.code, `doctor stderr: ${result.stderr}`).toBe(0);
      const payload = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(payload["milestone"]).toBe(
        "Milestone 7: openclaw coding workflow backend (NGX-312, NGX-313, NGX-314, NGX-315, NGX-316, NGX-317, NGX-318, NGX-319) complete"
      );
    },
    60_000
  );

  it(
    "ingests workflow fixtures and surfaces them through evidence list and doctor",
    () => {
      const dataDir = makeTempDir("momentum-smoke-m5-evidence-data-");
      const fixtureRoot = makeTempDir("momentum-smoke-m5-evidence-fixture-");
      const runDir = writeM5WorkflowFixture(fixtureRoot);

      const ingest = runCliBinary([
        "evidence",
        "ingest",
        "--path",
        runDir,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(ingest.code, `evidence ingest stderr: ${ingest.stderr}`).toBe(0);
      const ingestPayload = JSON.parse(ingest.stdout) as Record<string, unknown>;
      expect(ingestPayload).toMatchObject({
        ok: true,
        command: "evidence ingest",
        dataDir,
        path: runDir,
        goalId: null,
        sourceItemId: null
      });
      const ingestCounts = ingestPayload["counts"] as Record<string, number>;
      expect(ingestCounts.observed).toBe(4);
      expect(ingestCounts.created).toBe(4);
      expect(ingestCounts.skipped).toBe(0);
      expect(ingestCounts.errors).toBe(0);
      expect(ingestCounts.diagnostics).toBe(0);
      const createdTypes = (ingestPayload["created"] as Array<Record<string, unknown>>)
        .map((record) => record["type"])
        .sort();
      expect(createdTypes).toEqual([
        "implementation_complete",
        "implementation_started",
        "plan_created",
        "preflight_complete"
      ]);

      // Re-running ingestion is idempotent via stable ingest_key.
      const reIngest = runCliBinary([
        "evidence",
        "ingest",
        "--path",
        runDir,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(
        reIngest.code,
        `re-ingest stderr: ${reIngest.stderr}`
      ).toBe(0);
      const reIngestPayload = JSON.parse(reIngest.stdout) as Record<
        string,
        unknown
      >;
      const reIngestCounts = reIngestPayload["counts"] as Record<string, number>;
      expect(reIngestCounts.observed).toBe(4);
      expect(reIngestCounts.created).toBe(0);
      expect(reIngestCounts.skipped).toBe(4);

      const list = runCliBinary([
        "evidence",
        "list",
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(list.code, `evidence list stderr: ${list.stderr}`).toBe(0);
      const listPayload = JSON.parse(list.stdout) as Record<string, unknown>;
      expect(listPayload).toMatchObject({
        ok: true,
        command: "evidence list",
        dataDir
      });
      expect(listPayload["count"]).toBe(4);
      const listedTypes = (listPayload["records"] as Array<Record<string, unknown>>)
        .map((record) => record["type"])
        .sort();
      expect(listedTypes).toEqual([
        "implementation_complete",
        "implementation_started",
        "plan_created",
        "preflight_complete"
      ]);
      const records = listPayload["records"] as Array<Record<string, unknown>>;
      for (const record of records) {
        expect(record["source"]).toBe("agent-workflow");
        expect(record["formatVersion"]).toBe(1);
        expect(typeof record["ingestKey"]).toBe("string");
        expect((record["ingestKey"] as string).startsWith("agent-workflow:")).toBe(
          true
        );
      }

      const filtered = runCliBinary([
        "evidence",
        "list",
        "--type",
        "plan_created",
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(filtered.code, `filtered evidence list stderr: ${filtered.stderr}`).toBe(
        0
      );
      const filteredPayload = JSON.parse(filtered.stdout) as Record<
        string,
        unknown
      >;
      expect(filteredPayload["count"]).toBe(1);
      expect(
        (filteredPayload["records"] as Array<Record<string, unknown>>)[0]?.["type"]
      ).toBe("plan_created");

      const doctor = runCliBinary([
        "doctor",
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(doctor.code, `doctor stderr: ${doctor.stderr}`).toBe(0);
      const doctorPayload = JSON.parse(doctor.stdout) as Record<string, unknown>;
      const evidencePayload = doctorPayload["evidence"] as Record<string, unknown>;
      expect(evidencePayload).toMatchObject({
        ok: true,
        totalRecords: 4,
        goalLinkedRecords: 0,
        sourceItemLinkedRecords: 0
      });
    },
    60_000
  );

  it(
    "reports an empty intent list cleanly when no update intents exist",
    () => {
      const dataDir = makeTempDir("momentum-smoke-m5-intent-data-");
      const result = runCliBinary([
        "intent",
        "list",
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(result.code, `intent list stderr: ${result.stderr}`).toBe(0);
      const payload = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: true,
        command: "intent list",
        dataDir,
        count: 0
      });
      expect(payload["intents"]).toEqual([]);
    },
    60_000
  );

  it(
    "reports a deterministic project status rollup when no source items exist",
    () => {
      const dataDir = makeTempDir("momentum-smoke-m5-project-data-");
      const result = runCliBinary([
        "project",
        "status",
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(
        result.code,
        `project status stderr: ${result.stderr}`
      ).toBe(0);
      const payload = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: true,
        command: "project status",
        dataDir
      });
      const counts = payload["counts"] as Record<string, Record<string, unknown>>;
      expect(counts.sourceItems).toMatchObject({
        total: 0,
        linkedToGoal: 0,
        unlinked: 0
      });
      expect(counts.goals).toMatchObject({ total: 0, needingManualRecovery: 0 });
      expect(counts.evidence).toMatchObject({
        totalRecords: 0,
        goalsWithEvidence: 0,
        goalsWithoutEvidence: 0
      });
      expect(payload["sourceItems"]).toEqual([]);
      expect(payload["mismatches"]).toEqual([]);
      expect(payload["pendingUpdateIntents"]).toEqual([]);
      expect(payload["reconciliationWarnings"]).toEqual([]);
      const nextAction = payload["nextAction"] as Record<string, unknown>;
      expect(typeof nextAction["kind"]).toBe("string");
      expect(typeof nextAction["message"]).toBe("string");
    },
    60_000
  );

  it(
    "reconciles fixture Linear issues against a mock endpoint and surfaces them through source list and source get",
    async () => {
      const dataDir = makeTempDir("momentum-smoke-m5-reconcile-data-");
      const issue = {
        id: "issue-smoke-ngx-294",
        identifier: "NGX-294",
        title: "M5-07 M5 smoke, docs, and milestone closeout",
        description: "Smoke fixture for the M5 closeout reconciliation path.",
        url: "https://linear.app/ngxcalvin/issue/NGX-294",
        updatedAt: "2026-05-18T10:00:00.000Z",
        priority: 0,
        state: { id: "state-in-progress", name: "In Progress" },
        project: {
          id: "project-momentum",
          name: "Momentum",
          url: "https://linear.app/ngxcalvin/project/momentum"
        },
        projectMilestone: {
          id: "milestone-m5",
          name: "Milestone 5: Source Adapters And Evidence Sync"
        },
        labels: { nodes: [] },
        assignee: null
      };
      const mock = await startLinearMockServer([issue]);
      try {
        const reconcile = await runCliBinaryAsync(
          [
            "source",
            "reconcile",
            "linear",
            "--linear-endpoint",
            mock.endpoint,
            "--data-dir",
            dataDir,
            "--json"
          ],
          { env: { LINEAR_API_KEY: "lin_api_smoke_fixture_key" } }
        );
        expect(
          reconcile.code,
          `source reconcile linear stderr: ${reconcile.stderr}`
        ).toBe(0);
        const reconcilePayload = JSON.parse(reconcile.stdout) as Record<
          string,
          unknown
        >;
        expect(reconcilePayload).toMatchObject({
          ok: true,
          command: "source reconcile linear",
          dataDir,
          adapter: "linear",
          dryRun: false
        });
        const reconcileCounts = reconcilePayload["counts"] as Record<
          string,
          number
        >;
        expect(reconcileCounts).toMatchObject({
          pages: 1,
          itemsObserved: 1,
          itemsCreated: 1,
          itemsUpdated: 0,
          itemsSkipped: 0,
          itemsErrored: 0
        });
        const paginationStopped = reconcilePayload["paginationStopped"] as Record<
          string,
          unknown
        >;
        expect(paginationStopped["reason"]).toBe("complete");
        expect(paginationStopped["code"]).toBeNull();
        const itemsSampled = reconcilePayload["itemsSampled"] as Array<
          Record<string, unknown>
        >;
        expect(itemsSampled).toHaveLength(1);
        expect(itemsSampled[0]).toMatchObject({
          classification: "created",
          externalId: "issue-smoke-ngx-294",
          externalKey: "NGX-294"
        });
        const run = reconcilePayload["run"] as Record<string, unknown>;
        expect(run["state"]).toBe("succeeded");
        expect(run["adapterKind"]).toBe("linear");

        expect(mock.bodies).toHaveLength(1);
        const requestBody = mock.bodies[0];
        expect(typeof requestBody?.["query"]).toBe("string");
        const variables = requestBody?.["variables"] as Record<string, unknown>;
        expect(variables).toMatchObject({ first: 50, after: null });

        const list = runCliBinary([
          "source",
          "list",
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(list.code, `source list stderr: ${list.stderr}`).toBe(0);
        const listPayload = JSON.parse(list.stdout) as Record<string, unknown>;
        expect(listPayload).toMatchObject({
          ok: true,
          command: "source list",
          dataDir
        });
        const listedItems = listPayload["items"] as Array<Record<string, unknown>>;
        expect(listedItems).toHaveLength(1);
        const listedItem = listedItems[0]!;
        expect(listedItem).toMatchObject({
          adapterKind: "linear",
          externalId: "issue-smoke-ngx-294",
          externalKey: "NGX-294",
          title: "M5-07 M5 smoke, docs, and milestone closeout",
          status: "In Progress",
          url: "https://linear.app/ngxcalvin/issue/NGX-294",
          goalId: null
        });
        expect(typeof listedItem["id"]).toBe("string");

        const sourceItemId = listedItem["id"] as string;
        const get = runCliBinary([
          "source",
          "get",
          sourceItemId,
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(get.code, `source get stderr: ${get.stderr}`).toBe(0);
        const getPayload = JSON.parse(get.stdout) as Record<string, unknown>;
        expect(getPayload).toMatchObject({
          ok: true,
          command: "source get",
          dataDir
        });
        const fetchedItem = getPayload["item"] as Record<string, unknown>;
        expect(fetchedItem).toMatchObject({
          id: sourceItemId,
          adapterKind: "linear",
          externalId: "issue-smoke-ngx-294",
          externalKey: "NGX-294"
        });
        const metadata = fetchedItem["metadata"] as Record<string, unknown>;
        expect((metadata["project"] as Record<string, unknown>)?.["name"]).toBe(
          "Momentum"
        );
        expect(
          (metadata["milestone"] as Record<string, unknown>)?.["name"]
        ).toBe("Milestone 5: Source Adapters And Evidence Sync");

        const doctor = runCliBinary([
          "doctor",
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(doctor.code, `doctor stderr: ${doctor.stderr}`).toBe(0);
        const doctorPayload = JSON.parse(doctor.stdout) as Record<string, unknown>;
        const sourcesPayload = doctorPayload["sources"] as Record<string, unknown>;
        expect(sourcesPayload).toMatchObject({
          ok: true,
          totalSourceItems: 1,
          linkedSourceItems: 0,
          unlinkedSourceItems: 1
        });
        const lastReconciliation = sourcesPayload["lastReconciliation"] as Record<
          string,
          unknown
        >;
        expect(lastReconciliation).toMatchObject({
          adapterKind: "linear",
          state: "succeeded",
          itemsSeen: 1,
          itemsUpserted: 1
        });
      } finally {
        await mock.close();
      }
    },
    60_000
  );

  it(
    "links a reconciled SourceItem to a queued Goal and surfaces it through status and handoff",
    async () => {
      const dataDir = makeTempDir("momentum-smoke-m5-link-data-");
      const repo = initDisposableRepo();
      const goalFile = path.join(dataDir, "goal.md");
      fs.writeFileSync(goalFile, SMOKE_GOAL_SPEC, "utf-8");

      const issue = {
        id: "issue-smoke-ngx-294-link",
        identifier: "NGX-294",
        title: "M5-07 M5 smoke, docs, and milestone closeout",
        description: "Smoke fixture for the M5 Goal/SourceItem linkage path.",
        url: "https://linear.app/ngxcalvin/issue/NGX-294",
        updatedAt: "2026-05-18T10:30:00.000Z",
        priority: 0,
        state: { id: "state-in-progress", name: "In Progress" },
        project: {
          id: "project-momentum",
          name: "Momentum",
          url: "https://linear.app/ngxcalvin/project/momentum"
        },
        projectMilestone: {
          id: "milestone-m5",
          name: "Milestone 5: Source Adapters And Evidence Sync"
        },
        labels: { nodes: [] },
        assignee: null
      };
      const mock = await startLinearMockServer([issue]);
      try {
        const reconcile = await runCliBinaryAsync(
          [
            "source",
            "reconcile",
            "linear",
            "--linear-endpoint",
            mock.endpoint,
            "--data-dir",
            dataDir,
            "--json"
          ],
          { env: { LINEAR_API_KEY: "lin_api_smoke_fixture_key" } }
        );
        expect(
          reconcile.code,
          `source reconcile linear stderr: ${reconcile.stderr}`
        ).toBe(0);
        const reconcilePayload = JSON.parse(reconcile.stdout) as Record<
          string,
          unknown
        >;
        expect(reconcilePayload["ok"]).toBe(true);
        const reconciledSample = reconcilePayload["itemsSampled"] as Array<
          Record<string, unknown>
        >;
        expect(reconciledSample).toHaveLength(1);
        expect(reconciledSample[0]).toMatchObject({
          classification: "created",
          externalKey: "NGX-294"
        });

        // Resolve the new SourceItem id via source list (reconcile payload omits the local id).
        const initialList = runCliBinary([
          "source",
          "list",
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(
          initialList.code,
          `initial source list stderr: ${initialList.stderr}`
        ).toBe(0);
        const initialListPayload = JSON.parse(initialList.stdout) as Record<
          string,
          unknown
        >;
        const initialListedItems = initialListPayload["items"] as Array<
          Record<string, unknown>
        >;
        expect(initialListedItems).toHaveLength(1);
        const sourceItemId = initialListedItems[0]?.["id"] as string;
        expect(typeof sourceItemId).toBe("string");
        expect(sourceItemId.length).toBeGreaterThan(0);
        expect(initialListedItems[0]?.["goalId"]).toBeNull();

        const goalStart = runCliBinary([
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
        expect(goalStart.code, `goal start stderr: ${goalStart.stderr}`).toBe(0);
        const goalPayload = JSON.parse(goalStart.stdout) as Record<string, unknown>;
        const goalId = goalPayload["goalId"] as string;
        expect(typeof goalId).toBe("string");
        expect(goalId.length).toBeGreaterThan(0);
        expect(goalPayload["goalState"]).toBe("queued");

        const link = runCliBinary([
          "source",
          "link",
          sourceItemId,
          "--goal",
          goalId,
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(link.code, `source link stderr: ${link.stderr}`).toBe(0);
        const linkPayload = JSON.parse(link.stdout) as Record<string, unknown>;
        expect(linkPayload).toMatchObject({
          ok: true,
          command: "source link",
          dataDir,
          goalId,
          sourceItemId,
          changed: true,
          previousGoalId: null
        });
        const linkedItem = linkPayload["item"] as Record<string, unknown>;
        expect(linkedItem).toMatchObject({
          id: sourceItemId,
          adapterKind: "linear",
          externalKey: "NGX-294",
          goalId
        });

        // Linking the same item again is a no-op (changed=false, skippedReason=already_linked).
        const relink = runCliBinary([
          "source",
          "link",
          sourceItemId,
          "--goal",
          goalId,
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(relink.code, `source relink stderr: ${relink.stderr}`).toBe(0);
        const relinkPayload = JSON.parse(relink.stdout) as Record<string, unknown>;
        expect(relinkPayload).toMatchObject({
          ok: true,
          changed: false,
          skippedReason: "already_linked_to_target"
        });

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
          goalId
        });
        const statusSourceItems = statusPayload["sourceItems"] as Array<
          Record<string, unknown>
        >;
        expect(Array.isArray(statusSourceItems)).toBe(true);
        expect(statusSourceItems).toHaveLength(1);
        expect(statusSourceItems[0]).toMatchObject({
          id: sourceItemId,
          adapterKind: "linear",
          externalId: "issue-smoke-ngx-294-link",
          externalKey: "NGX-294",
          title: "M5-07 M5 smoke, docs, and milestone closeout",
          status: "In Progress",
          url: "https://linear.app/ngxcalvin/issue/NGX-294"
        });
        expect(typeof statusSourceItems[0]?.["lastObservedAt"]).toBe("number");

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
          goalId
        });
        const handoffSourceItems = handoffPayload["sourceItems"] as Array<
          Record<string, unknown>
        >;
        expect(Array.isArray(handoffSourceItems)).toBe(true);
        expect(handoffSourceItems).toHaveLength(1);
        expect(handoffSourceItems[0]).toMatchObject({
          id: sourceItemId,
          adapterKind: "linear",
          externalKey: "NGX-294",
          title: "M5-07 M5 smoke, docs, and milestone closeout"
        });

        // handoff.md on disk surfaces the linked source item as well.
        const handoffMdPath = handoffPayload["handoffMdPath"] as string;
        expect(typeof handoffMdPath).toBe("string");
        const handoffMd = fs.readFileSync(handoffMdPath, "utf-8");
        expect(handoffMd).toContain("## Source items");
        expect(handoffMd).toContain("linear/NGX-294");
        expect(handoffMd).toContain(
          "M5-07 M5 smoke, docs, and milestone closeout"
        );

        // doctor --json now reports the linked source item, not the unlinked one.
        const doctor = runCliBinary([
          "doctor",
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(doctor.code, `doctor stderr: ${doctor.stderr}`).toBe(0);
        const doctorPayload = JSON.parse(doctor.stdout) as Record<string, unknown>;
        const sourcesPayload = doctorPayload["sources"] as Record<string, unknown>;
        expect(sourcesPayload).toMatchObject({
          ok: true,
          totalSourceItems: 1,
          linkedSourceItems: 1,
          unlinkedSourceItems: 0
        });
      } finally {
        await mock.close();
      }
    },
    60_000
  );

  it(
    "generates a source_satisfied update intent through source link after a goal completes and refuses --external-apply",
    async () => {
      const dataDir = makeTempDir("momentum-smoke-m5-intent-gen-data-");
      const repo = initDisposableRepo();
      const goalFile = path.join(dataDir, "goal.md");
      fs.writeFileSync(goalFile, SMOKE_GOAL_SPEC, "utf-8");

      const issue = {
        id: "issue-smoke-ngx-294-intent",
        identifier: "NGX-294",
        title: "M5-07 M5 smoke, docs, and milestone closeout",
        description: "Smoke fixture for the M5 intent generation path.",
        url: "https://linear.app/ngxcalvin/issue/NGX-294",
        updatedAt: "2026-05-18T11:00:00.000Z",
        priority: 0,
        state: { id: "state-in-progress", name: "In Progress" },
        project: {
          id: "project-momentum",
          name: "Momentum",
          url: "https://linear.app/ngxcalvin/project/momentum"
        },
        projectMilestone: {
          id: "milestone-m5",
          name: "Milestone 5: Source Adapters And Evidence Sync"
        },
        labels: { nodes: [] },
        assignee: null
      };
      const mock = await startLinearMockServer([issue]);
      try {
        const reconcile = await runCliBinaryAsync(
          [
            "source",
            "reconcile",
            "linear",
            "--linear-endpoint",
            mock.endpoint,
            "--data-dir",
            dataDir,
            "--json"
          ],
          { env: { LINEAR_API_KEY: "lin_api_smoke_fixture_key" } }
        );
        expect(
          reconcile.code,
          `source reconcile linear stderr: ${reconcile.stderr}`
        ).toBe(0);

        const sourceList = runCliBinary([
          "source",
          "list",
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(sourceList.code, `source list stderr: ${sourceList.stderr}`).toBe(0);
        const sourceListPayload = JSON.parse(sourceList.stdout) as Record<
          string,
          unknown
        >;
        const sourceItems = sourceListPayload["items"] as Array<
          Record<string, unknown>
        >;
        expect(sourceItems).toHaveLength(1);
        const sourceItemId = sourceItems[0]?.["id"] as string;
        expect(typeof sourceItemId).toBe("string");
        expect(sourceItemId.length).toBeGreaterThan(0);

        const goalStart = runCliBinary([
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
        expect(goalStart.code, `goal start stderr: ${goalStart.stderr}`).toBe(0);
        const goalStartPayload = JSON.parse(goalStart.stdout) as Record<
          string,
          unknown
        >;
        const goalId = goalStartPayload["goalId"] as string;
        expect(typeof goalId).toBe("string");
        expect(goalStartPayload["goalState"]).toBe("queued");

        // Drain the queued goal to completion. FAKE_RUNNER_GOAL_COMPLETE makes
        // the single iteration mark goal_complete so the reducer transitions
        // the goal to the `completed` state — required by the intent generator.
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
        const drainPayload = JSON.parse(drain.stdout) as Record<string, unknown>;
        const loop = drainPayload["loop"] as Record<string, unknown>;
        expect(loop).toMatchObject({
          workSucceeded: true,
          jobsRun: 1,
          jobsFailed: 0
        });

        const completedStatus = runCliBinary([
          "status",
          goalId,
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(completedStatus.code).toBe(0);
        expect(
          (JSON.parse(completedStatus.stdout) as Record<string, unknown>)[
            "state"
          ]
        ).toBe("completed");

        // Ingest a workflow evidence fixture with `no-mistakes complete` so
        // the intent generator finds an accepted verification evidence type.
        const fixtureRoot = makeTempDir("momentum-smoke-m5-intent-fixture-");
        const intentRunId = "smoke-m5-intent-run-1";
        const runDir = path.join(fixtureRoot, ".agent-workflows", intentRunId);
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(
          path.join(runDir, "plan.json"),
          JSON.stringify(
            {
              runId: intentRunId,
              schemaVersion: 1,
              mode: "execute-ready",
              profile: "momentum-m5-smoke",
              objective: "NGX-294 smoke fixture for intent generation",
              resolvedScope: {
                issues: ["NGX-294"],
                source: "explicit",
                status: "resolved"
              }
            },
            null,
            2
          )
        );
        const ledger = [
          {
            runId: intentRunId,
            step: "implementation",
            status: "complete",
            ts: "2026-05-18T11:20:00Z"
          },
          {
            runId: intentRunId,
            step: "no-mistakes",
            status: "complete",
            ts: "2026-05-18T11:25:00Z"
          }
        ];
        fs.writeFileSync(
          path.join(runDir, "ledger.jsonl"),
          `${ledger.map((line) => JSON.stringify(line)).join("\n")}\n`
        );

        const ingest = runCliBinary([
          "evidence",
          "ingest",
          "--path",
          runDir,
          "--goal",
          goalId,
          "--source-item",
          sourceItemId,
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(ingest.code, `evidence ingest stderr: ${ingest.stderr}`).toBe(0);
        const ingestPayload = JSON.parse(ingest.stdout) as Record<
          string,
          unknown
        >;
        const ingestCreated = ingestPayload["created"] as Array<
          Record<string, unknown>
        >;
        expect(
          ingestCreated.some(
            (record) => record["type"] === "no_mistakes_complete"
          ),
          `expected no_mistakes_complete in created evidence: ${JSON.stringify(
            ingestCreated
          )}`
        ).toBe(true);

        // Linking now triggers `evaluateGoalForSourceSatisfiedIntents` against
        // the completed goal + non-terminal source item + accepted evidence.
        const link = runCliBinary([
          "source",
          "link",
          sourceItemId,
          "--goal",
          goalId,
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(link.code, `source link stderr: ${link.stderr}`).toBe(0);
        const linkPayload = JSON.parse(link.stdout) as Record<string, unknown>;
        const linkCounts = linkPayload["counts"] as Record<string, number>;
        expect(linkCounts).toMatchObject({
          intentsCreated: 1,
          intentsReplayed: 0,
          intentWarnings: 0
        });

        const intentList = runCliBinary([
          "intent",
          "list",
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(intentList.code, `intent list stderr: ${intentList.stderr}`).toBe(
          0
        );
        const intentListPayload = JSON.parse(intentList.stdout) as Record<
          string,
          unknown
        >;
        expect(intentListPayload["count"]).toBe(1);
        const listedIntents = intentListPayload["intents"] as Array<
          Record<string, unknown>
        >;
        expect(listedIntents).toHaveLength(1);
        const intent = listedIntents[0]!;
        expect(intent).toMatchObject({
          adapterKind: "linear",
          intentType: "source_satisfied",
          status: "pending",
          goalId,
          sourceItemId,
          targetExternalId: "issue-smoke-ngx-294-intent"
        });
        const intentId = intent["id"] as string;
        expect(typeof intentId).toBe("string");
        expect(intentId.length).toBeGreaterThan(0);

        // Re-running the eval (e.g. relinking) replays the same intent rather
        // than creating a new one — proves idempotency through the built CLI.
        const relink = runCliBinary([
          "source",
          "link",
          sourceItemId,
          "--goal",
          goalId,
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(relink.code).toBe(0);
        const relinkPayload = JSON.parse(relink.stdout) as Record<string, unknown>;
        const relinkCounts = relinkPayload["counts"] as Record<string, number>;
        expect(relinkCounts).toMatchObject({
          intentsCreated: 0,
          intentsReplayed: 1
        });

        // `intent apply --external-apply` requires a repo context whose
        // MOMENTUM.md sets intent_apply_policy: external_apply_allowed.
        // Without --repo, the orchestrator refuses with policy_denied and
        // leaves the intent pending. No external write occurs.
        const externalApply = runCliBinary([
          "intent",
          "apply",
          intentId,
          "--reason",
          "smoke external apply attempt",
          "--external-apply",
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(externalApply.code).toBe(1);
        expect(externalApply.stdout).toBe("");
        const externalApplyPayload = JSON.parse(externalApply.stderr) as Record<
          string,
          unknown
        >;
        expect(externalApplyPayload).toMatchObject({
          ok: false,
          command: "intent apply",
          code: "policy_denied",
          intentId
        });
        const externalApplyPolicy = externalApplyPayload["applyPolicy"] as Record<
          string,
          unknown
        >;
        expect(externalApplyPolicy).toMatchObject({
          effective: "create_intents_only",
          source: "builtin_default",
          externalApplyRequested: true,
          externalApplyPerformed: false
        });

        const stillPending = runCliBinary([
          "intent",
          "get",
          intentId,
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(stillPending.code).toBe(0);
        const stillPendingPayload = JSON.parse(stillPending.stdout) as Record<
          string,
          unknown
        >;
        expect(
          (stillPendingPayload["intent"] as Record<string, unknown>)["status"]
        ).toBe("pending");

        // `intent apply` without --external-apply records the operator's
        // manual mark only; the intent moves to `applied` with no external
        // write attempted.
        const manualApply = runCliBinary([
          "intent",
          "apply",
          intentId,
          "--reason",
          "operator manual mark in smoke run",
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(
          manualApply.code,
          `manual apply stderr: ${manualApply.stderr}`
        ).toBe(0);
        const manualApplyPayload = JSON.parse(manualApply.stdout) as Record<
          string,
          unknown
        >;
        expect(manualApplyPayload["previousStatus"]).toBe("pending");
        const appliedIntent = manualApplyPayload["intent"] as Record<
          string,
          unknown
        >;
        expect(appliedIntent).toMatchObject({
          id: intentId,
          status: "applied",
          decisionReason: "operator manual mark in smoke run"
        });
        const manualApplyPolicy = manualApplyPayload["applyPolicy"] as Record<
          string,
          unknown
        >;
        expect(manualApplyPolicy).toMatchObject({
          effective: "create_intents_only",
          source: "builtin_default",
          externalApplyRequested: false,
          externalApplyPerformed: false
        });

        const pendingList = runCliBinary([
          "intent",
          "list",
          "--status",
          "pending",
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(pendingList.code).toBe(0);
        const pendingListPayload = JSON.parse(pendingList.stdout) as Record<
          string,
          unknown
        >;
        expect(pendingListPayload["count"]).toBe(0);

        const appliedList = runCliBinary([
          "intent",
          "list",
          "--status",
          "applied",
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(appliedList.code).toBe(0);
        const appliedListPayload = JSON.parse(appliedList.stdout) as Record<
          string,
          unknown
        >;
        expect(appliedListPayload["count"]).toBe(1);
        const appliedListedIntents = appliedListPayload["intents"] as Array<
          Record<string, unknown>
        >;
        expect(appliedListedIntents[0]).toMatchObject({
          id: intentId,
          status: "applied"
        });
      } finally {
        await mock.close();
      }
    },
    180_000
  );

  it(
    "computes a project rollup with mismatches and pending intents through the built CLI",
    async () => {
      const dataDir = makeTempDir("momentum-smoke-m5-rollup-data-");
      const repo = initDisposableRepo();
      const goalFile = path.join(dataDir, "goal.md");
      fs.writeFileSync(goalFile, SMOKE_GOAL_SPEC, "utf-8");

      // SourceItem stays in a non-terminal state ("In Progress") while the
      // Goal completes; that asymmetry is what produces the
      // `goal_done_source_not_done` mismatch the rollup must surface.
      const issue = {
        id: "issue-smoke-ngx-294-rollup",
        identifier: "NGX-294",
        title: "M5-07 M5 smoke, docs, and milestone closeout",
        description: "Smoke fixture for the M5 project rollup path.",
        url: "https://linear.app/ngxcalvin/issue/NGX-294",
        updatedAt: "2026-05-18T12:00:00.000Z",
        priority: 0,
        state: { id: "state-in-progress", name: "In Progress" },
        project: {
          id: "project-momentum",
          name: "Momentum",
          url: "https://linear.app/ngxcalvin/project/momentum"
        },
        projectMilestone: {
          id: "milestone-m5",
          name: "Milestone 5: Source Adapters And Evidence Sync"
        },
        labels: { nodes: [] },
        assignee: null
      };
      const mock = await startLinearMockServer([issue]);
      try {
        const reconcile = await runCliBinaryAsync(
          [
            "source",
            "reconcile",
            "linear",
            "--linear-endpoint",
            mock.endpoint,
            "--data-dir",
            dataDir,
            "--json"
          ],
          { env: { LINEAR_API_KEY: "lin_api_smoke_fixture_key" } }
        );
        expect(
          reconcile.code,
          `source reconcile linear stderr: ${reconcile.stderr}`
        ).toBe(0);

        const sourceList = runCliBinary([
          "source",
          "list",
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(sourceList.code, `source list stderr: ${sourceList.stderr}`).toBe(0);
        const sourceListPayload = JSON.parse(sourceList.stdout) as Record<
          string,
          unknown
        >;
        const sourceItems = sourceListPayload["items"] as Array<
          Record<string, unknown>
        >;
        expect(sourceItems).toHaveLength(1);
        const sourceItemId = sourceItems[0]?.["id"] as string;
        expect(typeof sourceItemId).toBe("string");

        const goalStart = runCliBinary([
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
        expect(goalStart.code, `goal start stderr: ${goalStart.stderr}`).toBe(0);
        const goalStartPayload = JSON.parse(goalStart.stdout) as Record<
          string,
          unknown
        >;
        const goalId = goalStartPayload["goalId"] as string;
        expect(typeof goalId).toBe("string");
        expect(goalStartPayload["goalState"]).toBe("queued");

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
        const drainPayload = JSON.parse(drain.stdout) as Record<string, unknown>;
        const loop = drainPayload["loop"] as Record<string, unknown>;
        expect(loop).toMatchObject({
          workSucceeded: true,
          jobsRun: 1,
          jobsFailed: 0
        });

        // Ingest workflow evidence with a no-mistakes complete entry so the
        // intent generator finds an accepted verification evidence type.
        const fixtureRoot = makeTempDir("momentum-smoke-m5-rollup-fixture-");
        const runId = "smoke-m5-rollup-run-1";
        const runDir = path.join(fixtureRoot, ".agent-workflows", runId);
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(
          path.join(runDir, "plan.json"),
          JSON.stringify(
            {
              runId,
              schemaVersion: 1,
              mode: "execute-ready",
              profile: "momentum-m5-smoke",
              objective: "NGX-294 smoke fixture for project rollup",
              resolvedScope: {
                issues: ["NGX-294"],
                source: "explicit",
                status: "resolved"
              }
            },
            null,
            2
          )
        );
        const ledger = [
          {
            runId,
            step: "implementation",
            status: "complete",
            ts: "2026-05-18T12:20:00Z"
          },
          {
            runId,
            step: "no-mistakes",
            status: "complete",
            ts: "2026-05-18T12:25:00Z"
          }
        ];
        fs.writeFileSync(
          path.join(runDir, "ledger.jsonl"),
          `${ledger.map((line) => JSON.stringify(line)).join("\n")}\n`
        );

        const ingest = runCliBinary([
          "evidence",
          "ingest",
          "--path",
          runDir,
          "--goal",
          goalId,
          "--source-item",
          sourceItemId,
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(ingest.code, `evidence ingest stderr: ${ingest.stderr}`).toBe(0);

        // Link the SourceItem to the completed Goal — this triggers intent
        // creation (completed goal + non-terminal source + no_mistakes_complete).
        const link = runCliBinary([
          "source",
          "link",
          sourceItemId,
          "--goal",
          goalId,
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(link.code, `source link stderr: ${link.stderr}`).toBe(0);
        const linkPayload = JSON.parse(link.stdout) as Record<string, unknown>;
        const linkCounts = linkPayload["counts"] as Record<string, number>;
        expect(linkCounts).toMatchObject({
          intentsCreated: 1,
          intentsReplayed: 0,
          intentWarnings: 0
        });

        const project = runCliBinary([
          "project",
          "status",
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(project.code, `project status stderr: ${project.stderr}`).toBe(0);
        const projectPayload = JSON.parse(project.stdout) as Record<
          string,
          unknown
        >;
        expect(projectPayload).toMatchObject({
          ok: true,
          command: "project status",
          dataDir
        });

        const counts = projectPayload["counts"] as Record<
          string,
          Record<string, unknown>
        >;
        expect(counts.sourceItems).toMatchObject({
          total: 1,
          linkedToGoal: 1,
          unlinked: 0
        });
        const sourceByStatus = counts.sourceItems?.["byStatus"] as Record<
          string,
          number
        >;
        expect(sourceByStatus["In Progress"]).toBe(1);
        expect(counts.goals).toMatchObject({
          total: 1,
          needingManualRecovery: 0
        });
        const goalByState = counts.goals?.["byState"] as Record<string, number>;
        expect(goalByState["completed"]).toBe(1);
        const evidenceCounts = counts.evidence as Record<string, number>;
        expect(evidenceCounts.totalRecords).toBeGreaterThanOrEqual(1);
        expect(evidenceCounts.goalsWithEvidence).toBe(1);
        expect(evidenceCounts.goalsWithoutEvidence).toBe(0);

        const mismatchCounts = counts.mismatches as Record<string, number>;
        expect(mismatchCounts.goal_done_source_not_done).toBe(1);
        expect(mismatchCounts.source_done_goal_not_terminal).toBe(0);
        expect(mismatchCounts.evidence_missing_after_completion).toBe(0);
        expect(mismatchCounts.manual_recovery_required).toBe(0);
        expect(counts["pendingUpdateIntents"]).toBe(1);
        expect(counts["staleUpdateIntents"]).toBe(0);

        // `project status` source-item summaries use `sourceItemId`, not the
        // bare `id` shape that `source list`/`source get` return — verify the
        // local id ties back to the SourceItem created by reconciliation.
        const rolledItems = projectPayload["sourceItems"] as Array<
          Record<string, unknown>
        >;
        expect(rolledItems).toHaveLength(1);
        expect(rolledItems[0]).toMatchObject({
          sourceItemId,
          adapterKind: "linear",
          externalKey: "NGX-294",
          status: "In Progress",
          goalId,
          goalState: "completed"
        });

        const mismatches = projectPayload["mismatches"] as Array<
          Record<string, unknown>
        >;
        expect(mismatches).toHaveLength(1);
        expect(mismatches[0]).toMatchObject({
          kind: "goal_done_source_not_done",
          sourceItemId,
          externalKey: "NGX-294",
          goalId,
          goalState: "completed",
          sourceStatus: "In Progress"
        });
        expect(projectPayload["totalMismatchCount"]).toBe(1);
        expect(projectPayload["truncatedMismatches"]).toBe(false);

        const pendingIntents = projectPayload["pendingUpdateIntents"] as Array<
          Record<string, unknown>
        >;
        expect(pendingIntents).toHaveLength(1);
        expect(pendingIntents[0]).toMatchObject({
          adapterKind: "linear",
          intentType: "source_satisfied",
          goalId,
          sourceItemId,
          targetExternalId: "issue-smoke-ngx-294-rollup",
          stale: false
        });
        expect(typeof pendingIntents[0]?.["intentId"]).toBe("string");
        expect(typeof pendingIntents[0]?.["ageMs"]).toBe("number");
        expect(projectPayload["totalPendingUpdateIntentCount"]).toBe(1);
        expect(projectPayload["truncatedPendingUpdateIntents"]).toBe(false);
        expect(projectPayload["reconciliationWarnings"]).toEqual([]);

        // `pickNextAction` prioritizes pending intents above the
        // `goal_done_source_not_done` mismatch, so the operator-facing
        // hint should steer to the intent review path here.
        const nextAction = projectPayload["nextAction"] as Record<
          string,
          unknown
        >;
        expect(nextAction["kind"]).toBe("review_pending_intents");
        expect(typeof nextAction["message"]).toBe("string");
        const nextActionDetail = nextAction["detail"] as Record<string, unknown>;
        expect(nextActionDetail["total"]).toBe(1);
        expect(nextActionDetail["stale"]).toBe(0);
        const intentIds = nextActionDetail["intentIds"] as string[];
        expect(Array.isArray(intentIds)).toBe(true);
        expect(intentIds).toHaveLength(1);
      } finally {
        await mock.close();
      }
    },
    180_000
  );
});

type LinearMockCommentCreateBehavior =
  | { kind: "success" }
  | { kind: "graphql_error"; message: string };

type LinearMockIssueRefreshBehavior =
  | { kind: "success" }
  | { kind: "graphql_error"; message: string };

type LinearExternalApplyMockServer = {
  endpoint: string;
  commentsCreated: Array<{ issueId: string; body: string }>;
  issueUpdates: Array<{ issueId: string; stateId: string }>;
  requestCounts: Record<string, number>;
  setIssueState: (issueId: string, state: { id: string; name: string }) => void;
  setCommentCreateBehavior: (behavior: LinearMockCommentCreateBehavior) => void;
  setIssueRefreshBehavior: (behavior: LinearMockIssueRefreshBehavior) => void;
  setCommentCreateDelayMs: (ms: number) => void;
  close: () => Promise<void>;
};

type LinearExternalApplyMockIssue = {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  url: string;
  updatedAt: string;
  priority?: number;
  state: { id: string; name: string };
  team?: { id: string };
  project?: { id: string; name: string; url: string };
  projectMilestone?: { id: string; name: string };
  labels?: { nodes: Array<{ id: string; name: string }> };
  assignee?: { id: string; name: string; email: string } | null;
  comments?: Array<{ id: string; body: string; url: string | null }>;
};

async function startLinearExternalApplyMockServer(
  issues: LinearExternalApplyMockIssue[]
): Promise<LinearExternalApplyMockServer> {
  type IssueRecord = LinearExternalApplyMockIssue & {
    comments: Array<{ id: string; body: string; url: string | null }>;
  };
  const issueById = new Map<string, IssueRecord>();
  for (const issue of issues) {
    issueById.set(issue.id, {
      ...issue,
      comments: [...(issue.comments ?? [])]
    });
  }
  const commentsCreated: Array<{ issueId: string; body: string }> = [];
  const issueUpdates: Array<{ issueId: string; stateId: string }> = [];
  const requestCounts: Record<string, number> = {};
  let commentCounter = 0;
  let commentCreateBehavior: LinearMockCommentCreateBehavior = {
    kind: "success"
  };
  let issueRefreshBehavior: LinearMockIssueRefreshBehavior = {
    kind: "success"
  };
  let commentCreateDelayMs = 0;

  function tallyOperation(query: string): void {
    const match = /(query|mutation)\s+(\w+)/.exec(query);
    const name = match ? match[2]! : "Unknown";
    requestCounts[name] = (requestCounts[name] ?? 0) + 1;
  }

  function serializeIssueForSourceListing(record: IssueRecord): unknown {
    return {
      id: record.id,
      identifier: record.identifier,
      title: record.title,
      description: record.description ?? null,
      url: record.url,
      updatedAt: record.updatedAt,
      priority: record.priority ?? 0,
      state: record.state,
      project: record.project ?? null,
      projectMilestone: record.projectMilestone ?? null,
      labels: record.labels ?? { nodes: [] },
      assignee: record.assignee ?? null
    };
  }

  function serializeIssueWithComments(record: IssueRecord): unknown {
    return {
      id: record.id,
      identifier: record.identifier,
      title: record.title,
      description: record.description ?? null,
      url: record.url,
      updatedAt: record.updatedAt,
      priority: record.priority ?? 0,
      state: record.state,
      team: record.team ?? { id: `team-${record.id}` },
      project: record.project ?? null,
      projectMilestone: record.projectMilestone ?? null,
      labels: record.labels ?? { nodes: [] },
      assignee: record.assignee ?? null,
      comments: {
        nodes: record.comments,
        pageInfo: { hasNextPage: false, endCursor: null }
      }
    };
  }

  function handle(body: {
    query?: string;
    variables?: Record<string, unknown>;
  }): { status: number; body: unknown } {
    const query = typeof body.query === "string" ? body.query : "";
    const variables = (body.variables ?? {}) as Record<string, unknown>;
    tallyOperation(query);

    if (query.includes("MomentumLinearIssues")) {
      const nodes = Array.from(issueById.values()).map(
        serializeIssueForSourceListing
      );
      return {
        status: 200,
        body: {
          data: {
            issues: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes
            }
          }
        }
      };
    }

    if (query.includes("MomentumIssueRefresh")) {
      if (issueRefreshBehavior.kind === "graphql_error") {
        return {
          status: 200,
          body: {
            errors: [{ message: issueRefreshBehavior.message }]
          }
        };
      }
      const id = typeof variables["id"] === "string" ? (variables["id"] as string) : "";
      const record = issueById.get(id);
      if (!record) {
        return { status: 200, body: { data: { issue: null } } };
      }
      return {
        status: 200,
        body: { data: { issue: serializeIssueWithComments(record) } }
      };
    }

    if (query.includes("MomentumExternalUpdateIssueLookup")) {
      const id = typeof variables["id"] === "string" ? (variables["id"] as string) : "";
      const record = issueById.get(id);
      if (!record) {
        return { status: 200, body: { data: { issue: null } } };
      }
      return {
        status: 200,
        body: { data: { issue: serializeIssueWithComments(record) } }
      };
    }

    if (
      query.includes("MomentumExternalUpdateIssueCommentsPage") ||
      query.includes("MomentumIssueRefreshCommentsPage")
    ) {
      return {
        status: 200,
        body: {
          data: {
            issue: {
              comments: {
                nodes: [],
                pageInfo: { hasNextPage: false, endCursor: null }
              }
            }
          }
        }
      };
    }

    if (query.includes("MomentumExternalUpdateCommentCreate")) {
      const input = (variables["input"] ?? {}) as {
        issueId?: string;
        body?: string;
      };
      const issueId = input.issueId ?? "";
      const commentBody = input.body ?? "";
      const record = issueById.get(issueId);
      if (!record) {
        return {
          status: 200,
          body: { data: { commentCreate: { success: false, comment: null } } }
        };
      }
      if (commentCreateBehavior.kind === "graphql_error") {
        return {
          status: 200,
          body: {
            errors: [{ message: commentCreateBehavior.message }]
          }
        };
      }
      commentCounter += 1;
      const commentId = `mock-comment-${commentCounter}`;
      const commentUrl = `${record.url}#comment-${commentCounter}`;
      record.comments.push({ id: commentId, body: commentBody, url: commentUrl });
      commentsCreated.push({ issueId, body: commentBody });
      return {
        status: 200,
        body: {
          data: {
            commentCreate: {
              success: true,
              comment: { id: commentId, url: commentUrl }
            }
          }
        }
      };
    }

    if (query.includes("MomentumExternalUpdateIssueStateUpdate")) {
      const id = typeof variables["id"] === "string" ? (variables["id"] as string) : "";
      const input = (variables["input"] ?? {}) as { stateId?: string };
      const stateId = input.stateId ?? "";
      const record = issueById.get(id);
      if (!record) {
        return {
          status: 200,
          body: { data: { issueUpdate: { success: false, issue: null } } }
        };
      }
      record.state = { id: stateId, name: record.state.name };
      issueUpdates.push({ issueId: id, stateId });
      return {
        status: 200,
        body: {
          data: {
            issueUpdate: {
              success: true,
              issue: { id: record.id, state: record.state }
            }
          }
        }
      };
    }

    if (query.includes("MomentumExternalUpdateWorkflowStateLookup")) {
      return {
        status: 200,
        body: { data: { workflowStates: { nodes: [] } } }
      };
    }

    return {
      status: 200,
      body: { errors: [{ message: `unknown query: ${query.slice(0, 80)}` }] }
    };
  }

  const server = http.createServer((req, res) => {
    const hostHeader = req.headers["host"] ?? "";
    if (typeof hostHeader === "string" && /linear\.app/i.test(hostHeader)) {
      res.statusCode = 599;
      res.end(
        JSON.stringify({
          errors: [
            {
              message:
                "smoke mock refused: real Linear host detected in Host header"
            }
          ]
        })
      );
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      let parsed: { query?: string; variables?: Record<string, unknown> };
      try {
        parsed = JSON.parse(raw) as {
          query?: string;
          variables?: Record<string, unknown>;
        };
      } catch {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ errors: [{ message: "invalid JSON body" }] }));
        return;
      }
      const result = handle(parsed);
      const isCommentCreate =
        typeof parsed.query === "string" &&
        parsed.query.includes("MomentumExternalUpdateCommentCreate");
      const writeResponse = (): void => {
        res.statusCode = result.status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result.body));
      };
      if (isCommentCreate && commentCreateDelayMs > 0) {
        setTimeout(writeResponse, commentCreateDelayMs);
        return;
      }
      writeResponse();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const endpoint = `http://127.0.0.1:${address.port}/graphql`;
  return {
    endpoint,
    commentsCreated,
    issueUpdates,
    requestCounts,
    setIssueState(issueId, state) {
      const record = issueById.get(issueId);
      if (record) record.state = state;
    },
    setCommentCreateBehavior(behavior) {
      commentCreateBehavior = behavior;
    },
    setIssueRefreshBehavior(behavior) {
      issueRefreshBehavior = behavior;
    },
    setCommentCreateDelayMs(ms) {
      commentCreateDelayMs = Math.max(0, ms);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      })
  };
}

describe("Milestone 6 external apply end-to-end smoke (NGX-301)", () => {
  it(
    "applies a pending source_satisfied intent through the mock Linear endpoint with deterministic idempotency and successful post-apply reconcile",
    async () => {
      const dataDir = makeTempDir("momentum-smoke-m6-apply-data-");
      const repo = initDisposableRepo();
      fs.writeFileSync(
        path.join(repo, "MOMENTUM.md"),
        [
          "---",
          "intent_apply_policy: external_apply_allowed",
          "---",
          "",
          "Smoke MOMENTUM.md for the M6 external apply path.",
          ""
        ].join("\n"),
        "utf-8"
      );
      runGit(repo, ["add", "MOMENTUM.md"]);
      runGit(repo, ["commit", "-m", "add MOMENTUM.md", "--quiet"]);

      const goalFile = path.join(dataDir, "goal.md");
      fs.writeFileSync(goalFile, SMOKE_GOAL_SPEC, "utf-8");

      const issue: LinearExternalApplyMockIssue = {
        id: "issue-smoke-ngx-301-apply",
        identifier: "NGX-301",
        title: "M6-06 External apply safety smoke and failure matrix",
        description: "Smoke fixture for the M6 external apply happy path.",
        url: "https://linear.app/ngxcalvin/issue/NGX-301",
        updatedAt: "2026-05-21T08:00:00.000Z",
        priority: 0,
        state: { id: "state-in-progress", name: "In Progress" },
        team: { id: "team-ngx" },
        project: {
          id: "project-momentum",
          name: "Momentum",
          url: "https://linear.app/ngxcalvin/project/momentum"
        },
        projectMilestone: {
          id: "milestone-m6",
          name: "Milestone 6: Policy-Gated External Apply"
        },
        labels: { nodes: [] },
        assignee: null,
        comments: []
      };
      const mock = await startLinearExternalApplyMockServer([issue]);
      try {
        const reconcile = await runCliBinaryAsync(
          [
            "source",
            "reconcile",
            "linear",
            "--linear-endpoint",
            mock.endpoint,
            "--data-dir",
            dataDir,
            "--json"
          ],
          { env: { LINEAR_API_KEY: "lin_api_smoke_fixture_key" } }
        );
        expect(
          reconcile.code,
          `source reconcile linear stderr: ${reconcile.stderr}`
        ).toBe(0);

        const sourceList = runCliBinary([
          "source",
          "list",
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(sourceList.code, `source list stderr: ${sourceList.stderr}`).toBe(0);
        const sourceItems = (
          JSON.parse(sourceList.stdout) as { items: Array<{ id: string }> }
        ).items;
        expect(sourceItems).toHaveLength(1);
        const sourceItemId = sourceItems[0]!.id;

        const goalStart = runCliBinary([
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
        expect(goalStart.code, `goal start stderr: ${goalStart.stderr}`).toBe(0);
        const goalId = (
          JSON.parse(goalStart.stdout) as { goalId: string }
        ).goalId;

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

        const fixtureRoot = makeTempDir("momentum-smoke-m6-apply-fixture-");
        const intentRunId = "smoke-m6-apply-run-1";
        const runDir = path.join(fixtureRoot, ".agent-workflows", intentRunId);
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(
          path.join(runDir, "plan.json"),
          JSON.stringify(
            {
              runId: intentRunId,
              schemaVersion: 1,
              mode: "execute-ready",
              profile: "momentum-m6-smoke",
              objective: "NGX-301 smoke fixture for external apply",
              resolvedScope: {
                issues: ["NGX-301"],
                source: "explicit",
                status: "resolved"
              }
            },
            null,
            2
          )
        );
        const ledger = [
          {
            runId: intentRunId,
            step: "implementation",
            status: "complete",
            ts: "2026-05-21T08:20:00Z"
          },
          {
            runId: intentRunId,
            step: "no-mistakes",
            status: "complete",
            ts: "2026-05-21T08:25:00Z"
          }
        ];
        fs.writeFileSync(
          path.join(runDir, "ledger.jsonl"),
          `${ledger.map((line) => JSON.stringify(line)).join("\n")}\n`
        );

        const ingest = runCliBinary([
          "evidence",
          "ingest",
          "--path",
          runDir,
          "--goal",
          goalId,
          "--source-item",
          sourceItemId,
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(ingest.code, `evidence ingest stderr: ${ingest.stderr}`).toBe(0);

        const link = runCliBinary([
          "source",
          "link",
          sourceItemId,
          "--goal",
          goalId,
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(link.code, `source link stderr: ${link.stderr}`).toBe(0);
        const linkCounts = (
          JSON.parse(link.stdout) as {
            counts: { intentsCreated: number };
          }
        ).counts;
        expect(linkCounts.intentsCreated).toBe(1);

        const intentList = runCliBinary([
          "intent",
          "list",
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(intentList.code).toBe(0);
        const intentListPayload = JSON.parse(intentList.stdout) as {
          intents: Array<{ id: string; status: string }>;
        };
        expect(intentListPayload.intents).toHaveLength(1);
        const intentId = intentListPayload.intents[0]!.id;
        expect(intentListPayload.intents[0]!.status).toBe("pending");

        const externalApply = await runCliBinaryAsync(
          [
            "intent",
            "apply",
            intentId,
            "--reason",
            "smoke happy-path external apply",
            "--external-apply",
            "--repo",
            repo,
            "--data-dir",
            dataDir,
            "--json"
          ],
          {
            env: {
              LINEAR_API_KEY: "lin_api_smoke_fixture_key",
              MOMENTUM_LINEAR_EXTERNAL_UPDATE_ENDPOINT: mock.endpoint,
              MOMENTUM_LINEAR_REFRESH_ENDPOINT: mock.endpoint
            }
          }
        );
        expect(
          externalApply.code,
          `external apply stderr: ${externalApply.stderr}`
        ).toBe(0);
        const externalApplyPayload = JSON.parse(externalApply.stdout) as {
          ok: boolean;
          intent: { id: string; status: string; decisionReason: string };
          applyPolicy: {
            effective: string;
            source: string;
            externalApplyRequested: boolean;
            externalApplyPerformed: boolean;
          };
          externalApply: {
            adapterKind: string;
            target: { externalId: string; externalKey: string };
            allowStatusMutation: boolean;
            auditId: string | null;
            mutationKind: string;
            external: {
              alreadyApplied: boolean;
              commentId: string;
              commentUrl: string;
              idempotencyMarker: string;
              statusTransitioned: boolean;
            };
            reconcile: { status: string; warning: string | null };
          };
        };
        expect(externalApplyPayload.ok).toBe(true);
        expect(externalApplyPayload.intent.status).toBe("applied");
        expect(externalApplyPayload.intent.decisionReason).toBe(
          "external_apply: smoke happy-path external apply"
        );
        expect(externalApplyPayload.applyPolicy).toMatchObject({
          effective: "external_apply_allowed",
          source: "momentum_policy",
          externalApplyRequested: true,
          externalApplyPerformed: true
        });
        const externalSummary = externalApplyPayload.externalApply;
        expect(externalSummary.adapterKind).toBe("linear");
        expect(externalSummary.allowStatusMutation).toBe(false);
        expect(externalSummary.mutationKind).toBe("comment");
        expect(externalSummary.target.externalId).toBe(
          "issue-smoke-ngx-301-apply"
        );
        expect(externalSummary.target.externalKey).toBe("NGX-301");
        expect(typeof externalSummary.auditId).toBe("string");
        expect(externalSummary.external.alreadyApplied).toBe(false);
        expect(externalSummary.external.statusTransitioned).toBe(false);
        expect(externalSummary.external.commentId).toBe("mock-comment-1");
        const marker = externalSummary.external.idempotencyMarker;
        expect(marker).toMatch(
          new RegExp(`^momentum-intent:linear:${intentId}:[0-9a-f]{16}$`)
        );
        expect(externalSummary.reconcile.status).toBe("success");
        expect(externalSummary.reconcile.warning).toBeNull();

        // The mock recorded exactly one commentCreate and zero issueUpdate
        // calls (comment-only mode); request counts also include the
        // post-apply refresh fetch on the same endpoint.
        expect(mock.commentsCreated).toHaveLength(1);
        expect(mock.commentsCreated[0]!.issueId).toBe(
          "issue-smoke-ngx-301-apply"
        );
        expect(mock.commentsCreated[0]!.body).toContain(`idempotency: ${marker}`);
        expect(mock.issueUpdates).toHaveLength(0);
        expect(mock.requestCounts["MomentumExternalUpdateCommentCreate"]).toBe(1);
        expect(
          mock.requestCounts["MomentumExternalUpdateIssueStateUpdate"] ?? 0
        ).toBe(0);
        expect(mock.requestCounts["MomentumIssueRefresh"]).toBe(1);

        // `intent get` surfaces the same audit summary with applyState=idle,
        // totalAttempts=1, succeeded=1, and the audit's idempotencyMarker
        // matches the value returned from the apply.
        const intentGet = runCliBinary([
          "intent",
          "get",
          intentId,
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(intentGet.code).toBe(0);
        const intentGetPayload = JSON.parse(intentGet.stdout) as {
          intent: { status: string };
          externalApply: {
            applyState: string;
            totalAttempts: number;
            counts: {
              claimed: number;
              succeeded: number;
              failed: number;
              blocked: number;
              audit_incomplete: number;
            };
            latestAttempt: {
              lifecycleState: string;
              resultStatus: string;
              resultCode: string;
              idempotencyMarker: string;
              externalRefs: {
                commentId: string;
                commentUrl: string;
                stateTransitionId: string | null;
              };
              reconcile: { status: string; warning: string | null };
            } | null;
          };
        };
        expect(intentGetPayload.intent.status).toBe("applied");
        expect(intentGetPayload.externalApply.applyState).toBe("idle");
        expect(intentGetPayload.externalApply.totalAttempts).toBe(1);
        expect(intentGetPayload.externalApply.counts).toMatchObject({
          claimed: 0,
          succeeded: 1,
          failed: 0,
          blocked: 0,
          audit_incomplete: 0
        });
        const latest = intentGetPayload.externalApply.latestAttempt;
        expect(latest).not.toBeNull();
        expect(latest!.lifecycleState).toBe("succeeded");
        expect(latest!.resultStatus).toBe("succeeded");
        expect(latest!.resultCode).toBe("applied");
        expect(latest!.idempotencyMarker).toBe(marker);
        expect(latest!.externalRefs.commentId).toBe("mock-comment-1");
        expect(latest!.externalRefs.stateTransitionId).toBeNull();
        expect(latest!.reconcile.status).toBe("success");
        expect(latest!.reconcile.warning).toBeNull();

        // Replaying `intent apply --external-apply` against a now-applied
        // intent refuses with intent_already_terminal and never opens a
        // new commentCreate against the mock.
        const replay = await runCliBinaryAsync(
          [
            "intent",
            "apply",
            intentId,
            "--reason",
            "smoke replay attempt",
            "--external-apply",
            "--repo",
            repo,
            "--data-dir",
            dataDir,
            "--json"
          ],
          {
            env: {
              LINEAR_API_KEY: "lin_api_smoke_fixture_key",
              MOMENTUM_LINEAR_EXTERNAL_UPDATE_ENDPOINT: mock.endpoint,
              MOMENTUM_LINEAR_REFRESH_ENDPOINT: mock.endpoint
            }
          }
        );
        expect(replay.code).toBe(1);
        expect(replay.stdout).toBe("");
        const replayPayload = JSON.parse(replay.stderr) as {
          ok: boolean;
          code: string;
          currentStatus: string;
        };
        expect(replayPayload).toMatchObject({
          ok: false,
          code: "intent_already_terminal",
          currentStatus: "applied"
        });
        expect(mock.commentsCreated).toHaveLength(1);
      } finally {
        await mock.close();
      }
    },
    180_000
  );

  it(
    "refuses with policy_denied when MOMENTUM.md does not opt into external apply and leaves the intent pending",
    async () => {
      const fixture = await establishM6ExternalApplyFixture({
        momentumPolicy: "create_intents_only"
      });
      const { repo, dataDir, intentId, mock } = fixture;
      try {
        const reconcileCallsBefore =
          mock.requestCounts["MomentumLinearIssues"] ?? 0;
        const externalApply = await runCliBinaryAsync(
          [
            "intent",
            "apply",
            intentId,
            "--reason",
            "smoke policy denied refusal",
            "--external-apply",
            "--repo",
            repo,
            "--data-dir",
            dataDir,
            "--json"
          ],
          {
            env: {
              LINEAR_API_KEY: "lin_api_smoke_fixture_key",
              MOMENTUM_LINEAR_EXTERNAL_UPDATE_ENDPOINT: mock.endpoint,
              MOMENTUM_LINEAR_REFRESH_ENDPOINT: mock.endpoint
            }
          }
        );
        expect(externalApply.code).toBe(1);
        expect(externalApply.stdout).toBe("");
        const refusal = JSON.parse(externalApply.stderr) as {
          ok: boolean;
          command: string;
          code: string;
          intentId: string;
          applyPolicy: {
            effective: string;
            source: string;
            externalApplyRequested: boolean;
            externalApplyPerformed: boolean;
          };
        };
        expect(refusal).toMatchObject({
          ok: false,
          command: "intent apply",
          code: "policy_denied",
          intentId
        });
        expect(refusal.applyPolicy).toMatchObject({
          effective: "create_intents_only",
          source: "momentum_policy",
          externalApplyRequested: true,
          externalApplyPerformed: false
        });

        // No external write or post-apply refresh touches the mock.
        expect(mock.commentsCreated).toHaveLength(0);
        expect(mock.issueUpdates).toHaveLength(0);
        expect(
          mock.requestCounts["MomentumExternalUpdateCommentCreate"] ?? 0
        ).toBe(0);
        expect(
          mock.requestCounts["MomentumExternalUpdateIssueStateUpdate"] ?? 0
        ).toBe(0);
        expect(
          mock.requestCounts["MomentumExternalUpdateIssueLookup"] ?? 0
        ).toBe(0);
        expect(mock.requestCounts["MomentumIssueRefresh"] ?? 0).toBe(0);
        // Source reconcile counts are unchanged by the refused apply.
        expect(mock.requestCounts["MomentumLinearIssues"] ?? 0).toBe(
          reconcileCallsBefore
        );

        const stillPending = runCliBinary([
          "intent",
          "get",
          intentId,
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(stillPending.code).toBe(0);
        const stillPendingPayload = JSON.parse(stillPending.stdout) as {
          intent: { status: string };
          externalApply: {
            applyState: string;
            totalAttempts: number;
            latestAttempt: unknown;
          };
        };
        expect(stillPendingPayload.intent.status).toBe("pending");
        expect(stillPendingPayload.externalApply.applyState).toBe("idle");
        expect(stillPendingPayload.externalApply.totalAttempts).toBe(0);
        expect(stillPendingPayload.externalApply.latestAttempt).toBeNull();
      } finally {
        await fixture.close();
      }
    },
    180_000
  );

  it(
    "refuses with auth_unavailable when LINEAR_API_KEY is missing and leaves the intent pending",
    async () => {
      const fixture = await establishM6ExternalApplyFixture({
        momentumPolicy: "external_apply_allowed"
      });
      const { repo, dataDir, intentId, mock } = fixture;
      try {
        const reconcileCallsBefore =
          mock.requestCounts["MomentumLinearIssues"] ?? 0;
        const externalApply = await runCliBinaryAsync(
          [
            "intent",
            "apply",
            intentId,
            "--reason",
            "smoke auth unavailable refusal",
            "--external-apply",
            "--repo",
            repo,
            "--data-dir",
            dataDir,
            "--json"
          ],
          {
            env: {
              LINEAR_API_KEY: "",
              MOMENTUM_LINEAR_EXTERNAL_UPDATE_ENDPOINT: mock.endpoint,
              MOMENTUM_LINEAR_REFRESH_ENDPOINT: mock.endpoint
            }
          }
        );
        expect(externalApply.code).toBe(1);
        expect(externalApply.stdout).toBe("");
        const refusal = JSON.parse(externalApply.stderr) as {
          ok: boolean;
          command: string;
          code: string;
          intentId: string;
          message: string;
          applyPolicy: {
            effective: string;
            source: string;
            externalApplyRequested: boolean;
            externalApplyPerformed: boolean;
          };
        };
        expect(refusal).toMatchObject({
          ok: false,
          command: "intent apply",
          code: "auth_unavailable",
          intentId
        });
        expect(refusal.message).toContain("LINEAR_API_KEY");
        expect(refusal.applyPolicy).toMatchObject({
          effective: "external_apply_allowed",
          source: "momentum_policy",
          externalApplyRequested: true,
          externalApplyPerformed: false
        });

        // Policy resolved but auth failed before any adapter call.
        expect(mock.commentsCreated).toHaveLength(0);
        expect(mock.issueUpdates).toHaveLength(0);
        expect(
          mock.requestCounts["MomentumExternalUpdateCommentCreate"] ?? 0
        ).toBe(0);
        expect(
          mock.requestCounts["MomentumExternalUpdateIssueStateUpdate"] ?? 0
        ).toBe(0);
        expect(
          mock.requestCounts["MomentumExternalUpdateIssueLookup"] ?? 0
        ).toBe(0);
        expect(mock.requestCounts["MomentumIssueRefresh"] ?? 0).toBe(0);
        expect(mock.requestCounts["MomentumLinearIssues"] ?? 0).toBe(
          reconcileCallsBefore
        );

        const stillPending = runCliBinary([
          "intent",
          "get",
          intentId,
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(stillPending.code).toBe(0);
        const stillPendingPayload = JSON.parse(stillPending.stdout) as {
          intent: { status: string };
          externalApply: {
            applyState: string;
            totalAttempts: number;
            latestAttempt: unknown;
          };
        };
        expect(stillPendingPayload.intent.status).toBe("pending");
        expect(stillPendingPayload.externalApply.applyState).toBe("idle");
        expect(stillPendingPayload.externalApply.totalAttempts).toBe(0);
        expect(stillPendingPayload.externalApply.latestAttempt).toBeNull();
      } finally {
        await fixture.close();
      }
    },
    180_000
  );

  it(
    "refuses with write_rejected when the external write fails, finalizes the audit as failed, and leaves the intent pending for retry",
    async () => {
      const fixture = await establishM6ExternalApplyFixture({
        momentumPolicy: "external_apply_allowed"
      });
      const { repo, dataDir, intentId, mock } = fixture;
      try {
        const reconcileCallsBefore =
          mock.requestCounts["MomentumLinearIssues"] ?? 0;
        mock.setCommentCreateBehavior({
          kind: "graphql_error",
          message: "smoke mock injected commentCreate failure"
        });

        const externalApply = await runCliBinaryAsync(
          [
            "intent",
            "apply",
            intentId,
            "--reason",
            "smoke adapter failure",
            "--external-apply",
            "--repo",
            repo,
            "--data-dir",
            dataDir,
            "--json"
          ],
          {
            env: {
              LINEAR_API_KEY: "lin_api_smoke_fixture_key",
              MOMENTUM_LINEAR_EXTERNAL_UPDATE_ENDPOINT: mock.endpoint,
              MOMENTUM_LINEAR_REFRESH_ENDPOINT: mock.endpoint
            }
          }
        );
        expect(externalApply.code).toBe(1);
        expect(externalApply.stdout).toBe("");
        const refusal = JSON.parse(externalApply.stderr) as {
          ok: boolean;
          command: string;
          code: string;
          intentId: string;
          message: string;
          applyPolicy: {
            effective: string;
            source: string;
            externalApplyRequested: boolean;
            externalApplyPerformed: boolean;
          };
          externalApply: {
            adapterKind: string;
            allowStatusMutation: boolean;
            mutationKind: string | null;
            auditId: string | null;
            external: unknown;
            reconcile: { status: string | null; warning: string | null };
          };
        };
        expect(refusal).toMatchObject({
          ok: false,
          command: "intent apply",
          code: "write_rejected",
          intentId
        });
        expect(refusal.message).toContain(
          "smoke mock injected commentCreate failure"
        );
        expect(refusal.applyPolicy).toMatchObject({
          effective: "external_apply_allowed",
          source: "momentum_policy",
          externalApplyRequested: true,
          externalApplyPerformed: false
        });
        expect(refusal.externalApply.adapterKind).toBe("linear");
        expect(refusal.externalApply.mutationKind).toBe("comment");
        expect(refusal.externalApply.allowStatusMutation).toBe(false);
        expect(typeof refusal.externalApply.auditId).toBe("string");
        // No comment was successfully created by the mock — but the mutation
        // attempt itself must have reached the mock, proving the adapter
        // actually performed an external request before being rejected.
        expect(mock.commentsCreated).toHaveLength(0);
        expect(mock.issueUpdates).toHaveLength(0);
        expect(
          mock.requestCounts["MomentumExternalUpdateCommentCreate"] ?? 0
        ).toBe(1);
        expect(
          mock.requestCounts["MomentumExternalUpdateIssueLookup"] ?? 0
        ).toBeGreaterThanOrEqual(1);
        // No post-apply refresh because the apply failed before it.
        expect(mock.requestCounts["MomentumIssueRefresh"] ?? 0).toBe(0);
        // Source reconcile counts are unchanged by the refused apply.
        expect(mock.requestCounts["MomentumLinearIssues"] ?? 0).toBe(
          reconcileCallsBefore
        );

        const intentGet = runCliBinary([
          "intent",
          "get",
          intentId,
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(intentGet.code).toBe(0);
        const intentGetPayload = JSON.parse(intentGet.stdout) as {
          intent: { status: string };
          externalApply: {
            applyState: string;
            totalAttempts: number;
            counts: {
              claimed: number;
              succeeded: number;
              failed: number;
              blocked: number;
              audit_incomplete: number;
            };
            latestAttempt: {
              lifecycleState: string;
              resultStatus: string;
              resultCode: string;
              externalRefs: {
                commentId: string | null;
                commentUrl: string | null;
                stateTransitionId: string | null;
              };
            } | null;
          };
        };
        // Intent itself remains pending — only the audit attempt is marked
        // failed, leaving the intent eligible for a later retry against a
        // recovered Linear endpoint.
        expect(intentGetPayload.intent.status).toBe("pending");
        expect(intentGetPayload.externalApply.applyState).toBe("idle");
        expect(intentGetPayload.externalApply.totalAttempts).toBe(1);
        expect(intentGetPayload.externalApply.counts).toMatchObject({
          claimed: 0,
          succeeded: 0,
          failed: 1,
          blocked: 0,
          audit_incomplete: 0
        });
        const latest = intentGetPayload.externalApply.latestAttempt;
        expect(latest).not.toBeNull();
        expect(latest!.lifecycleState).toBe("failed");
        expect(latest!.resultStatus).toBe("failed");
        expect(latest!.resultCode).toBe("write_rejected");
        expect(latest!.externalRefs.commentId).toBeNull();
        expect(latest!.externalRefs.stateTransitionId).toBeNull();
      } finally {
        await fixture.close();
      }
    },
    180_000
  );

  it(
    "still marks the intent applied when post-apply refresh fails, with reconcile.status=refresh_failed and a warning recorded on the audit",
    async () => {
      const fixture = await establishM6ExternalApplyFixture({
        momentumPolicy: "external_apply_allowed"
      });
      const { repo, dataDir, intentId, mock } = fixture;
      try {
        const reconcileCallsBefore =
          mock.requestCounts["MomentumLinearIssues"] ?? 0;
        mock.setIssueRefreshBehavior({
          kind: "graphql_error",
          message: "smoke mock injected IssueRefresh failure"
        });

        const externalApply = await runCliBinaryAsync(
          [
            "intent",
            "apply",
            intentId,
            "--reason",
            "smoke reconcile refresh failed",
            "--external-apply",
            "--repo",
            repo,
            "--data-dir",
            dataDir,
            "--json"
          ],
          {
            env: {
              LINEAR_API_KEY: "lin_api_smoke_fixture_key",
              MOMENTUM_LINEAR_EXTERNAL_UPDATE_ENDPOINT: mock.endpoint,
              MOMENTUM_LINEAR_REFRESH_ENDPOINT: mock.endpoint
            }
          }
        );
        expect(
          externalApply.code,
          `external apply stderr: ${externalApply.stderr}`
        ).toBe(0);
        const payload = JSON.parse(externalApply.stdout) as {
          ok: boolean;
          intent: { id: string; status: string };
          applyPolicy: {
            effective: string;
            source: string;
            externalApplyRequested: boolean;
            externalApplyPerformed: boolean;
          };
          externalApply: {
            adapterKind: string;
            allowStatusMutation: boolean;
            mutationKind: string;
            auditId: string | null;
            external: {
              alreadyApplied: boolean;
              commentId: string;
              commentUrl: string;
              idempotencyMarker: string;
              statusTransitioned: boolean;
            };
            reconcile: { status: string; warning: string | null };
          };
        };
        expect(payload.ok).toBe(true);
        expect(payload.intent.status).toBe("applied");
        expect(payload.applyPolicy).toMatchObject({
          effective: "external_apply_allowed",
          source: "momentum_policy",
          externalApplyRequested: true,
          externalApplyPerformed: true
        });
        // The external write itself succeeded — the audit captures a real
        // comment id even though the post-apply refresh failed.
        expect(payload.externalApply.adapterKind).toBe("linear");
        expect(payload.externalApply.mutationKind).toBe("comment");
        expect(payload.externalApply.external.alreadyApplied).toBe(false);
        expect(payload.externalApply.external.statusTransitioned).toBe(false);
        expect(payload.externalApply.external.commentId).toBe("mock-comment-1");
        const marker = payload.externalApply.external.idempotencyMarker;
        expect(marker).toMatch(
          new RegExp(`^momentum-intent:linear:${intentId}:[0-9a-f]{16}$`)
        );

        // Reconcile reports the failure code and a warning describing the
        // refresh error, but does NOT revert the apply.
        expect(payload.externalApply.reconcile.status).toBe("refresh_failed");
        expect(payload.externalApply.reconcile.warning).not.toBeNull();
        expect(payload.externalApply.reconcile.warning ?? "").toContain(
          "smoke mock injected IssueRefresh failure"
        );

        // Mock saw exactly one commentCreate and at least one IssueRefresh
        // attempt (the injected failure). Source reconcile traffic unchanged.
        expect(mock.commentsCreated).toHaveLength(1);
        expect(mock.commentsCreated[0]!.body).toContain(`idempotency: ${marker}`);
        expect(mock.issueUpdates).toHaveLength(0);
        expect(mock.requestCounts["MomentumExternalUpdateCommentCreate"]).toBe(1);
        expect(
          mock.requestCounts["MomentumExternalUpdateIssueStateUpdate"] ?? 0
        ).toBe(0);
        expect(mock.requestCounts["MomentumIssueRefresh"] ?? 0).toBeGreaterThanOrEqual(
          1
        );
        expect(mock.requestCounts["MomentumLinearIssues"] ?? 0).toBe(
          reconcileCallsBefore
        );

        // `intent get` rollup carries the same reconcile warning forward on
        // the latest audit attempt while still showing the audit as succeeded.
        const intentGet = runCliBinary([
          "intent",
          "get",
          intentId,
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(intentGet.code).toBe(0);
        const intentGetPayload = JSON.parse(intentGet.stdout) as {
          intent: { status: string };
          externalApply: {
            applyState: string;
            totalAttempts: number;
            counts: {
              claimed: number;
              succeeded: number;
              failed: number;
              blocked: number;
              audit_incomplete: number;
            };
            latestAttempt: {
              lifecycleState: string;
              resultStatus: string;
              resultCode: string;
              idempotencyMarker: string;
              externalRefs: {
                commentId: string;
                commentUrl: string;
                stateTransitionId: string | null;
              };
              reconcile: { status: string; warning: string | null };
            } | null;
          };
        };
        expect(intentGetPayload.intent.status).toBe("applied");
        expect(intentGetPayload.externalApply.applyState).toBe("idle");
        expect(intentGetPayload.externalApply.totalAttempts).toBe(1);
        expect(intentGetPayload.externalApply.counts).toMatchObject({
          claimed: 0,
          succeeded: 1,
          failed: 0,
          blocked: 0,
          audit_incomplete: 0
        });
        const latest = intentGetPayload.externalApply.latestAttempt;
        expect(latest).not.toBeNull();
        expect(latest!.lifecycleState).toBe("succeeded");
        expect(latest!.resultStatus).toBe("succeeded");
        expect(latest!.resultCode).toBe("applied");
        expect(latest!.idempotencyMarker).toBe(marker);
        expect(latest!.externalRefs.commentId).toBe("mock-comment-1");
        expect(latest!.externalRefs.stateTransitionId).toBeNull();
        expect(latest!.reconcile.status).toBe("refresh_failed");
        expect(latest!.reconcile.warning ?? "").toContain(
          "smoke mock injected IssueRefresh failure"
        );
      } finally {
        await fixture.close();
      }
    },
    180_000
  );

  it(
    "rejects a concurrent intent apply --external-apply with intent_apply_in_progress and performs only one external mutation",
    async () => {
      const fixture = await establishM6ExternalApplyFixture({
        momentumPolicy: "external_apply_allowed"
      });
      const { repo, dataDir, intentId, mock } = fixture;
      try {
        const reconcileCallsBefore =
          mock.requestCounts["MomentumLinearIssues"] ?? 0;
        // Hold the mock's commentCreate response so the first CLI is still
        // in flight (apply_state='in_flight') when the second CLI attempts
        // to claim the same intent.
        mock.setCommentCreateDelayMs(2000);

        const baseArgs = [
          "intent",
          "apply",
          intentId,
          "--external-apply",
          "--repo",
          repo,
          "--data-dir",
          dataDir,
          "--json"
        ];
        const env = {
          LINEAR_API_KEY: "lin_api_smoke_fixture_key",
          MOMENTUM_LINEAR_EXTERNAL_UPDATE_ENDPOINT: mock.endpoint,
          MOMENTUM_LINEAR_REFRESH_ENDPOINT: mock.endpoint
        };

        const firstPromise = runCliBinaryAsync(
          [...baseArgs, "--reason", "smoke concurrent A"],
          { env }
        );
        // Give the first CLI enough headroom to finish its claim
        // transaction (idle -> in_flight) before the second CLI's claim
        // attempt collides on the same intent row. The external write
        // itself is still pending against the delayed mock.
        await new Promise((resolve) => setTimeout(resolve, 750));
        const secondPromise = runCliBinaryAsync(
          [...baseArgs, "--reason", "smoke concurrent B"],
          { env }
        );

        const [first, second] = await Promise.all([firstPromise, secondPromise]);

        const results = [first, second];
        const successResult = results.find((r) => r.code === 0);
        const blockedResult = results.find((r) => r.code !== 0);
        expect(
          successResult,
          `expected one CLI to succeed but got codes a=${first.code} b=${second.code}`
        ).toBeDefined();
        expect(
          blockedResult,
          `expected one CLI to fail with intent_apply_in_progress but got codes a=${first.code} b=${second.code}`
        ).toBeDefined();

        const successPayload = JSON.parse(successResult!.stdout) as {
          ok: boolean;
          intent: { id: string; status: string };
          applyPolicy: {
            effective: string;
            source: string;
            externalApplyRequested: boolean;
            externalApplyPerformed: boolean;
          };
          externalApply: {
            adapterKind: string;
            mutationKind: string;
            external: {
              alreadyApplied: boolean;
              commentId: string;
              idempotencyMarker: string;
              statusTransitioned: boolean;
            };
            reconcile: { status: string; warning: string | null };
          };
        };
        expect(successPayload.ok).toBe(true);
        expect(successPayload.intent.id).toBe(intentId);
        expect(successPayload.intent.status).toBe("applied");
        expect(successPayload.applyPolicy).toMatchObject({
          effective: "external_apply_allowed",
          source: "momentum_policy",
          externalApplyRequested: true,
          externalApplyPerformed: true
        });
        expect(successPayload.externalApply.adapterKind).toBe("linear");
        expect(successPayload.externalApply.mutationKind).toBe("comment");
        expect(successPayload.externalApply.external.alreadyApplied).toBe(false);
        expect(successPayload.externalApply.external.statusTransitioned).toBe(
          false
        );
        expect(successPayload.externalApply.external.commentId).toBe(
          "mock-comment-1"
        );
        const marker = successPayload.externalApply.external.idempotencyMarker;
        expect(marker).toMatch(
          new RegExp(`^momentum-intent:linear:${intentId}:[0-9a-f]{16}$`)
        );
        expect(successPayload.externalApply.reconcile.status).toBe("success");

        const blockedPayload = JSON.parse(blockedResult!.stderr) as {
          ok: boolean;
          command: string;
          code: string;
          message: string;
          intentId: string;
          applyPolicy?: { effective: string; source: string };
          externalApply?: {
            adapterKind: string;
            mutationKind: string | null;
            allowStatusMutation: boolean;
            auditId: string | null;
          };
        };
        expect(blockedPayload.ok).toBe(false);
        expect(blockedPayload.command).toBe("intent apply");
        expect(blockedPayload.code).toBe("intent_apply_in_progress");
        expect(blockedPayload.intentId).toBe(intentId);
        // The refused claim must not have called the external adapter; the
        // failure envelope still reports the resolved policy so operators see
        // why the second invocation was refused.
        expect(blockedPayload.applyPolicy).toMatchObject({
          effective: "external_apply_allowed",
          source: "momentum_policy"
        });

        // Mock observed exactly one commentCreate request and zero status
        // mutations. The second CLI never reached the external write path.
        expect(mock.commentsCreated).toHaveLength(1);
        expect(mock.commentsCreated[0]!.body).toContain(
          `idempotency: ${marker}`
        );
        expect(mock.issueUpdates).toHaveLength(0);
        expect(mock.requestCounts["MomentumExternalUpdateCommentCreate"]).toBe(
          1
        );
        expect(
          mock.requestCounts["MomentumExternalUpdateIssueStateUpdate"] ?? 0
        ).toBe(0);
        // Post-apply reconciliation ran exactly once for the winning CLI.
        expect(mock.requestCounts["MomentumIssueRefresh"]).toBe(1);
        // Source reconcile traffic from the fixture is unchanged.
        expect(mock.requestCounts["MomentumLinearIssues"] ?? 0).toBe(
          reconcileCallsBefore
        );

        const intentGet = runCliBinary([
          "intent",
          "get",
          intentId,
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(intentGet.code).toBe(0);
        const intentGetPayload = JSON.parse(intentGet.stdout) as {
          intent: { status: string };
          externalApply: {
            applyState: string;
            totalAttempts: number;
            counts: {
              claimed: number;
              succeeded: number;
              failed: number;
              blocked: number;
              audit_incomplete: number;
            };
            latestAttempt: {
              lifecycleState: string;
              resultStatus: string;
              resultCode: string;
              idempotencyMarker: string;
              externalRefs: {
                commentId: string;
                commentUrl: string;
                stateTransitionId: string | null;
              };
              reconcile: { status: string; warning: string | null };
            } | null;
          };
        };
        expect(intentGetPayload.intent.status).toBe("applied");
        expect(intentGetPayload.externalApply.applyState).toBe("idle");
        // Only the winning claimant's audit row exists; the refused CLI was
        // rejected at the CAS guard before any audit row was inserted.
        expect(intentGetPayload.externalApply.totalAttempts).toBe(1);
        expect(intentGetPayload.externalApply.counts).toMatchObject({
          claimed: 0,
          succeeded: 1,
          failed: 0,
          blocked: 0,
          audit_incomplete: 0
        });
        const latest = intentGetPayload.externalApply.latestAttempt;
        expect(latest).not.toBeNull();
        expect(latest!.lifecycleState).toBe("succeeded");
        expect(latest!.resultStatus).toBe("succeeded");
        expect(latest!.resultCode).toBe("applied");
        expect(latest!.idempotencyMarker).toBe(marker);
        expect(latest!.externalRefs.commentId).toBe("mock-comment-1");
        expect(latest!.externalRefs.stateTransitionId).toBeNull();
        expect(latest!.reconcile.status).toBe("success");
      } finally {
        await fixture.close();
      }
    },
    180_000
  );

  it(
    "surfaces the external apply audit through status, project status, doctor, and the handoff.json artifact after a write_rejected attempt leaves the intent pending",
    async () => {
      const fixture = await establishM6ExternalApplyFixture({
        momentumPolicy: "external_apply_allowed"
      });
      const { repo, dataDir, goalId, intentId, mock } = fixture;
      try {
        // Drive a write_rejected attempt so the intent stays pending — that
        // keeps the audit row visible through the pending-intent rollups used
        // by status, project status, and the handoff artifact, while doctor
        // surfaces the same audit through its global listIntentApplyAudits
        // view regardless of intent state.
        mock.setCommentCreateBehavior({
          kind: "graphql_error",
          message: "smoke mock injected commentCreate failure"
        });

        const externalApply = await runCliBinaryAsync(
          [
            "intent",
            "apply",
            intentId,
            "--reason",
            "smoke audit visibility",
            "--external-apply",
            "--repo",
            repo,
            "--data-dir",
            dataDir,
            "--json"
          ],
          {
            env: {
              LINEAR_API_KEY: "lin_api_smoke_fixture_key",
              MOMENTUM_LINEAR_EXTERNAL_UPDATE_ENDPOINT: mock.endpoint,
              MOMENTUM_LINEAR_REFRESH_ENDPOINT: mock.endpoint
            }
          }
        );
        expect(externalApply.code).toBe(1);
        const refusal = JSON.parse(externalApply.stderr) as {
          ok: boolean;
          code: string;
          intentId: string;
          externalApply: { auditId: string | null };
        };
        expect(refusal).toMatchObject({
          ok: false,
          code: "write_rejected",
          intentId
        });
        const auditId = refusal.externalApply.auditId;
        expect(typeof auditId).toBe("string");

        // status --json shows the failed audit on the pending intent and at
        // the rollup level so operators can see the latest attempt without
        // drilling into intent get.
        const statusResult = runCliBinary([
          "status",
          goalId,
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(statusResult.code, `status stderr: ${statusResult.stderr}`).toBe(0);
        const statusPayload = JSON.parse(statusResult.stdout) as {
          goalId: string;
          artifactDir: string;
          pendingUpdateIntents: Array<{
            intentId: string;
            externalApply: {
              applyState: string;
              totalAttempts: number;
              counts: { failed: number };
              latestAttempt: {
                id: string;
                lifecycleState: string;
                resultCode: string;
              } | null;
            };
          }>;
          externalApply: {
            pendingIntentApplyStateCounts: {
              idle: number;
              in_flight: number;
              blocked: number;
            };
            pendingAuditCounts: { failed: number; succeeded: number };
            totalAttempts: number;
            latestAttempt: {
              intentId: string;
              id: string;
              lifecycleState: string;
              resultStatus: string;
              resultCode: string;
            } | null;
          };
        };
        expect(statusPayload.goalId).toBe(goalId);
        expect(statusPayload.pendingUpdateIntents).toHaveLength(1);
        const statusIntent = statusPayload.pendingUpdateIntents[0]!;
        expect(statusIntent.intentId).toBe(intentId);
        expect(statusIntent.externalApply.applyState).toBe("idle");
        expect(statusIntent.externalApply.totalAttempts).toBe(1);
        expect(statusIntent.externalApply.counts.failed).toBe(1);
        expect(statusIntent.externalApply.latestAttempt).not.toBeNull();
        expect(statusIntent.externalApply.latestAttempt!.id).toBe(auditId);
        expect(statusIntent.externalApply.latestAttempt!.lifecycleState).toBe(
          "failed"
        );
        expect(statusIntent.externalApply.latestAttempt!.resultCode).toBe(
          "write_rejected"
        );
        expect(statusPayload.externalApply.totalAttempts).toBe(1);
        expect(statusPayload.externalApply.pendingAuditCounts.failed).toBe(1);
        expect(statusPayload.externalApply.pendingAuditCounts.succeeded).toBe(0);
        expect(statusPayload.externalApply.pendingIntentApplyStateCounts).toMatchObject({
          idle: 1,
          in_flight: 0,
          blocked: 0
        });
        expect(statusPayload.externalApply.latestAttempt).not.toBeNull();
        expect(statusPayload.externalApply.latestAttempt!.intentId).toBe(intentId);
        expect(statusPayload.externalApply.latestAttempt!.id).toBe(auditId);
        expect(statusPayload.externalApply.latestAttempt!.lifecycleState).toBe(
          "failed"
        );
        expect(statusPayload.externalApply.latestAttempt!.resultCode).toBe(
          "write_rejected"
        );

        // project status --json exposes the same audit via its pending-intent
        // rollup; this is the operator surface for cross-goal external apply
        // visibility.
        const projectStatus = runCliBinary([
          "project",
          "status",
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(projectStatus.code, `project status stderr: ${projectStatus.stderr}`).toBe(0);
        const projectPayload = JSON.parse(projectStatus.stdout) as {
          externalApply: {
            pendingIntentApplyStateCounts: { idle: number };
            pendingAuditCounts: { failed: number; succeeded: number };
            totalAttempts: number;
            latestAttempt: {
              intentId: string;
              id: string;
              lifecycleState: string;
              resultCode: string;
            } | null;
          };
          pendingUpdateIntents: Array<{
            intentId: string;
            externalApply: {
              applyState: string;
              totalAttempts: number;
              latestAttempt: { id: string; lifecycleState: string } | null;
            };
          }>;
        };
        expect(projectPayload.pendingUpdateIntents).toHaveLength(1);
        const projectIntent = projectPayload.pendingUpdateIntents[0]!;
        expect(projectIntent.intentId).toBe(intentId);
        expect(projectIntent.externalApply.totalAttempts).toBe(1);
        expect(projectIntent.externalApply.latestAttempt).not.toBeNull();
        expect(projectIntent.externalApply.latestAttempt!.id).toBe(auditId);
        expect(projectIntent.externalApply.latestAttempt!.lifecycleState).toBe(
          "failed"
        );
        expect(projectPayload.externalApply.totalAttempts).toBe(1);
        expect(projectPayload.externalApply.pendingAuditCounts.failed).toBe(1);
        expect(projectPayload.externalApply.pendingAuditCounts.succeeded).toBe(0);
        expect(projectPayload.externalApply.pendingIntentApplyStateCounts.idle).toBe(
          1
        );
        expect(projectPayload.externalApply.latestAttempt).not.toBeNull();
        expect(projectPayload.externalApply.latestAttempt!.intentId).toBe(intentId);
        expect(projectPayload.externalApply.latestAttempt!.id).toBe(auditId);
        expect(projectPayload.externalApply.latestAttempt!.lifecycleState).toBe(
          "failed"
        );
        expect(projectPayload.externalApply.latestAttempt!.resultCode).toBe(
          "write_rejected"
        );

        // doctor --json reads from the global audit ledger, so its
        // externalApply.latestAttempt remains visible even once the intent
        // transitions to applied. Here it confirms the same failed audit.
        const doctor = runCliBinary([
          "doctor",
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(doctor.code, `doctor stderr: ${doctor.stderr}`).toBe(0);
        const doctorPayload = JSON.parse(doctor.stdout) as {
          externalApply: {
            ok: boolean;
            intentApplyStateCounts: { idle: number; in_flight: number; blocked: number };
            auditCounts: { failed: number; succeeded: number };
            totalAttempts: number;
            latestAttempt: {
              intentId: string;
              id: string;
              lifecycleState: string;
              resultStatus: string;
              resultCode: string;
            } | null;
          };
        };
        expect(doctorPayload.externalApply.ok).toBe(true);
        expect(doctorPayload.externalApply.intentApplyStateCounts).toMatchObject({
          idle: 1,
          in_flight: 0,
          blocked: 0
        });
        expect(doctorPayload.externalApply.auditCounts.failed).toBe(1);
        expect(doctorPayload.externalApply.auditCounts.succeeded).toBe(0);
        expect(doctorPayload.externalApply.totalAttempts).toBe(1);
        expect(doctorPayload.externalApply.latestAttempt).not.toBeNull();
        expect(doctorPayload.externalApply.latestAttempt!.intentId).toBe(intentId);
        expect(doctorPayload.externalApply.latestAttempt!.id).toBe(auditId);
        expect(doctorPayload.externalApply.latestAttempt!.lifecycleState).toBe(
          "failed"
        );
        expect(doctorPayload.externalApply.latestAttempt!.resultStatus).toBe(
          "failed"
        );
        expect(doctorPayload.externalApply.latestAttempt!.resultCode).toBe(
          "write_rejected"
        );

        // handoff writes the same external_apply payload into handoff.json so
        // downstream automations can pick up the audit from a single
        // artifact file.
        const handoff = runCliBinary([
          "handoff",
          goalId,
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(handoff.code, `handoff stderr: ${handoff.stderr}`).toBe(0);
        const handoffJsonPath = path.join(statusPayload.artifactDir, "handoff.json");
        const handoffArtifact = JSON.parse(
          fs.readFileSync(handoffJsonPath, "utf-8")
        ) as {
          external_apply: {
            pending_intent_apply_state_counts: { idle: number };
            pending_audit_counts: { failed: number; succeeded: number };
            total_attempts: number;
            latest_attempt: {
              intent_id: string;
              id: string;
              lifecycle_state: string;
              result_status: string;
              result_code: string;
            } | null;
          };
          pending_update_intents: Array<{
            intent_id: string;
            external_apply: {
              apply_state: string;
              total_attempts: number;
              latest_attempt: {
                id: string;
                lifecycle_state: string;
                result_code: string;
              } | null;
            };
          }>;
        };
        expect(handoffArtifact.pending_update_intents).toHaveLength(1);
        const handoffIntent = handoffArtifact.pending_update_intents[0]!;
        expect(handoffIntent.intent_id).toBe(intentId);
        expect(handoffIntent.external_apply.total_attempts).toBe(1);
        expect(handoffIntent.external_apply.apply_state).toBe("idle");
        expect(handoffIntent.external_apply.latest_attempt).not.toBeNull();
        expect(handoffIntent.external_apply.latest_attempt!.id).toBe(auditId);
        expect(handoffIntent.external_apply.latest_attempt!.lifecycle_state).toBe(
          "failed"
        );
        expect(handoffIntent.external_apply.latest_attempt!.result_code).toBe(
          "write_rejected"
        );
        expect(handoffArtifact.external_apply.total_attempts).toBe(1);
        expect(handoffArtifact.external_apply.pending_audit_counts.failed).toBe(1);
        expect(handoffArtifact.external_apply.pending_audit_counts.succeeded).toBe(0);
        expect(handoffArtifact.external_apply.pending_intent_apply_state_counts.idle).toBe(
          1
        );
        expect(handoffArtifact.external_apply.latest_attempt).not.toBeNull();
        expect(handoffArtifact.external_apply.latest_attempt!.intent_id).toBe(intentId);
        expect(handoffArtifact.external_apply.latest_attempt!.id).toBe(auditId);
        expect(handoffArtifact.external_apply.latest_attempt!.lifecycle_state).toBe(
          "failed"
        );
        expect(handoffArtifact.external_apply.latest_attempt!.result_status).toBe(
          "failed"
        );
        expect(handoffArtifact.external_apply.latest_attempt!.result_code).toBe(
          "write_rejected"
        );
      } finally {
        await fixture.close();
      }
    },
    180_000
  );

  it(
    "blocks the intent and marks the audit incomplete when audit finalize fails after a successful external write, then refuses retries with intent_blocked without a second external mutation",
    async () => {
      const fixture = await establishM6ExternalApplyFixture({
        momentumPolicy: "external_apply_allowed"
      });
      const { repo, dataDir, intentId, mock } = fixture;
      try {
        const reconcileCallsBefore =
          mock.requestCounts["MomentumLinearIssues"] ?? 0;
        // Hold the mock's commentCreate response so the CLI is parked
        // mid-apply (audit row in 'claimed', external write in flight)
        // long enough for the test to tamper with the audit row and
        // force audit_already_finalized on the post-write finalize.
        mock.setCommentCreateDelayMs(2500);

        const baseArgs = [
          "intent",
          "apply",
          intentId,
          "--external-apply",
          "--reason",
          "smoke audit finalize failure",
          "--repo",
          repo,
          "--data-dir",
          dataDir,
          "--json"
        ];
        const env = {
          LINEAR_API_KEY: "lin_api_smoke_fixture_key",
          MOMENTUM_LINEAR_EXTERNAL_UPDATE_ENDPOINT: mock.endpoint,
          MOMENTUM_LINEAR_REFRESH_ENDPOINT: mock.endpoint
        };

        const cliPromise = runCliBinaryAsync(baseArgs, { env });

        // Poll the audit ledger for the in-flight claim, then flip its
        // lifecycle_state out from under the CLI so finalizeIntentApply
        // returns audit_already_finalized after the external write returns.
        // The CLI is awaiting the delayed commentCreate fetch and not
        // holding the SQLite file lock during this window, so a separate
        // DatabaseSync connection can safely rewrite the row.
        const inspectionDb = new DatabaseSync(
          path.join(dataDir, "momentum.db")
        );
        let tamperedAuditId: string | null = null;
        try {
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            const row = inspectionDb
              .prepare(
                `SELECT id FROM intent_apply_audits
                  WHERE intent_id = ? AND lifecycle_state = 'claimed'`
              )
              .get(intentId) as { id: string } | undefined;
            if (row) {
              tamperedAuditId = row.id;
              inspectionDb
                .prepare(
                  `UPDATE intent_apply_audits
                      SET lifecycle_state = 'failed',
                          result_status = 'failed',
                          result_code = 'smoke_tampered_for_finalize_failure'
                    WHERE id = ?`
                )
                .run(tamperedAuditId);
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        } finally {
          inspectionDb.close();
        }
        expect(
          tamperedAuditId,
          "expected an in-flight 'claimed' audit row to appear before the CLI completed"
        ).not.toBeNull();

        const result = await cliPromise;
        expect(result.code, `cli stderr: ${result.stderr}`).toBe(1);
        const refusal = JSON.parse(result.stderr) as {
          ok: boolean;
          command: string;
          code: string;
          intentId: string;
          applyPolicy: {
            effective: string;
            source: string;
            externalApplyRequested: boolean;
            externalApplyPerformed: boolean;
          };
          externalApply: {
            adapterKind: string;
            mutationKind: string | null;
            allowStatusMutation: boolean;
            auditId: string | null;
            reconcile: { status: string | null; warning: string | null };
            external: {
              alreadyApplied: boolean;
              commentId: string | null;
              commentUrl: string | null;
              statusTransitioned: boolean;
              idempotencyMarker: string | null;
            } | null;
          };
        };
        expect(refusal.ok).toBe(false);
        expect(refusal.command).toBe("intent apply");
        expect(refusal.code).toBe("audit_incomplete");
        expect(refusal.intentId).toBe(intentId);
        // The external write reached the tracker before audit finalize
        // failed, so the policy summary reports externalApplyPerformed=true
        // even though the intent was never marked applied.
        expect(refusal.applyPolicy).toMatchObject({
          effective: "external_apply_allowed",
          source: "momentum_policy",
          externalApplyRequested: true,
          externalApplyPerformed: true
        });
        expect(refusal.externalApply.adapterKind).toBe("linear");
        expect(refusal.externalApply.mutationKind).toBe("comment");
        expect(refusal.externalApply.allowStatusMutation).toBe(false);
        expect(refusal.externalApply.auditId).toBe(tamperedAuditId);
        expect(refusal.externalApply.reconcile).toEqual({
          status: "deferred",
          warning: "external write applied; audit finalize failed"
        });
        expect(refusal.externalApply.external).not.toBeNull();
        expect(refusal.externalApply.external!.alreadyApplied).toBe(false);
        expect(refusal.externalApply.external!.statusTransitioned).toBe(false);
        expect(refusal.externalApply.external!.commentId).toBe(
          "mock-comment-1"
        );
        const marker = refusal.externalApply.external!.idempotencyMarker;
        expect(typeof marker).toBe("string");
        expect(marker).toMatch(
          new RegExp(`^momentum-intent:linear:${intentId}:[0-9a-f]{16}$`)
        );

        // Exactly one external write made it through before audit finalize
        // failed; the post-apply reconcile path is skipped on the
        // audit_incomplete branch so no IssueRefresh was issued.
        expect(mock.commentsCreated).toHaveLength(1);
        expect(mock.commentsCreated[0]!.body).toContain(
          `idempotency: ${marker}`
        );
        expect(mock.issueUpdates).toHaveLength(0);
        expect(mock.requestCounts["MomentumExternalUpdateCommentCreate"]).toBe(
          1
        );
        expect(
          mock.requestCounts["MomentumExternalUpdateIssueStateUpdate"] ?? 0
        ).toBe(0);
        expect(mock.requestCounts["MomentumIssueRefresh"] ?? 0).toBe(0);

        const intentGet = runCliBinary([
          "intent",
          "get",
          intentId,
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(intentGet.code, `intent get stderr: ${intentGet.stderr}`).toBe(0);
        const intentGetPayload = JSON.parse(intentGet.stdout) as {
          intent: { status: string };
          externalApply: {
            applyState: string;
            totalAttempts: number;
            counts: {
              claimed: number;
              succeeded: number;
              failed: number;
              blocked: number;
              audit_incomplete: number;
            };
            latestAttempt: {
              id: string;
              lifecycleState: string;
              resultStatus: string;
              resultCode: string;
              externalRefs: {
                commentId: string | null;
                commentUrl: string | null;
                stateTransitionId: string | null;
              };
              reconcile: { status: string | null; warning: string | null };
            } | null;
          };
        };
        // Intent stays pending — markUpdateIntentApplied was never reached.
        expect(intentGetPayload.intent.status).toBe("pending");
        // ...but the CAS column is blocked so any retry must be refused
        // at the claim guard before the external write path runs again.
        expect(intentGetPayload.externalApply.applyState).toBe("blocked");
        expect(intentGetPayload.externalApply.totalAttempts).toBe(1);
        expect(intentGetPayload.externalApply.counts).toMatchObject({
          claimed: 0,
          succeeded: 0,
          failed: 0,
          blocked: 0,
          audit_incomplete: 1
        });
        const latest = intentGetPayload.externalApply.latestAttempt;
        expect(latest).not.toBeNull();
        expect(latest!.id).toBe(tamperedAuditId);
        expect(latest!.lifecycleState).toBe("audit_incomplete");
        expect(latest!.resultStatus).toBe("audit_incomplete");
        expect(latest!.resultCode).toBe("audit_finalize_failed");
        // External write evidence is preserved on the audit row even after
        // the forced audit_incomplete transition, so operators can correlate
        // the surviving comment with the blocked intent.
        expect(latest!.externalRefs.commentId).toBe("mock-comment-1");
        expect(latest!.externalRefs.stateTransitionId).toBeNull();
        expect(latest!.reconcile).toEqual({
          status: "deferred",
          warning: "external write applied; audit finalize failed"
        });

        // Retrying the apply must be refused at the CAS guard with
        // intent_blocked and must not produce a second external write.
        mock.setCommentCreateDelayMs(0);
        const retry = await runCliBinaryAsync(baseArgs, { env });
        expect(retry.code, `retry stdout: ${retry.stdout}`).toBe(1);
        const retryRefusal = JSON.parse(retry.stderr) as {
          ok: boolean;
          command: string;
          code: string;
          intentId: string;
          applyPolicy: {
            effective: string;
            source: string;
            externalApplyRequested: boolean;
          };
        };
        expect(retryRefusal.ok).toBe(false);
        expect(retryRefusal.command).toBe("intent apply");
        expect(retryRefusal.code).toBe("intent_blocked");
        expect(retryRefusal.intentId).toBe(intentId);
        expect(retryRefusal.applyPolicy).toMatchObject({
          effective: "external_apply_allowed",
          source: "momentum_policy",
          externalApplyRequested: true
        });

        // Mock state is unchanged after the retry refusal: no second comment,
        // no status mutation, no follow-up refresh.
        expect(mock.commentsCreated).toHaveLength(1);
        expect(mock.issueUpdates).toHaveLength(0);
        expect(mock.requestCounts["MomentumExternalUpdateCommentCreate"]).toBe(
          1
        );
        expect(
          mock.requestCounts["MomentumExternalUpdateIssueStateUpdate"] ?? 0
        ).toBe(0);
        expect(mock.requestCounts["MomentumIssueRefresh"] ?? 0).toBe(0);
        // Source reconcile traffic from the fixture is unchanged.
        expect(mock.requestCounts["MomentumLinearIssues"] ?? 0).toBe(
          reconcileCallsBefore
        );
      } finally {
        await fixture.close();
      }
    },
    180_000
  );
});

type M6ExternalApplyFixture = {
  repo: string;
  dataDir: string;
  sourceItemId: string;
  goalId: string;
  intentId: string;
  mock: LinearExternalApplyMockServer;
  close: () => Promise<void>;
};

async function establishM6ExternalApplyFixture(options: {
  momentumPolicy: "external_apply_allowed" | "create_intents_only";
}): Promise<M6ExternalApplyFixture> {
  const dataDir = makeTempDir("momentum-smoke-m6-failure-data-");
  const repo = initDisposableRepo();
  const momentumLines =
    options.momentumPolicy === "external_apply_allowed"
      ? [
          "---",
          "intent_apply_policy: external_apply_allowed",
          "---",
          "",
          "Smoke MOMENTUM.md for the M6 external apply failure matrix.",
          ""
        ]
      : [
          "---",
          "intent_apply_policy: create_intents_only",
          "---",
          "",
          "Smoke MOMENTUM.md for the M6 external apply failure matrix.",
          ""
        ];
  fs.writeFileSync(
    path.join(repo, "MOMENTUM.md"),
    momentumLines.join("\n"),
    "utf-8"
  );
  runGit(repo, ["add", "MOMENTUM.md"]);
  runGit(repo, ["commit", "-m", "add MOMENTUM.md", "--quiet"]);

  const goalFile = path.join(dataDir, "goal.md");
  fs.writeFileSync(goalFile, SMOKE_GOAL_SPEC, "utf-8");

  const issue: LinearExternalApplyMockIssue = {
    id: "issue-smoke-ngx-301-failure",
    identifier: "NGX-301",
    title: "M6-06 External apply safety smoke and failure matrix",
    description: "Smoke fixture for the M6 external apply failure matrix.",
    url: "https://linear.app/ngxcalvin/issue/NGX-301",
    updatedAt: "2026-05-21T08:00:00.000Z",
    priority: 0,
    state: { id: "state-in-progress", name: "In Progress" },
    team: { id: "team-ngx" },
    project: {
      id: "project-momentum",
      name: "Momentum",
      url: "https://linear.app/ngxcalvin/project/momentum"
    },
    projectMilestone: {
      id: "milestone-m6",
      name: "Milestone 6: Policy-Gated External Apply"
    },
    labels: { nodes: [] },
    assignee: null,
    comments: []
  };
  const mock = await startLinearExternalApplyMockServer([issue]);

  const reconcile = await runCliBinaryAsync(
    [
      "source",
      "reconcile",
      "linear",
      "--linear-endpoint",
      mock.endpoint,
      "--data-dir",
      dataDir,
      "--json"
    ],
    { env: { LINEAR_API_KEY: "lin_api_smoke_fixture_key" } }
  );
  if (reconcile.code !== 0) {
    await mock.close();
    throw new Error(`source reconcile linear failed: ${reconcile.stderr}`);
  }

  const sourceList = runCliBinary([
    "source",
    "list",
    "--data-dir",
    dataDir,
    "--json"
  ]);
  const sourceItems = (
    JSON.parse(sourceList.stdout) as { items: Array<{ id: string }> }
  ).items;
  const sourceItemId = sourceItems[0]!.id;

  const goalStart = runCliBinary([
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
  const goalId = (JSON.parse(goalStart.stdout) as { goalId: string }).goalId;

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
  if (drain.code !== 0) {
    await mock.close();
    throw new Error(`daemon start failed: ${drain.stderr}`);
  }

  const fixtureRoot = makeTempDir("momentum-smoke-m6-failure-fixture-");
  const intentRunId = "smoke-m6-failure-run-1";
  const runDir = path.join(fixtureRoot, ".agent-workflows", intentRunId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "plan.json"),
    JSON.stringify(
      {
        runId: intentRunId,
        schemaVersion: 1,
        mode: "execute-ready",
        profile: "momentum-m6-smoke",
        objective: "NGX-301 smoke fixture for failure matrix",
        resolvedScope: {
          issues: ["NGX-301"],
          source: "explicit",
          status: "resolved"
        }
      },
      null,
      2
    )
  );
  const ledger = [
    {
      runId: intentRunId,
      step: "implementation",
      status: "complete",
      ts: "2026-05-21T08:20:00Z"
    },
    {
      runId: intentRunId,
      step: "no-mistakes",
      status: "complete",
      ts: "2026-05-21T08:25:00Z"
    }
  ];
  fs.writeFileSync(
    path.join(runDir, "ledger.jsonl"),
    `${ledger.map((line) => JSON.stringify(line)).join("\n")}\n`
  );

  const ingest = runCliBinary([
    "evidence",
    "ingest",
    "--path",
    runDir,
    "--goal",
    goalId,
    "--source-item",
    sourceItemId,
    "--data-dir",
    dataDir,
    "--json"
  ]);
  if (ingest.code !== 0) {
    await mock.close();
    throw new Error(`evidence ingest failed: ${ingest.stderr}`);
  }

  const link = runCliBinary([
    "source",
    "link",
    sourceItemId,
    "--goal",
    goalId,
    "--data-dir",
    dataDir,
    "--json"
  ]);
  if (link.code !== 0) {
    await mock.close();
    throw new Error(`source link failed: ${link.stderr}`);
  }

  const intentList = runCliBinary([
    "intent",
    "list",
    "--data-dir",
    dataDir,
    "--json"
  ]);
  const intentListPayload = JSON.parse(intentList.stdout) as {
    intents: Array<{ id: string; status: string }>;
  };
  const intentId = intentListPayload.intents[0]!.id;

  return {
    repo,
    dataDir,
    sourceItemId,
    goalId,
    intentId,
    mock,
    close: () => mock.close()
  };
}

type M7WorkflowImportFixtureOptions = {
  runId: string;
  withMonitor?: "stale" | "terminal" | "none";
  withLostManagedMarkers?: boolean;
  withApproval?: "discharged" | "pending";
  withMalformedPlan?: boolean;
};

function writeM7WorkflowImportFixture(
  rootDir: string,
  options: M7WorkflowImportFixtureOptions
): string {
  const { runId } = options;
  const runDir = path.join(rootDir, ".agent-workflows", runId);
  fs.mkdirSync(runDir, { recursive: true });

  if (options.withMalformedPlan) {
    fs.writeFileSync(path.join(runDir, "plan.json"), "{not valid json");
  } else {
    fs.writeFileSync(
      path.join(runDir, "plan.json"),
      JSON.stringify(
        {
          runId,
          schemaVersion: 1,
          mode: "execute-ready",
          profile: "momentum-m7-smoke",
          objective: "NGX-314 smoke fixture for workflow import",
          repo: "/Users/test/repos/momentum",
          resolvedScope: {
            issues: ["NGX-314"],
            source: "explicit",
            status: "resolved"
          },
          skillRevision: {
            contract: "coding-workflow-pipeline compact skill architecture",
            digest:
              "abc123def4560000000000000000000000000000000000000000000000000000",
            version: "2026.05.22.18",
            schemaVersion: 1
          },
          approvalsRequired: [
            "implementation",
            "postflight:1",
            "no-mistakes",
            "merge-cleanup"
          ],
          taskFlow: {
            childTasks: [
              { stepId: "preflight" },
              { stepId: "implementation" },
              { stepId: "postflight:1" },
              { stepId: "no-mistakes" },
              { stepId: "merge-cleanup" }
            ]
          }
        },
        null,
        2
      )
    );
  }

  const ledgerEvents = [
    {
      runId,
      step: "preflight",
      status: "complete",
      ts: "2026-05-17T10:00:00Z"
    },
    {
      runId,
      step: "implementation",
      status: "started",
      ts: "2026-05-17T10:01:00Z"
    },
    {
      runId,
      step: "implementation",
      status: "complete",
      ts: "2026-05-17T10:30:00Z"
    },
    {
      runId,
      step: "postflight:1",
      status: "complete",
      ts: "2026-05-17T10:35:00Z"
    },
    {
      runId,
      step: "no-mistakes",
      status: "complete",
      ts: "2026-05-17T10:40:00Z"
    },
    {
      runId,
      step: "merge-cleanup",
      status: "complete",
      ts: "2026-05-17T10:45:00Z"
    }
  ];
  fs.writeFileSync(
    path.join(runDir, "ledger.jsonl"),
    `${ledgerEvents.map((line) => JSON.stringify(line)).join("\n")}\n`
  );

  if (options.withMonitor === "stale") {
    fs.writeFileSync(
      path.join(runDir, "monitor.json"),
      JSON.stringify(
        {
          runId,
          schemaVersion: 1,
          active: true,
          terminal: false,
          lastSeenState: "running",
          step: "implementation"
        },
        null,
        2
      )
    );
  } else if (options.withMonitor === "terminal") {
    fs.writeFileSync(
      path.join(runDir, "monitor.json"),
      JSON.stringify(
        {
          runId,
          schemaVersion: 1,
          active: false,
          terminal: true,
          lastSeenState: "complete"
        },
        null,
        2
      )
    );
  }

  if (options.withLostManagedMarkers) {
    fs.writeFileSync(
      path.join(runDir, "managed-gnhf_implementation.pid"),
      "99999\n"
    );
    fs.writeFileSync(
      path.join(runDir, "managed-gnhf_implementation.log"),
      "stale log content\n"
    );
    fs.mkdirSync(path.join(runDir, "locks"));
  }

  if (options.withApproval === "discharged") {
    fs.writeFileSync(
      path.join(runDir, "approval-through-merge-cleanup.json"),
      JSON.stringify(
        {
          runId,
          schemaVersion: 1,
          boundary: "through-merge-cleanup",
          actor: "smoke-tester",
          approvedAt: "2026-05-17T09:00:00Z",
          approvalContract: "approve plan <run-id> <boundary>",
          allowedSteps: [
            "preflight",
            "implementation",
            "postflight:1",
            "no-mistakes",
            "merge-cleanup"
          ]
        },
        null,
        2
      )
    );
  } else if (options.withApproval === "pending") {
    fs.writeFileSync(
      path.join(runDir, "approval-through-implementation.json"),
      JSON.stringify(
        {
          runId,
          schemaVersion: 1,
          boundary: "through-implementation",
          approvalContract: "approve plan <run-id> <boundary>",
          allowedSteps: ["preflight", "implementation"]
        },
        null,
        2
      )
    );
  }

  return runDir;
}

describe("Milestone 7 workflow import end-to-end smoke (NGX-314)", () => {
  it(
    "imports a completed workflow run via the built CLI and persists rows",
    () => {
      const dataDir = makeTempDir("momentum-smoke-m7-import-completed-");
      const fixtureRoot = makeTempDir("momentum-smoke-m7-import-fixture-");
      const runId = "cwfp-smoke7completed";
      const runDir = writeM7WorkflowImportFixture(fixtureRoot, {
        runId,
        withMonitor: "terminal",
        withApproval: "discharged"
      });

      const result = runCliBinary([
        "workflow",
        "import",
        "--path",
        runDir,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(result.code, `workflow import stderr: ${result.stderr}`).toBe(0);
      expect(result.stderr).toBe("");

      const payload = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: true,
        command: "workflow import",
        dataDir,
        path: runDir,
        runId,
        source: "agent-workflow",
        state: "succeeded",
        inserted: true,
        approvalBoundary: "through-merge-cleanup"
      });
      const counts = payload["counts"] as Record<string, number>;
      expect(counts).toMatchObject({
        steps: 5,
        approvals: 1,
        diagnostics: 0
      });

      const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
      try {
        const runRow = db
          .prepare(
            "SELECT id, state, source, approval_boundary FROM workflow_runs WHERE id = ?"
          )
          .get(runId) as {
          id: string;
          state: string;
          source: string;
          approval_boundary: string | null;
        };
        expect(runRow).toMatchObject({
          id: runId,
          state: "succeeded",
          source: "agent-workflow",
          approval_boundary: "through-merge-cleanup"
        });

        const stepRows = db
          .prepare(
            "SELECT step_id, state FROM workflow_steps WHERE run_id = ? ORDER BY step_order"
          )
          .all(runId) as Array<{ step_id: string; state: string }>;
        expect(stepRows.map((row) => row.step_id)).toEqual([
          "preflight",
          "implementation",
          "postflight:1",
          "no-mistakes",
          "merge-cleanup"
        ]);
        for (const row of stepRows) {
          expect(row.state).toBe("succeeded");
        }

        const approvalRow = db
          .prepare(
            "SELECT boundary, actor FROM workflow_approvals WHERE run_id = ?"
          )
          .get(runId) as { boundary: string; actor: string | null };
        expect(approvalRow).toMatchObject({
          boundary: "through-merge-cleanup",
          actor: "smoke-tester"
        });
      } finally {
        db.close();
      }
    },
    60_000
  );

  it(
    "treats a stale monitor as advisory: terminal ledger wins through the built CLI",
    () => {
      const dataDir = makeTempDir("momentum-smoke-m7-import-stale-monitor-");
      const fixtureRoot = makeTempDir(
        "momentum-smoke-m7-import-stale-fixture-"
      );
      const runId = "cwfp-smoke7staleobs";
      const runDir = writeM7WorkflowImportFixture(fixtureRoot, {
        runId,
        withMonitor: "stale"
      });

      const result = runCliBinary([
        "workflow",
        "import",
        "--path",
        runDir,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(result.code, `workflow import stderr: ${result.stderr}`).toBe(0);

      const payload = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: true,
        command: "workflow import",
        runId,
        state: "succeeded"
      });
      const monitor = payload["monitor"] as Record<string, unknown>;
      expect(monitor).toMatchObject({
        advisory: true,
        runState: "running",
        terminal: false
      });

      const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
      try {
        const runRow = db
          .prepare("SELECT state FROM workflow_runs WHERE id = ?")
          .get(runId) as { state: string };
        expect(runRow.state).toBe("succeeded");

        const stepRow = db
          .prepare(
            "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = ?"
          )
          .get(runId, "implementation") as { state: string };
        expect(stepRow.state).toBe("succeeded");

        const leaseCount = db
          .prepare(
            "SELECT count(*) AS c FROM workflow_leases WHERE run_id = ?"
          )
          .get(runId) as { c: number };
        expect(leaseCount.c).toBe(0);
      } finally {
        db.close();
      }
    },
    60_000
  );

  it(
    "imports a run with lost managed-task markers and a completed ledger without diagnostics",
    () => {
      const dataDir = makeTempDir("momentum-smoke-m7-import-lost-managed-");
      const fixtureRoot = makeTempDir(
        "momentum-smoke-m7-import-lost-fixture-"
      );
      const runId = "cwfp-smoke7lostmgd";
      const runDir = writeM7WorkflowImportFixture(fixtureRoot, {
        runId,
        withLostManagedMarkers: true
      });

      const result = runCliBinary([
        "workflow",
        "import",
        "--path",
        runDir,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(result.code, `workflow import stderr: ${result.stderr}`).toBe(0);

      const payload = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: true,
        command: "workflow import",
        runId,
        state: "succeeded"
      });
      expect((payload["counts"] as Record<string, number>).diagnostics).toBe(
        0
      );
      expect(payload["diagnostics"]).toEqual([]);

      const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
      try {
        const stepRow = db
          .prepare(
            "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = ?"
          )
          .get(runId, "implementation") as { state: string };
        expect(stepRow.state).toBe("succeeded");
      } finally {
        db.close();
      }
    },
    60_000
  );

  it(
    "imports an approval file with no approvedAt as a pending-style record (recordedAt=0)",
    () => {
      const dataDir = makeTempDir("momentum-smoke-m7-import-pending-approval-");
      const fixtureRoot = makeTempDir(
        "momentum-smoke-m7-import-pending-fixture-"
      );
      const runId = "cwfp-smoke7pendapv";
      const runDir = writeM7WorkflowImportFixture(fixtureRoot, {
        runId,
        withApproval: "pending"
      });

      const result = runCliBinary([
        "workflow",
        "import",
        "--path",
        runDir,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(result.code, `workflow import stderr: ${result.stderr}`).toBe(0);

      const payload = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: true,
        command: "workflow import",
        runId,
        approvalBoundary: "through-implementation"
      });
      const counts = payload["counts"] as Record<string, number>;
      expect(counts.approvals).toBe(1);
      expect(counts.diagnostics).toBe(0);

      const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
      try {
        const approvalRow = db
          .prepare(
            "SELECT boundary, recorded_at, discharged_at FROM workflow_approvals WHERE run_id = ?"
          )
          .get(runId) as {
          boundary: string;
          recorded_at: number;
          discharged_at: number | null;
        };
        expect(approvalRow.boundary).toBe("through-implementation");
        expect(approvalRow.recorded_at).toBe(0);
        expect(approvalRow.discharged_at).toBeNull();
      } finally {
        db.close();
      }
    },
    60_000
  );

  it(
    "reports diagnostics for a malformed plan but still imports valid ledger evidence",
    () => {
      const dataDir = makeTempDir("momentum-smoke-m7-import-malformed-");
      const fixtureRoot = makeTempDir(
        "momentum-smoke-m7-import-malformed-fixture-"
      );
      const runId = "cwfp-smoke7badplan";
      const runDir = writeM7WorkflowImportFixture(fixtureRoot, {
        runId,
        withMalformedPlan: true
      });

      const result = runCliBinary([
        "workflow",
        "import",
        "--path",
        runDir,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(result.code, `workflow import stderr: ${result.stderr}`).toBe(0);

      const payload = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: true,
        command: "workflow import",
        runId,
        source: "agent-workflow"
      });
      const counts = payload["counts"] as Record<string, number>;
      expect(counts.diagnostics).toBeGreaterThan(0);
      const diagnostics = payload["diagnostics"] as Array<
        Record<string, unknown>
      >;
      const reasons = diagnostics.map((d) => d["reason"]);
      expect(reasons).toContain("file_not_json");

      const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
      try {
        const runRow = db
          .prepare("SELECT id, source FROM workflow_runs WHERE id = ?")
          .get(runId) as { id: string; source: string };
        expect(runRow.id).toBe(runId);
        expect(runRow.source).toBe("agent-workflow");

        const stepRow = db
          .prepare(
            "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = ?"
          )
          .get(runId, "preflight") as { state: string };
        expect(stepRow.state).toBe("succeeded");
      } finally {
        db.close();
      }
    },
    60_000
  );
});

type E2EStep = {
  stepId: string;
  kind: WorkflowStepKind;
};

const E2E_STEPS: E2EStep[] = [
  { stepId: "preflight", kind: "preflight" },
  { stepId: "implementation", kind: "implementation" },
  { stepId: "postflight:1", kind: "postflight" },
  { stepId: "no-mistakes", kind: "no-mistakes" },
  { stepId: "merge-cleanup", kind: "merge-cleanup" }
];

function writeM7EndToEndFixture(rootDir: string, runId: string): string {
  const runDir = path.join(rootDir, ".agent-workflows", runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "plan.json"),
    JSON.stringify(
      {
        runId,
        schemaVersion: 1,
        mode: "execute-ready",
        profile: "momentum-m7-e2e-smoke",
        objective: "NGX-318 end-to-end smoke for a coding workflow",
        repo: "/Users/test/repos/momentum",
        resolvedScope: {
          issues: ["NGX-318"],
          source: "explicit",
          status: "resolved"
        },
        skillRevision: {
          contract: "coding-workflow-pipeline compact skill architecture",
          digest:
            "e2e0000000000000000000000000000000000000000000000000000000000000",
          version: "2026.05.25.01",
          schemaVersion: 1
        },
        approvalsRequired: [
          "implementation",
          "postflight:1",
          "no-mistakes",
          "merge-cleanup"
        ],
        taskFlow: {
          childTasks: E2E_STEPS.map((s) => ({ stepId: s.stepId }))
        }
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(runDir, "approval-through-merge-cleanup.json"),
    JSON.stringify(
      {
        runId,
        schemaVersion: 1,
        boundary: "through-merge-cleanup",
        actor: "smoke-tester",
        phrase: "through-merge-cleanup",
        approvedAt: "2026-05-25T09:00:00Z",
        approvalContract: "approve plan <run-id> <boundary>",
        allowedSteps: E2E_STEPS.map((s) => s.stepId)
      },
      null,
      2
    )
  );
  fs.writeFileSync(path.join(runDir, "ledger.jsonl"), "");
  return runDir;
}

function safeStepBaseName(stepId: string): string {
  return stepId.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function appendLedgerEvent(
  runDir: string,
  event: Record<string, unknown>
): void {
  fs.appendFileSync(
    path.join(runDir, "ledger.jsonl"),
    `${JSON.stringify(event)}\n`
  );
}

type DriveStepResult = {
  executorOk: boolean;
  ledgerStatus: "complete" | "failed";
  errorCode: string | null;
};

function driveStepWithFakeExecutor(
  runDir: string,
  runId: string,
  step: E2EStep,
  outcome: FakeWorkflowStepExecutorOutcome,
  startTs: string,
  endTs: string,
  attempt = 1
): DriveStepResult {
  const baseName = safeStepBaseName(step.stepId);
  const resultJsonPath = path.join(runDir, `step-${baseName}.result.json`);
  const executorLogPath = path.join(runDir, `step-${baseName}.log`);
  fs.writeFileSync(
    executorLogPath,
    `executor=${step.kind} step=${step.stepId} attempt=${attempt} outcome=${outcome}\n`
  );

  const input: WorkflowStepExecutorInput = {
    runId,
    stepId: step.stepId,
    kind: step.kind,
    attempt,
    repoPath: runDir,
    runDir,
    resultJsonPath,
    executorLogPath,
    config: { outcome }
  };

  const dispatch = dispatchWorkflowStepExecutor(step.kind, input);

  appendLedgerEvent(runDir, {
    runId,
    step: step.stepId,
    status: "started",
    ts: startTs
  });

  if (!dispatch.ok) {
    fs.writeFileSync(
      resultJsonPath,
      JSON.stringify(
        { ok: false, code: dispatch.code, error: dispatch.error },
        null,
        2
      )
    );
    appendLedgerEvent(runDir, {
      runId,
      step: step.stepId,
      status: "failed",
      ts: endTs,
      errorCode: dispatch.code,
      errorMessage: dispatch.error
    });
    return {
      executorOk: false,
      ledgerStatus: "failed",
      errorCode: dispatch.code
    };
  }

  fs.writeFileSync(resultJsonPath, JSON.stringify(dispatch.result, null, 2));

  if (
    dispatch.result.state === "succeeded" ||
    dispatch.result.state === "skipped"
  ) {
    appendLedgerEvent(runDir, {
      runId,
      step: step.stepId,
      status: "complete",
      ts: endTs
    });
    return { executorOk: true, ledgerStatus: "complete", errorCode: null };
  }

  appendLedgerEvent(runDir, {
    runId,
    step: step.stepId,
    status: "failed",
    ts: endTs,
    errorCode: dispatch.result.errorCode ?? "command_failed",
    errorMessage: dispatch.result.errorMessage ?? `fake ${step.kind} failed`
  });
  return {
    executorOk: true,
    ledgerStatus: "failed",
    errorCode: dispatch.result.errorCode
  };
}

function importWorkflowRun(
  dataDir: string,
  runDir: string
): Record<string, unknown> {
  const result = runCliBinary([
    "workflow",
    "import",
    "--path",
    runDir,
    "--data-dir",
    dataDir,
    "--json"
  ]);
  expect(result.code, `workflow import stderr: ${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function workflowStatusJson(
  dataDir: string,
  args: string[] = []
): Record<string, unknown> {
  const result = runCliBinary([
    "workflow",
    "status",
    ...args,
    "--data-dir",
    dataDir,
    "--json"
  ]);
  expect(result.code, `workflow status stderr: ${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function workflowHandoffJson(
  dataDir: string,
  runId: string
): Record<string, unknown> {
  const result = runCliBinary([
    "workflow",
    "handoff",
    runId,
    "--data-dir",
    dataDir,
    "--json"
  ]);
  expect(result.code, `workflow handoff stderr: ${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe("Milestone 7 end-to-end coding workflow smoke (NGX-318)", () => {
  it(
    "drives a full happy-path workflow through fake executors, import, status, and handoff",
    () => {
      const dataDir = makeTempDir("momentum-smoke-m7-e2e-ok-");
      const fixtureRoot = makeTempDir("momentum-smoke-m7-e2e-ok-fixture-");
      const runId = "cwfp-smoke7e2eok";
      const runDir = writeM7EndToEndFixture(fixtureRoot, runId);

      // Initial import: plan + approval only, no ledger events yet.
      const initialImport = importWorkflowRun(dataDir, runDir);
      expect(initialImport).toMatchObject({
        ok: true,
        runId,
        state: "approved",
        approvalBoundary: "through-merge-cleanup"
      });
      expect(
        (initialImport["counts"] as Record<string, number>)["approvals"]
      ).toBe(1);

      // Drive each step through the fake WorkflowStepExecutor and capture
      // ledger evidence between iterations.
      let cursor = Date.parse("2026-05-25T10:00:00Z");
      for (const step of E2E_STEPS) {
        const start = new Date(cursor).toISOString();
        const end = new Date(cursor + 60_000).toISOString();
        const driveResult = driveStepWithFakeExecutor(
          runDir,
          runId,
          step,
          "success",
          start,
          end
        );
        expect(driveResult.ledgerStatus).toBe("complete");
        cursor += 120_000;

        const midImport = importWorkflowRun(dataDir, runDir);
        expect(midImport["runId"]).toBe(runId);
      }

      const finalImport = importWorkflowRun(dataDir, runDir);
      expect(finalImport).toMatchObject({
        ok: true,
        runId,
        state: "succeeded",
        approvalBoundary: "through-merge-cleanup"
      });
      expect((finalImport["counts"] as Record<string, number>)["steps"]).toBe(
        E2E_STEPS.length
      );

      // No active or stale run remains.
      const activeRuns = workflowStatusJson(dataDir, [
        "--filter",
        "active"
      ]);
      expect(activeRuns).toMatchObject({ ok: true, count: 0 });
      expect((activeRuns["runs"] as unknown[]).length).toBe(0);

      const blockedRuns = workflowStatusJson(dataDir, [
        "--filter",
        "blocked"
      ]);
      expect(blockedRuns).toMatchObject({ ok: true, count: 0 });

      // Detail view: terminal succeeded run with all required steps green.
      const detail = workflowStatusJson(dataDir, [runId]);
      const detailRun = detail["run"] as Record<string, unknown>;
      expect(detailRun["state"]).toBe("succeeded");
      expect(detailRun["needsManualRecovery"]).toBe(false);
      const detailSteps = detail["steps"] as Array<Record<string, unknown>>;
      expect(detailSteps.map((s) => s["stepId"])).toEqual(
        E2E_STEPS.map((s) => s.stepId)
      );
      for (const step of detailSteps) {
        expect(step["state"]).toBe("succeeded");
      }
      expect((detail["leases"] as unknown[]).length).toBe(0);
      expect((detail["approvals"] as unknown[]).length).toBe(1);

      // Handoff envelope: terminal next action, no recovery.
      const handoff = workflowHandoffJson(dataDir, runId);
      expect(handoff).toMatchObject({
        ok: true,
        schemaVersion: 1
      });
      expect((handoff["run"] as Record<string, unknown>)["state"]).toBe(
        "succeeded"
      );
      const nextAction = handoff["nextAction"] as Record<string, unknown>;
      expect(nextAction["code"]).toBe("no_action");
      const monitor = handoff["monitor"] as Record<string, unknown>;
      expect(monitor["recovery"]).toBeNull();
      expect((handoff["leases"] as unknown[]).length).toBe(0);
      expect((handoff["evidence"] as unknown[]).length).toBe(0);

      // Approval-gated step durably recorded.
      const approvals = handoff["approvals"] as Array<Record<string, unknown>>;
      expect(approvals).toHaveLength(1);
      expect(approvals[0]).toMatchObject({
        boundary: "through-merge-cleanup",
        actor: "smoke-tester",
        runId
      });

      // Ingest evidence so the handoff envelope surfaces artifact pointers.
      const evidenceResult = runCliBinary([
        "evidence",
        "ingest",
        "--path",
        runDir,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(
        evidenceResult.code,
        `evidence ingest stderr: ${evidenceResult.stderr}`
      ).toBe(0);
      const evidencePayload = JSON.parse(evidenceResult.stdout) as Record<
        string,
        unknown
      >;
      const evidenceCounts = evidencePayload["counts"] as Record<string, number>;
      expect(evidenceCounts["created"]).toBeGreaterThan(0);

      const handoffAfterEvidence = workflowHandoffJson(dataDir, runId);
      const evidenceLinks = handoffAfterEvidence["evidence"] as Array<
        Record<string, unknown>
      >;
      expect(evidenceLinks.length).toBeGreaterThan(0);
      expect(evidenceLinks.some((e) => e["type"] === "plan_created")).toBe(
        true
      );
      expect(
        evidenceLinks.some((e) => e["type"] === "merge_complete")
      ).toBe(true);
    },
    120_000
  );

  it(
    "leaves no ghost active run when a required step fails mid-workflow",
    () => {
      const dataDir = makeTempDir("momentum-smoke-m7-e2e-fail-");
      const fixtureRoot = makeTempDir(
        "momentum-smoke-m7-e2e-fail-fixture-"
      );
      const runId = "cwfp-smoke7e2efail";
      const runDir = writeM7EndToEndFixture(fixtureRoot, runId);

      let cursor = Date.parse("2026-05-25T11:00:00Z");

      const preflightStep = E2E_STEPS[0]!;
      const preflightResult = driveStepWithFakeExecutor(
        runDir,
        runId,
        preflightStep,
        "success",
        new Date(cursor).toISOString(),
        new Date(cursor + 60_000).toISOString()
      );
      expect(preflightResult.ledgerStatus).toBe("complete");
      cursor += 120_000;

      const implementationStep = E2E_STEPS[1]!;
      const implementationResult = driveStepWithFakeExecutor(
        runDir,
        runId,
        implementationStep,
        "fail_retry",
        new Date(cursor).toISOString(),
        new Date(cursor + 60_000).toISOString()
      );
      expect(implementationResult.ledgerStatus).toBe("failed");
      expect(implementationResult.errorCode).toBe("command_failed");

      const importPayload = importWorkflowRun(dataDir, runDir);
      expect(importPayload).toMatchObject({
        ok: true,
        runId,
        state: "failed"
      });

      // Failure leaves no ghost active or blocked run.
      const activeRuns = workflowStatusJson(dataDir, [
        "--filter",
        "active"
      ]);
      expect(activeRuns).toMatchObject({ ok: true, count: 0 });
      const blockedRuns = workflowStatusJson(dataDir, [
        "--filter",
        "blocked"
      ]);
      expect(blockedRuns).toMatchObject({ ok: true, count: 0 });

      const completedRuns = workflowStatusJson(dataDir, [
        "--filter",
        "completed"
      ]);
      const completedList = completedRuns["runs"] as Array<
        Record<string, unknown>
      >;
      expect(
        completedList.some(
          (entry) =>
            (entry["run"] as Record<string, unknown>)["runId"] === runId &&
            (entry["run"] as Record<string, unknown>)["state"] === "failed"
        )
      ).toBe(true);

      // Detail view: failed required step, no leases.
      const detail = workflowStatusJson(dataDir, [runId]);
      const detailSteps = detail["steps"] as Array<Record<string, unknown>>;
      const preflightDetail = detailSteps.find(
        (s) => s["stepId"] === preflightStep.stepId
      );
      expect(preflightDetail?.["state"]).toBe("succeeded");
      const implementationDetail = detailSteps.find(
        (s) => s["stepId"] === implementationStep.stepId
      );
      expect(implementationDetail?.["state"]).toBe("failed");
      expect(implementationDetail?.["errorCode"]).toBe("command_failed");
      expect((detail["leases"] as unknown[]).length).toBe(0);

      // Handoff envelope surfaces the failed-required-step recovery.
      const handoff = workflowHandoffJson(dataDir, runId);
      const handoffRun = handoff["run"] as Record<string, unknown>;
      expect(handoffRun["state"]).toBe("failed");
      const handoffNext = handoff["nextAction"] as Record<string, unknown>;
      expect(handoffNext["code"]).toBe("rerun_failed_step");
      expect(handoffNext["stepId"]).toBe(implementationStep.stepId);
      const handoffMonitor = handoff["monitor"] as Record<string, unknown>;
      const recovery = handoffMonitor["recovery"] as Record<string, unknown>;
      expect(recovery).not.toBeNull();
      expect(recovery["code"]).toBe("failed_required_step");
      expect(recovery["stepId"]).toBe(implementationStep.stepId);
      expect((handoff["leases"] as unknown[]).length).toBe(0);
    },
    120_000
  );
});
