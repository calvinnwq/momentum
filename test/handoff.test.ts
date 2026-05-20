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
import { writeRecoveryArtifact } from "../src/recovery-artifact.js";
import { upsertSourceItem } from "../src/source-items.js";
import { ingestEvidenceRecord } from "../src/evidence-records.js";
import { createUpdateIntent } from "../src/update-intents.js";
import {
  claimIntentApply,
  finalizeIntentApply
} from "../src/intent-apply-audits.js";
import { DEFAULT_INTENT_STALE_THRESHOLD_MS } from "../src/project-rollup.js";

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

function makeAcpRuntimeUnavailableSpecContent(
  repoPath: string,
  title: string,
  command = "/definitely-missing-acp-runtime"
): string {
  return `---
title: ${title}
repo: ${repoPath}
runner: acp
acp:
  command: ${command}
verification:
  - true
---
Apply this goal via an ACP runtime that does not exist.
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
  return setupGoalInDataDir(repo, dataDir, title, verificationCommand, mode);
}

function setupGoalInDataDir(
  repo: string,
  dataDir: string,
  title: string,
  verificationCommand = "true",
  mode: "foreground" | "queued" = "foreground"
): GoalSetup {
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

function setupAcpRuntimeUnavailableGoal(
  repo: string,
  title = "Handoff ACP startup runtime unavailable",
  mode: "foreground" | "queued" = "foreground",
  command: string = "/definitely-missing-acp-runtime"
): GoalSetup {
  const dataDir = makeTempDir("momentum-handoff-data-");
  const specDir = makeTempDir("momentum-handoff-spec-");
  const goalFile = path.join(specDir, "goal.md");
  fs.writeFileSync(
    goalFile,
    makeAcpRuntimeUnavailableSpecContent(repo, title, command),
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

function makeStartupFailedAcpCommand(): string {
  const commandDir = makeTempDir("momentum-handoff-acp-startup-failed-");
  const commandPath = path.join(commandDir, "acp-startup-failed.sh");
  fs.writeFileSync(
    commandPath,
    "#!/bin/sh\necho should-not-run\n",
    "utf-8"
  );
  fs.chmodSync(commandPath, 0o644);
  return commandPath;
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
    expect(artifacts["recovery_md"]).toBe(setup.artifactPaths.recoveryMd);

    const artifactFiles = json["artifact_files"] as Record<string, unknown>;
    expect(artifactFiles).toMatchObject({
      goal_md: true,
      handoff_md: true,
      handoff_json: true,
      recovery_md: false,
      prompt_md: true,
      runner_log: true,
      verification_log: true,
      result_json: true
    });
  });

  it("surfaces recovery.md path + presence after writeRecoveryArtifact fires", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Handoff recovery surface");
    runVerifiedIteration(setup);

    writeRecoveryArtifact({
      dataDir: setup.dataDir,
      input: {
        goalId: setup.goalId,
        goalTitle: "Handoff recovery surface",
        iteration: 1,
        jobId: setup.jobId,
        daemonRunId: null,
        repoPath: repo,
        expectedCommit: null,
        currentCommit: null,
        reason: {
          code: "repo_dirty",
          message: "Repo was dirty when the stale claim recovered."
        },
        artifactPaths: {
          iterationDir: setup.artifactPaths.iterationDir,
          promptPath: setup.artifactPaths.promptMd,
          runnerLog: setup.artifactPaths.runnerLog,
          verificationLog: setup.artifactPaths.verificationLog,
          resultJson: setup.artifactPaths.resultJson
        },
        safeNextSteps: ["Run `git status` in the repo and reset manually."],
        classifiedAt: 1717000000000
      }
    });

    expectSuccess(
      writeHandoff({
        goalId: setup.goalId,
        dataDirOptions: { dataDir: setup.dataDir },
        now: () => 1700000000001
      })
    );

    const json = JSON.parse(
      fs.readFileSync(setup.artifactPaths.handoffJson, "utf-8")
    ) as Record<string, unknown>;

    const artifacts = json["artifacts"] as Record<string, unknown>;
    expect(artifacts["recovery_md"]).toBe(setup.artifactPaths.recoveryMd);
    const artifactFiles = json["artifact_files"] as Record<string, unknown>;
    expect(artifactFiles["recovery_md"]).toBe(true);

    const markdown = fs.readFileSync(setup.artifactPaths.handoffMd, "utf-8");
    expect(markdown).toContain(
      `recovery.md (present): ${setup.artifactPaths.recoveryMd}`
    );
  });

  it("renders recovery.md as (missing) in handoff markdown when never written", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Handoff recovery missing");
    runVerifiedIteration(setup);

    expectSuccess(
      writeHandoff({
        goalId: setup.goalId,
        dataDirOptions: { dataDir: setup.dataDir },
        now: () => 1700000000001
      })
    );

    const markdown = fs.readFileSync(setup.artifactPaths.handoffMd, "utf-8");
    expect(markdown).toContain(
      `recovery.md (missing): ${setup.artifactPaths.recoveryMd}`
    );
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

  it("captures runtime-unavailable startup failure in handoff failure summary and markdown", () => {
    if (process.platform === "win32") {
      return;
    }
    const repo = initRepo();
    const setup = setupAcpRuntimeUnavailableGoal(
      repo,
      "Handoff ACP startup runtime unavailable",
      "queued"
    );
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
      if (job.ok) return;
      expect(job.iteration.code).toBe("runtime_unavailable");
    } finally {
      db.close();
    }

    const result = writeHandoff({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });
    const handoff = expectSuccess(result);

    expect(handoff.data.iteration?.failure?.code).toBe("runtime_unavailable");
    expect(handoff.data.latestJob?.errorPath).toBe(setup.artifactPaths.runnerLog);

    const json = JSON.parse(
      fs.readFileSync(setup.artifactPaths.handoffJson, "utf-8")
    ) as Record<string, unknown>;
    const iteration = json["iteration"] as Record<string, unknown>;
    const failure = iteration["failure"] as Record<string, unknown>;
    expect(iteration["runner_success"]).toBeNull();
    expect(failure["code"]).toBe("runtime_unavailable");
    expect((json["latest_job"] as Record<string, unknown>)["error_path"]).toBe(
      setup.artifactPaths.runnerLog
    );

    const markdown = fs.readFileSync(setup.artifactPaths.handoffMd, "utf-8");
    expect(markdown).toContain("Failure: runtime_unavailable");
    expect(markdown).toContain(`Error path: ${setup.artifactPaths.runnerLog}`);
    expect(markdown).not.toContain(`Result path: ${setup.artifactPaths.resultJson}`);
  });

  it("captures startup-failed ACP startup error in handoff failure summary and markdown", () => {
    if (process.platform === "win32") {
      return;
    }
    const repo = initRepo();
    const startupFailedCommand = makeStartupFailedAcpCommand();

    const setup = setupAcpRuntimeUnavailableGoal(
      repo,
      "Handoff ACP startup startup_failed",
      "queued",
      startupFailedCommand
    );
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
      if (job.ok) {
        throw new Error("iteration unexpectedly succeeded");
      }
      expect(job.iteration.code).toBe("startup_failed");
      expect(job.iteration.error).toContain("acp failed to start");
    } finally {
      db.close();
    }

    const result = writeHandoff({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });
    const handoff = expectSuccess(result);

    expect(handoff.data.iteration?.failure?.code).toBe("startup_failed");
    expect(handoff.data.latestJob?.errorPath).toBe(setup.artifactPaths.runnerLog);

    const json = JSON.parse(
      fs.readFileSync(setup.artifactPaths.handoffJson, "utf-8")
    ) as Record<string, unknown>;
    const iteration = json["iteration"] as Record<string, unknown>;
    const failure = iteration["failure"] as Record<string, unknown>;
    expect(iteration["runner_success"]).toBeNull();
    expect(failure["code"]).toBe("startup_failed");
    expect((json["latest_job"] as Record<string, unknown>)["error_path"]).toBe(
      setup.artifactPaths.runnerLog
    );

    const markdown = fs.readFileSync(setup.artifactPaths.handoffMd, "utf-8");
    expect(markdown).toContain("Failure: startup_failed");
    expect(markdown).toContain(`Error path: ${setup.artifactPaths.runnerLog}`);
    expect(markdown).not.toContain(`Result path: ${setup.artifactPaths.resultJson}`);
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

  it("records a malformed runner result parse error in handoff output", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Handoff malformed result");
    runVerifiedIteration(setup);

    fs.writeFileSync(setup.artifactPaths.resultJson, "{not valid json", "utf-8");

    const result = writeHandoff({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });
    const handoff = expectSuccess(result);

    expect(handoff.data.runnerResult).toBeNull();
    expect(handoff.data.runnerResultError).toContain("malformed runner result JSON");

    const json = JSON.parse(
      fs.readFileSync(setup.artifactPaths.handoffJson, "utf-8")
    ) as Record<string, unknown>;
    expect(json["runner_result"]).toBeNull();
    expect(json["runner_result_error"]).toContain("malformed runner result JSON");

    const markdown = fs.readFileSync(setup.artifactPaths.handoffMd, "utf-8");
    expect(markdown).toContain("No runner result captured.");
    expect(markdown).toContain("Runner result read error:");
    expect(markdown).toContain("malformed runner result JSON");
  });

  it("records a missing runner result read error in handoff output", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Handoff missing result");
    runVerifiedIteration(setup);

    fs.rmSync(setup.artifactPaths.resultJson);

    const result = writeHandoff({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });
    const handoff = expectSuccess(result);

    expect(handoff.data.runnerResult).toBeNull();
    expect(handoff.data.runnerResultError).toContain("failed to read runner result file");

    const json = JSON.parse(
      fs.readFileSync(setup.artifactPaths.handoffJson, "utf-8")
    ) as Record<string, unknown>;
    expect(json["runner_result"]).toBeNull();
    expect(json["runner_result_error"]).toContain("failed to read runner result file");

    const markdown = fs.readFileSync(setup.artifactPaths.handoffMd, "utf-8");
    expect(markdown).toContain("No runner result captured.");
    expect(markdown).toContain("Runner result read error:");
    expect(markdown).toContain("failed to read runner result file");
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

  it("captures goal-scoped stale-recovery activity in JSON and markdown", async () => {
    const repo = initRepo();
    const setup = setupGoal(
      repo,
      "Handoff stale recovery",
      "true",
      "queued"
    );
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
        type: QUEUE_EVENT_TYPES.JOB_RECOVERED,
        payload: { recovered_at: 1_700_000_002_000 },
        createdAt: 1_700_000_002_000
      });
    } finally {
      db.close();
    }

    const result = writeHandoff({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });
    const handoff = expectSuccess(result);

    expect(handoff.data.staleRecovery).toMatchObject({
      recoveredRepoLockCount: 1,
      recoveredJobCount: 1,
      latestRecoveredRepoLockAt: 1_700_000_001_000,
      latestRecoveredJobAt: 1_700_000_002_000,
      staleRepoLockCount: 0,
      staleClaimedJobCount: 0,
      staleLeaseGraceMs: 5_000
    });

    const json = JSON.parse(
      fs.readFileSync(setup.artifactPaths.handoffJson, "utf-8")
    ) as Record<string, unknown>;
    expect(json["stale_recovery"]).toEqual({
      recovered_repo_lock_count: 1,
      recovered_job_count: 1,
      latest_recovered_repo_lock_at: 1_700_000_001_000,
      latest_recovered_job_at: 1_700_000_002_000,
      stale_repo_lock_count: 0,
      stale_claimed_job_count: 0,
      stale_lease_grace_ms: 5_000
    });

    const markdown = fs.readFileSync(setup.artifactPaths.handoffMd, "utf-8");
    expect(markdown).toContain("## Stale recovery");
    expect(markdown).toContain(
      "Recovered repo locks: 1 (latest at 1700000001000)"
    );
    expect(markdown).toContain("Recovered jobs: 1 (latest at 1700000002000)");
  });

  it("renders the no-activity stale recovery section when nothing has been recovered", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Handoff stale recovery empty");

    const result = writeHandoff({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });
    const handoff = expectSuccess(result);
    expect(handoff.data.staleRecovery).toEqual({
      recoveredRepoLockCount: 0,
      recoveredJobCount: 0,
      latestRecoveredRepoLockAt: null,
      latestRecoveredJobAt: null,
      staleRepoLockCount: 0,
      staleClaimedJobCount: 0,
      staleLeaseGraceMs: 5_000
    });

    const markdown = fs.readFileSync(setup.artifactPaths.handoffMd, "utf-8");
    expect(markdown).toContain("## Stale recovery");
    expect(markdown).toContain(
      "No stale-lease recovery activity recorded for this goal."
    );
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

  it("emits a MOMENTUM.md policy block in JSON and markdown when no policy file is present", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Handoff no policy");

    expectSuccess(
      writeHandoff({
        goalId: setup.goalId,
        dataDirOptions: { dataDir: setup.dataDir }
      })
    );

    const json = JSON.parse(
      fs.readFileSync(setup.artifactPaths.handoffJson, "utf-8")
    ) as Record<string, unknown>;
    expect(json["policy"]).toMatchObject({
      configured: true,
      present: false,
      has_notes: false,
      error: null
    });

    const markdown = fs.readFileSync(setup.artifactPaths.handoffMd, "utf-8");
    expect(markdown).toContain("## Policy (MOMENTUM.md)");
    expect(markdown).toContain("Not present at:");
  });

  it("emits a MOMENTUM.md policy block with config and notes when a policy file is present", () => {
    const repo = initRepo();
    fs.writeFileSync(
      path.join(repo, "MOMENTUM.md"),
      `---\nrunner: trusted-shell\nverification:\n  - pnpm test\nverification_timeout_sec: 1200\n---\nNotes body.\n`,
      "utf-8"
    );
    const setup = setupGoal(repo, "Handoff with policy");

    expectSuccess(
      writeHandoff({
        goalId: setup.goalId,
        dataDirOptions: { dataDir: setup.dataDir }
      })
    );

    const json = JSON.parse(
      fs.readFileSync(setup.artifactPaths.handoffJson, "utf-8")
    ) as Record<string, unknown>;
    expect(json["policy"]).toMatchObject({
      configured: true,
      present: true,
      has_notes: true,
      error: null
    });
    expect((json["policy"] as Record<string, unknown>)["config"]).toEqual({
      runner: "trusted-shell",
      verification: ["pnpm test"],
      verification_timeout_sec: 1200
    });

    const markdown = fs.readFileSync(setup.artifactPaths.handoffMd, "utf-8");
    expect(markdown).toContain("## Policy (MOMENTUM.md)");
    expect(markdown).toContain("Loaded from:");
    expect(markdown).toContain("Default runner: trusted-shell");
    expect(markdown).toContain("Default verification: pnpm test");
    expect(markdown).toContain("Default verification_timeout_sec: 1200");
    expect(markdown).toContain("Policy notes: present");
  });

  it("writes linked source item summaries to handoff JSON only when present", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Handoff with source item");
    const db = openDb(setup.dataDir);
    try {
      upsertSourceItem(
        db,
        {
          adapterKind: "local-fixture",
          externalId: "fixture-2",
          externalKey: "SRC-2",
          url: "https://example.test/source/SRC-2",
          title: "Linked source context",
          status: "Todo",
          metadata: { opaque: "not surfaced here" },
          observedAt: 1700000002000,
          goalId: setup.goalId
        },
        { now: () => 1700000003000 }
      );
    } finally {
      db.close();
    }

    const result = writeHandoff({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });
    const handoff = expectSuccess(result);
    expect(handoff.data.sourceItems).toEqual([
      {
        id: expect.any(String),
        adapterKind: "local-fixture",
        externalId: "fixture-2",
        externalKey: "SRC-2",
        url: "https://example.test/source/SRC-2",
        title: "Linked source context",
        status: "Todo",
        lastObservedAt: 1700000002000
      }
    ]);

    const json = JSON.parse(
      fs.readFileSync(setup.artifactPaths.handoffJson, "utf-8")
    ) as Record<string, unknown>;
    expect(json["source_items"]).toEqual([
      {
        id: expect.any(String),
        adapter_kind: "local-fixture",
        external_id: "fixture-2",
        external_key: "SRC-2",
        url: "https://example.test/source/SRC-2",
        title: "Linked source context",
        status: "Todo",
        last_observed_at: 1700000002000
      }
    ]);
    expect(JSON.stringify(json["source_items"])).not.toContain("opaque");

    const markdown = fs.readFileSync(
      setup.artifactPaths.handoffMd,
      "utf-8"
    );
    expect(markdown).toContain("## Source items");
    expect(markdown).toContain("local-fixture/SRC-2");
    expect(markdown).toContain("Linked source context");
  });

  it("omits the source items section from handoff markdown when no items are linked", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Handoff without source items");

    const result = writeHandoff({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });
    const handoff = expectSuccess(result);
    expect(handoff.data.sourceItems).toEqual([]);

    const markdown = fs.readFileSync(
      setup.artifactPaths.handoffMd,
      "utf-8"
    );
    expect(markdown).not.toContain("## Source items");
  });

  it("writes latest evidence summaries to handoff JSON and markdown only when present", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Handoff with evidence");
    const db = openDb(setup.dataDir);
    try {
      ingestEvidenceRecord(
        db,
        {
          source: "agent-workflow",
          type: "plan_created",
          occurredAt: 1700000010000,
          summary: "Plan created for run cwfp-test-1",
          ingestKey: "agent-workflow:cwfp-test-1:plan:plan_created",
          artifactPath: "/tmp/.agent-workflows/cwfp-test-1/plan.json",
          goalId: setup.goalId,
          metadata: { runId: "cwfp-test-1" }
        },
        { now: () => 1700000010500 }
      );
      ingestEvidenceRecord(
        db,
        {
          source: "agent-workflow",
          type: "merge_complete",
          occurredAt: 1700000020000,
          summary: "Merge complete for run cwfp-test-1",
          ingestKey: "agent-workflow:cwfp-test-1:merge:merge_complete",
          artifactPath: "/tmp/.agent-workflows/cwfp-test-1/ledger.jsonl",
          goalId: setup.goalId,
          metadata: { mergeCommit: "deadbeef" }
        },
        { now: () => 1700000020500 }
      );
    } finally {
      db.close();
    }

    const result = writeHandoff({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });
    const handoff = expectSuccess(result);
    expect(handoff.data.latestEvidence).toHaveLength(2);
    expect(handoff.data.latestEvidence[0]).toMatchObject({
      source: "agent-workflow",
      type: "merge_complete",
      occurredAt: 1700000020000,
      summary: "Merge complete for run cwfp-test-1",
      formatVersion: 1,
      sourceItemId: null
    });

    const json = JSON.parse(
      fs.readFileSync(setup.artifactPaths.handoffJson, "utf-8")
    ) as Record<string, unknown>;
    const evidence = json["latest_evidence"] as Array<Record<string, unknown>>;
    expect(evidence).toHaveLength(2);
    expect(evidence[0]).toMatchObject({
      source: "agent-workflow",
      type: "merge_complete",
      occurred_at: 1700000020000,
      summary: "Merge complete for run cwfp-test-1",
      format_version: 1
    });
    expect(evidence[1]).toMatchObject({
      source: "agent-workflow",
      type: "plan_created",
      occurred_at: 1700000010000
    });

    const markdown = fs.readFileSync(
      setup.artifactPaths.handoffMd,
      "utf-8"
    );
    expect(markdown).toContain("## Latest evidence");
    expect(markdown).toContain("Merge complete for run cwfp-test-1");
    expect(markdown).toContain("Plan created for run cwfp-test-1");
  });

  it("omits the latest evidence section from handoff JSON and markdown when no evidence is linked", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Handoff without evidence");

    const result = writeHandoff({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });
    const handoff = expectSuccess(result);
    expect(handoff.data.latestEvidence).toEqual([]);

    const json = JSON.parse(
      fs.readFileSync(setup.artifactPaths.handoffJson, "utf-8")
    ) as Record<string, unknown>;
    expect(json).not.toHaveProperty("latest_evidence");

    const markdown = fs.readFileSync(
      setup.artifactPaths.handoffMd,
      "utf-8"
    );
    expect(markdown).not.toContain("## Latest evidence");
  });

  it("writes pending update intents to handoff JSON and markdown with stale flag when present", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Handoff with pending intents");
    const freshCreatedAt = Date.now() - 60_000;
    const staleCreatedAt = Date.now() - (DEFAULT_INTENT_STALE_THRESHOLD_MS + 60_000);
    const db = openDb(setup.dataDir);
    try {
      createUpdateIntent(
        db,
        {
          adapterKind: "linear",
          targetExternalId: "issue-fresh",
          intentType: "source_satisfied",
          payload: { status: "done" },
          reason: "Goal completed with verification evidence.",
          goalId: setup.goalId,
          idempotencyKey: "linear:issue-fresh:source_satisfied:fresh"
        },
        { now: () => freshCreatedAt }
      );
      createUpdateIntent(
        db,
        {
          adapterKind: "linear",
          targetExternalId: "issue-stale",
          intentType: "source_satisfied",
          payload: { status: "done" },
          reason: "Goal completed long ago.",
          goalId: setup.goalId,
          idempotencyKey: "linear:issue-stale:source_satisfied:stale"
        },
        { now: () => staleCreatedAt }
      );
    } finally {
      db.close();
    }

    const result = writeHandoff({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });
    const handoff = expectSuccess(result);
    expect(handoff.data.pendingUpdateIntents).toHaveLength(2);
    expect(handoff.data.totalPendingUpdateIntentCount).toBe(2);
    expect(handoff.data.truncatedPendingUpdateIntents).toBe(false);
    expect(handoff.data.intentStaleThresholdMs).toBe(
      DEFAULT_INTENT_STALE_THRESHOLD_MS
    );

    const byTarget = new Map(
      handoff.data.pendingUpdateIntents.map((intent) => [
        intent.targetExternalId,
        intent
      ])
    );
    const freshIntent = byTarget.get("issue-fresh");
    const staleIntent = byTarget.get("issue-stale");
    expect(freshIntent).toBeDefined();
    expect(staleIntent).toBeDefined();
    expect(freshIntent?.stale).toBe(false);
    expect(staleIntent?.stale).toBe(true);
    expect(freshIntent?.adapterKind).toBe("linear");
    expect(freshIntent?.intentType).toBe("source_satisfied");

    const json = JSON.parse(
      fs.readFileSync(setup.artifactPaths.handoffJson, "utf-8")
    ) as Record<string, unknown>;
    const intents = json["pending_update_intents"] as Array<
      Record<string, unknown>
    >;
    expect(json["pending_update_intent_count"]).toBe(2);
    expect(json["pending_update_intents_truncated"]).toBe(false);
    expect(intents).toHaveLength(2);
    expect(intents[0]).toMatchObject({
      adapter_kind: "linear",
      intent_type: "source_satisfied"
    });
    expect(json["intent_stale_threshold_ms"]).toBe(
      DEFAULT_INTENT_STALE_THRESHOLD_MS
    );

    const markdown = fs.readFileSync(setup.artifactPaths.handoffMd, "utf-8");
    expect(markdown).toContain("## Pending update intents");
    expect(markdown).toContain("(1 stale)");
    expect(markdown).toContain("issue-fresh");
    expect(markdown).toContain("issue-stale");
    expect(markdown).toContain("STALE");
    expect(markdown).toContain("`momentum intent list --status pending`");
  });

  it("omits pending update intents from handoff JSON and markdown when none are pending for the goal", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Handoff without intents");

    const result = writeHandoff({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });
    const handoff = expectSuccess(result);
    expect(handoff.data.pendingUpdateIntents).toEqual([]);
    expect(handoff.data.totalPendingUpdateIntentCount).toBe(0);
    expect(handoff.data.truncatedPendingUpdateIntents).toBe(false);
    expect(handoff.data.intentStaleThresholdMs).toBe(
      DEFAULT_INTENT_STALE_THRESHOLD_MS
    );

    const json = JSON.parse(
      fs.readFileSync(setup.artifactPaths.handoffJson, "utf-8")
    ) as Record<string, unknown>;
    expect(json).not.toHaveProperty("pending_update_intents");
    expect(json).not.toHaveProperty("intent_stale_threshold_ms");

    const markdown = fs.readFileSync(
      setup.artifactPaths.handoffMd,
      "utf-8"
    );
    expect(markdown).not.toContain("## Pending update intents");
  });

  it("scopes pending update intents in handoff to the goal under inspection", () => {
    const sharedDataDir = makeTempDir("momentum-handoff-shared-intent-");
    const repoA = initRepo();
    const repoB = initRepo();
    const setupA = setupGoalInDataDir(repoA, sharedDataDir, "Handoff intent goal A");
    const setupB = setupGoalInDataDir(repoB, sharedDataDir, "Handoff intent goal B");
    const db = openDb(sharedDataDir);
    try {
      createUpdateIntent(db, {
        adapterKind: "linear",
        targetExternalId: "issue-A",
        intentType: "source_satisfied",
        reason: "Goal A satisfied.",
        goalId: setupA.goalId,
        idempotencyKey: "linear:issue-A:source_satisfied:A"
      });
      createUpdateIntent(db, {
        adapterKind: "linear",
        targetExternalId: "issue-B",
        intentType: "source_satisfied",
        reason: "Goal B satisfied.",
        goalId: setupB.goalId,
        idempotencyKey: "linear:issue-B:source_satisfied:B"
      });
    } finally {
      db.close();
    }

    const handoffA = expectSuccess(
      writeHandoff({
        goalId: setupA.goalId,
        dataDirOptions: { dataDir: sharedDataDir }
      })
    );
    expect(handoffA.data.pendingUpdateIntents).toHaveLength(1);
    expect(handoffA.data.pendingUpdateIntents[0]?.targetExternalId).toBe(
      "issue-A"
    );

    const handoffB = expectSuccess(
      writeHandoff({
        goalId: setupB.goalId,
        dataDirOptions: { dataDir: sharedDataDir }
      })
    );
    expect(handoffB.data.pendingUpdateIntents).toHaveLength(1);
    expect(handoffB.data.pendingUpdateIntents[0]?.targetExternalId).toBe(
      "issue-B"
    );
  });

  it("excludes terminal update intents from handoff pending lists", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Handoff terminal intent excluded");
    const db = openDb(setup.dataDir);
    try {
      const pending = createUpdateIntent(db, {
        adapterKind: "linear",
        targetExternalId: "issue-pending",
        intentType: "source_satisfied",
        reason: "Still pending.",
        goalId: setup.goalId,
        idempotencyKey: "linear:issue-pending:source_satisfied:p"
      });
      expect(pending.created).toBe(true);
      const applied = createUpdateIntent(db, {
        adapterKind: "linear",
        targetExternalId: "issue-applied",
        intentType: "source_satisfied",
        reason: "Will be marked applied.",
        goalId: setup.goalId,
        idempotencyKey: "linear:issue-applied:source_satisfied:a"
      });
      expect(applied.created).toBe(true);
      // Manually flip one to applied so it is excluded by the pending filter.
      db.prepare("UPDATE update_intents SET status = 'applied' WHERE id = ?").run(
        applied.intent.id
      );
    } finally {
      db.close();
    }

    const handoff = expectSuccess(
      writeHandoff({
        goalId: setup.goalId,
        dataDirOptions: { dataDir: setup.dataDir }
      })
    );
    expect(handoff.data.pendingUpdateIntents).toHaveLength(1);
    expect(handoff.data.pendingUpdateIntents[0]?.targetExternalId).toBe(
      "issue-pending"
    );
  });

  it("reports total and truncation metadata when handoff pending intents are capped", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Handoff pending intents truncated");
    const db = openDb(setup.dataDir);
    try {
      for (let i = 0; i < 12; i += 1) {
        createUpdateIntent(db, {
          adapterKind: "linear",
          targetExternalId: `issue-${String(i).padStart(2, "0")}`,
          intentType: "source_satisfied",
          payload: { status: "done" },
          reason: `Pending intent ${i}.`,
          goalId: setup.goalId,
          idempotencyKey: `linear:issue-${i}:source_satisfied:handoff-truncate`
        });
      }
    } finally {
      db.close();
    }

    const handoff = expectSuccess(
      writeHandoff({
        goalId: setup.goalId,
        dataDirOptions: { dataDir: setup.dataDir }
      })
    );
    expect(handoff.data.pendingUpdateIntents).toHaveLength(10);
    expect(handoff.data.totalPendingUpdateIntentCount).toBe(12);
    expect(handoff.data.truncatedPendingUpdateIntents).toBe(true);

    const json = JSON.parse(
      fs.readFileSync(setup.artifactPaths.handoffJson, "utf-8")
    ) as Record<string, unknown>;
    expect(json["pending_update_intent_count"]).toBe(12);
    expect(json["pending_update_intents_truncated"]).toBe(true);
    expect(json["pending_update_intents"]).toHaveLength(10);

    const markdown = fs.readFileSync(setup.artifactPaths.handoffMd, "utf-8");
    expect(markdown).toContain("## Pending update intents (showing 10 of 12)");
    expect(markdown).toContain(
      "2 additional pending update intents are hidden"
    );
  });

  it("writes an empty external apply rollup when no audits exist", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Handoff external apply empty");

    const handoff = expectSuccess(
      writeHandoff({
        goalId: setup.goalId,
        dataDirOptions: { dataDir: setup.dataDir }
      })
    );
    expect(handoff.data.externalApply).toEqual({
      pendingIntentApplyStateCounts: { idle: 0, in_flight: 0, blocked: 0 },
      pendingAuditCounts: {
        claimed: 0,
        succeeded: 0,
        failed: 0,
        blocked: 0,
        audit_incomplete: 0
      },
      totalAttempts: 0,
      latestAttempt: null
    });

    const json = JSON.parse(
      fs.readFileSync(setup.artifactPaths.handoffJson, "utf-8")
    ) as Record<string, unknown>;
    expect(json["external_apply"]).toEqual({
      pending_intent_apply_state_counts: {
        idle: 0,
        in_flight: 0,
        blocked: 0
      },
      pending_audit_counts: {
        claimed: 0,
        succeeded: 0,
        failed: 0,
        blocked: 0,
        audit_incomplete: 0
      },
      total_attempts: 0,
      latest_attempt: null
    });

    const markdown = fs.readFileSync(setup.artifactPaths.handoffMd, "utf-8");
    expect(markdown).toContain("## External apply");
    expect(markdown).toContain(
      "- Pending intent apply state: idle=0, in_flight=0, blocked=0"
    );
    expect(markdown).toContain(
      "- Pending audits: total=0, succeeded=0, failed=0, claimed=0, blocked=0, audit_incomplete=0"
    );
    expect(markdown).toContain("- Latest attempt: (none)");
  });

  it("aggregates per-intent audit surfaces in handoff JSON and markdown", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Handoff external apply mixed");
    const baseNow = 1_700_000_000_000;
    const db = openDb(setup.dataDir);
    let succeededIntentId = "";
    let blockedIntentId = "";
    try {
      const succeeded = createUpdateIntent(
        db,
        {
          adapterKind: "linear",
          intentType: "source_satisfied",
          reason: "Goal completed",
          targetExternalId: "issue-handoff-succeeded",
          goalId: setup.goalId,
          idempotencyKey:
            "linear:issue-handoff-succeeded:source_satisfied:handoff"
        },
        { now: () => baseNow }
      );
      succeededIntentId = succeeded.intent.id;
      const blocked = createUpdateIntent(
        db,
        {
          adapterKind: "linear",
          intentType: "comment_requested",
          reason: "Followup",
          targetExternalId: "issue-handoff-blocked",
          goalId: setup.goalId,
          idempotencyKey:
            "linear:issue-handoff-blocked:comment_requested:handoff"
        },
        { now: () => baseNow + 1 }
      );
      blockedIntentId = blocked.intent.id;

      const claimSucceeded = claimIntentApply(db, {
        intentId: succeededIntentId,
        adapterKind: "linear",
        provider: "linear",
        target: {
          externalId: "issue-handoff-succeeded",
          externalKey: "NGX-HANDOFF-SUCCEEDED",
          url: "https://linear.app/example/issue/issue-handoff-succeeded",
          title: "Handoff succeeded issue"
        },
        operatorReason: "verified done",
        operatorActor: "operator@example.com",
        intentApplyPolicy: "external_apply_allowed",
        allowStatusMutation: false,
        mutationKind: "comment",
        previewSummary: "Linear comment: source_satisfied",
        idempotencyMarker: `momentum-intent:linear:${succeededIntentId}:deadbeef`,
        now: baseNow + 10
      });
      if (!claimSucceeded.ok) {
        throw new Error(`seed: claim succeeded failed (${claimSucceeded.code})`);
      }
      const finalizeSucceeded = finalizeIntentApply(db, {
        auditId: claimSucceeded.audit.id,
        lifecycleState: "succeeded",
        resultStatus: "ok",
        resultCode: "ok",
        resultMessage: "wrote comment",
        externalRefs: {
          commentId: "linear_comment_ok",
          commentUrl:
            "https://linear.app/example/issue/issue-handoff-succeeded#c1",
          stateTransitionId: null
        },
        now: baseNow + 11
      });
      if (!finalizeSucceeded.ok) {
        throw new Error(
          `seed: finalize succeeded failed (${finalizeSucceeded.code})`
        );
      }

      const claimBlocked = claimIntentApply(db, {
        intentId: blockedIntentId,
        adapterKind: "linear",
        provider: "linear",
        target: {
          externalId: "issue-handoff-blocked",
          externalKey: "NGX-HANDOFF-BLOCKED",
          url: "https://linear.app/example/issue/issue-handoff-blocked",
          title: "Handoff blocked issue"
        },
        operatorReason: "needs followup",
        operatorActor: "operator@example.com",
        intentApplyPolicy: "external_apply_allowed",
        allowStatusMutation: false,
        mutationKind: "comment",
        previewSummary: "Linear comment: comment_requested",
        idempotencyMarker: `momentum-intent:linear:${blockedIntentId}:deadbeef`,
        now: baseNow + 20
      });
      if (!claimBlocked.ok) {
        throw new Error(`seed: claim blocked failed (${claimBlocked.code})`);
      }
      const finalizeBlocked = finalizeIntentApply(db, {
        auditId: claimBlocked.audit.id,
        lifecycleState: "audit_incomplete",
        resultStatus: "wrote_no_audit",
        resultCode: "audit_finalize_failed",
        resultMessage: "linear succeeded but audit could not be finalized",
        externalRefs: {
          commentId: "linear_comment_late",
          commentUrl:
            "https://linear.app/example/issue/issue-handoff-blocked#c2",
          stateTransitionId: null
        },
        now: baseNow + 21
      });
      if (!finalizeBlocked.ok) {
        throw new Error(
          `seed: finalize blocked failed (${finalizeBlocked.code})`
        );
      }
    } finally {
      db.close();
    }

    const handoff = expectSuccess(
      writeHandoff({
        goalId: setup.goalId,
        dataDirOptions: { dataDir: setup.dataDir }
      })
    );
    expect(handoff.data.externalApply.pendingIntentApplyStateCounts).toEqual({
      idle: 1,
      in_flight: 0,
      blocked: 1
    });
    expect(handoff.data.externalApply.pendingAuditCounts).toEqual({
      claimed: 0,
      succeeded: 1,
      failed: 0,
      blocked: 0,
      audit_incomplete: 1
    });
    expect(handoff.data.externalApply.totalAttempts).toBe(2);
    expect(handoff.data.externalApply.latestAttempt?.intentId).toBe(
      blockedIntentId
    );
    expect(handoff.data.externalApply.latestAttempt?.lifecycleState).toBe(
      "audit_incomplete"
    );

    const json = JSON.parse(
      fs.readFileSync(setup.artifactPaths.handoffJson, "utf-8")
    ) as Record<string, unknown>;
    const externalApply = json["external_apply"] as Record<string, unknown>;
    expect(externalApply).toMatchObject({
      pending_intent_apply_state_counts: {
        idle: 1,
        in_flight: 0,
        blocked: 1
      },
      pending_audit_counts: {
        claimed: 0,
        succeeded: 1,
        failed: 0,
        blocked: 0,
        audit_incomplete: 1
      },
      total_attempts: 2
    });
    const latest = externalApply["latest_attempt"] as Record<string, unknown>;
    expect(latest["intent_id"]).toBe(blockedIntentId);
    expect(latest["lifecycle_state"]).toBe("audit_incomplete");
    expect(latest["result_code"]).toBe("audit_finalize_failed");

    const intents = json["pending_update_intents"] as Array<
      Record<string, unknown>
    >;
    expect(intents).toHaveLength(2);
    const succeededRow = intents.find(
      (intent) => intent["intent_id"] === succeededIntentId
    );
    expect(succeededRow?.["external_apply"]).toMatchObject({
      apply_state: "idle",
      total_attempts: 1,
      counts: {
        claimed: 0,
        succeeded: 1,
        failed: 0,
        blocked: 0,
        audit_incomplete: 0
      }
    });
    const succeededLatest = (succeededRow?.["external_apply"] as Record<
      string,
      unknown
    >)["latest_attempt"] as Record<string, unknown>;
    expect(succeededLatest["lifecycle_state"]).toBe("succeeded");
    expect(succeededLatest["result_code"]).toBe("ok");

    const blockedRow = intents.find(
      (intent) => intent["intent_id"] === blockedIntentId
    );
    expect(blockedRow?.["external_apply"]).toMatchObject({
      apply_state: "blocked",
      total_attempts: 1,
      counts: {
        claimed: 0,
        succeeded: 0,
        failed: 0,
        blocked: 0,
        audit_incomplete: 1
      }
    });

    const markdown = fs.readFileSync(setup.artifactPaths.handoffMd, "utf-8");
    expect(markdown).toContain("## External apply");
    expect(markdown).toContain(
      "- Pending intent apply state: idle=1, in_flight=0, blocked=1"
    );
    expect(markdown).toContain(
      "- Pending audits: total=2, succeeded=1, failed=0, claimed=0, blocked=0, audit_incomplete=1"
    );
    expect(markdown).toContain(
      `- Latest attempt: ${latest["id"]} audit_incomplete intent=${blockedIntentId}`
    );
    expect(markdown).toContain("apply=idle attempts=1 latest=succeeded");
    expect(markdown).toContain(
      "apply=blocked attempts=1 latest=audit_incomplete"
    );
  });
});
