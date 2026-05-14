import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb } from "../src/db.js";
import { initGoal, type GoalInitSuccess } from "../src/goal-init.js";
import { executeIterationJob } from "../src/iteration-job.js";
import { reduceGoalIteration } from "../src/goal-reducer.js";
import { ensureIterationArtifactDir } from "../src/artifacts.js";
import {
  HANDOFF_SCHEMA_VERSION,
  writeHandoff,
  type HandoffSuccess
} from "../src/handoff.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix = "momentum-handoff-"): string {
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
  const dir = makeTempDir("momentum-handoff-repo-");
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
  verificationCommand = "true"
): string {
  return `---
title: ${title}
repo: ${repoPath}
runner: fake
verification:
  - ${verificationCommand}
---
Apply the fixture file deterministically.
`;
}

type GoalSetup = GoalInitSuccess & { dataDir: string };

function setupGoal(
  repo: string,
  title = "Prove handoff command",
  verificationCommand = "true",
  mode: "foreground" | "queued" = "foreground"
): GoalSetup {
  const dataDir = makeTempDir("momentum-handoff-data-");
  const specDir = makeTempDir("momentum-handoff-spec-");
  const goalFile = path.join(specDir, "goal.md");
  fs.writeFileSync(
    goalFile,
    makeSpecContent(repo, title, verificationCommand),
    "utf-8"
  );
  const init = initGoal({
    goalPath: goalFile,
    dataDirOptions: { dataDir },
    mode
  });
  if (!init.ok) {
    throw new Error(`initGoal failed: ${init.error}`);
  }
  return { ...init, dataDir };
}

function runVerifiedIteration(setup: GoalSetup): void {
  const db = openDb(setup.dataDir);
  try {
    const job = executeIterationJob({
      db,
      goalId: setup.goalId,
      jobId: setup.jobId,
      spec: setup.spec,
      artifactPaths: setup.artifactPaths
    });
    if (!job.ok || !job.iteration.ok) {
      throw new Error("iteration unexpectedly failed");
    }
  } finally {
    db.close();
  }
}

function runFailedIteration(setup: GoalSetup): void {
  const db = openDb(setup.dataDir);
  try {
    const job = executeIterationJob({
      db,
      goalId: setup.goalId,
      jobId: setup.jobId,
      spec: setup.spec,
      artifactPaths: setup.artifactPaths
    });
    if (job.ok) {
      throw new Error("iteration unexpectedly succeeded");
    }
  } finally {
    db.close();
  }
}

function expectSuccess(result: ReturnType<typeof writeHandoff>): HandoffSuccess {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected handoff success");
  return result;
}

