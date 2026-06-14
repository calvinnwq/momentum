import { afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  FAKE_RUNNER_FIXTURE_FILENAME,
  FAKE_RUNNER_GOAL_COMPLETE_ENV
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
      const { openDb } = await import("../src/adapters/db.js");
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
      const { openDb } = await import("../src/adapters/db.js");
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

      const { openDb } = await import("../src/adapters/db.js");
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

      const { openDb } = await import("../src/adapters/db.js");
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
