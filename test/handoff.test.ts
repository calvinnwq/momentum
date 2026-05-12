import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb } from "../src/db.js";
import { initGoal, type GoalInitSuccess } from "../src/goal-init.js";
import { executeIterationJob } from "../src/iteration-job.js";
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
  verificationCommand = "true"
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
    dataDirOptions: { dataDir }
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
      error_path: null
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
});
