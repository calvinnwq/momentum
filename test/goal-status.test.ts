import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb } from "../src/db.js";
import { FAKE_RUNNER_GOAL_COMPLETE_ENV } from "../src/fake-runner.js";
import { initGoal, type GoalInitSuccess } from "../src/goal-init.js";
import { executeIterationJob } from "../src/iteration-job.js";
import { loadGoalStatus } from "../src/goal-status.js";
import { reduceGoalIteration } from "../src/goal-reducer.js";
import { ensureIterationArtifactDir } from "../src/artifacts.js";
import { claimPendingGoalIterationJob } from "../src/queue-jobs.js";
import { writeRecoveryArtifact } from "../src/recovery-artifact.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix = "momentum-status-"): string {
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
  const dir = makeTempDir("momentum-status-repo-");
  runGit(dir, ["init", "--initial-branch=main", "--quiet"]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  runGit(dir, ["config", "user.name", "Test User"]);
  runGit(dir, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "README.md"), "init\n", "utf-8");
  runGit(dir, ["add", "README.md"]);
  runGit(dir, ["commit", "-m", "init", "--quiet"]);
  return dir;
}

function makeSpecContent(
  repoPath: string,
  title: string,
  verificationCommand = "true",
  maxIterations?: number
): string {
  const maxIterLine =
    maxIterations !== undefined ? `max_iterations: ${maxIterations}\n` : "";
  return `---
title: ${title}
repo: ${repoPath}
runner: fake
${maxIterLine}verification:
  - ${verificationCommand}
---
Apply the fixture file deterministically.
`;
}

type GoalSetup = GoalInitSuccess & { dataDir: string };

type SetupOptions = {
  verificationCommand?: string;
  maxIterations?: number;
  mode?: "foreground" | "queued";
};

function setupGoal(
  repo: string,
  title = "Prove status command",
  options: SetupOptions = {}
): GoalSetup {
  const dataDir = makeTempDir("momentum-status-data-");
  return setupGoalInDataDir(repo, dataDir, title, options);
}

function setupGoalInDataDir(
  repo: string,
  dataDir: string,
  title: string,
  options: SetupOptions = {}
): GoalSetup {
  const specDir = makeTempDir("momentum-status-spec-");
  const goalFile = path.join(specDir, "goal.md");
  fs.writeFileSync(
    goalFile,
    makeSpecContent(
      repo,
      title,
      options.verificationCommand ?? "true",
      options.maxIterations
    ),
    "utf-8"
  );
  const init = initGoal({
    goalPath: goalFile,
    dataDirOptions: { dataDir },
    mode: options.mode ?? "foreground"
  });
  if (!init.ok) {
    throw new Error(`initGoal failed: ${init.error}`);
  }
  return { ...init, dataDir };
}

