import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureIterationArtifactDir } from "../src/artifacts.js";
import { openDb } from "../src/db.js";
import { initGoal, type GoalInitSuccess } from "../src/goal-init.js";
import { executeIterationJob } from "../src/iteration-job.js";
import { loadGoalLogs } from "../src/goal-logs.js";
import { ingestEvidenceRecord } from "../src/evidence-records.js";

const tempRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix = "momentum-logs-"): string {
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
  const dir = makeTempDir("momentum-logs-repo-");
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

function makeTrustedShellFailureSpecContent(
  repoPath: string,
  title: string
): string {
  return `---
title: ${title}
repo: ${repoPath}
runner: trusted-shell
trusted_shell:
  command: /bin/sh
  args:
    - -c
    - "echo from-stdout; echo from-stderr >&2; exit 2"
verification:
  - true
---
Apply the failure fixture deterministically.
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
  title = "Logs command target",
  options: { verificationCommand?: string; mode?: "foreground" | "queued" } = {}
): GoalSetup {
  const dataDir = makeTempDir("momentum-logs-data-");
  const specDir = makeTempDir("momentum-logs-spec-");
  const goalFile = path.join(specDir, "goal.md");
  fs.writeFileSync(
    goalFile,
    makeSpecContent(repo, title, options.verificationCommand ?? "true"),
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

function setupAcpRuntimeUnavailableGoal(
  repo: string,
  title = "Logs ACP startup runtime unavailable",
  mode: "foreground" | "queued" = "queued",
  command: string = "/definitely-missing-acp-runtime"
): GoalSetup {
  const dataDir = makeTempDir("momentum-logs-data-");
  const specDir = makeTempDir("momentum-logs-spec-");
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
  const commandDir = makeTempDir("momentum-logs-acp-startup-failed-");
  const commandPath = path.join(commandDir, "acp-startup-failed.sh");
  fs.writeFileSync(
    commandPath,
    "#!/bin/sh\necho should-not-run\n",
    "utf-8"
  );
  fs.chmodSync(commandPath, 0o644);
  return commandPath;
}

describe("loadGoalLogs", () => {
  it("returns goal_not_found when the goalId does not exist", () => {
    const dataDir = makeTempDir();
    const result = loadGoalLogs({
      goalId: "missing-goal",
      dataDirOptions: { dataDir }
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("goal_not_found");
    expect(result.error).toContain("missing-goal");
  });

  it("returns no_goals when omitting goalId on an empty data dir", () => {
    const dataDir = makeTempDir();
    const result = loadGoalLogs({ dataDirOptions: { dataDir } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("no_goals");
  });

  it("rejects an empty goalId string", () => {
    const result = loadGoalLogs({ goalId: "  " });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_input");
  });

  it("rejects a non-positive iteration", () => {
    const result = loadGoalLogs({ iteration: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_input");
  });

  it("returns empty log content for a freshly initialized goal with iteration 1 dir", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Fresh logs");

    const result = loadGoalLogs({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.iteration).toBe(1);
    expect(result.availableIterations).toEqual([1]);
    expect(result.runnerLog.exists).toBe(true);
    expect(result.runnerLog.bytes).toBe(0);
    expect(result.runnerLog.content).toBe("");
    expect(result.verificationLog.exists).toBe(true);
    expect(result.verificationLog.bytes).toBe(0);
    expect(result.verificationLog.content).toBe("");
    expect(result.iterationDir).toBe(setup.artifactPaths.iterationDir);
  });

  it("returns runner and verification log content after a successful iteration", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Logs after success");
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
    } finally {
      db.close();
    }

    const result = loadGoalLogs({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.iteration).toBe(1);
    expect(result.availableIterations).toEqual([1]);
    expect(result.runnerLog.exists).toBe(true);
    expect(result.runnerLog.bytes).toBeGreaterThan(0);
    expect(result.runnerLog.content.length).toBeGreaterThan(0);
    expect(result.verificationLog.exists).toBe(true);
    expect(result.verificationLog.bytes).toBeGreaterThan(0);
    expect(result.verificationLog.content.length).toBeGreaterThan(0);
  });

  it("returns parse errors for malformed runner result JSON", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Malformed runner result");
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
    } finally {
      db.close();
    }

    fs.writeFileSync(
      setup.artifactPaths.resultJson,
      "{\"summary\": true",
      "utf-8"
    );
    const result = loadGoalLogs({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resultJson.exists).toBe(true);
    expect(result.resultJson.readable).toBe(true);
    expect(result.resultJson.parseError).toContain("Invalid runner result JSON");
  });

  it("includes command stdout and stderr in runner.log for trusted-shell command failures", () => {
    const repo = initRepo();
    const dataDir = makeTempDir("momentum-logs-data-");
    const specDir = makeTempDir("momentum-logs-spec-");
    const goalFile = path.join(specDir, "goal.md");
    fs.writeFileSync(
      goalFile,
      makeTrustedShellFailureSpecContent(repo, "trusted shell command failure"),
      "utf-8"
    );
    const init = initGoal({
      goalPath: goalFile,
      dataDirOptions: { dataDir },
      mode: "queued"
    });
    if (!init.ok) {
      throw new Error(`initGoal failed: ${init.error}`);
    }

    const db = openDb(dataDir);
    try {
      const job = executeIterationJob({
        db,
        goalId: init.goalId,
        jobId: init.jobId,
        spec: init.spec,
        artifactPaths: init.artifactPaths
      });
      expect(job.ok).toBe(false);
      if (job.ok) return;
      expect(job.iteration.code).toBe("command_failed");
    } finally {
      db.close();
    }

    const result = loadGoalLogs({
      goalId: init.goalId,
      dataDirOptions: { dataDir }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.runnerLog.readable).toBe(true);
    expect(result.runnerLog.content).toContain("from-stdout");
    expect(result.runnerLog.content).toContain("from-stderr");
    expect(result.runnerLog.content).toContain("[trusted-shell] exit_code: 2");
  });

  it("surfaces runtime-unavailable startup failures from ACP in runner.log", () => {
    if (process.platform === "win32") {
      return;
    }
    const repo = initRepo();
    const setup = setupAcpRuntimeUnavailableGoal(
      repo,
      "ACP runtime unavailable logs"
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

    const result = loadGoalLogs({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.runnerLog.readable).toBe(true);
    expect(result.runnerLog.content).toContain("[acp] runtime_unavailable:");
    expect(result.verificationLog.readable).toBe(true);
    expect(result.verificationLog.content).toBe("");
    expect(result.resultJson.exists).toBe(true);
    expect(result.resultJson.parseError).toBeUndefined();
  });

  it("surfaces startup failures from ACP in runner.log", () => {
    if (process.platform === "win32") {
      return;
    }
    const repo = initRepo();
    const startupFailedCommand = makeStartupFailedAcpCommand();

    const setup = setupAcpRuntimeUnavailableGoal(
      repo,
      "ACP startup_failed logs",
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

    const result = loadGoalLogs({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.runnerLog.readable).toBe(true);
    expect(result.runnerLog.content).toContain("[acp] spawn_error:");
    expect(result.runnerLog.content).toContain("[acp] summary: startup failed");
    expect(result.verificationLog.readable).toBe(true);
    expect(result.verificationLog.content).toBe("");
    expect(result.resultJson.exists).toBe(true);
    expect(result.resultJson.parseError).toBeUndefined();
  });

  it("marks existing log files unreadable when content cannot be read", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Unreadable logs");
    fs.writeFileSync(setup.artifactPaths.runnerLog, "runner output\n", "utf-8");
    const originalReadFileSync = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation(((filePath, options) => {
      if (filePath === setup.artifactPaths.runnerLog) {
        throw new Error("permission denied");
      }
      return originalReadFileSync(filePath, options);
    }) as typeof fs.readFileSync);

    const result = loadGoalLogs({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.runnerLog.exists).toBe(true);
    expect(result.runnerLog.readable).toBe(false);
    expect(result.runnerLog.bytes).toBeGreaterThan(0);
    expect(result.runnerLog.content).toBe("");
    expect(result.runnerLog.error).toContain("permission denied");
    expect(result.verificationLog.readable).toBe(true);
  });

  it("defaults to the highest available iteration when multiple exist", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Multi iteration default");

    // Simulate a chained iteration 2 artifact dir.
    const iter2 = ensureIterationArtifactDir(setup.dataDir, setup.goalId, 2);
    fs.writeFileSync(iter2.runnerLog, "iter2 runner output\n", "utf-8");
    fs.writeFileSync(iter2.verificationLog, "iter2 verification output\n", "utf-8");

    const result = loadGoalLogs({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.availableIterations).toEqual([1, 2]);
    expect(result.iteration).toBe(2);
    expect(result.runnerLog.content).toContain("iter2 runner output");
    expect(result.verificationLog.content).toContain("iter2 verification output");
  });

  it("returns the requested iteration when --iteration is provided", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Specific iteration");

    const iter2 = ensureIterationArtifactDir(setup.dataDir, setup.goalId, 2);
    fs.writeFileSync(iter2.runnerLog, "iter2 runner\n", "utf-8");

    const result = loadGoalLogs({
      goalId: setup.goalId,
      iteration: 1,
      dataDirOptions: { dataDir: setup.dataDir }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.iteration).toBe(1);
    expect(result.runnerLog.path).toBe(setup.artifactPaths.runnerLog);
    expect(result.runnerLog.content).toBe("");
  });

  it("returns iteration_not_found when an explicit iteration has no artifact dir", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Missing iteration");

    const result = loadGoalLogs({
      goalId: setup.goalId,
      iteration: 9,
      dataDirOptions: { dataDir: setup.dataDir }
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("iteration_not_found");
    expect(result.error).toContain("Iteration 9");
    expect(result.error).toContain("Available iterations");
  });

  it("includes latestEvidence summaries newest-first for linked goals", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Logs with evidence");
    const db = openDb(setup.dataDir);
    try {
      ingestEvidenceRecord(
        db,
        {
          source: "agent-workflow",
          type: "plan_created",
          occurredAt: 1700000010000,
          summary: "plan for logs-run-1",
          ingestKey: "agent-workflow:logs-run-1:plan",
          artifactPath: "/tmp/.agent-workflows/logs-run-1/plan.json",
          goalId: setup.goalId
        },
        { now: () => 1700000010500 }
      );
      ingestEvidenceRecord(
        db,
        {
          source: "agent-workflow",
          type: "merge_complete",
          occurredAt: 1700000020000,
          summary: "merge for logs-run-1",
          ingestKey: "agent-workflow:logs-run-1:merge",
          artifactPath: "/tmp/.agent-workflows/logs-run-1/ledger.jsonl",
          goalId: setup.goalId
        },
        { now: () => 1700000020500 }
      );
    } finally {
      db.close();
    }

    const result = loadGoalLogs({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.latestEvidence).toHaveLength(2);
    expect(result.latestEvidence[0]).toMatchObject({
      type: "merge_complete",
      occurredAt: 1700000020000,
      summary: "merge for logs-run-1"
    });
    expect(result.latestEvidence[1]).toMatchObject({
      type: "plan_created",
      occurredAt: 1700000010000
    });
  });

  it("returns an empty latestEvidence list for goals with no evidence", () => {
    const repo = initRepo();
    const setup = setupGoal(repo, "Logs without evidence");
    const result = loadGoalLogs({
      goalId: setup.goalId,
      dataDirOptions: { dataDir: setup.dataDir }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.latestEvidence).toEqual([]);
  });
});