describe("writeHandoff", () => {
  it("rejects empty goalId strings via invalid_input", () => {
    const result = writeHandoff({ goalId: "   " });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_input");
  });

  it("propagates goal_not_found when the goalId is missing", () => {
    const dataDir = makeTempDir("momentum-handoff-data-");
    const result = writeHandoff({
      goalId: "no-such-goal",
      dataDirOptions: { dataDir }
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("goal_not_found");
    expect(result.error).toContain("no-such-goal");
  });

  it("propagates no_goals when the data dir has no goals", () => {
    const dataDir = makeTempDir("momentum-handoff-data-");
    const result = writeHandoff({ dataDirOptions: { dataDir } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("no_goals");
  });

  it("writes handoff.json with the verified-commit evidence after a successful iteration", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Handoff verified commit");
    runVerifiedIteration(setup);

    const result = writeHandoff({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir },
      now: () => 1700000000000
    });
    const handoff = expectSuccess(result);

    expect(handoff.handoffJsonPath).toBe(setup.artifactPaths.handoffJson);
    expect(handoff.handoffMdPath).toBe(setup.artifactPaths.handoffMd);
    expect(handoff.data.generatedAt).toBe(1700000000000);
    expect(handoff.data.schemaVersion).toBe(HANDOFF_SCHEMA_VERSION);

    const raw = fs.readFileSync(setup.artifactPaths.handoffJson, "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    const json = JSON.parse(raw) as Record<string, unknown>;

    expect(json).toMatchObject({
      schema_version: HANDOFF_SCHEMA_VERSION,
      generated_at: 1700000000000
    });

    const goal = json["goal"] as Record<string, unknown>;
    expect(goal).toMatchObject({
      id: setup.goalId,
      title: "Handoff verified commit",
      state: "iteration_complete",
      repo,
      branch: "momentum/handoff-verified-commit",
      runner: "fake",
      max_iterations: 1,
      verification: ["true"],
      verification_timeout_sec: 900,
      data_dir: setup.dataDir
    });

    const iteration = json["iteration"] as Record<string, unknown>;
    expect(iteration["iteration"]).toBe(1);
    expect(iteration["runner_success"]).toBe(true);
    expect(iteration["goal_complete"]).toBe(false);
    expect(iteration["commit_sha"]).toMatch(/^[0-9a-f]{40}$/);
    expect(iteration["base_head"]).toMatch(/^[0-9a-f]{40}$/);
    expect(iteration["post_runner_head"]).toBe(iteration["base_head"]);
    expect(iteration["failure"]).toBeNull();
    expect(typeof iteration["commit_message"]).toBe("string");

    const runnerResult = json["runner_result"] as Record<string, unknown>;
    expect(runnerResult).toMatchObject({
      success: true,
      summary: "Applied fake runner fixture.",
      goal_complete: false
    });
    expect(runnerResult["key_changes_made"]).toEqual([
      "Created or modified fixture target file."
    ]);

    const latestJob = json["latest_job"] as Record<string, unknown>;
    expect(latestJob).toMatchObject({
      state: "succeeded",
      iteration: 1,
      type: "foreground_iteration",
      result_path: setup.artifactPaths.resultJson,
      error_path: null,
      idempotency_key: null,
      lease_holder: null,
      lease_acquired_at: null,
      lease_heartbeat_at: null,
      lease_expires_at: null
    });

    const artifacts = json["artifacts"] as Record<string, unknown>;
    expect(artifacts["handoff_md"]).toBe(setup.artifactPaths.handoffMd);
    expect(artifacts["handoff_json"]).toBe(setup.artifactPaths.handoffJson);

    const artifactFiles = json["artifact_files"] as Record<string, unknown>;
    expect(artifactFiles).toMatchObject({
      goal_md: true,
      handoff_md: true,
      handoff_json: true,
      prompt_md: true,
      runner_log: true,
      verification_log: true,
      result_json: true
    });
  });

  it("writes a human-readable handoff.md with the iteration summary", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Handoff markdown render");
    runVerifiedIteration(setup);

    expectSuccess(
      writeHandoff({
        goalId: setup.goalId,
        dataDirOptions: { dataDir: setup.dataDir },
        now: () => 1700000000001
      })
    );

    const markdown = fs.readFileSync(setup.artifactPaths.handoffMd, "utf-8");
    expect(markdown).toContain("# Momentum handoff: Handoff markdown render");
    expect(markdown).toContain(`Goal ID: ${setup.goalId}`);
    expect(markdown).toContain("State: iteration_complete");
    expect(markdown).toContain("Branch: momentum/handoff-markdown-render");
    expect(markdown).toContain("## Verification commands");
    expect(markdown).toContain("- `true`");
    expect(markdown).toContain("## Iteration");
    expect(markdown).toMatch(/Commit SHA: [0-9a-f]{40}/);
    expect(markdown).toContain("Runner success: true");
    expect(markdown).toContain("## Runner result");
    expect(markdown).toContain("Summary: Applied fake runner fixture.");
    expect(markdown).toContain("- Key changes made:");
    expect(markdown).toContain(`Data dir: ${setup.dataDir}`);
    expect(markdown).toContain(
      `verification.log (present): ${setup.artifactPaths.verificationLog}`
    );
    expect(markdown).toContain(`Result path: ${setup.artifactPaths.resultJson}`);
    expect(markdown).not.toContain("Error path:");
  });

  it("captures failure metadata when the iteration fails verification", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Handoff verification failure", "false");
    runFailedIteration(setup);

    const result = writeHandoff({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });
    const handoff = expectSuccess(result);

    expect(handoff.data.iteration?.failure?.code).toBe("verification_failed");

    const json = JSON.parse(
      fs.readFileSync(setup.artifactPaths.handoffJson, "utf-8")
    ) as Record<string, unknown>;
    const iteration = json["iteration"] as Record<string, unknown>;
    expect(iteration["commit_sha"]).toBeNull();
    expect(iteration["runner_success"]).toBeNull();
    const failure = iteration["failure"] as Record<string, unknown>;
    expect(failure["code"]).toBe("verification_failed");
    expect(typeof failure["error"]).toBe("string");

    expect((json["goal"] as Record<string, unknown>)["state"]).toBe("failed");
    const failedLatestJob = json["latest_job"] as Record<string, unknown>;
    expect(failedLatestJob["state"]).toBe("failed");
    expect(failedLatestJob["result_path"]).toBeNull();
    expect(failedLatestJob["error_path"]).toBe(
      setup.artifactPaths.verificationLog
    );

    const markdown = fs.readFileSync(setup.artifactPaths.handoffMd, "utf-8");
    expect(markdown).toContain("State: failed");
    expect(markdown).toContain("Failure: verification_failed");
    expect(markdown).toContain(
      `Error path: ${setup.artifactPaths.verificationLog}`
    );
    expect(markdown).not.toContain("Result path:");
  });

  it("returns null runner_result when result.json is the empty initializer", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Handoff initialized only");

    expectSuccess(
      writeHandoff({
        goalId: setup.goalId,
        dataDirOptions: { dataDir: setup.dataDir }
      })
    );

    const json = JSON.parse(
      fs.readFileSync(setup.artifactPaths.handoffJson, "utf-8")
    ) as Record<string, unknown>;
    expect(json["runner_result"]).toBeNull();
    expect(json["iteration"]).toBeNull();
    expect((json["latest_job"] as Record<string, unknown>)["state"]).toBe(
      "pending"
    );

    const markdown = fs.readFileSync(setup.artifactPaths.handoffMd, "utf-8");
    expect(markdown).toContain("No iteration has run yet.");
    expect(markdown).toContain("No runner result captured.");
    expect(markdown).not.toContain("Commit SHA:");
  });

  it("captures reducer decision, next job, and next-action hint when a reducer has run", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Handoff reducer continue", "true", "queued");
    // Force max_iterations = 2 so the reducer chooses CONTINUE on iteration 1.
    const db = openDb(setup.dataDir);
    db.prepare("UPDATE goals SET max_iterations = 2 WHERE id = ?").run(
      setup.goalId
    );
    let nextJobId: string;
    try {
      const job = executeIterationJob({
        db,
        goalId: setup.goalId,
        jobId: setup.jobId,
        spec: { ...setup.spec, max_iterations: 2 },
        artifactPaths: setup.artifactPaths
      });
      if (!job.ok || !job.iteration.ok) {
        throw new Error("iteration unexpectedly failed");
      }
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

    const result = writeHandoff({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });
    const handoff = expectSuccess(result);

    expect(handoff.data.reducer?.decision).toBe("continue");
    expect(handoff.data.reducer?.nextJob?.jobId).toBe(nextJobId);
    expect(handoff.data.nextJob?.jobId).toBe(nextJobId);
    expect(handoff.data.nextAction).toContain("worker run");

    const json = JSON.parse(
      fs.readFileSync(setup.artifactPaths.handoffJson, "utf-8")
    ) as Record<string, unknown>;
    const reducerJson = json["reducer"] as Record<string, unknown>;
    expect(reducerJson["decision"]).toBe("continue");
    expect(reducerJson["job_id"]).toBe(setup.jobId);
    expect(reducerJson["iteration"]).toBe(1);
    expect(reducerJson["goal_state"]).toBe("queued");
    const nextJobJson = reducerJson["next_job"] as Record<string, unknown>;
    expect(nextJobJson["job_id"]).toBe(nextJobId);
    expect(nextJobJson["iteration"]).toBe(2);
    expect(nextJobJson["idempotency_key"]).toBe(
      `goal:${setup.goalId}:iteration:2`
    );
    const topNextJob = json["next_job"] as Record<string, unknown>;
    expect(topNextJob["state"]).toBe("pending");
    expect(topNextJob["idempotency_key"]).toBe(
      `goal:${setup.goalId}:iteration:2`
    );
    expect(topNextJob["lease_holder"]).toBeNull();
    expect(topNextJob["lease_acquired_at"]).toBeNull();
    expect(topNextJob["lease_heartbeat_at"]).toBeNull();
    expect(topNextJob["lease_expires_at"]).toBeNull();
    expect(json["next_action"]).toEqual(handoff.data.nextAction);
    expect((json["goal"] as Record<string, unknown>)["current_iteration"]).toBe(
      1
    );
    expect(
      (json["goal"] as Record<string, unknown>)["completion_reason"]
    ).toBeNull();

    const markdown = fs.readFileSync(setup.artifactPaths.handoffMd, "utf-8");
    expect(markdown).toContain("## Reducer");
    expect(markdown).toContain("Decision: continue");
    expect(markdown).toContain(`Next job: ${nextJobId}`);
    expect(markdown).toContain("Next action: ");
  });

  it("records max_iterations_reached reducer state with null next job", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Handoff reducer max iter", "true", "queued");
    const db = openDb(setup.dataDir);
    try {
      const job = executeIterationJob({
        db,
        goalId: setup.goalId,
        jobId: setup.jobId,
        spec: setup.spec,
        artifactPaths: setup.artifactPaths
      });
      if (!job.ok || !job.iteration.ok) {
        throw new Error("iteration unexpectedly failed");
      }
      const reducer = reduceGoalIteration({
        db,
        goalId: setup.goalId,
        jobId: setup.jobId
      });
      expect(reducer.decision).toBe("max_iterations_reached");
    } finally {
      db.close();
    }

    const handoff = expectSuccess(
      writeHandoff({
        goalId: setup.goalId,
        dataDirOptions: { dataDir: setup.dataDir }
      })
    );

    expect(handoff.data.reducer?.decision).toBe("max_iterations_reached");
    expect(handoff.data.reducer?.nextJob).toBeNull();
    expect(handoff.data.nextJob).toBeNull();
    expect(handoff.data.nextAction).toContain("max_iterations");

    const json = JSON.parse(
      fs.readFileSync(setup.artifactPaths.handoffJson, "utf-8")
    ) as Record<string, unknown>;
    expect((json["goal"] as Record<string, unknown>)["state"]).toBe(
      "max_iterations_reached"
    );
    expect((json["goal"] as Record<string, unknown>)["completion_reason"]).toBe(
      "max_iterations_reached:1"
    );
    expect((json["reducer"] as Record<string, unknown>)["next_job"]).toBeNull();
    expect(json["next_job"]).toBeNull();
  });

  it("writes handoff artifacts from the latest executed iteration", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Handoff iteration two artifacts", "true", "queued");
    const db = openDb(setup.dataDir);
    db.prepare("UPDATE goals SET max_iterations = 2 WHERE id = ?").run(
      setup.goalId
    );
    let iterationTwoResultPath = "";
    try {
      const spec = { ...setup.spec, max_iterations: 2 };
      const firstJob = executeIterationJob({
        db,
        goalId: setup.goalId,
        jobId: setup.jobId,
        spec,
        artifactPaths: setup.artifactPaths
      });
      if (!firstJob.ok || !firstJob.iteration.ok) {
        throw new Error("iteration unexpectedly failed");
      }
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
      iterationTwoResultPath = iterationTwoPaths.resultJson;
      const secondJob = executeIterationJob({
        db,
        goalId: setup.goalId,
        jobId: firstReducer.nextJob.jobId,
        spec,
        artifactPaths: iterationTwoPaths,
        iteration: 2
      });
      if (!secondJob.ok || !secondJob.iteration.ok) {
        throw new Error("iteration unexpectedly failed");
      }
      const secondReducer = reduceGoalIteration({
        db,
        goalId: setup.goalId,
        jobId: firstReducer.nextJob.jobId
      });
      expect(secondReducer.decision).toBe("max_iterations_reached");
    } finally {
      db.close();
    }

    const handoff = expectSuccess(
      writeHandoff({
        goalId: setup.goalId,
        dataDirOptions: { dataDir: setup.dataDir }
      })
    );

    expect(handoff.data.artifactPaths.iteration).toBe(2);
    expect(handoff.data.artifactPaths.resultJson).toBe(iterationTwoResultPath);
    expect(handoff.data.runnerResult?.success).toBe(true);

    const json = JSON.parse(
      fs.readFileSync(setup.artifactPaths.handoffJson, "utf-8")
    ) as Record<string, unknown>;
    expect((json["artifacts"] as Record<string, unknown>)["result_json"]).toBe(
      iterationTwoResultPath
    );
    expect(json["runner_result"]).not.toBeNull();
  });

  it("pins goal_state and latest_commit_sha on the handoff JSON after a successful iteration", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Handoff goal state pinning");
    runVerifiedIteration(setup);

    const handoff = expectSuccess(
      writeHandoff({
        goalId: setup.goalId,
        dataDirOptions: { dataDir: setup.dataDir }
      })
    );

    expect(handoff.data.goalState).toBe("iteration_complete");
    expect(handoff.data.latestCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(handoff.data.latestCommitSha).toBe(handoff.data.iteration?.commitSha);

    const json = JSON.parse(
      fs.readFileSync(setup.artifactPaths.handoffJson, "utf-8")
    ) as Record<string, unknown>;
    expect(json["goal_state"]).toBe("iteration_complete");
    expect(json["latest_commit_sha"]).toBe(handoff.data.latestCommitSha);
    // The nested goal block keeps its existing `state` field for back-compat.
    expect((json["goal"] as Record<string, unknown>)["state"]).toBe(
      "iteration_complete"
    );
  });

  it("pins next_action_detail.kind=run_worker after a reducer continue", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Handoff next action continue", "true", "queued");
    const db = openDb(setup.dataDir);
    db.prepare("UPDATE goals SET max_iterations = 2 WHERE id = ?").run(
      setup.goalId
    );
    let nextJobId: string;
    try {
      const job = executeIterationJob({
        db,
        goalId: setup.goalId,
        jobId: setup.jobId,
        spec: { ...setup.spec, max_iterations: 2 },
        artifactPaths: setup.artifactPaths
      });
      if (!job.ok || !job.iteration.ok) {
        throw new Error("iteration unexpectedly failed");
      }
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

    const handoff = expectSuccess(
      writeHandoff({
        goalId: setup.goalId,
        dataDirOptions: { dataDir: setup.dataDir }
      })
    );

    expect(handoff.data.nextActionDetail?.kind).toBe("run_worker");
    expect(handoff.data.nextActionDetail?.jobId).toBe(nextJobId);
    expect(handoff.data.nextActionDetail?.iteration).toBe(2);
    expect(handoff.data.nextActionDetail?.message).toBe(handoff.data.nextAction);

    const json = JSON.parse(
      fs.readFileSync(setup.artifactPaths.handoffJson, "utf-8")
    ) as Record<string, unknown>;
    const detail = json["next_action_detail"] as Record<string, unknown>;
    expect(detail).toMatchObject({
      kind: "run_worker",
      job_id: nextJobId,
      iteration: 2,
      message: handoff.data.nextAction
    });
  });

  it("emits a null next_action_detail when no action is required", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Handoff next action terminal", "true", "queued");
    const db = openDb(setup.dataDir);
    try {
      const job = executeIterationJob({
        db,
        goalId: setup.goalId,
        jobId: setup.jobId,
        spec: setup.spec,
        artifactPaths: setup.artifactPaths
      });
      if (!job.ok || !job.iteration.ok) {
        throw new Error("iteration unexpectedly failed");
      }
      const reducer = reduceGoalIteration({
        db,
        goalId: setup.goalId,
        jobId: setup.jobId
      });
      expect(reducer.decision).toBe("max_iterations_reached");
    } finally {
      db.close();
    }

    const handoff = expectSuccess(
      writeHandoff({
        goalId: setup.goalId,
        dataDirOptions: { dataDir: setup.dataDir }
      })
    );

    expect(handoff.data.nextActionDetail?.kind).toBe("max_iterations_reached");
    expect(handoff.data.nextActionDetail?.message).toBe(handoff.data.nextAction);

    const json = JSON.parse(
      fs.readFileSync(setup.artifactPaths.handoffJson, "utf-8")
    ) as Record<string, unknown>;
    const detail = json["next_action_detail"] as Record<string, unknown>;
    expect(detail["kind"]).toBe("max_iterations_reached");
    expect(detail["job_id"]).toBe(setup.jobId);
    expect(detail["iteration"]).toBe(1);
  });

  it("emits null latest_commit_sha and the initialized goal_state before any iteration runs", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Handoff init no commit");

    const handoff = expectSuccess(
      writeHandoff({
        goalId: setup.goalId,
        dataDirOptions: { dataDir: setup.dataDir }
      })
    );

    expect(handoff.data.goalState).toBe("initialized");
    expect(handoff.data.latestCommitSha).toBeNull();

    const json = JSON.parse(
      fs.readFileSync(setup.artifactPaths.handoffJson, "utf-8")
    ) as Record<string, unknown>;
    expect(json["goal_state"]).toBe("initialized");
    expect(json["latest_commit_sha"]).toBeNull();
  });

  it("operates on the most recently created goal when goalId is omitted", () => {
    const repo = initRepo();
    const dataDir = makeTempDir("momentum-handoff-data-");

    const firstSpecDir = makeTempDir("momentum-handoff-spec-");
    const firstGoalFile = path.join(firstSpecDir, "goal.md");
    fs.writeFileSync(
      firstGoalFile,
      makeSpecContent(repo, "First handoff goal"),
      "utf-8"
    );
    const first = initGoal({
      goalPath: firstGoalFile,
      dataDirOptions: { dataDir }
    });
    if (!first.ok) throw new Error("first initGoal failed");

    const secondSpecDir = makeTempDir("momentum-handoff-spec-");
    const secondGoalFile = path.join(secondSpecDir, "goal.md");
    fs.writeFileSync(
      secondGoalFile,
      makeSpecContent(repo, "Second handoff goal"),
      "utf-8"
    );
    const second = initGoal({
      goalPath: secondGoalFile,
      dataDirOptions: { dataDir }
    });
    if (!second.ok) throw new Error("second initGoal failed");

    const handoff = expectSuccess(writeHandoff({ dataDirOptions: { dataDir } }));
    expect(handoff.data.goal.id).toBe(second.goalId);
    expect(handoff.data.goal.title).toBe("Second handoff goal");
  });

  it("pins current_iteration_detail to the queued iteration before execution", () => {
    const repo = initRepo();
    const setup = setupGoal(
      repo,
      "Handoff current iteration queued",
      "true",
      "queued"
    );

    const result = writeHandoff({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });
    const handoff = expectSuccess(result);
    expect(handoff.data.currentIterationDetail).not.toBeNull();
    expect(handoff.data.currentIterationDetail?.number).toBe(1);
    expect(handoff.data.currentIterationDetail?.jobId).toBe(setup.jobId);
    expect(handoff.data.currentIterationDetail?.state).toBe("pending");

    const json = JSON.parse(
      fs.readFileSync(setup.artifactPaths.handoffJson, "utf-8")
    ) as Record<string, unknown>;
    const detail = json["current_iteration_detail"] as Record<string, unknown>;
    expect(detail).toMatchObject({
      number: 1,
      job_id: setup.jobId,
      state: "pending",
      started_at: null,
      completed_at: null
    });
    expect(typeof detail["queued_at"]).toBe("number");
  });

  it("pins current_iteration_detail timestamps after a successful iteration", () => {
    const repo = initRepo();
    const setup = setupGoal(
      repo,
      "Handoff current iteration succeeded",
      "true",
      "queued"
    );
    runVerifiedIteration(setup);

    const handoff = expectSuccess(
      writeHandoff({
        goalId: setup.goalId,
        dataDirOptions: { dataDir: setup.dataDir }
      })
    );
    expect(handoff.data.currentIterationDetail?.state).toBe("succeeded");
    expect(handoff.data.currentIterationDetail?.startedAt).not.toBeNull();
    expect(handoff.data.currentIterationDetail?.completedAt).not.toBeNull();

    const json = JSON.parse(
      fs.readFileSync(setup.artifactPaths.handoffJson, "utf-8")
    ) as Record<string, unknown>;
    const detail = json["current_iteration_detail"] as Record<string, unknown>;
    expect(detail["number"]).toBe(1);
    expect(detail["job_id"]).toBe(setup.jobId);
    expect(detail["state"]).toBe("succeeded");
    expect(typeof detail["queued_at"]).toBe("number");
    expect(typeof detail["started_at"]).toBe("number");
    expect(typeof detail["completed_at"]).toBe("number");
  });

  it("surfaces handoff_write_failed when the artifact dir is unwritable", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Handoff write failure");

    fs.rmSync(setup.artifactPaths.goalDir, { recursive: true, force: true });
    fs.writeFileSync(setup.artifactPaths.goalDir, "not-a-dir", "utf-8");

    const result = writeHandoff({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("handoff_write_failed");
    expect(result.error).toContain("failed to write handoff artifacts");
  });

  it("captures the active daemon stop-request state in JSON and markdown", async () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Handoff daemon stop");
    const { startDaemonRun, requestDaemonRunStop } = await import(
      "../src/daemon-runs.js"
    );
    const db = openDb(setup.dataDir);
    let runId: string;
    try {
      ({ runId } = startDaemonRun(db, {
        pid: 7777,
        host: "handoff-daemon-host",
        now: 1_700_000_000_000
      }));
      requestDaemonRunStop(db, {
        runId,
        reason: "operator-requested",
        now: 1_700_000_002_000
      });
    } finally {
      db.close();
    }

    const result = writeHandoff({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });
    const handoff = expectSuccess(result);

    expect(handoff.data.daemon).toMatchObject({
      runId,
      state: "stop_requested",
      isActive: true,
      isTerminal: false,
      stopRequest: {
        requestedAt: 1_700_000_002_000,
        reason: "operator-requested"
      }
    });

    const json = JSON.parse(
      fs.readFileSync(setup.artifactPaths.handoffJson, "utf-8")
    ) as Record<string, unknown>;
    const daemon = json["daemon"] as Record<string, unknown>;
    expect(daemon).toMatchObject({
      run_id: runId,
      state: "stop_requested",
      is_active: true,
      is_terminal: false
    });
    const stopRequest = daemon["stop_request"] as Record<string, unknown>;
    expect(stopRequest).toEqual({
      requested_at: 1_700_000_002_000,
      reason: "operator-requested"
    });

    const markdown = fs.readFileSync(setup.artifactPaths.handoffMd, "utf-8");
    expect(markdown).toContain("## Daemon");
    expect(markdown).toContain(`Run ID: ${runId}`);
    expect(markdown).toContain("State: stop_requested (active)");
    expect(markdown).toContain("Stop requested at: 1700000002000");
    expect(markdown).toContain("reason: operator-requested");
  });

  it("writes daemon=null when no daemon has ever run for the data dir", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Handoff no daemon");

    const result = writeHandoff({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });
    const handoff = expectSuccess(result);
    expect(handoff.data.daemon).toBeNull();

    const json = JSON.parse(
      fs.readFileSync(setup.artifactPaths.handoffJson, "utf-8")
    ) as Record<string, unknown>;
    expect(json["daemon"]).toBeNull();

    const markdown = fs.readFileSync(setup.artifactPaths.handoffMd, "utf-8");
    expect(markdown).toContain("## Daemon");
    expect(markdown).toContain("No daemon run recorded for this data directory.");
  });
});
