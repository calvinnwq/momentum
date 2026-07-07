import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import {
  insertExecutorInvocation,
  listExecutorArtifactsForRound,
  loadExecutorRound
} from "../src/core/executors/loop/persist.js";
import type { ExecutorInvocationRecord } from "../src/core/executors/loop/reducer.js";
import {
  resolveGoalLoopRoundSelection,
  type PlanGoalLoopRoundStartInput
} from "../src/core/executors/goal-loop/executor.js";
import {
  goalLoopRoundMechanismFromPromptedResultFile,
  goalLoopRoundMechanismFromResultFile
} from "../src/core/executors/goal-loop/mechanism.js";
import { runGoalLoopRound } from "../src/core/executors/goal-loop/orchestrator.js";
import type { CommitIntent, RunnerResult } from "../src/core/executors/runner/types.js";

// Proves the goal-loop round *mechanism* bridge reuses the shared goal /
// iteration safety (the `finalizeWorkflowStepFromResultFile` verify -> commit /
// reset transaction with its moved-HEAD / result-document recovery) rather than
// re-implementing it, projecting a finished round's durable result
// document into the `{ result, finalize, artifacts }` the goal-loop driver
// consumes — including the recovery / finalization boundaries the ticket
// requires (NGX-349 "Reuse existing Goal / iteration safety where possible").

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-goal-loop-mechanism-"): string {
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
  const dir = makeTempDir();
  runGit(dir, ["init", "--initial-branch=main", "--quiet"]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  runGit(dir, ["config", "user.name", "Test User"]);
  runGit(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

function commitInitial(dir: string): string {
  fs.writeFileSync(path.join(dir, "README.md"), "init\n", "utf-8");
  runGit(dir, ["add", "README.md"]);
  runGit(dir, ["commit", "-m", "init", "--quiet"]);
  return runGit(dir, ["rev-parse", "HEAD"]).trim();
}

function setupRepoWithRoundEdits(): { repoPath: string; baseHead: string } {
  const repoPath = initRepo();
  const baseHead = commitInitial(repoPath);
  fs.writeFileSync(
    path.join(repoPath, "round-edit.txt"),
    "from-goal-loop-round\n",
    "utf-8"
  );
  return { repoPath, baseHead };
}

function baseIntent(overrides: Partial<CommitIntent> = {}): CommitIntent {
  return {
    type: "feat",
    scope: "goal-loop",
    subject: "prove goal-loop round mechanism",
    body: "",
    breaking: false,
    ...overrides
  };
}

function baseRunnerResult(overrides: Partial<RunnerResult> = {}): RunnerResult {
  return {
    success: true,
    summary: "round finished",
    key_changes_made: ["wrote round-edit.txt"],
    key_learnings: [],
    remaining_work: [],
    goal_complete: false,
    commit: baseIntent(),
    ...overrides
  };
}

function writeResultFile(content: string): string {
  const dir = makeTempDir("momentum-goal-loop-mechanism-result-");
  const resultPath = path.join(dir, "runner-result.json");
  fs.writeFileSync(resultPath, content, "utf-8");
  return resultPath;
}

function makeVerificationLogPath(): string {
  const dir = makeTempDir("momentum-goal-loop-mechanism-log-");
  return path.join(dir, "verification.log");
}

function sha256Digest(content: string): string {
  return `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`;
}

describe("goalLoopRoundMechanismFromResultFile", () => {
  it("commits and returns the normalized result + result/verification artifacts on a verified success", () => {
    const { repoPath, baseHead } = setupRepoWithRoundEdits();
    const resultFilePath = writeResultFile(
      JSON.stringify(baseRunnerResult({ goal_complete: true }))
    );
    const verificationLogPath = makeVerificationLogPath();

    const mechanism = goalLoopRoundMechanismFromResultFile({
      repoPath,
      baseHead,
      resultFilePath,
      verificationCommands: ["echo verify-ok"],
      verificationTimeoutSec: 30,
      verificationLogPath
    });

    expect(mechanism.finalize.outcome).toBe("committed");
    expect(mechanism.result).not.toBeNull();
    expect(mechanism.result?.goal_complete).toBe(true);
    expect(mechanism.result?.summary).toBe("round finished");
    // The bridge reports the result document + verification log pointers it owns.
    expect(mechanism.artifacts?.resultDocument?.path).toBe(resultFilePath);
    expect(mechanism.artifacts?.verificationOutput?.path).toBe(
      verificationLogPath
    );
    // It genuinely committed onto the base HEAD.
    expect(runGit(repoPath, ["rev-parse", "HEAD"]).trim()).not.toBe(baseHead);
  });

  it("reports the committed change set on a verified success", () => {
    const { repoPath, baseHead } = setupRepoWithRoundEdits();
    const resultFilePath = writeResultFile(
      JSON.stringify(baseRunnerResult({ goal_complete: true }))
    );
    const verificationLogPath = makeVerificationLogPath();

    const mechanism = goalLoopRoundMechanismFromResultFile({
      repoPath,
      baseHead,
      resultFilePath,
      verificationCommands: ["echo verify-ok"],
      verificationTimeoutSec: 30,
      verificationLogPath
    });

    expect(mechanism.finalize.outcome).toBe("committed");
    // The round wrote exactly round-edit.txt, so the durable change set names it.
    expect(mechanism.changedFiles).toEqual(["round-edit.txt"]);
  });

  it("reports an empty change set when the round resets without committing", () => {
    const { repoPath, baseHead } = setupRepoWithRoundEdits();
    const resultFilePath = writeResultFile(
      JSON.stringify(baseRunnerResult({ success: false }))
    );
    const verificationLogPath = makeVerificationLogPath();

    const mechanism = goalLoopRoundMechanismFromResultFile({
      repoPath,
      baseHead,
      resultFilePath,
      verificationCommands: ["echo should-not-run"],
      verificationTimeoutSec: 30,
      verificationLogPath
    });

    expect(mechanism.finalize.outcome).toBe("reset_step_failure");
    // Nothing was committed, so there is no durable change set to report.
    expect(mechanism.changedFiles).toEqual([]);
  });

  it("reports a content digest of the captured result document", () => {
    const { repoPath, baseHead } = setupRepoWithRoundEdits();
    const content = JSON.stringify(baseRunnerResult({ goal_complete: true }));
    const resultFilePath = writeResultFile(content);
    const verificationLogPath = makeVerificationLogPath();

    const mechanism = goalLoopRoundMechanismFromResultFile({
      repoPath,
      baseHead,
      resultFilePath,
      verificationCommands: ["echo verify-ok"],
      verificationTimeoutSec: 30,
      verificationLogPath
    });

    // The digest fingerprints the exact bytes of the result document on disk, so
    // a later reattach can prove the artifact has not changed underneath it.
    expect(mechanism.resultDigest).toBe(sha256Digest(content));
    // The same digest is attached to the result_document artifact pointer, so the
    // durable artifact row is self-verifying and cannot drift from the round field.
    expect(mechanism.artifacts?.resultDocument?.digest).toBe(
      sha256Digest(content)
    );
  });

  it("reports a null result digest when the result file is missing", () => {
    const { repoPath, baseHead } = setupRepoWithRoundEdits();
    const resultFilePath = path.join(makeTempDir(), "absent-result.json");
    const verificationLogPath = makeVerificationLogPath();

    const mechanism = goalLoopRoundMechanismFromResultFile({
      repoPath,
      baseHead,
      resultFilePath,
      verificationCommands: ["echo verify-ok"],
      verificationTimeoutSec: 30,
      verificationLogPath
    });

    expect(mechanism.finalize.outcome).toBe("result_missing");
    expect(mechanism.resultDigest).toBeNull();
  });

  it("reports a null result digest when the result document is invalid", () => {
    const { repoPath, baseHead } = setupRepoWithRoundEdits();
    const resultFilePath = writeResultFile("{ not valid json");
    const verificationLogPath = makeVerificationLogPath();

    const mechanism = goalLoopRoundMechanismFromResultFile({
      repoPath,
      baseHead,
      resultFilePath,
      verificationCommands: ["echo verify-ok"],
      verificationTimeoutSec: 30,
      verificationLogPath
    });

    expect(mechanism.finalize.outcome).toBe("result_invalid");
    // No usable result means no digest, mirroring the null result itself.
    expect(mechanism.result).toBeNull();
    expect(mechanism.resultDigest).toBeNull();
  });

  it("resets without verification and keeps the result document pointer when the round reported failure", () => {
    const { repoPath, baseHead } = setupRepoWithRoundEdits();
    const resultFilePath = writeResultFile(
      JSON.stringify(baseRunnerResult({ success: false }))
    );
    const verificationLogPath = makeVerificationLogPath();

    const mechanism = goalLoopRoundMechanismFromResultFile({
      repoPath,
      baseHead,
      resultFilePath,
      verificationCommands: ["echo should-not-run"],
      verificationTimeoutSec: 30,
      verificationLogPath
    });

    expect(mechanism.finalize.outcome).toBe("reset_step_failure");
    // The document was valid, so the failed round still captures its result.
    expect(mechanism.result?.success).toBe(false);
    expect(mechanism.artifacts?.resultDocument?.path).toBe(resultFilePath);
    // Verification never ran for a step-failure reset, so no verification artifact.
    expect(mechanism.artifacts?.verificationOutput).toBeUndefined();
    expect(runGit(repoPath, ["rev-parse", "HEAD"]).trim()).toBe(baseHead);
  });

  it("resets and records a verification artifact when verification fails", () => {
    const { repoPath, baseHead } = setupRepoWithRoundEdits();
    const resultFilePath = writeResultFile(JSON.stringify(baseRunnerResult()));
    const verificationLogPath = makeVerificationLogPath();

    const mechanism = goalLoopRoundMechanismFromResultFile({
      repoPath,
      baseHead,
      resultFilePath,
      verificationCommands: ["echo ok", "false"],
      verificationTimeoutSec: 30,
      verificationLogPath
    });

    expect(mechanism.finalize.outcome).toBe("reset_verification_failure");
    expect(mechanism.result).not.toBeNull();
    expect(mechanism.artifacts?.verificationOutput?.path).toBe(
      verificationLogPath
    );
    expect(runGit(repoPath, ["rev-parse", "HEAD"]).trim()).toBe(baseHead);
  });

  it("fingerprints the verification log on the verification_output artifact pointer", () => {
    const { repoPath, baseHead } = setupRepoWithRoundEdits();
    const resultFilePath = writeResultFile(JSON.stringify(baseRunnerResult()));
    const verificationLogPath = makeVerificationLogPath();

    const mechanism = goalLoopRoundMechanismFromResultFile({
      repoPath,
      baseHead,
      resultFilePath,
      verificationCommands: ["echo verify-ok"],
      verificationTimeoutSec: 30,
      verificationLogPath
    });

    expect(mechanism.finalize.outcome).toBe("committed");
    // The verification log the finalize seam wrote is fingerprinted, so a later
    // reattach can prove the verification evidence has not changed underneath it,
    // exactly like the result-document pointer.
    const logBytes = fs.readFileSync(verificationLogPath, "utf-8");
    expect(mechanism.artifacts?.verificationOutput?.digest).toBe(
      sha256Digest(logBytes)
    );
  });

  it("fingerprints the verification log of a failed-verification reset", () => {
    const { repoPath, baseHead } = setupRepoWithRoundEdits();
    const resultFilePath = writeResultFile(JSON.stringify(baseRunnerResult()));
    const verificationLogPath = makeVerificationLogPath();

    const mechanism = goalLoopRoundMechanismFromResultFile({
      repoPath,
      baseHead,
      resultFilePath,
      verificationCommands: ["echo ok", "false"],
      verificationTimeoutSec: 30,
      verificationLogPath
    });

    expect(mechanism.finalize.outcome).toBe("reset_verification_failure");
    // On a reset the verification log is the primary evidence of why the round
    // did not commit, so fingerprinting it for reattach matters most here.
    const logBytes = fs.readFileSync(verificationLogPath, "utf-8");
    expect(mechanism.artifacts?.verificationOutput?.digest).toBe(
      sha256Digest(logBytes)
    );
  });

  it("returns a null result and no result-document artifact when the result file is missing", () => {
    const { repoPath, baseHead } = setupRepoWithRoundEdits();
    const resultFilePath = path.join(makeTempDir(), "absent-result.json");
    const verificationLogPath = makeVerificationLogPath();

    const mechanism = goalLoopRoundMechanismFromResultFile({
      repoPath,
      baseHead,
      resultFilePath,
      verificationCommands: ["echo verify-ok"],
      verificationTimeoutSec: 30,
      verificationLogPath
    });

    expect(mechanism.finalize.outcome).toBe("result_missing");
    expect(mechanism.result).toBeNull();
    expect(mechanism.artifacts?.resultDocument).toBeUndefined();
    expect(mechanism.artifacts?.verificationOutput).toBeUndefined();
    // An ambiguous outcome never mutates git.
    expect(runGit(repoPath, ["rev-parse", "HEAD"]).trim()).toBe(baseHead);
  });

  it("returns a null result but keeps the document pointer when the result file is invalid", () => {
    const { repoPath, baseHead } = setupRepoWithRoundEdits();
    const resultFilePath = writeResultFile("{ not valid json");
    const verificationLogPath = makeVerificationLogPath();

    const mechanism = goalLoopRoundMechanismFromResultFile({
      repoPath,
      baseHead,
      resultFilePath,
      verificationCommands: ["echo verify-ok"],
      verificationTimeoutSec: 30,
      verificationLogPath
    });

    expect(mechanism.finalize.outcome).toBe("result_invalid");
    expect(mechanism.result).toBeNull();
    // The file exists (it is evidence of what went wrong), so the pointer stays.
    expect(mechanism.artifacts?.resultDocument?.path).toBe(resultFilePath);
    expect(runGit(repoPath, ["rev-parse", "HEAD"]).trim()).toBe(baseHead);
  });

  it("returns a null result when the document is valid JSON but exceeds the size ceiling", () => {
    const { repoPath, baseHead } = setupRepoWithRoundEdits();
    // A well-formed RunnerResult that is too large to trust: the finalize seam
    // judges it `result_invalid`, so the bridge must NOT capture the parsed
    // result even though `parseRunnerResult` alone would accept it.
    const resultFilePath = writeResultFile(
      JSON.stringify(baseRunnerResult({ summary: "x".repeat(1024 * 1024 + 1) }))
    );
    const verificationLogPath = makeVerificationLogPath();

    const mechanism = goalLoopRoundMechanismFromResultFile({
      repoPath,
      baseHead,
      resultFilePath,
      verificationCommands: ["echo verify-ok"],
      verificationTimeoutSec: 30,
      verificationLogPath
    });

    expect(mechanism.finalize.outcome).toBe("result_invalid");
    expect(mechanism.result).toBeNull();
    expect(runGit(repoPath, ["rev-parse", "HEAD"]).trim()).toBe(baseHead);
  });

  it("routes a moved HEAD to manual recovery without a destructive reset", () => {
    const repoPath = initRepo();
    const baseHead = commitInitial(repoPath);
    // Simulate a round that itself committed: HEAD advances past baseHead.
    fs.writeFileSync(path.join(repoPath, "rogue.txt"), "rogue\n", "utf-8");
    runGit(repoPath, ["add", "rogue.txt"]);
    runGit(repoPath, ["commit", "-m", "rogue round commit", "--quiet"]);
    const movedHead = runGit(repoPath, ["rev-parse", "HEAD"]).trim();
    const resultFilePath = writeResultFile(JSON.stringify(baseRunnerResult()));
    const verificationLogPath = makeVerificationLogPath();

    const mechanism = goalLoopRoundMechanismFromResultFile({
      repoPath,
      baseHead,
      resultFilePath,
      verificationCommands: ["echo verify-ok"],
      verificationTimeoutSec: 30,
      verificationLogPath
    });

    expect(mechanism.finalize.outcome).toBe("manual_recovery_required");
    // The result document is readable, so the result is preserved for evidence.
    expect(mechanism.result).not.toBeNull();
    expect(runGit(repoPath, ["rev-parse", "HEAD"]).trim()).toBe(movedHead);
  });
});

describe("goalLoopRoundMechanismFromPromptedResultFile", () => {
  it("writes the native round prompt before finalizing the runner-authored result file", () => {
    const { repoPath, baseHead } = setupRepoWithRoundEdits();
    const promptFilePath = path.join(
      makeTempDir("momentum-goal-loop-mechanism-prompt-"),
      "prompt.md"
    );
    const resultFilePath = writeResultFile("");
    fs.rmSync(resultFilePath);
    const verificationLogPath = makeVerificationLogPath();
    const calls: Array<{
      promptFilePath: string;
      resultFilePath: string;
      prompt: string;
    }> = [];

    const mechanism = goalLoopRoundMechanismFromPromptedResultFile({
      repoPath,
      baseHead,
      resultFilePath,
      verificationCommands: ["echo verify-ok"],
      verificationTimeoutSec: 30,
      verificationLogPath,
      promptFilePath,
      promptInput: {
        objective: "Prove the prompted result mechanism.",
        round: {
          workflowRunId: "run-1",
          stepRunId: "step-1",
          invocationId: "inv-1",
          roundId: "round-1",
          roundIndex: 0,
          attempt: 1
        },
        repo: {
          path: repoPath,
          baseHead,
          branch: "feat/ngx-569-round-prompt-result"
        },
        acceptanceRequirements: [
          "Prompt must be written before the runner result is consumed."
        ],
        verificationCommands: ["echo verify-ok"]
      },
      runPromptedRound: (runnerInput) => {
        calls.push(runnerInput);
        expect(fs.readFileSync(runnerInput.promptFilePath, "utf-8")).toBe(
          runnerInput.prompt
        );
        expect(runnerInput.prompt).toContain(
          "- objective: Prove the prompted result mechanism."
        );
        expect(runnerInput.prompt).toContain(
          `- result_path: ${resultFilePath}`
        );
        fs.writeFileSync(
          runnerInput.resultFilePath,
          JSON.stringify({
            success: true,
            summary: "round finished",
            key_changes_made: ["wrote round-edit.txt"],
            goal_complete: true,
            commit: baseIntent()
          }),
          "utf-8"
        );
      }
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.promptFilePath).toBe(promptFilePath);
    expect(calls[0]?.resultFilePath).toBe(resultFilePath);
    expect(fs.readFileSync(promptFilePath, "utf-8")).toContain(
      "## Output contract"
    );
    expect(mechanism.finalize.outcome).toBe("committed");
    expect(mechanism.result?.key_learnings).toEqual([]);
    expect(mechanism.result?.remaining_work).toEqual([]);
    expect(mechanism.artifacts?.resultDocument?.path).toBe(resultFilePath);
  });

  it("routes a prompted runner that writes no result to explicit missing-result recovery", () => {
    const { repoPath, baseHead } = setupRepoWithRoundEdits();
    const promptFilePath = path.join(
      makeTempDir("momentum-goal-loop-mechanism-prompt-"),
      "prompt.md"
    );
    const resultFilePath = path.join(
      makeTempDir("momentum-goal-loop-mechanism-result-"),
      "missing-result.json"
    );
    const verificationLogPath = makeVerificationLogPath();

    const mechanism = goalLoopRoundMechanismFromPromptedResultFile({
      repoPath,
      baseHead,
      resultFilePath,
      verificationCommands: ["echo should-not-run"],
      verificationTimeoutSec: 30,
      verificationLogPath,
      promptFilePath,
      promptInput: {
        objective: "Preserve missing result evidence.",
        round: {
          workflowRunId: "run-1",
          stepRunId: "step-1",
          invocationId: "inv-1",
          roundId: "round-1",
          roundIndex: 0,
          attempt: 1
        },
        repo: { path: repoPath, baseHead }
      },
      runPromptedRound: () => {
        // Simulate a runner that exits without writing the configured result.
      }
    });

    expect(fs.readFileSync(promptFilePath, "utf-8")).toContain(
      "- objective: Preserve missing result evidence."
    );
    expect(mechanism.finalize.outcome).toBe("result_missing");
    expect(mechanism.result).toBeNull();
    expect(mechanism.artifacts?.resultDocument).toBeUndefined();
    expect(runGit(repoPath, ["rev-parse", "HEAD"]).trim()).toBe(baseHead);
  });
});

// Foreign keys are enforced, so a round needs a real invocation, which needs a
// real (workflow_run_id, step_run_id). Seed the minimal parent rows; the driver
// inserts the round.
function openRoundDb(): MomentumDb {
  const db = openDb(makeTempDir("momentum-goal-loop-mechanism-db-"));
  db.prepare(
    "INSERT INTO workflow_runs (id, source, created_at, updated_at) VALUES ('run-1', 'test', 1, 1)"
  ).run();
  db.prepare(
    `INSERT INTO workflow_steps (run_id, step_id, kind, step_order, created_at, updated_at)
       VALUES ('run-1', 'step-1', 'implementation', 0, 1, 1)`
  ).run();
  const invocation: ExecutorInvocationRecord = {
    invocationId: "inv-1",
    workflowRunId: "run-1",
    stepRunId: "step-1",
    stepKey: "implementation",
    executorFamily: "goal-loop",
    state: "running",
    attempt: 1,
    startedAt: 1,
    heartbeatAt: 1,
    finishedAt: null
  };
  insertExecutorInvocation(db, invocation, { now: 1 });
  return db;
}

function buildStart(): PlanGoalLoopRoundStartInput {
  return {
    roundId: "round-1",
    invocationId: "inv-1",
    workflowRunId: "run-1",
    stepRunId: "step-1",
    stepKey: "implementation",
    attempt: 1,
    roundIndex: 0,
    selection: resolveGoalLoopRoundSelection({ stepConfig: { maxRounds: 5 } }),
    inputDigest: "sha256:input",
    artifactRoot: "/artifacts/round-1",
    logPaths: ["/artifacts/round-1/stdout.log"],
    startedAt: 1_000
  };
}

describe("goalLoopRoundMechanismFromResultFile composed into runGoalLoopRound", () => {
  it("drives a verified, goal-complete round to a durable succeeded round with the commit SHA", () => {
    const { repoPath, baseHead } = setupRepoWithRoundEdits();
    const resultFilePath = writeResultFile(
      JSON.stringify(baseRunnerResult({ goal_complete: true }))
    );
    const verificationLogPath = makeVerificationLogPath();
    const db = openRoundDb();

    const outcome = runGoalLoopRound({
      db,
      start: buildStart(),
      finishedAt: 5_000,
      runRound: () =>
        goalLoopRoundMechanismFromResultFile({
          repoPath,
          baseHead,
          resultFilePath,
          verificationCommands: ["echo verify-ok"],
          verificationTimeoutSec: 30,
          verificationLogPath
        })
    });

    expect(outcome.round.state).toBe("succeeded");
    expect(outcome.decision.classification).toBe("complete");
    expect(outcome.round.commitSha).not.toBeNull();
    expect(outcome.round.verificationStatus).toBe("passed");

    const durable = loadExecutorRound(db, "round-1");
    expect(durable?.state).toBe("succeeded");
    expect(durable?.commitSha).toBe(outcome.round.commitSha);
    db.close();
  });

  it("persists the captured result document digest onto the durable round", () => {
    const { repoPath, baseHead } = setupRepoWithRoundEdits();
    const content = JSON.stringify(baseRunnerResult({ goal_complete: true }));
    const resultFilePath = writeResultFile(content);
    const verificationLogPath = makeVerificationLogPath();
    const db = openRoundDb();

    const outcome = runGoalLoopRound({
      db,
      start: buildStart(),
      finishedAt: 5_000,
      runRound: () =>
        goalLoopRoundMechanismFromResultFile({
          repoPath,
          baseHead,
          resultFilePath,
          verificationCommands: ["echo verify-ok"],
          verificationTimeoutSec: 30,
          verificationLogPath
        })
    });

    expect(outcome.round.resultDigest).toBe(sha256Digest(content));
    const durable = loadExecutorRound(db, "round-1");
    expect(durable?.resultDigest).toBe(sha256Digest(content));
    db.close();
  });

  it("persists the real committed change set onto the durable round", () => {
    const { repoPath, baseHead } = setupRepoWithRoundEdits();
    const resultFilePath = writeResultFile(
      JSON.stringify(baseRunnerResult({ goal_complete: true }))
    );
    const verificationLogPath = makeVerificationLogPath();
    const db = openRoundDb();

    const outcome = runGoalLoopRound({
      db,
      start: buildStart(),
      finishedAt: 5_000,
      runRound: () =>
        goalLoopRoundMechanismFromResultFile({
          repoPath,
          baseHead,
          resultFilePath,
          verificationCommands: ["echo verify-ok"],
          verificationTimeoutSec: 30,
          verificationLogPath
        })
    });

    // The committed change set the real finalize produced round-trips onto the
    // durable executor_rounds row, not just the in-memory record.
    expect(outcome.round.changedFiles).toEqual(["round-edit.txt"]);
    const durable = loadExecutorRound(db, "round-1");
    expect(durable?.changedFiles).toEqual(["round-edit.txt"]);
    db.close();
  });

  it("persists the verification log digest onto the durable verification_output artifact row", () => {
    const { repoPath, baseHead } = setupRepoWithRoundEdits();
    const resultFilePath = writeResultFile(
      JSON.stringify(baseRunnerResult({ goal_complete: true }))
    );
    const verificationLogPath = makeVerificationLogPath();
    const db = openRoundDb();

    runGoalLoopRound({
      db,
      start: buildStart(),
      finishedAt: 5_000,
      runRound: () =>
        goalLoopRoundMechanismFromResultFile({
          repoPath,
          baseHead,
          resultFilePath,
          verificationCommands: ["echo verify-ok"],
          verificationTimeoutSec: 30,
          verificationLogPath
        })
    });

    // The pointer digest round-trips into the durable executor_artifacts row, so
    // the verification evidence is self-verifying from durable state alone.
    const logBytes = fs.readFileSync(verificationLogPath, "utf-8");
    const verificationArtifact = listExecutorArtifactsForRound(
      db,
      "round-1"
    ).find((artifact) => artifact.artifactClass === "verification_output");
    expect(verificationArtifact?.digest).toBe(sha256Digest(logBytes));
    db.close();
  });

  it("persists per-command verification results onto the durable round", () => {
    const { repoPath, baseHead } = setupRepoWithRoundEdits();
    const resultFilePath = writeResultFile(
      JSON.stringify(baseRunnerResult({ goal_complete: true }))
    );
    const verificationLogPath = makeVerificationLogPath();
    const db = openRoundDb();

    runGoalLoopRound({
      db,
      start: buildStart(),
      finishedAt: 5_000,
      runRound: () =>
        goalLoopRoundMechanismFromResultFile({
          repoPath,
          baseHead,
          resultFilePath,
          verificationCommands: ["echo verify-ok"],
          verificationTimeoutSec: 30,
          verificationLogPath
        })
    });

    const durable = loadExecutorRound(db, "round-1");
    expect(durable?.verificationResults).toEqual([
      expect.objectContaining({
        command: "echo verify-ok",
        exitCode: 0,
        timedOut: false
      })
    ]);
    expect(durable?.verificationResults?.[0]?.durationMs).toEqual(
      expect.any(Number)
    );
    db.close();
  });

  it("drives a missing-result round to a durable manual-recovery round through the real finalize", () => {
    const { repoPath, baseHead } = setupRepoWithRoundEdits();
    const resultFilePath = path.join(makeTempDir(), "absent-result.json");
    const verificationLogPath = makeVerificationLogPath();
    const db = openRoundDb();

    const outcome = runGoalLoopRound({
      db,
      start: buildStart(),
      finishedAt: 5_000,
      runRound: () =>
        goalLoopRoundMechanismFromResultFile({
          repoPath,
          baseHead,
          resultFilePath,
          verificationCommands: ["echo verify-ok"],
          verificationTimeoutSec: 30,
          verificationLogPath
        })
    });

    expect(outcome.round.state).toBe("manual_recovery_required");
    expect(outcome.decision.classification).toBe("manual_recovery_required");
    expect(outcome.round.recoveryCode).toBe("result_missing");

    const durable = loadExecutorRound(db, "round-1");
    expect(durable?.state).toBe("manual_recovery_required");
    expect(durable?.recoveryCode).toBe("result_missing");
    db.close();
  });
});
