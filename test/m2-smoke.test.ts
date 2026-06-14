import { afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  FAKE_RUNNER_FAIL_ENV,
  FAKE_RUNNER_FIXTURE_FILENAME
} from "../src/adapters/fake-runner.js";

import {
  SMOKE_GOAL_SPEC,
  buildCli,
  cleanupTempRoots,
  initDisposableRepo,
  makeTempDir,
  runCliBinary,
  runGit
} from "./helpers/smoke-harness.js";

beforeAll(buildCli, 60_000);

afterEach(cleanupTempRoots);

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