describe("loadGoalStatus", () => {
  it("returns goal_not_found when the goalId does not exist", () => {
    const dataDir = makeTempDir("momentum-status-data-");
    const result = loadGoalStatus({
      goalId: "missing-goal",
      dataDirOptions: { dataDir }
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("goal_not_found");
    expect(result.error).toContain("missing-goal");
    expect(result.error).toContain(dataDir);
  });

  it("returns no_goals when omitting goalId on an empty data dir", () => {
    const dataDir = makeTempDir("momentum-status-data-");

    const result = loadGoalStatus({ dataDirOptions: { dataDir } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("no_goals");
    expect(result.error).toContain(dataDir);
  });

  it("rejects an empty goalId string", () => {
    const result = loadGoalStatus({ goalId: "   " });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_input");
  });

  it("reports an initialized goal with no iteration data yet", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Status init only");

    const result = loadGoalStatus({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.goalId).toBe(setup.goalId);
    expect(result.title).toBe("Status init only");
    expect(result.state).toBe("initialized");
    expect(result.repo).toBe(repo);
    expect(result.branch).toBe("momentum/status-init-only");
    expect(result.runner).toBe("fake");
    expect(result.maxIterations).toBe(1);
    expect(result.verification).toEqual(["true"]);
    expect(result.verificationTimeoutSec).toBe(900);
    expect(result.artifactDir).toBe(setup.artifactPaths.goalDir);
    expect(result.dataDir).toBe(setup.dataDir);
    expect(result.iteration).toBeNull();
    expect(result.latestJob).not.toBeNull();
    expect(result.latestJob?.state).toBe("pending");
    expect(result.latestJob?.iteration).toBe(1);
    expect(result.latestJob?.attemptCount).toBe(0);
    expect(result.latestJob?.startedAt).toBeNull();
    expect(result.latestJob?.finishedAt).toBeNull();
    expect(result.latestJob?.error).toBeNull();
    expect(result.latestJob?.leaseHolder).toBeNull();
    expect(result.latestJob?.leaseAcquiredAt).toBeNull();
    expect(result.latestJob?.leaseHeartbeatAt).toBeNull();
    expect(result.latestJob?.leaseExpiresAt).toBeNull();
    expect(result.artifactFiles.goalMd).toBe(true);
    expect(result.artifactFiles.handoffMd).toBe(true);
    expect(result.artifactFiles.handoffJson).toBe(true);
  });

  it("reports a verified commit with iteration metadata after a successful job", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Status verified commit");
    const db = openDb(setup.dataDir);
    try {
      const job = executeIterationJob({
        db,
        goalId: setup.goalId,
        jobId: setup.jobId,
        spec: setup.spec,
        artifactPaths: setup.artifactPaths
      });
      expect(job.ok).toBe(true);
      if (!job.ok || !job.iteration.ok) throw new Error("iteration failed");
    } finally {
      db.close();
    }

    const status = loadGoalStatus({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });

    expect(status.ok).toBe(true);
    if (!status.ok) return;

    expect(status.state).toBe("iteration_complete");
    expect(status.latestJob?.state).toBe("succeeded");
    expect(status.latestJob?.error).toBeNull();
    expect(status.latestJob?.startedAt).not.toBeNull();
    expect(status.latestJob?.finishedAt).not.toBeNull();
    expect(status.latestJob?.attemptCount).toBe(1);

    expect(status.iteration).not.toBeNull();
    expect(status.iteration?.iteration).toBe(1);
    expect(status.iteration?.branch).toBe("momentum/status-verified-commit");
    expect(status.iteration?.branchCreated).toBe(true);
    expect(status.iteration?.runnerSuccess).toBe(true);
    expect(status.iteration?.goalComplete).toBe(false);
    expect(status.iteration?.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(status.iteration?.baseHead).toMatch(/^[0-9a-f]{40}$/);
    expect(status.iteration?.postRunnerHead).toBe(status.iteration?.baseHead);
    expect(status.iteration?.failure).toBeNull();
    expect(typeof status.iteration?.commitMessage).toBe("string");

    expect(status.artifactFiles.promptMd).toBe(true);
    expect(status.artifactFiles.runnerLog).toBe(true);
    expect(status.artifactFiles.verificationLog).toBe(true);
    expect(status.artifactFiles.resultJson).toBe(true);

    expect(status.latestJob?.resultPath).toBe(setup.artifactPaths.resultJson);
    expect(status.latestJob?.errorPath).toBeNull();
  });

  it("reports failure metadata when the iteration fails verification", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Status failed verification", {
      verificationCommand: "false"
    });
    const db = openDb(setup.dataDir);
    try {
      const job = executeIterationJob({
        db,
        goalId: setup.goalId,
        jobId: setup.jobId,
        spec: setup.spec,
        artifactPaths: setup.artifactPaths
      });
      expect(job.ok).toBe(false);
    } finally {
      db.close();
    }

    const status = loadGoalStatus({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });

    expect(status.ok).toBe(true);
    if (!status.ok) return;

    expect(status.state).toBe("failed");
    expect(status.latestJob?.state).toBe("failed");
    expect(status.latestJob?.error).toContain("verification_failed");

    expect(status.iteration).not.toBeNull();
    expect(status.iteration?.failure).not.toBeNull();
    expect(status.iteration?.failure?.code).toBe("verification_failed");
    expect(status.iteration?.failure?.error).toContain("command_failed");
    expect(status.iteration?.commitSha).toBeNull();
    expect(status.iteration?.runnerSuccess).toBeNull();

    expect(status.latestJob?.resultPath).toBeNull();
    expect(status.latestJob?.errorPath).toBe(setup.artifactPaths.verificationLog);
  });

  it("reports null result/error paths for a pending job that has not yet executed", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Status pending paths");

    const result = loadGoalStatus({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.latestJob?.state).toBe("pending");
    expect(result.latestJob?.resultPath).toBeNull();
    expect(result.latestJob?.errorPath).toBeNull();
  });

  it("reports null reducer and a queued next-action hint before the worker runs", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Status pending action hint");

    const result = loadGoalStatus({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.currentIteration).toBe(0);
    expect(result.completionReason).toBeNull();
    expect(result.reducer).toBeNull();
    expect(result.nextJob).toBeNull();
    expect(result.nextAction).toContain("foreground");
    expect(result.nextAction).toContain(setup.jobId);
  });

  it("surfaces the reducer max_iterations_reached decision plus null nextJob on a 1-iteration goal", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Status reducer max iter", { mode: "queued" });
    const db = openDb(setup.dataDir);
    try {
      const job = executeIterationJob({
        db,
        goalId: setup.goalId,
        jobId: setup.jobId,
        spec: setup.spec,
        artifactPaths: setup.artifactPaths
      });
      if (!job.ok || !job.iteration.ok) throw new Error("iteration failed");
      const reducer = reduceGoalIteration({
        db,
        goalId: setup.goalId,
        jobId: setup.jobId
      });
      expect(reducer.decision).toBe("max_iterations_reached");
    } finally {
      db.close();
    }

    const status = loadGoalStatus({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });

    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.state).toBe("max_iterations_reached");
    expect(status.currentIteration).toBe(1);
    expect(status.completionReason).toBe("max_iterations_reached:1");
    expect(status.reducer).not.toBeNull();
    expect(status.reducer?.decision).toBe("max_iterations_reached");
    expect(status.reducer?.iteration).toBe(1);
    expect(status.reducer?.jobId).toBe(setup.jobId);
    expect(status.reducer?.goalState).toBe("max_iterations_reached");
    expect(status.reducer?.completionReason).toBe("max_iterations_reached:1");
    expect(status.reducer?.maxIterations).toBe(1);
    expect(status.reducer?.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(status.reducer?.nextJob).toBeNull();
    expect(status.nextJob).toBeNull();
    expect(status.nextAction).toContain("max_iterations");
  });

  it("surfaces the reducer continue decision and the queued next iteration job", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Status reducer continue", {
      maxIterations: 2,
      mode: "queued"
    });
    expect(setup.spec.max_iterations).toBe(2);

    const db = openDb(setup.dataDir);
    let nextJobId: string;
    try {
      const job = executeIterationJob({
        db,
        goalId: setup.goalId,
        jobId: setup.jobId,
        spec: setup.spec,
        artifactPaths: setup.artifactPaths
      });
      if (!job.ok || !job.iteration.ok) throw new Error("iteration failed");
      const reducer = reduceGoalIteration({
        db,
        goalId: setup.goalId,
        jobId: setup.jobId
      });
      expect(reducer.decision).toBe("continue");
      expect(reducer.nextJob?.iteration).toBe(2);
      nextJobId = reducer.nextJob!.jobId;
    } finally {
      db.close();
    }

    const status = loadGoalStatus({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });

    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.state).toBe("queued");
    expect(status.currentIteration).toBe(1);
    expect(status.completionReason).toBeNull();
    expect(status.reducer?.decision).toBe("continue");
    expect(status.reducer?.nextJob?.jobId).toBe(nextJobId);
    expect(status.reducer?.nextJob?.iteration).toBe(2);
    expect(status.reducer?.nextJob?.idempotencyKey).toBe(
      `goal:${setup.goalId}:iteration:2`
    );
    expect(status.nextJob).not.toBeNull();
    expect(status.nextJob?.jobId).toBe(nextJobId);
    expect(status.nextJob?.state).toBe("pending");
    expect(status.nextJob?.iteration).toBe(2);
    expect(status.nextAction).toContain("worker run");
    expect(status.nextAction).toContain(nextJobId);
  });

  it("resolves artifact paths for the latest executed iteration", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Status iteration two artifacts", {
      maxIterations: 2,
      mode: "queued"
    });

    const db = openDb(setup.dataDir);
    try {
      const firstJob = executeIterationJob({
        db,
        goalId: setup.goalId,
        jobId: setup.jobId,
        spec: setup.spec,
        artifactPaths: setup.artifactPaths
      });
      if (!firstJob.ok || !firstJob.iteration.ok) throw new Error("iteration failed");
      const firstReducer = reduceGoalIteration({
        db,
        goalId: setup.goalId,
        jobId: setup.jobId
      });
      if (firstReducer.decision !== "continue" || !firstReducer.nextJob) {
        throw new Error("expected next iteration job");
      }

      const iterationTwoPaths = ensureIterationArtifactDir(
        setup.dataDir,
        setup.goalId,
        2
      );
      const secondJob = executeIterationJob({
        db,
        goalId: setup.goalId,
        jobId: firstReducer.nextJob.jobId,
        spec: setup.spec,
        artifactPaths: iterationTwoPaths,
        iteration: 2
      });
      if (!secondJob.ok || !secondJob.iteration.ok) throw new Error("iteration failed");
      const secondReducer = reduceGoalIteration({
        db,
        goalId: setup.goalId,
        jobId: firstReducer.nextJob.jobId
      });
      expect(secondReducer.decision).toBe("max_iterations_reached");
    } finally {
      db.close();
    }

    const status = loadGoalStatus({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });

    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.currentIteration).toBe(2);
    expect(status.artifactPaths.iteration).toBe(2);
    expect(status.artifactPaths.resultJson).toContain(path.join("iterations", "2"));
    expect(status.artifactFiles.resultJson).toBe(true);
  });

  it("surfaces the queued idempotency key on a pending goal_iteration job", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Status queued idempotency", { mode: "queued" });

    const result = loadGoalStatus({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.latestJob?.state).toBe("pending");
    expect(result.latestJob?.idempotencyKey).toBe(`goal:${setup.goalId}:iteration:1`);
    expect(result.latestJob?.leaseHolder).toBeNull();
    expect(result.latestJob?.leaseAcquiredAt).toBeNull();
    expect(result.latestJob?.leaseHeartbeatAt).toBeNull();
    expect(result.latestJob?.leaseExpiresAt).toBeNull();
  });

  it("surfaces leaseHolder and lease timestamps after a worker claims the job", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Status claimed lease", { mode: "queued" });

    const db = openDb(setup.dataDir);
    const claimNow = 1_700_000_001_000;
    const leaseDurationMs = 30_000;
    try {
      const claim = claimPendingGoalIterationJob(db, {
        workerId: "worker-status-test",
        leaseDurationMs,
        now: claimNow
      });
      expect(claim.ok).toBe(true);
      if (!claim.ok) throw new Error("claim failed");
      expect(claim.job.id).toBe(setup.jobId);
    } finally {
      db.close();
    }

    const result = loadGoalStatus({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.latestJob?.state).toBe("claimed");
    expect(result.latestJob?.idempotencyKey).toBe(`goal:${setup.goalId}:iteration:1`);
    expect(result.latestJob?.leaseHolder).toBe("worker-status-test");
    expect(result.latestJob?.leaseAcquiredAt).toBe(claimNow);
    expect(result.latestJob?.leaseHeartbeatAt).toBe(claimNow);
    expect(result.latestJob?.leaseExpiresAt).toBe(claimNow + leaseDurationMs);
    expect(result.latestJob?.attemptCount).toBe(1);
  });

  it("aliases goalState to state and reports null latestCommitSha on a freshly initialized goal", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Status pinning fresh init");

    const result = loadGoalStatus({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.goalState).toBe("initialized");
    expect(result.goalState).toBe(result.state);
    expect(result.latestCommitSha).toBeNull();
  });

  it("surfaces the iteration commit as latestCommitSha after a successful run", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Status pinning commit");
    const db = openDb(setup.dataDir);
    try {
      const job = executeIterationJob({
        db,
        goalId: setup.goalId,
        jobId: setup.jobId,
        spec: setup.spec,
        artifactPaths: setup.artifactPaths
      });
      if (!job.ok || !job.iteration.ok) throw new Error("iteration failed");
    } finally {
      db.close();
    }

    const status = loadGoalStatus({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });

    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.goalState).toBe("iteration_complete");
    expect(status.goalState).toBe(status.state);
    expect(status.latestCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(status.latestCommitSha).toBe(status.iteration?.commitSha);
  });

  it("falls back to the reducer commit for latestCommitSha when the latest job is the queued next iteration", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Status pinning reducer fallback", {
      maxIterations: 2,
      mode: "queued"
    });

    const db = openDb(setup.dataDir);
    let reducerCommit: string | null = null;
    try {
      const job = executeIterationJob({
        db,
        goalId: setup.goalId,
        jobId: setup.jobId,
        spec: setup.spec,
        artifactPaths: setup.artifactPaths
      });
      if (!job.ok || !job.iteration.ok) throw new Error("iteration failed");
      const reducer = reduceGoalIteration({
        db,
        goalId: setup.goalId,
        jobId: setup.jobId
      });
      expect(reducer.decision).toBe("continue");
      reducerCommit = reducer.commitSha;
    } finally {
      db.close();
    }

    const status = loadGoalStatus({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });

    expect(status.ok).toBe(true);
    if (!status.ok) return;
    // The latest job is now the pending next iteration, so the iteration
    // summary tied to that pending job is null.
    expect(status.latestJob?.state).toBe("pending");
    expect(status.iteration).toBeNull();
    expect(reducerCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(status.latestCommitSha).toBe(reducerCommit);
    expect(status.latestCommitSha).toBe(status.reducer?.commitSha);
    expect(status.goalState).toBe("queued");
  });

  it("returns the most recently created goal when goalId is omitted", () => {
    const repo = initRepo();
    const dataDir = makeTempDir("momentum-status-data-");
    setupGoalInDataDir(repo, dataDir, "First status goal");
    const second = setupGoalInDataDir(repo, dataDir, "Second status goal");

    const result = loadGoalStatus({ dataDirOptions: { dataDir } });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.goalId).toBe(second.goalId);
    expect(result.title).toBe("Second status goal");
  });

  describe("nextActionDetail", () => {
    it("emits kind=resume_foreground for a fresh foreground goal", () => {
      const repo = initRepo();
      const setup = setupGoal(repo, "Next action foreground");

      const result = loadGoalStatus({
        goalId: setup.goalId,
        dataDirOptions: { dataDir: setup.dataDir }
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.nextActionDetail).not.toBeNull();
      expect(result.nextActionDetail?.kind).toBe("resume_foreground");
      expect(result.nextActionDetail?.jobId).toBe(setup.jobId);
      expect(result.nextActionDetail?.iteration).toBe(1);
      expect(result.nextActionDetail?.message).toBe(result.nextAction);
    });

    it("emits kind=run_worker for a fresh queued goal with no reducer yet", () => {
      const repo = initRepo();
      const setup = setupGoal(repo, "Next action queued pending", {
        mode: "queued"
      });

      const result = loadGoalStatus({
        goalId: setup.goalId,
        dataDirOptions: { dataDir: setup.dataDir }
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.reducer).toBeNull();
      expect(result.nextActionDetail).not.toBeNull();
      expect(result.nextActionDetail?.kind).toBe("run_worker");
      expect(result.nextActionDetail?.jobId).toBe(setup.jobId);
      expect(result.nextActionDetail?.iteration).toBe(1);
      expect(result.nextActionDetail?.message).toContain("worker run");
      expect(result.nextActionDetail?.message).toBe(result.nextAction);
    });

    it("emits kind=run_worker pointing at the reducer next job after continue", () => {
      const repo = initRepo();
      const setup = setupGoal(repo, "Next action continue", {
        maxIterations: 2,
        mode: "queued"
      });
      const db = openDb(setup.dataDir);
      let nextJobId: string;
      try {
        const job = executeIterationJob({
          db,
          goalId: setup.goalId,
          jobId: setup.jobId,
          spec: setup.spec,
          artifactPaths: setup.artifactPaths
        });
        if (!job.ok || !job.iteration.ok) throw new Error("iteration failed");
        const reducer = reduceGoalIteration({
          db,
          goalId: setup.goalId,
          jobId: setup.jobId
        });
        expect(reducer.decision).toBe("continue");
        nextJobId = reducer.nextJob!.jobId;
      } finally {
        db.close();
      }

      const result = loadGoalStatus({
        goalId: setup.goalId,
        dataDirOptions: { dataDir: setup.dataDir }
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.nextActionDetail?.kind).toBe("run_worker");
      expect(result.nextActionDetail?.jobId).toBe(nextJobId);
      expect(result.nextActionDetail?.iteration).toBe(2);
      expect(result.nextActionDetail?.message).toBe(result.nextAction);
    });

    it("emits kind=max_iterations_reached on a single-iteration goal terminal reducer", () => {
      const repo = initRepo();
      const setup = setupGoal(repo, "Next action max iter", {
        mode: "queued"
      });
      const db = openDb(setup.dataDir);
      try {
        const job = executeIterationJob({
          db,
          goalId: setup.goalId,
          jobId: setup.jobId,
          spec: setup.spec,
          artifactPaths: setup.artifactPaths
        });
        if (!job.ok || !job.iteration.ok) throw new Error("iteration failed");
        const reducer = reduceGoalIteration({
          db,
          goalId: setup.goalId,
          jobId: setup.jobId
        });
        expect(reducer.decision).toBe("max_iterations_reached");
      } finally {
        db.close();
      }

      const result = loadGoalStatus({
        goalId: setup.goalId,
        dataDirOptions: { dataDir: setup.dataDir }
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.nextActionDetail?.kind).toBe("max_iterations_reached");
      expect(result.nextActionDetail?.jobId).toBe(setup.jobId);
      expect(result.nextActionDetail?.iteration).toBe(1);
      expect(result.nextActionDetail?.message).toContain("max_iterations");
      expect(result.nextActionDetail?.message).toBe(result.nextAction);
    });

    it("emits kind=goal_complete when the reducer marks the goal completed", () => {
      const repo = initRepo();
      const setup = setupGoal(repo, "Next action goal complete", {
        maxIterations: 3,
        mode: "queued"
      });
      const db = openDb(setup.dataDir);
      const prev = process.env[FAKE_RUNNER_GOAL_COMPLETE_ENV];
      process.env[FAKE_RUNNER_GOAL_COMPLETE_ENV] = "1";
      try {
        const job = executeIterationJob({
          db,
          goalId: setup.goalId,
          jobId: setup.jobId,
          spec: setup.spec,
          artifactPaths: setup.artifactPaths
        });
        if (!job.ok || !job.iteration.ok) throw new Error("iteration failed");
        const reducer = reduceGoalIteration({
          db,
          goalId: setup.goalId,
          jobId: setup.jobId
        });
        expect(reducer.decision).toBe("goal_complete");
      } finally {
        db.close();
        if (prev === undefined) {
          delete process.env[FAKE_RUNNER_GOAL_COMPLETE_ENV];
        } else {
          process.env[FAKE_RUNNER_GOAL_COMPLETE_ENV] = prev;
        }
      }

      const result = loadGoalStatus({
        goalId: setup.goalId,
        dataDirOptions: { dataDir: setup.dataDir }
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.nextActionDetail?.kind).toBe("goal_complete");
      expect(result.nextActionDetail?.jobId).toBe(setup.jobId);
      expect(result.nextActionDetail?.iteration).toBe(1);
      expect(result.nextActionDetail?.message).toBe(result.nextAction);
    });

    it("emits kind=iteration_failed when verification fails terminally", () => {
      const repo = initRepo();
      const setup = setupGoal(repo, "Next action iteration failed", {
        verificationCommand: "false",
        mode: "queued"
      });
      const db = openDb(setup.dataDir);
      try {
        const job = executeIterationJob({
          db,
          goalId: setup.goalId,
          jobId: setup.jobId,
          spec: setup.spec,
          artifactPaths: setup.artifactPaths
        });
        expect(job.ok).toBe(false);
        const reducer = reduceGoalIteration({
          db,
          goalId: setup.goalId,
          jobId: setup.jobId
        });
        expect(reducer.decision).toBe("iteration_failed");
      } finally {
        db.close();
      }

      const result = loadGoalStatus({
        goalId: setup.goalId,
        dataDirOptions: { dataDir: setup.dataDir }
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.nextActionDetail?.kind).toBe("iteration_failed");
      expect(result.nextActionDetail?.jobId).toBe(setup.jobId);
      expect(result.nextActionDetail?.iteration).toBe(1);
      expect(result.nextActionDetail?.message).toContain("inspect");
      expect(result.nextActionDetail?.message).toBe(result.nextAction);
    });
  });

  describe("currentIterationDetail", () => {
    it("returns null when no goal job exists", () => {
      const dataDir = makeTempDir("momentum-status-data-");
      const result = loadGoalStatus({ dataDirOptions: { dataDir } });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("no_goals");
    });

    it("surfaces queuedAt with null startedAt/completedAt for a fresh queued goal", () => {
      const repo = initRepo();
      const setup = setupGoal(repo, "Current iteration queued", {
        mode: "queued"
      });

      const result = loadGoalStatus({
        goalId: setup.goalId,
        dataDirOptions: { dataDir: setup.dataDir }
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.latestJob?.state).toBe("pending");
      expect(result.currentIterationDetail).not.toBeNull();
      expect(result.currentIterationDetail?.number).toBe(1);
      expect(result.currentIterationDetail?.jobId).toBe(setup.jobId);
      expect(result.currentIterationDetail?.state).toBe("pending");
      expect(result.currentIterationDetail?.queuedAt).toBe(
        result.latestJob?.createdAt
      );
      expect(result.currentIterationDetail?.startedAt).toBeNull();
      expect(result.currentIterationDetail?.completedAt).toBeNull();
    });

    it("surfaces startedAt and completedAt after a successful queued iteration", () => {
      const repo = initRepo();
      const setup = setupGoal(repo, "Current iteration succeeded", {
        mode: "queued"
      });
      const db = openDb(setup.dataDir);
      try {
        const job = executeIterationJob({
          db,
          goalId: setup.goalId,
          jobId: setup.jobId,
          spec: setup.spec,
          artifactPaths: setup.artifactPaths
        });
        if (!job.ok || !job.iteration.ok) throw new Error("iteration failed");
      } finally {
        db.close();
      }

      const status = loadGoalStatus({
        goalId: setup.goalId,
        dataDirOptions: { dataDir: setup.dataDir }
      });

      expect(status.ok).toBe(true);
      if (!status.ok) return;
      expect(status.currentIterationDetail).not.toBeNull();
      expect(status.currentIterationDetail?.number).toBe(1);
      expect(status.currentIterationDetail?.jobId).toBe(setup.jobId);
      expect(status.currentIterationDetail?.state).toBe("succeeded");
      expect(status.currentIterationDetail?.queuedAt).toBe(
        status.latestJob?.createdAt
      );
      expect(status.currentIterationDetail?.startedAt).toBe(
        status.latestJob?.startedAt
      );
      expect(status.currentIterationDetail?.completedAt).toBe(
        status.latestJob?.finishedAt
      );
      expect(status.currentIterationDetail?.startedAt).not.toBeNull();
      expect(status.currentIterationDetail?.completedAt).not.toBeNull();
    });

    it("tracks the queued next iteration after the reducer enqueues it", () => {
      const repo = initRepo();
      const setup = setupGoal(repo, "Current iteration after continue", {
        maxIterations: 2,
        mode: "queued"
      });
      const db = openDb(setup.dataDir);
      let nextJobId: string;
      try {
        const job = executeIterationJob({
          db,
          goalId: setup.goalId,
          jobId: setup.jobId,
          spec: setup.spec,
          artifactPaths: setup.artifactPaths
        });
        if (!job.ok || !job.iteration.ok) throw new Error("iteration failed");
        const reducer = reduceGoalIteration({
          db,
          goalId: setup.goalId,
          jobId: setup.jobId
        });
        expect(reducer.decision).toBe("continue");
        nextJobId = reducer.nextJob!.jobId;
      } finally {
        db.close();
      }

      const status = loadGoalStatus({
        goalId: setup.goalId,
        dataDirOptions: { dataDir: setup.dataDir }
      });

      expect(status.ok).toBe(true);
      if (!status.ok) return;
      expect(status.currentIterationDetail?.number).toBe(2);
      expect(status.currentIterationDetail?.jobId).toBe(nextJobId);
      expect(status.currentIterationDetail?.state).toBe("pending");
      expect(status.currentIterationDetail?.startedAt).toBeNull();
      expect(status.currentIterationDetail?.completedAt).toBeNull();
      expect(typeof status.currentIterationDetail?.queuedAt).toBe("number");
    });

    it("surfaces completedAt with state=failed for a verification failure", () => {
      const repo = initRepo();
      const setup = setupGoal(repo, "Current iteration failed", {
        verificationCommand: "false",
        mode: "queued"
      });
      const db = openDb(setup.dataDir);
      try {
        const job = executeIterationJob({
          db,
          goalId: setup.goalId,
          jobId: setup.jobId,
          spec: setup.spec,
          artifactPaths: setup.artifactPaths
        });
        expect(job.ok).toBe(false);
      } finally {
        db.close();
      }

      const status = loadGoalStatus({
        goalId: setup.goalId,
        dataDirOptions: { dataDir: setup.dataDir }
      });

      expect(status.ok).toBe(true);
      if (!status.ok) return;
      expect(status.currentIterationDetail?.number).toBe(1);
      expect(status.currentIterationDetail?.jobId).toBe(setup.jobId);
      expect(status.currentIterationDetail?.state).toBe("failed");
      expect(status.currentIterationDetail?.startedAt).not.toBeNull();
      expect(status.currentIterationDetail?.completedAt).not.toBeNull();
    });

    it("surfaces startedAt with null completedAt after a worker claim and before execution", () => {
      const repo = initRepo();
      const setup = setupGoal(repo, "Current iteration claimed", {
        mode: "queued"
      });

      const db = openDb(setup.dataDir);
      const claimNow = 1_700_000_002_000;
      try {
        const claim = claimPendingGoalIterationJob(db, {
          workerId: "worker-current-iter",
          leaseDurationMs: 30_000,
          now: claimNow
        });
        expect(claim.ok).toBe(true);
        if (!claim.ok) throw new Error("claim failed");
      } finally {
        db.close();
      }

      const status = loadGoalStatus({
        goalId: setup.goalId,
        dataDirOptions: { dataDir: setup.dataDir }
      });

      expect(status.ok).toBe(true);
      if (!status.ok) return;
      expect(status.currentIterationDetail?.state).toBe("claimed");
      expect(status.currentIterationDetail?.startedAt).toBeNull();
      expect(status.currentIterationDetail?.completedAt).toBeNull();
    });
  });

  describe("artifacts", () => {
    it("exposes path+exists entries for goal- and iteration-scoped files on a fresh init", () => {
      const repo = initRepo();
      const setup = setupGoal(repo, "Status artifacts fresh init");

      const result = loadGoalStatus({
        goalId: setup.goalId,
        dataDirOptions: { dataDir: setup.dataDir }
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.artifacts.iteration).toBe(1);
      expect(result.artifacts.goalDir).toBe(setup.artifactPaths.goalDir);
      expect(result.artifacts.iterationDir).toBe(
        setup.artifactPaths.iterationDir
      );

      expect(result.artifacts.goalMd).toEqual({
        path: setup.artifactPaths.goalMd,
        exists: true
      });
      expect(result.artifacts.ledgerMd).toEqual({
        path: setup.artifactPaths.ledgerMd,
        exists: true
      });
      expect(result.artifacts.handoffMd).toEqual({
        path: setup.artifactPaths.handoffMd,
        exists: true
      });
      expect(result.artifacts.handoffJson).toEqual({
        path: setup.artifactPaths.handoffJson,
        exists: true
      });
      expect(result.artifacts.promptMd).toEqual({
        path: setup.artifactPaths.promptMd,
        exists: true
      });
      expect(result.artifacts.runnerLog).toEqual({
        path: setup.artifactPaths.runnerLog,
        exists: true
      });
      expect(result.artifacts.verificationLog).toEqual({
        path: setup.artifactPaths.verificationLog,
        exists: true
      });
      expect(result.artifacts.resultJson).toEqual({
        path: setup.artifactPaths.resultJson,
        exists: true
      });

      expect(result.artifactPaths.recoveryMd).toBe(
        path.join(setup.artifactPaths.goalDir, "recovery.md")
      );
      expect(result.artifactFiles.recoveryMd).toBe(false);
      expect(result.artifacts.recoveryMd).toEqual({
        path: setup.artifactPaths.recoveryMd,
        exists: false
      });
    });

    it("flips recoveryMd.exists to true after writeRecoveryArtifact lays the file down", () => {
      const repo = initRepo();
      const setup = setupGoal(repo, "Status surfaces recovery.md when present");

      writeRecoveryArtifact({
        dataDir: setup.dataDir,
        input: {
          goalId: setup.goalId,
          goalTitle: "Status surfaces recovery.md when present",
          iteration: 1,
          jobId: setup.jobId,
          daemonRunId: null,
          repoPath: repo,
          expectedCommit: null,
          currentCommit: null,
          reason: {
            code: "repo_dirty",
            message: "Worktree had uncommitted changes during stale recovery."
          },
          artifactPaths: {
            iterationDir: setup.artifactPaths.iterationDir,
            runnerLog: setup.artifactPaths.runnerLog,
            verificationLog: setup.artifactPaths.verificationLog,
            resultJson: setup.artifactPaths.resultJson
          },
          safeNextSteps: ["Inspect repo with `git status`."],
          classifiedAt: 1717000000000
        }
      });

      const result = loadGoalStatus({
        goalId: setup.goalId,
        dataDirOptions: { dataDir: setup.dataDir }
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.artifactFiles.recoveryMd).toBe(true);
      expect(result.artifacts.recoveryMd).toEqual({
        path: setup.artifactPaths.recoveryMd,
        exists: true
      });
    });

    it("walks artifacts forward to iteration N after the next iteration executes", () => {
      const repo = initRepo();
      const setup = setupGoal(repo, "Status artifacts iteration two", {
        maxIterations: 2,
        mode: "queued"
      });

      const db = openDb(setup.dataDir);
      try {
        const firstJob = executeIterationJob({
          db,
          goalId: setup.goalId,
          jobId: setup.jobId,
          spec: setup.spec,
          artifactPaths: setup.artifactPaths
        });
        if (!firstJob.ok || !firstJob.iteration.ok) {
          throw new Error("iteration failed");
        }
        const reducer = reduceGoalIteration({
          db,
          goalId: setup.goalId,
          jobId: setup.jobId
        });
        if (reducer.decision !== "continue" || !reducer.nextJob) {
          throw new Error("expected continue with next job");
        }

        const iterationTwoPaths = ensureIterationArtifactDir(
          setup.dataDir,
          setup.goalId,
          2
        );
        const secondJob = executeIterationJob({
          db,
          goalId: setup.goalId,
          jobId: reducer.nextJob.jobId,
          spec: setup.spec,
          artifactPaths: iterationTwoPaths,
          iteration: 2
        });
        if (!secondJob.ok || !secondJob.iteration.ok) {
          throw new Error("iteration failed");
        }
      } finally {
        db.close();
      }

      const status = loadGoalStatus({
        goalId: setup.goalId,
        dataDirOptions: { dataDir: setup.dataDir }
      });

      expect(status.ok).toBe(true);
      if (!status.ok) return;
      expect(status.artifacts.iteration).toBe(2);
      expect(status.artifacts.iterationDir).toContain(
        path.join("iterations", "2")
      );
      expect(status.artifacts.runnerLog.path).toBe(
        status.artifactPaths.runnerLog
      );
      expect(status.artifacts.resultJson.path).toContain(
        path.join("iterations", "2")
      );
      expect(status.artifacts.resultJson.exists).toBe(true);
      expect(status.artifacts.goalMd.exists).toBe(true);
      expect(status.artifacts.handoffJson.exists).toBe(true);
    });
  });

  describe("daemon surface", () => {
    it("returns daemon=null when no daemon has ever run", () => {
      const repo = initRepo();
      const setup = setupGoal(repo, "Status no daemon");

      const status = loadGoalStatus({
        goalId: setup.goalId,
        dataDirOptions: { dataDir: setup.dataDir }
      });

      expect(status.ok).toBe(true);
      if (!status.ok) return;
      expect(status.daemon).toBeNull();
    });

    it("surfaces the active daemon run with its stop-request state", async () => {
      const repo = initRepo();
      const setup = setupGoal(repo, "Status daemon stop request", {
        mode: "queued"
      });
      const { startDaemonRun, requestDaemonRunStop } = await import(
        "../src/daemon-runs.js"
      );
      const db = openDb(setup.dataDir);
      let runId: string;
      try {
        ({ runId } = startDaemonRun(db, {
          pid: 9876,
          host: "status-daemon-host",
          now: 1_700_000_000_000
        }));
        requestDaemonRunStop(db, {
          runId,
          reason: "operator-requested",
          now: 1_700_000_010_000
        });
      } finally {
        db.close();
      }

      const status = loadGoalStatus({
        goalId: setup.goalId,
        dataDirOptions: { dataDir: setup.dataDir }
      });

      expect(status.ok).toBe(true);
      if (!status.ok) return;
      expect(status.daemon).not.toBeNull();
      expect(status.daemon).toMatchObject({
        runId,
        state: "stop_requested",
        isActive: true,
        isTerminal: false,
        startedAt: 1_700_000_000_000,
        finishedAt: null,
        stopRequest: {
          requestedAt: 1_700_000_010_000,
          reason: "operator-requested"
        },
        activeJob: { jobId: null, lockId: null }
      });
    });

    it("falls back to the latest terminal daemon run when none are active", async () => {
      const repo = initRepo();
      const setup = setupGoal(repo, "Status daemon terminal");
      const { startDaemonRun, finishDaemonRun } = await import(
        "../src/daemon-runs.js"
      );
      const db = openDb(setup.dataDir);
      let runId: string;
      try {
        ({ runId } = startDaemonRun(db, {
          pid: 5555,
          now: 1_700_000_000_000
        }));
        finishDaemonRun(db, {
          runId,
          terminalState: "stopped",
          now: 1_700_000_005_000
        });
      } finally {
        db.close();
      }

      const status = loadGoalStatus({
        goalId: setup.goalId,
        dataDirOptions: { dataDir: setup.dataDir }
      });

      expect(status.ok).toBe(true);
      if (!status.ok) return;
      expect(status.daemon).not.toBeNull();
      expect(status.daemon).toMatchObject({
        runId,
        state: "stopped",
        isActive: false,
        isTerminal: true,
        finishedAt: 1_700_000_005_000
      });
    });
  });

  describe("stale recovery surface", () => {
    it("returns zeroed counts when no recovery activity has been recorded", () => {
      const repo = initRepo();
      const setup = setupGoal(repo, "Status no stale recovery");

      const status = loadGoalStatus({
        goalId: setup.goalId,
        dataDirOptions: { dataDir: setup.dataDir }
      });

      expect(status.ok).toBe(true);
      if (!status.ok) return;
      expect(status.staleRecovery).toEqual({
        recoveredRepoLockCount: 0,
        recoveredJobCount: 0,
        latestRecoveredRepoLockAt: null,
        latestRecoveredJobAt: null,
        staleRepoLockCount: 0,
        staleClaimedJobCount: 0,
        staleLeaseGraceMs: 5_000
      });
    });

    it("aggregates repo_lock.recovered and job.recovered events for this goal", async () => {
      const repo = initRepo();
      const setup = setupGoal(repo, "Status recovered events", {
        mode: "queued"
      });
      const { appendQueueEvent, QUEUE_EVENT_TYPES } = await import(
        "../src/events.js"
      );

      const db = openDb(setup.dataDir);
      try {
        appendQueueEvent(db, {
          goalId: setup.goalId,
          jobId: setup.jobId,
          type: QUEUE_EVENT_TYPES.REPO_LOCK_RECOVERED,
          payload: { recovered_at: 1_700_000_001_000 },
          createdAt: 1_700_000_001_000
        });
        appendQueueEvent(db, {
          goalId: setup.goalId,
          jobId: setup.jobId,
          type: QUEUE_EVENT_TYPES.REPO_LOCK_RECOVERED,
          payload: { recovered_at: 1_700_000_002_000 },
          createdAt: 1_700_000_002_000
        });
        appendQueueEvent(db, {
          goalId: setup.goalId,
          jobId: setup.jobId,
          type: QUEUE_EVENT_TYPES.JOB_RECOVERED,
          payload: { recovered_at: 1_700_000_003_000 },
          createdAt: 1_700_000_003_000
        });
      } finally {
        db.close();
      }

      const status = loadGoalStatus({
        goalId: setup.goalId,
        dataDirOptions: { dataDir: setup.dataDir }
      });
      expect(status.ok).toBe(true);
      if (!status.ok) return;
      expect(status.staleRecovery).toMatchObject({
        recoveredRepoLockCount: 2,
        recoveredJobCount: 1,
        latestRecoveredRepoLockAt: 1_700_000_002_000,
        latestRecoveredJobAt: 1_700_000_003_000
      });
    });

    it("ignores recovery events that belong to a different goal", async () => {
      const repo = initRepo();
      const setupA = setupGoal(repo, "Status stale recovery A", {
        mode: "queued"
      });
      const repoB = initRepo();
      const setupB = setupGoalInDataDir(
        repoB,
        setupA.dataDir,
        "Status stale recovery B",
        { mode: "queued" }
      );
      const { appendQueueEvent, QUEUE_EVENT_TYPES } = await import(
        "../src/events.js"
      );

      const db = openDb(setupA.dataDir);
      try {
        appendQueueEvent(db, {
          goalId: setupB.goalId,
          jobId: setupB.jobId,
          type: QUEUE_EVENT_TYPES.REPO_LOCK_RECOVERED,
          payload: { recovered_at: 1_700_000_010_000 },
          createdAt: 1_700_000_010_000
        });
        appendQueueEvent(db, {
          goalId: setupB.goalId,
          jobId: setupB.jobId,
          type: QUEUE_EVENT_TYPES.JOB_RECOVERED,
          payload: { recovered_at: 1_700_000_011_000 },
          createdAt: 1_700_000_011_000
        });
      } finally {
        db.close();
      }

      const status = loadGoalStatus({
        goalId: setupA.goalId,
        dataDirOptions: { dataDir: setupA.dataDir }
      });
      expect(status.ok).toBe(true);
      if (!status.ok) return;
      expect(status.staleRecovery.recoveredRepoLockCount).toBe(0);
      expect(status.staleRecovery.recoveredJobCount).toBe(0);
      expect(status.staleRecovery.latestRecoveredRepoLockAt).toBeNull();
      expect(status.staleRecovery.latestRecoveredJobAt).toBeNull();
    });

    it("counts active+expired repo locks and claimed jobs pending manual recovery", async () => {
      const repo = initRepo();
      const setup = setupGoal(repo, "Status pending stale", {
        mode: "queued"
      });
      const { acquireRepoLock } = await import("../src/repo-locks.js");

      const db = openDb(setup.dataDir);
      try {
        const lock = acquireRepoLock(db, {
          repoRoot: "/tmp/momentum-status-pending-repo",
          holder: "worker-pending",
          goalId: setup.goalId,
          iteration: 1,
          jobId: setup.jobId,
          leaseExpiresAt: 1_000,
          now: 100
        });
        expect(lock.ok).toBe(true);

        const claim = claimPendingGoalIterationJob(db, {
          workerId: "worker-pending",
          leaseDurationMs: 1_800,
          now: 200
        });
        expect(claim.ok).toBe(true);
      } finally {
        db.close();
      }

      const status = loadGoalStatus({
        goalId: setup.goalId,
        dataDirOptions: { dataDir: setup.dataDir }
      });
      expect(status.ok).toBe(true);
      if (!status.ok) return;
      expect(status.staleRecovery.staleRepoLockCount).toBe(1);
      expect(status.staleRecovery.staleClaimedJobCount).toBe(1);
      expect(status.staleRecovery.staleLeaseGraceMs).toBe(5_000);
    });
  });
});
