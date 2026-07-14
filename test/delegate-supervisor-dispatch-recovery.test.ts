import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDb } from "../src/adapters/db.js";
import { createProfileBackedDelegateToolAdapter } from "../src/adapters/profile-backed-delegate-tool-adapter.js";
import { resolveDaemonWorkflowStepDispatch } from "../src/core/daemon/workflow-dispatch.js";
import type { WorkflowDefinition } from "../src/core/workflow/definition/definition.js";
import { persistWorkflowDefinition } from "../src/core/workflow/definition/persist.js";
import { executeWorkflowStepDispatch } from "../src/core/workflow/dispatch/execute.js";
import { claimRunnableWorkflowStep } from "../src/core/workflow/dispatch/scheduler.js";
import { CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR } from "../src/core/workflow/live-wrapper/coding-workflow.js";
import { DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR } from "../src/core/workflow/live-wrapper/daemon-profile.js";
import { clearWorkflowRunManualRecoveryGuarded } from "../src/core/workflow/run/recovery.js";
import { persistWorkflowRunStart } from "../src/core/workflow/run/start-persist.js";

const NOW = 1_700_000_000_000;
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const value = fs.mkdtempSync(
    path.join(os.tmpdir(), "momentum-delegate-recovery-"),
  );
  tempDirs.push(value);
  return value;
}

function runGit(repoPath: string, args: string[]): string {
  return execFileSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initRepo(): string {
  const repoPath = tempDir();
  runGit(repoPath, ["init", "--quiet"]);
  runGit(repoPath, ["config", "user.name", "Momentum Test"]);
  runGit(repoPath, ["config", "user.email", "momentum@example.test"]);
  fs.writeFileSync(path.join(repoPath, ".gitignore"), ".agent-workflows/\n");
  fs.writeFileSync(path.join(repoPath, "README.md"), "fixture\n");
  runGit(repoPath, ["add", ".gitignore", "README.md"]);
  runGit(repoPath, ["commit", "--quiet", "-m", "test: initialize fixture"]);
  return repoPath;
}

function writeProfile(profileDir: string): string {
  const profilePath = path.join(profileDir, "profile.json");
  const script = `count_file="$MOMENTUM_REPO_PATH/.agent-workflows/$MOMENTUM_RUN_ID/gnhf-launch-count"
count=0
test ! -f "$count_file" || count=$(cat "$count_file")
printf '%s\n' "$((count + 1))" > "$count_file"
printf '%s\n' "$MOMENTUM_STEP_ID" > "$MOMENTUM_REPO_PATH/$MOMENTUM_STEP_ID.txt"
cat > "$MOMENTUM_RESULT_PATH" <<JSON
{"success":true,"summary":"$MOMENTUM_STEP_ID completed","key_changes_made":[],"key_learnings":[],"remaining_work":[],"goal_complete":false,"commit":{"type":"test","subject":"complete $MOMENTUM_STEP_ID","body":"","breaking":false}}
JSON`;
  fs.writeFileSync(
    profilePath,
    JSON.stringify({
      name: "delegate-recovery-test",
      wrappers: {
        implementation: {
          command: "/bin/sh",
          args: ["-c", script],
          cwd: "iteration",
          timeout_sec: 5,
          env_allow: [],
          result_file: "result.json",
        },
      },
    }),
  );
  return profilePath;
}

function writeNoMistakesProfile(
  profileDir: string,
  statusMode: "completed" | "lagging" | "blocked" = "completed",
  launchIdentityMode: "valid" | "missing" = "valid",
): {
  profilePath: string;
  wrapperConfigPath: string;
} {
  const executablePath = path.join(profileDir, "no-mistakes");
  const statusOutput =
    statusMode === "lagging"
      ? `printf 'run:\n  id: "nm-run-1"\n  branch: %s\n  status: running\n  head: %s\nsteps[1]{step,status,findings,duration_ms}:\n  ci,completed,0,1\n' "$branch" "$head"`
      : statusMode === "blocked"
        ? `printf 'run:\n  id: "nm-run-1"\n  branch: %s\n  status: blocked\n  head: %s\nsteps[1]{step,status,findings,duration_ms}:\n  ci,completed,0,1\n' "$branch" "$head"`
        : `printf 'run:\n  id: "nm-run-1"\n  branch: %s\n  status: completed\n  head: %s\noutcome: checks-passed\nsteps[1]{step,status,findings,duration_ms}:\n  ci,completed,0,1\n' "$branch" "$head"`;
  fs.writeFileSync(
    executablePath,
    `#!/bin/sh
branch=$(git branch --show-current)
head=$(git rev-parse HEAD)
${statusOutput}
`,
  );
  fs.chmodSync(executablePath, 0o755);
  const wrapperConfigPath = path.join(profileDir, "wrapper-config.json");
  fs.writeFileSync(
    wrapperConfigPath,
    JSON.stringify({
      steps: {
        "no-mistakes": {
          command: executablePath,
          args: [],
          cwd: "repo",
          timeout_sec: 5,
          env_allow: ["HOME", "PATH"],
          runner_profile: {
            interface: "axi",
            stdin: "closed",
            agent: "claude",
            required_env: ["HOME", "PATH"],
            agent_path: "/bin/sh",
          },
          commit: { type: "test", subject: "run no-mistakes" },
        },
      },
    }),
  );
  const launchMutation =
    launchIdentityMode === "valid"
      ? `printf 'validated\n' > "$MOMENTUM_REPO_PATH/no-mistakes.txt"`
      : "";
  const launchOutput =
    launchIdentityMode === "valid"
      ? `printf 'run:\n  id: "nm-run-1"\n'`
      : `printf 'launch completed without identity\n'`;
  const launchScript = `count_file="$MOMENTUM_REPO_PATH/.agent-workflows/$MOMENTUM_RUN_ID/no-mistakes-launch-count"
count=0
test ! -f "$count_file" || count=$(cat "$count_file")
printf '%s\n' "$((count + 1))" > "$count_file"
${launchMutation}
${launchOutput}
cat > "$MOMENTUM_RESULT_PATH" <<JSON
{"success":true,"summary":"no-mistakes launched","key_changes_made":[],"key_learnings":[],"remaining_work":[],"goal_complete":false,"commit":{"type":"test","subject":"launch no-mistakes","body":"","breaking":false}}
JSON`;
  const profilePath = path.join(profileDir, "profile.json");
  fs.writeFileSync(
    profilePath,
    JSON.stringify({
      name: "no-mistakes-recovery-test",
      wrappers: {
        "no-mistakes": {
          command: "/bin/sh",
          args: ["-c", launchScript],
          cwd: "iteration",
          timeout_sec: 5,
          env_allow: [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR, "HOME", "PATH"],
          result_file: "result.json",
        },
      },
    }),
  );
  return { profilePath, wrapperConfigPath };
}

function definition(
  stepKeys: string[],
  tool: "gnhf" | "no-mistakes" = "gnhf",
): WorkflowDefinition {
  return {
    key: "delegate-recovery",
    title: "Delegate Recovery",
    version: 1,
    steps: stepKeys.map((key, order) => ({
      key,
      kind: tool === "gnhf" ? "implementation" : "no-mistakes",
      executor: "delegate-supervisor",
      config: { tool },
      order,
      required: true,
    })),
  };
}

function prepareRun(input: {
  dataDir: string;
  repoPath: string;
  runId: string;
  stepKeys: string[];
  tool?: "gnhf" | "no-mistakes";
}) {
  const db = openDb(input.dataDir);
  const workflow = definition(input.stepKeys, input.tool);
  persistWorkflowDefinition(db, workflow, { now: NOW });
  persistWorkflowRunStart(db, {
    definition: workflow,
    runId: input.runId,
    repoPath: input.repoPath,
    objective: "Prove delegated handoff recovery",
    now: NOW,
  });
  db.prepare(
    "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ?",
  ).run(input.runId);
  return db;
}

function claimStep(
  db: ReturnType<typeof openDb>,
  runId: string,
  stepId: string,
  now: number,
) {
  const claim = claimRunnableWorkflowStep(db, {
    runId,
    stepId,
    holder: "delegate-test-worker",
    leaseExpiresAt: now + 30_000,
    now,
  });
  if (!claim.ok) throw new Error(claim.reason);
  return claim.claim;
}

function reopenInterruptedHandoff(
  db: ReturnType<typeof openDb>,
  runId: string,
  stepId: string,
): void {
  const round = db
    .prepare(
      "SELECT round_id FROM executor_rounds WHERE workflow_run_id = ? AND attempt = 1",
    )
    .get(runId) as { round_id: string };
  db.prepare(
    "DELETE FROM executor_checkpoints WHERE round_id = ? AND stage <> 'delegate_handoff_intent'",
  ).run(round.round_id);
  db.prepare(
    `UPDATE executor_invocations
        SET state = 'running', attempt = 2, finished_at = NULL
      WHERE workflow_run_id = ?`,
  ).run(runId);
  db.prepare(
    `UPDATE workflow_steps
        SET state = 'approved', finished_at = NULL
      WHERE run_id = ? AND step_id = ?`,
  ).run(runId, stepId);
  db.prepare(
    `UPDATE workflow_runs
        SET state = 'approved', finished_at = NULL
      WHERE id = ?`,
  ).run(runId);
}

function reopenCompletedHandoff(
  db: ReturnType<typeof openDb>,
  runId: string,
  stepId: string,
): void {
  const round = db
    .prepare(
      "SELECT round_id FROM executor_rounds WHERE workflow_run_id = ? AND attempt = 1",
    )
    .get(runId) as { round_id: string };
  db.prepare(
    "DELETE FROM executor_checkpoints WHERE round_id = ? AND stage NOT IN ('delegate_handoff_intent', 'delegate_handoff_completed')",
  ).run(round.round_id);
  db.prepare(
    `UPDATE executor_rounds
        SET state = 'running', classification = NULL, recovery_code = NULL,
            human_gate = NULL, finished_at = NULL
      WHERE round_id = ?`,
  ).run(round.round_id);
  db.prepare(
    `UPDATE executor_invocations
        SET state = 'running', finished_at = NULL
      WHERE workflow_run_id = ?`,
  ).run(runId);
  db.prepare(
    `UPDATE workflow_steps
        SET state = 'approved', finished_at = NULL
      WHERE run_id = ? AND step_id = ?`,
  ).run(runId, stepId);
  db.prepare(
    `UPDATE workflow_runs
        SET state = 'approved', finished_at = NULL
      WHERE id = ?`,
  ).run(runId);
}

describe(
  "profile-backed delegate handoff artifacts",
  { timeout: 60_000 },
  () => {
    it.each(["gnhf", "no-mistakes"] as const)(
      "rejects a symbolic-link %s handoff receipt",
      async (tool) => {
        const repoPath = initRepo();
        const branch = runGit(repoPath, ["branch", "--show-current"]);
        const headSha = runGit(repoPath, ["rev-parse", "HEAD"]);
        const root = path.join(repoPath, ".agent-workflows", "symlink-receipt");
        fs.mkdirSync(root, { recursive: true });
        const handoffReceiptPath = path.join(root, "delegate-handoff.json");
        const realReceiptPath = path.join(root, "real-receipt.json");
        const statePath = path.join(root, "delegate-external-state.json");
        const resultJsonPath = path.join(root, "result.json");
        const executorLogPath = path.join(root, "executor.log");
        const verificationLogPath = path.join(root, "verification.log");
        const invocationId = "symlink-receipt::step::dispatch";
        const receipt =
          tool === "gnhf"
            ? {
                schemaVersion: 1,
                tool,
                invocationId,
                attempt: 1,
                phase: "launched",
                baseHead: headSha,
                branch,
                statePath,
                resultJsonPath,
                executorLogPath,
                verificationLogPath,
                preexistingResultDigest: null,
              }
            : {
                schemaVersion: 1,
                invocationId,
                attempt: 1,
                phase: "launched",
                branch,
                headSha,
                statePath,
                resultJsonPath,
                executorLogPath,
                externalIdentity: {
                  externalRunId: "nm-run-1",
                  branch,
                  headSha,
                },
              };
        fs.writeFileSync(realReceiptPath, JSON.stringify(receipt));
        fs.symlinkSync(realReceiptPath, handoffReceiptPath);
        const adapter = createProfileBackedDelegateToolAdapter({
          tool,
          invocationId,
          attempt: 1,
          branch,
          headSha,
          statePath,
          handoffReceiptPath,
          resultJsonPath,
          executorLogPath,
          repoPath,
          repoSafety: {
            baseHead: headSha,
            verificationCommands: [],
            verificationTimeoutSec: 5,
            verificationLogPath,
          },
          run: () => {
            throw new Error("unexpected launch");
          },
          statusCommand: "/usr/bin/false",
          statusArgsPrefix: [],
          statusEnv: {},
          legacyPaths: {
            rootDir: root,
            handoffReceiptPath: path.join(root, "legacy-handoff.json"),
          },
        });

        await expect(
          Promise.resolve().then(() =>
            adapter.recoverHandoff!({
              invocation: {} as never,
              config: { tool },
              signal: new AbortController().signal,
            }),
          ),
        ).rejects.toThrow(/not a bounded regular file/);
      },
    );

    it("rejects symbolic-link no-mistakes launch evidence", async () => {
      const repoPath = initRepo();
      const branch = runGit(repoPath, ["branch", "--show-current"]);
      const headSha = runGit(repoPath, ["rev-parse", "HEAD"]);
      const root = path.join(
        repoPath,
        ".agent-workflows",
        "symlink-launch-log",
      );
      fs.mkdirSync(root, { recursive: true });
      const handoffReceiptPath = path.join(root, "delegate-handoff.json");
      const statePath = path.join(root, "delegate-external-state.json");
      const resultJsonPath = path.join(root, "result.json");
      const executorLogPath = path.join(root, "executor.log");
      const realExecutorLogPath = path.join(root, "real-executor.log");
      const verificationLogPath = path.join(root, "verification.log");
      const invocationId = "symlink-launch-log::step::dispatch";
      fs.writeFileSync(realExecutorLogPath, 'run:\n  id: "nm-run-1"\n');
      fs.symlinkSync(realExecutorLogPath, executorLogPath);
      fs.writeFileSync(
        handoffReceiptPath,
        JSON.stringify({
          schemaVersion: 1,
          invocationId,
          attempt: 1,
          phase: "launching",
          branch,
          headSha,
          statePath,
          resultJsonPath,
          executorLogPath,
        }),
      );
      const adapter = createProfileBackedDelegateToolAdapter({
        tool: "no-mistakes",
        invocationId,
        attempt: 1,
        branch,
        headSha,
        statePath,
        handoffReceiptPath,
        resultJsonPath,
        executorLogPath,
        repoPath,
        repoSafety: {
          baseHead: headSha,
          verificationCommands: [],
          verificationTimeoutSec: 5,
          verificationLogPath,
        },
        run: () => {
          throw new Error("unexpected launch");
        },
        statusCommand: "/usr/bin/false",
        statusArgsPrefix: [],
        statusEnv: {},
        legacyPaths: {
          rootDir: root,
          handoffReceiptPath: path.join(root, "legacy-handoff.json"),
        },
      });

      await expect(
        adapter.recoverHandoff!({
          invocation: {} as never,
          config: { tool: "no-mistakes" },
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(/launch evidence.*bounded regular file/);
    });

    it.each(["failed", "cancelled"] as const)(
      "launches a fresh run after a prior-attempt no-mistakes run is %s",
      async (terminalStatus) => {
        const repoPath = initRepo();
        const branch = runGit(repoPath, ["branch", "--show-current"]);
        const headSha = runGit(repoPath, ["rev-parse", "HEAD"]);
        const root = path.join(
          repoPath,
          ".agent-workflows",
          `terminal-${terminalStatus}-retry`,
        );
        fs.mkdirSync(root, { recursive: true });
        const handoffReceiptPath = path.join(root, "delegate-handoff.json");
        const statePath = path.join(root, "delegate-external-state.json");
        const resultJsonPath = path.join(root, "result.json");
        const executorLogPath = path.join(root, "executor.log");
        const verificationLogPath = path.join(root, "verification.log");
        const statusCountPath = path.join(root, "status-count");
        const statusCommand = path.join(root, "status.sh");
        const invocationId = `terminal-${terminalStatus}-retry::no-mistakes::dispatch`;
        fs.writeFileSync(
          handoffReceiptPath,
          JSON.stringify({
            schemaVersion: 1,
            invocationId,
            attempt: 1,
            phase: "launched",
            branch,
            headSha,
            statePath,
            resultJsonPath,
            executorLogPath,
            externalIdentity: {
              externalRunId: "nm-run-old",
              branch,
              headSha,
            },
          }),
        );
        fs.writeFileSync(
          statusCommand,
          `#!/bin/sh
count=0
test ! -f '${statusCountPath}' || count=$(cat '${statusCountPath}')
count=$((count + 1))
printf '%s\n' "$count" > '${statusCountPath}'
head=$(git -C '${repoPath}' rev-parse HEAD)
if test "$count" -eq 1; then
  printf 'run:\n  id: "nm-run-old"\n  branch: ${branch}\n  status: ${terminalStatus}\n  head: %s\nsteps[1]{step,status,findings,duration_ms}:\n  ci,failed,0,1\n' "$head"
else
  printf 'run:\n  id: "nm-run-new"\n  branch: ${branch}\n  status: completed\n  head: %s\noutcome: checks-passed\nsteps[1]{step,status,findings,duration_ms}:\n  ci,completed,0,1\n' "$head"
fi
`,
        );
        fs.chmodSync(statusCommand, 0o755);
        let launches = 0;
        const adapter = createProfileBackedDelegateToolAdapter({
          tool: "no-mistakes",
          invocationId,
          attempt: 2,
          branch,
          headSha,
          statePath,
          handoffReceiptPath,
          resultJsonPath,
          executorLogPath,
          repoPath,
          repoSafety: {
            baseHead: headSha,
            verificationCommands: [],
            verificationTimeoutSec: 5,
            verificationLogPath,
          },
          run: () => {
            launches += 1;
            fs.writeFileSync(executorLogPath, 'run:\n  id: "nm-run-new"\n');
            fs.writeFileSync(path.join(repoPath, "retried.txt"), "retried\n");
            fs.writeFileSync(
              resultJsonPath,
              JSON.stringify({
                success: true,
                summary: "fresh no-mistakes run launched",
                key_changes_made: [],
                key_learnings: [],
                remaining_work: [],
                goal_complete: false,
                commit: {
                  type: "test",
                  subject: "retry no-mistakes",
                  body: "",
                  breaking: false,
                },
              }),
            );
            return {
              ok: true,
              result: {
                state: "succeeded",
                summary: "fresh no-mistakes run launched",
                checkpoints: [],
                artifacts: [],
                resultDigest: null,
                errorCode: null,
                errorMessage: null,
                retryHint: null,
                recoveryHint: null,
              },
              executorLogPath,
              resultJsonPath,
            };
          },
          statusCommand,
          statusArgsPrefix: [],
          statusEnv: {},
          legacyPaths: {
            rootDir: root,
            handoffReceiptPath: path.join(root, "legacy-handoff.json"),
          },
        });

        const handoff = await adapter.recoverHandoff!({
          invocation: {} as never,
          config: { tool: "no-mistakes" },
          signal: new AbortController().signal,
        });

        expect(launches).toBe(1);
        expect(handoff.externalIdentity.externalRunId).toBe("nm-run-new");
        expect(handoff.terminalState?.value.stepStatus).toBe("completed");
        expect(fs.readFileSync(statusCountPath, "utf8")).toBe("2\n");
        expect(
          JSON.parse(fs.readFileSync(handoffReceiptPath, "utf8")),
        ).toMatchObject({
          attempt: 2,
          phase: "launched",
          externalIdentity: { externalRunId: "nm-run-new" },
        });
      },
    );

    it("namespaces attempt-one artifacts by step", async () => {
      const dataDir = tempDir();
      const repoPath = initRepo();
      const runId = "delegate-artifact-scope";
      const profilePath = writeProfile(tempDir());
      const db = prepareRun({
        dataDir,
        repoPath,
        runId,
        stepKeys: ["implementation-a", "implementation-b"],
      });
      const resolved = resolveDaemonWorkflowStepDispatch(
        { [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: profilePath },
        executeWorkflowStepDispatch,
        {},
      );
      if (!resolved.ok) throw new Error(resolved.message);

      await resolved.dispatch(claimStep(db, runId, "implementation-a", NOW), {
        db,
        workerId: "delegate-test-worker",
        now: NOW + 1,
      });
      await resolved.dispatch(
        claimStep(db, runId, "implementation-b", NOW + 2),
        {
          db,
          workerId: "delegate-test-worker",
          now: NOW + 3,
        },
      );

      const artifactRoot = path.join(repoPath, ".agent-workflows", runId);
      for (const stepId of ["implementation-a", "implementation-b"]) {
        const stepRoot = path.join(artifactRoot, "delegate", stepId);
        expect(fs.existsSync(path.join(stepRoot, "executor.log"))).toBe(true);
        expect(fs.existsSync(path.join(stepRoot, "result.json"))).toBe(true);
        expect(
          fs.existsSync(path.join(stepRoot, "delegate-external-state.json")),
        ).toBe(true);
        expect(
          fs.existsSync(path.join(stepRoot, "delegate-handoff.json")),
        ).toBe(true);
      }
      expect(fs.existsSync(path.join(artifactRoot, "executor.log"))).toBe(
        false,
      );
      expect(
        fs.existsSync(path.join(artifactRoot, "delegate-external-state.json")),
      ).toBe(false);
      db.close();
    });

    it("releases a failed handoff lock before the production retry reacquires it", async () => {
      const dataDir = tempDir();
      const repoPath = initRepo();
      const runId = "no-mistakes-handoff-lock-retry";
      const stepId = "no-mistakes";
      const profile = writeNoMistakesProfile(tempDir(), "completed", "missing");
      const db = prepareRun({
        dataDir,
        repoPath,
        runId,
        stepKeys: [stepId],
        tool: "no-mistakes",
      });
      const resolved = resolveDaemonWorkflowStepDispatch(
        {
          [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: profile.profilePath,
          [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: profile.wrapperConfigPath,
          HOME: process.env.HOME,
          PATH: process.env.PATH,
        },
        executeWorkflowStepDispatch,
        {},
      );
      if (!resolved.ok) throw new Error(resolved.message);

      await resolved.dispatch(claimStep(db, runId, stepId, NOW), {
        db,
        workerId: "delegate-test-worker",
        now: NOW + 1,
      });
      expect(
        db
          .prepare(
            "SELECT state, attempt FROM executor_invocations WHERE workflow_run_id = ?",
          )
          .get(runId),
      ).toEqual({ state: "manual_recovery_required", attempt: 1 });
      expect(
        db
          .prepare(
            "SELECT needs_manual_recovery FROM workflow_runs WHERE id = ?",
          )
          .get(runId),
      ).toEqual({ needs_manual_recovery: 1 });
      expect(
        db
          .prepare(
            "SELECT state, iteration FROM repo_locks WHERE goal_id = ? ORDER BY acquired_at DESC LIMIT 1",
          )
          .get(runId),
      ).toEqual({ state: "needs_manual_recovery", iteration: 1 });

      expect(
        clearWorkflowRunManualRecoveryGuarded(db, {
          runId,
          now: NOW + 2,
        }),
      ).toMatchObject({
        ok: true,
        retryPrepared: {
          stepId,
          recoveryCode: "delegate_handoff_failed",
        },
      });
      expect(
        db
          .prepare(
            "SELECT state FROM repo_locks WHERE goal_id = ? AND iteration = 1",
          )
          .get(runId),
      ).toEqual({ state: "released" });

      await resolved.dispatch(claimStep(db, runId, stepId, NOW + 3), {
        db,
        workerId: "delegate-test-worker",
        now: NOW + 4,
      });
      expect(
        db
          .prepare(
            "SELECT state, attempt FROM executor_invocations WHERE workflow_run_id = ?",
          )
          .get(runId),
      ).toEqual({ state: "manual_recovery_required", attempt: 2 });
      expect(
        db
          .prepare(
            "SELECT state, iteration FROM repo_locks WHERE goal_id = ? ORDER BY iteration",
          )
          .all(runId),
      ).toEqual([
        { state: "released", iteration: 1 },
        { state: "needs_manual_recovery", iteration: 2 },
      ]);
      expect(
        db
          .prepare(
            "SELECT recovery_code FROM executor_rounds WHERE workflow_run_id = ? ORDER BY round_index DESC LIMIT 1",
          )
          .get(runId),
      ).toEqual({ recovery_code: "delegate_handoff_failed" });
      db.close();
    });

    it("recovers a committed handoff from its finalization receipt", async () => {
      const dataDir = tempDir();
      const repoPath = initRepo();
      const runId = "delegate-commit-recovery";
      const stepId = "implementation";
      const profilePath = writeProfile(tempDir());
      const db = prepareRun({
        dataDir,
        repoPath,
        runId,
        stepKeys: [stepId],
      });
      const resolved = resolveDaemonWorkflowStepDispatch(
        { [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: profilePath },
        executeWorkflowStepDispatch,
        {},
      );
      if (!resolved.ok) throw new Error(resolved.message);
      const receiptPath = path.join(
        repoPath,
        ".agent-workflows",
        runId,
        "delegate",
        stepId,
        "delegate-handoff.json",
      );
      await resolved.dispatch(claimStep(db, runId, stepId, NOW), {
        db,
        workerId: "delegate-test-worker",
        now: NOW + 1,
      });

      expect(runGit(repoPath, ["log", "-1", "--format=%s"])).toBe(
        "test: complete implementation",
      );
      const receipt = JSON.parse(
        fs.readFileSync(receiptPath, "utf8"),
      ) as Record<string, unknown>;
      expect(receipt).toMatchObject({
        phase: "finalized",
        invocationId: `${runId}::${stepId}::dispatch`,
      });
      delete receipt["externalState"];
      receipt["phase"] = "finalizing";
      fs.writeFileSync(receiptPath, JSON.stringify(receipt));
      fs.rmSync(
        path.join(path.dirname(receiptPath), "delegate-external-state.json"),
      );
      reopenInterruptedHandoff(db, runId, stepId);

      await resolved.dispatch(claimStep(db, runId, stepId, NOW + 2), {
        db,
        workerId: "delegate-test-worker",
        now: NOW + 3,
      });

      expect(
        db
          .prepare(
            "SELECT state, attempt FROM executor_invocations WHERE workflow_run_id = ?",
          )
          .get(runId),
      ).toEqual({ state: "succeeded", attempt: 2 });
      expect(
        fs.readFileSync(
          path.join(repoPath, ".agent-workflows", runId, "gnhf-launch-count"),
          "utf8",
        ),
      ).toBe("1\n");
      expect(JSON.parse(fs.readFileSync(receiptPath, "utf8"))).toMatchObject({
        phase: "finalized",
        externalState: { stepStatus: "completed" },
      });
      db.close();
    });

    it("refuses a completed generic handoff after repository HEAD advances", async () => {
      const dataDir = tempDir();
      const repoPath = initRepo();
      const runId = "delegate-completed-head-drift";
      const stepId = "implementation";
      const profilePath = writeProfile(tempDir());
      const db = prepareRun({
        dataDir,
        repoPath,
        runId,
        stepKeys: [stepId],
      });
      const resolved = resolveDaemonWorkflowStepDispatch(
        { [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: profilePath },
        executeWorkflowStepDispatch,
        {},
      );
      if (!resolved.ok) throw new Error(resolved.message);

      await resolved.dispatch(claimStep(db, runId, stepId, NOW), {
        db,
        workerId: "delegate-test-worker",
        now: NOW + 1,
      });
      const delegatedHead = runGit(repoPath, ["rev-parse", "HEAD"]);
      fs.writeFileSync(path.join(repoPath, "external-change.txt"), "drift\n");
      runGit(repoPath, ["add", "external-change.txt"]);
      runGit(repoPath, ["commit", "--quiet", "-m", "test: advance head"]);
      expect(runGit(repoPath, ["rev-parse", "HEAD"])).not.toBe(delegatedHead);
      reopenCompletedHandoff(db, runId, stepId);

      await resolved.dispatch(claimStep(db, runId, stepId, NOW + 2), {
        db,
        workerId: "delegate-test-worker",
        now: NOW + 3,
      });

      expect(
        db
          .prepare(
            "SELECT state FROM executor_invocations WHERE workflow_run_id = ?",
          )
          .get(runId),
      ).toEqual({ state: "manual_recovery_required" });
      expect(
        db
          .prepare(
            "SELECT recovery_code FROM executor_rounds WHERE workflow_run_id = ? ORDER BY round_index DESC LIMIT 1",
          )
          .get(runId),
      ).toEqual({ recovery_code: "external_state_unreadable" });
      db.close();
    });

    it.each([
      {
        alterResult: false,
        expectedPhase: "finalized",
        expectedState: "failed",
        name: "recovers a completed reset from its durable reset intent",
      },
      {
        alterResult: true,
        expectedPhase: "resetting",
        expectedState: "manual_recovery_required",
        name: "refuses a completed reset with altered result evidence",
      },
    ] as const)(
      "$name",
      async ({ alterResult, expectedPhase, expectedState }) => {
        const dataDir = tempDir();
        const repoPath = initRepo();
        const runId = alterResult
          ? "delegate-reset-altered-result"
          : "delegate-reset-recovery";
        const stepId = "implementation";
        const profilePath = writeProfile(tempDir());
        const db = prepareRun({
          dataDir,
          repoPath,
          runId,
          stepKeys: [stepId],
        });
        const resolved = resolveDaemonWorkflowStepDispatch(
          { [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: profilePath },
          executeWorkflowStepDispatch,
          {},
        );
        if (!resolved.ok) throw new Error(resolved.message);
        const stepRoot = path.join(
          repoPath,
          ".agent-workflows",
          runId,
          "delegate",
          stepId,
        );
        const receiptPath = path.join(stepRoot, "delegate-handoff.json");
        await resolved.dispatch(claimStep(db, runId, stepId, NOW), {
          db,
          workerId: "delegate-test-worker",
          now: NOW + 1,
        });

        const receipt = JSON.parse(
          fs.readFileSync(receiptPath, "utf8"),
        ) as Record<string, unknown>;
        const baseHead = String(receipt["baseHead"]);
        runGit(repoPath, ["reset", "--hard", baseHead]);
        delete receipt["externalState"];
        receipt["phase"] = "resetting";
        receipt["expectedTree"] = runGit(repoPath, [
          "rev-parse",
          `${baseHead}^{tree}`,
        ]);
        fs.writeFileSync(receiptPath, JSON.stringify(receipt));
        if (alterResult) {
          const resultPath = path.join(stepRoot, "result.json");
          const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as {
            commit: { subject: string };
          };
          result.commit.subject = "altered commit intent";
          fs.writeFileSync(resultPath, JSON.stringify(result));
        }
        fs.rmSync(path.join(stepRoot, "delegate-external-state.json"));
        reopenInterruptedHandoff(db, runId, stepId);

        await resolved.dispatch(claimStep(db, runId, stepId, NOW + 2), {
          db,
          workerId: "delegate-test-worker",
          now: NOW + 3,
        });

        expect(
          db
            .prepare(
              "SELECT state, attempt FROM executor_invocations WHERE workflow_run_id = ?",
            )
            .get(runId),
        ).toEqual({ state: expectedState, attempt: 2 });
        expect(
          fs.readFileSync(
            path.join(repoPath, ".agent-workflows", runId, "gnhf-launch-count"),
            "utf8",
          ),
        ).toBe("1\n");
        expect(JSON.parse(fs.readFileSync(receiptPath, "utf8"))).toMatchObject(
          alterResult
            ? { phase: expectedPhase }
            : {
                phase: expectedPhase,
                externalState: { stepStatus: "failed", headSha: baseHead },
              },
        );
        db.close();
      },
    );

    it.each([
      {
        recoveryMode: "launching receipt",
        removeReceipt: false,
        expectedState: "manual_recovery_required",
        expectedReceiptPhase: "launching",
      },
      {
        recoveryMode: "missing receipt",
        removeReceipt: true,
        expectedState: "manual_recovery_required",
        expectedReceiptPhase: null,
      },
    ] as const)(
      "handles no-mistakes interruption with $recoveryMode",
      async ({ removeReceipt, expectedReceiptPhase, expectedState }) => {
        const dataDir = tempDir();
        const repoPath = initRepo();
        const runId = removeReceipt
          ? "no-mistakes-missing-receipt-recovery"
          : "no-mistakes-launch-recovery";
        const stepId = "no-mistakes";
        const profile = writeNoMistakesProfile(tempDir());
        const db = prepareRun({
          dataDir,
          repoPath,
          runId,
          stepKeys: [stepId],
          tool: "no-mistakes",
        });
        const env = {
          [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: profile.profilePath,
          [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: profile.wrapperConfigPath,
          HOME: process.env.HOME,
          PATH: process.env.PATH,
        };
        const resolved = resolveDaemonWorkflowStepDispatch(
          env,
          executeWorkflowStepDispatch,
          {},
        );
        if (!resolved.ok) throw new Error(resolved.message);
        const stepRoot = path.join(
          repoPath,
          ".agent-workflows",
          runId,
          "delegate",
          stepId,
        );
        const receiptPath = path.join(stepRoot, "delegate-handoff.json");
        await resolved.dispatch(claimStep(db, runId, stepId, NOW), {
          db,
          workerId: "delegate-test-worker",
          now: NOW + 1,
        });

        expect(
          db
            .prepare(
              "SELECT state FROM executor_invocations WHERE workflow_run_id = ?",
            )
            .get(runId),
        ).toEqual({ state: "succeeded" });
        const receipt = JSON.parse(
          fs.readFileSync(receiptPath, "utf8"),
        ) as Record<string, unknown>;
        const interruptedExecutorLogPath = receipt["executorLogPath"];
        expect(receipt).toMatchObject({ schemaVersion: 1, phase: "launched" });
        if (removeReceipt) {
          fs.rmSync(receiptPath);
        } else {
          receipt["phase"] = "launching";
          delete receipt["externalIdentity"];
          delete receipt["terminalProofHeadSha"];
          fs.writeFileSync(receiptPath, JSON.stringify(receipt));
        }
        fs.rmSync(path.join(stepRoot, "delegate-external-state.json"));
        reopenInterruptedHandoff(db, runId, stepId);

        await resolved.dispatch(claimStep(db, runId, stepId, NOW + 2), {
          db,
          workerId: "delegate-test-worker",
          now: NOW + 3,
        });

        expect(
          db
            .prepare(
              "SELECT state, attempt FROM executor_invocations WHERE workflow_run_id = ?",
            )
            .get(runId),
        ).toEqual({ state: expectedState, attempt: 2 });
        expect(
          fs.readFileSync(
            path.join(
              repoPath,
              ".agent-workflows",
              runId,
              "no-mistakes-launch-count",
            ),
            "utf8",
          ),
        ).toBe("1\n");
        if (removeReceipt) {
          expect(fs.existsSync(receiptPath)).toBe(false);
        } else {
          expect(
            JSON.parse(fs.readFileSync(receiptPath, "utf8")),
          ).toMatchObject({
            phase: expectedReceiptPhase,
            attempt: 1,
            executorLogPath: interruptedExecutorLogPath,
          });
        }
        db.close();
      },
    );

    it.each(["unstaged", "staged", "untracked"] as const)(
      "refuses to promote a launching no-mistakes receipt with %s worktree changes",
      async (worktreeState) => {
        const repoPath = initRepo();
        const branch = runGit(repoPath, ["branch", "--show-current"]);
        const headSha = runGit(repoPath, ["rev-parse", "HEAD"]);
        const root = path.join(
          repoPath,
          ".agent-workflows",
          `no-mistakes-launching-${worktreeState}`,
        );
        fs.mkdirSync(root, { recursive: true });
        const handoffReceiptPath = path.join(root, "delegate-handoff.json");
        const statePath = path.join(root, "delegate-external-state.json");
        const resultJsonPath = path.join(root, "result.json");
        const executorLogPath = path.join(root, "executor.log");
        const verificationLogPath = path.join(root, "verification.log");
        const invocationId = `no-mistakes-launching-${worktreeState}::no-mistakes::dispatch`;
        fs.writeFileSync(executorLogPath, 'run:\n  id: "nm-run-1"\n');
        fs.writeFileSync(
          handoffReceiptPath,
          JSON.stringify({
            schemaVersion: 1,
            invocationId,
            attempt: 1,
            phase: "launching",
            branch,
            headSha,
            statePath,
            resultJsonPath,
            executorLogPath,
          }),
        );
        if (worktreeState === "untracked") {
          fs.writeFileSync(path.join(repoPath, "dirty.txt"), "unfinalized\n");
        } else {
          fs.writeFileSync(path.join(repoPath, "README.md"), "unfinalized\n");
          if (worktreeState === "staged") {
            runGit(repoPath, ["add", "README.md"]);
          }
        }
        const adapter = createProfileBackedDelegateToolAdapter({
          tool: "no-mistakes",
          invocationId,
          attempt: 2,
          branch,
          headSha,
          statePath,
          handoffReceiptPath,
          resultJsonPath,
          executorLogPath,
          repoPath,
          repoSafety: {
            baseHead: headSha,
            verificationCommands: [],
            verificationTimeoutSec: 5,
            verificationLogPath,
          },
          run: () => {
            throw new Error("interrupted handoff must not relaunch");
          },
          statusCommand: "/usr/bin/false",
          statusArgsPrefix: [],
          statusEnv: {},
          legacyPaths: {
            rootDir: root,
            handoffReceiptPath: path.join(root, "legacy-handoff.json"),
          },
        });

        await expect(
          adapter.recoverHandoff!({
            invocation: {} as never,
            config: { tool: "no-mistakes" },
            signal: new AbortController().signal,
          }),
        ).rejects.toThrow(/launching receipt has unfinalized worktree changes/);
        expect(
          JSON.parse(fs.readFileSync(handoffReceiptPath, "utf8")),
        ).toMatchObject({ phase: "launching" });
        expect(
          runGit(repoPath, ["status", "--porcelain", "--untracked-files=all"]),
        ).not.toBe("");
      },
    );

    it.each([
      {
        advanceHead: false,
        name: "without durable finalization proof",
        error: /no durable wrapper-finalization proof/,
      },
      {
        advanceHead: true,
        name: "after HEAD advances",
        error: /launching receipt has unfinalized HEAD/,
      },
    ])(
      "refuses to promote a clean launching no-mistakes receipt $name",
      async ({ advanceHead, error }) => {
        const repoPath = initRepo();
        const branch = runGit(repoPath, ["branch", "--show-current"]);
        const headSha = runGit(repoPath, ["rev-parse", "HEAD"]);
        const root = path.join(
          repoPath,
          ".agent-workflows",
          "no-mistakes-launching-advanced-head",
        );
        fs.mkdirSync(root, { recursive: true });
        const handoffReceiptPath = path.join(root, "delegate-handoff.json");
        const statePath = path.join(root, "delegate-external-state.json");
        const resultJsonPath = path.join(root, "result.json");
        const executorLogPath = path.join(root, "executor.log");
        const verificationLogPath = path.join(root, "verification.log");
        const invocationId =
          "no-mistakes-launching-advanced-head::no-mistakes::dispatch";
        fs.writeFileSync(executorLogPath, 'run:\n  id: "nm-run-1"\n');
        fs.writeFileSync(
          handoffReceiptPath,
          JSON.stringify({
            schemaVersion: 1,
            invocationId,
            attempt: 1,
            phase: "launching",
            branch,
            headSha,
            statePath,
            resultJsonPath,
            executorLogPath,
          }),
        );
        if (advanceHead) {
          fs.writeFileSync(path.join(repoPath, "advanced.txt"), "committed\n");
          runGit(repoPath, ["add", "advanced.txt"]);
          runGit(repoPath, ["commit", "--quiet", "-m", "test: advance head"]);
        }
        expect(
          runGit(repoPath, ["status", "--porcelain", "--untracked-files=all"]),
        ).toBe("");
        const adapter = createProfileBackedDelegateToolAdapter({
          tool: "no-mistakes",
          invocationId,
          attempt: 2,
          branch,
          headSha,
          statePath,
          handoffReceiptPath,
          resultJsonPath,
          executorLogPath,
          repoPath,
          repoSafety: {
            baseHead: headSha,
            verificationCommands: ["/usr/bin/false"],
            verificationTimeoutSec: 5,
            verificationLogPath,
          },
          run: () => {
            throw new Error("interrupted handoff must not relaunch");
          },
          statusCommand: "/usr/bin/false",
          statusArgsPrefix: [],
          statusEnv: {},
          legacyPaths: {
            rootDir: root,
            handoffReceiptPath: path.join(root, "legacy-handoff.json"),
          },
        });

        await expect(
          adapter.recoverHandoff!({
            invocation: {} as never,
            config: { tool: "no-mistakes" },
            signal: new AbortController().signal,
          }),
        ).rejects.toThrow(error);
        expect(
          JSON.parse(fs.readFileSync(handoffReceiptPath, "utf8")),
        ).toMatchObject({ phase: "launching", headSha });
      },
    );

    it("binds lagging no-mistakes terminal proof to post-finalization HEAD", async () => {
      const dataDir = tempDir();
      const repoPath = initRepo();
      const runId = "no-mistakes-post-finalization-head";
      const stepId = "no-mistakes";
      const profile = writeNoMistakesProfile(tempDir(), "lagging");
      const db = prepareRun({
        dataDir,
        repoPath,
        runId,
        stepKeys: [stepId],
        tool: "no-mistakes",
      });
      const resolved = resolveDaemonWorkflowStepDispatch(
        {
          [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: profile.profilePath,
          [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: profile.wrapperConfigPath,
          HOME: process.env.HOME,
          PATH: process.env.PATH,
        },
        executeWorkflowStepDispatch,
        {},
      );
      if (!resolved.ok) throw new Error(resolved.message);

      await resolved.dispatch(claimStep(db, runId, stepId, NOW), {
        db,
        workerId: "delegate-test-worker",
        now: NOW + 1,
      });

      const currentHead = runGit(repoPath, ["rev-parse", "HEAD"]);
      const receiptPath = path.join(
        repoPath,
        ".agent-workflows",
        runId,
        "delegate",
        stepId,
        "delegate-handoff.json",
      );
      const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as {
        headSha: string;
        terminalProofHeadSha: string;
      };
      expect(receipt.headSha).not.toBe(currentHead);
      expect(receipt.terminalProofHeadSha).toBe(currentHead);
      expect(
        db
          .prepare(
            "SELECT state FROM executor_invocations WHERE workflow_run_id = ?",
          )
          .get(runId),
      ).toEqual({ state: "succeeded" });
      fs.rmSync(
        path.join(path.dirname(receiptPath), "delegate-external-state.json"),
      );
      reopenInterruptedHandoff(db, runId, stepId);

      await resolved.dispatch(claimStep(db, runId, stepId, NOW + 2), {
        db,
        workerId: "delegate-test-worker",
        now: NOW + 3,
      });

      expect(
        db
          .prepare(
            "SELECT state, attempt FROM executor_invocations WHERE workflow_run_id = ?",
          )
          .get(runId),
      ).toEqual({ state: "succeeded", attempt: 2 });
      expect(
        fs.readFileSync(
          path.join(
            repoPath,
            ".agent-workflows",
            runId,
            "no-mistakes-launch-count",
          ),
          "utf8",
        ),
      ).toBe("1\n");
      db.close();
    });

    it("uses fresh descendant status when cached terminal proof is stale", async () => {
      const dataDir = tempDir();
      const repoPath = initRepo();
      const runId = "no-mistakes-stale-terminal-proof";
      const stepId = "no-mistakes";
      const profile = writeNoMistakesProfile(tempDir());
      const db = prepareRun({
        dataDir,
        repoPath,
        runId,
        stepKeys: [stepId],
        tool: "no-mistakes",
      });
      const resolved = resolveDaemonWorkflowStepDispatch(
        {
          [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: profile.profilePath,
          [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: profile.wrapperConfigPath,
          HOME: process.env.HOME,
          PATH: process.env.PATH,
        },
        executeWorkflowStepDispatch,
        {},
      );
      if (!resolved.ok) throw new Error(resolved.message);

      await resolved.dispatch(claimStep(db, runId, stepId, NOW), {
        db,
        workerId: "delegate-test-worker",
        now: NOW + 1,
      });

      const stepRoot = path.join(
        repoPath,
        ".agent-workflows",
        runId,
        "delegate",
        stepId,
      );
      const receiptPath = path.join(stepRoot, "delegate-handoff.json");
      const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as {
        terminalProofHeadSha: string;
      };
      fs.writeFileSync(path.join(repoPath, "descendant.txt"), "new head\n");
      runGit(repoPath, ["add", "descendant.txt"]);
      runGit(repoPath, ["commit", "--quiet", "-m", "test: advance head"]);
      const descendantHead = runGit(repoPath, ["rev-parse", "HEAD"]);
      expect(receipt.terminalProofHeadSha).not.toBe(descendantHead);
      fs.rmSync(path.join(stepRoot, "delegate-external-state.json"));
      reopenInterruptedHandoff(db, runId, stepId);

      await resolved.dispatch(claimStep(db, runId, stepId, NOW + 2), {
        db,
        workerId: "delegate-test-worker",
        now: NOW + 3,
      });

      expect(
        db
          .prepare(
            "SELECT state, attempt FROM executor_invocations WHERE workflow_run_id = ?",
          )
          .get(runId),
      ).toEqual({ state: "succeeded", attempt: 2 });
      expect(
        db
          .prepare(
            "SELECT commit_sha FROM executor_rounds WHERE workflow_run_id = ? ORDER BY round_index DESC LIMIT 1",
          )
          .get(runId),
      ).toEqual({ commit_sha: descendantHead });
      db.close();
    });

    it("does not settle success after no-mistakes verification failure", async () => {
      const dataDir = tempDir();
      const repoPath = initRepo();
      fs.writeFileSync(
        path.join(repoPath, "MOMENTUM.md"),
        "---\nverification:\n  - /usr/bin/false\nverification_timeout_sec: 5\n---\n",
      );
      runGit(repoPath, ["add", "MOMENTUM.md"]);
      runGit(repoPath, ["commit", "--quiet", "-m", "test: fail verification"]);
      const runId = "no-mistakes-verification-failure";
      const stepId = "no-mistakes";
      const profile = writeNoMistakesProfile(tempDir());
      const db = prepareRun({
        dataDir,
        repoPath,
        runId,
        stepKeys: [stepId],
        tool: "no-mistakes",
      });
      const resolved = resolveDaemonWorkflowStepDispatch(
        {
          [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: profile.profilePath,
          [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: profile.wrapperConfigPath,
          HOME: process.env.HOME,
          PATH: process.env.PATH,
        },
        executeWorkflowStepDispatch,
        {},
      );
      if (!resolved.ok) throw new Error(resolved.message);

      await resolved.dispatch(claimStep(db, runId, stepId, NOW), {
        db,
        workerId: "delegate-test-worker",
        now: NOW + 1,
      });

      expect(
        db
          .prepare(
            "SELECT state FROM executor_invocations WHERE workflow_run_id = ?",
          )
          .get(runId),
      ).toEqual({ state: "manual_recovery_required" });
      const stepRoot = path.join(
        repoPath,
        ".agent-workflows",
        runId,
        "delegate",
        stepId,
      );
      const receiptPath = path.join(stepRoot, "delegate-handoff.json");
      const receipt = JSON.parse(
        fs.readFileSync(receiptPath, "utf8"),
      ) as Record<string, unknown>;
      expect(receipt).toMatchObject({ phase: "failed" });
      expect(fs.existsSync(path.join(repoPath, "no-mistakes.txt"))).toBe(false);
      receipt["phase"] = "resetting";
      delete receipt["failureSummary"];
      fs.writeFileSync(receiptPath, JSON.stringify(receipt));
      const recoveryRepoPath = fs.realpathSync(repoPath);
      const recoveryStepRoot = path.join(
        recoveryRepoPath,
        ".agent-workflows",
        runId,
        "delegate",
        stepId,
      );
      const recoveryAdapter = createProfileBackedDelegateToolAdapter({
        tool: "no-mistakes",
        invocationId: `${runId}::${stepId}::dispatch`,
        attempt: 2,
        branch: runGit(repoPath, ["branch", "--show-current"]),
        headSha: runGit(repoPath, ["rev-parse", "HEAD"]),
        statePath: path.join(recoveryStepRoot, "delegate-external-state.json"),
        handoffReceiptPath: path.join(
          recoveryStepRoot,
          "delegate-handoff.json",
        ),
        resultJsonPath: path.join(recoveryStepRoot, "result.json"),
        executorLogPath: path.join(recoveryStepRoot, "executor.log"),
        repoPath: recoveryRepoPath,
        repoSafety: {
          baseHead: runGit(repoPath, ["rev-parse", "HEAD"]),
          verificationCommands: ["/usr/bin/false"],
          verificationTimeoutSec: 5,
          verificationLogPath: path.join(recoveryStepRoot, "verification.log"),
        },
        run: () => {
          throw new Error("interrupted reset must not relaunch");
        },
        statusCommand: "/usr/bin/false",
        statusArgsPrefix: [],
        statusEnv: {},
        legacyPaths: {
          rootDir: path.join(recoveryRepoPath, ".agent-workflows", runId),
          handoffReceiptPath: path.join(
            recoveryRepoPath,
            ".agent-workflows",
            runId,
            "delegate-handoff.json",
          ),
        },
      });

      await expect(
        recoveryAdapter.recoverHandoff!({
          invocation: {} as never,
          config: { tool: "no-mistakes" },
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("interrupted during failure reset");
      expect(
        fs.readFileSync(
          path.join(
            repoPath,
            ".agent-workflows",
            runId,
            "no-mistakes-launch-count",
          ),
          "utf8",
        ),
      ).toBe("1\n");
      db.close();
    });

    it("prepares a fresh attempt after a blocked external run is cleared", async () => {
      const dataDir = tempDir();
      const repoPath = initRepo();
      const runId = "no-mistakes-blocked-attempt-retry";
      const stepId = "no-mistakes";
      const profile = writeNoMistakesProfile(tempDir(), "blocked");
      const db = prepareRun({
        dataDir,
        repoPath,
        runId,
        stepKeys: [stepId],
        tool: "no-mistakes",
      });
      const resolved = resolveDaemonWorkflowStepDispatch(
        {
          [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: profile.profilePath,
          [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: profile.wrapperConfigPath,
          HOME: process.env.HOME,
          PATH: process.env.PATH,
        },
        executeWorkflowStepDispatch,
        {},
      );
      if (!resolved.ok) throw new Error(resolved.message);

      await resolved.dispatch(claimStep(db, runId, stepId, NOW), {
        db,
        workerId: "delegate-test-worker",
        now: NOW + 1,
      });

      expect(
        db
          .prepare(
            "SELECT state, attempt FROM executor_invocations WHERE workflow_run_id = ?",
          )
          .get(runId),
      ).toEqual({ state: "blocked", attempt: 1 });
      expect(
        db
          .prepare(
            "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = ?",
          )
          .get(runId, stepId),
      ).toEqual({ state: "running" });

      expect(
        clearWorkflowRunManualRecoveryGuarded(db, {
          runId,
          now: NOW + 2,
        }),
      ).toMatchObject({
        ok: true,
        retryPrepared: {
          stepId,
          recoveryCode: "external_state_blocked",
        },
      });
      expect(
        db
          .prepare(
            "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = ?",
          )
          .get(runId, stepId),
      ).toEqual({ state: "approved" });

      await resolved.dispatch(claimStep(db, runId, stepId, NOW + 3), {
        db,
        workerId: "delegate-test-worker",
        now: NOW + 4,
      });
      expect(
        db
          .prepare(
            "SELECT state, attempt FROM executor_invocations WHERE workflow_run_id = ?",
          )
          .get(runId),
      ).toEqual({ state: "blocked", attempt: 2 });
      db.close();
    });

    it("launches a fresh no-mistakes run after a failed prior attempt is cleared", async () => {
      const dataDir = tempDir();
      const repoPath = initRepo();
      fs.writeFileSync(
        path.join(repoPath, "MOMENTUM.md"),
        "---\nverification:\n  - /usr/bin/false\nverification_timeout_sec: 5\n---\n",
      );
      runGit(repoPath, ["add", "MOMENTUM.md"]);
      runGit(repoPath, ["commit", "--quiet", "-m", "test: fail verification"]);
      const runId = "no-mistakes-failed-attempt-retry";
      const stepId = "no-mistakes";
      const profile = writeNoMistakesProfile(tempDir());
      const db = prepareRun({
        dataDir,
        repoPath,
        runId,
        stepKeys: [stepId],
        tool: "no-mistakes",
      });
      const resolved = resolveDaemonWorkflowStepDispatch(
        {
          [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: profile.profilePath,
          [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: profile.wrapperConfigPath,
          HOME: process.env.HOME,
          PATH: process.env.PATH,
        },
        executeWorkflowStepDispatch,
        {},
      );
      if (!resolved.ok) throw new Error(resolved.message);

      await resolved.dispatch(claimStep(db, runId, stepId, NOW), {
        db,
        workerId: "delegate-test-worker",
        now: NOW + 1,
      });
      expect(
        db
          .prepare(
            "SELECT state, attempt FROM executor_invocations WHERE workflow_run_id = ?",
          )
          .get(runId),
      ).toEqual({ state: "manual_recovery_required", attempt: 1 });

      fs.writeFileSync(
        path.join(repoPath, "MOMENTUM.md"),
        "---\nverification:\n  - /usr/bin/true\nverification_timeout_sec: 5\n---\n",
      );
      runGit(repoPath, ["add", "MOMENTUM.md"]);
      runGit(repoPath, ["commit", "--quiet", "-m", "test: fix verification"]);
      expect(
        clearWorkflowRunManualRecoveryGuarded(db, {
          runId,
          now: NOW + 2,
        }),
      ).toMatchObject({
        ok: true,
        retryPrepared: {
          stepId,
          recoveryCode: "delegate_handoff_failed",
        },
      });

      await resolved.dispatch(claimStep(db, runId, stepId, NOW + 3), {
        db,
        workerId: "delegate-test-worker",
        now: NOW + 4,
      });
      expect(
        db
          .prepare(
            "SELECT state, attempt FROM executor_invocations WHERE workflow_run_id = ?",
          )
          .get(runId),
      ).toEqual({ state: "succeeded", attempt: 2 });
      expect(
        fs.readFileSync(
          path.join(
            repoPath,
            ".agent-workflows",
            runId,
            "no-mistakes-launch-count",
          ),
          "utf8",
        ),
      ).toBe("2\n");
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(
              repoPath,
              ".agent-workflows",
              runId,
              "delegate",
              stepId,
              "delegate-handoff.json",
            ),
            "utf8",
          ),
        ),
      ).toMatchObject({ attempt: 2, phase: "launched" });
      db.close();
    });

    it("recovers a no-mistakes commit from prepared finalization evidence", async () => {
      const dataDir = tempDir();
      const repoPath = initRepo();
      const runId = "no-mistakes-prepared-commit-recovery";
      const stepId = "no-mistakes";
      const profile = writeNoMistakesProfile(tempDir(), "lagging");
      const db = prepareRun({
        dataDir,
        repoPath,
        runId,
        stepKeys: [stepId],
        tool: "no-mistakes",
      });
      const resolved = resolveDaemonWorkflowStepDispatch(
        {
          [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: profile.profilePath,
          [CODING_WORKFLOW_WRAPPER_CONFIG_ENV_VAR]: profile.wrapperConfigPath,
          HOME: process.env.HOME,
          PATH: process.env.PATH,
        },
        executeWorkflowStepDispatch,
        {},
      );
      if (!resolved.ok) throw new Error(resolved.message);

      await resolved.dispatch(claimStep(db, runId, stepId, NOW), {
        db,
        workerId: "delegate-test-worker",
        now: NOW + 1,
      });

      const stepRoot = path.join(
        repoPath,
        ".agent-workflows",
        runId,
        "delegate",
        stepId,
      );
      const receiptPath = path.join(stepRoot, "delegate-handoff.json");
      const receipt = JSON.parse(
        fs.readFileSync(receiptPath, "utf8"),
      ) as Record<string, unknown>;
      const committedHead = runGit(repoPath, ["rev-parse", "HEAD"]);
      expect(receipt["expectedTree"]).toBe(
        runGit(repoPath, ["rev-parse", `${committedHead}^{tree}`]),
      );
      expect(receipt["expectedMessage"]).toBe(
        runGit(repoPath, ["show", "-s", "--format=%B", committedHead]),
      );
      receipt["phase"] = "finalizing";
      delete receipt["terminalProofHeadSha"];
      fs.writeFileSync(receiptPath, JSON.stringify(receipt));
      fs.rmSync(path.join(stepRoot, "delegate-external-state.json"));
      reopenInterruptedHandoff(db, runId, stepId);

      await resolved.dispatch(claimStep(db, runId, stepId, NOW + 2), {
        db,
        workerId: "delegate-test-worker",
        now: NOW + 3,
      });

      expect(runGit(repoPath, ["rev-parse", "HEAD"])).toBe(committedHead);
      expect(
        db
          .prepare(
            "SELECT state, attempt FROM executor_invocations WHERE workflow_run_id = ?",
          )
          .get(runId),
      ).toEqual({ state: "succeeded", attempt: 2 });
      expect(JSON.parse(fs.readFileSync(receiptPath, "utf8"))).toMatchObject({
        phase: "launched",
        terminalProofHeadSha: committedHead,
      });
      expect(
        fs.readFileSync(
          path.join(
            repoPath,
            ".agent-workflows",
            runId,
            "no-mistakes-launch-count",
          ),
          "utf8",
        ),
      ).toBe("1\n");
      db.close();
    });

    it("migrates a correlated legacy run-root state artifact", async () => {
      const dataDir = tempDir();
      const repoPath = initRepo();
      const runId = "delegate-legacy-migration";
      const stepId = "implementation";
      const profilePath = writeProfile(tempDir());
      const db = prepareRun({
        dataDir,
        repoPath,
        runId,
        stepKeys: [stepId],
      });
      const resolved = resolveDaemonWorkflowStepDispatch(
        { [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: profilePath },
        executeWorkflowStepDispatch,
        {},
      );
      if (!resolved.ok) throw new Error(resolved.message);
      await resolved.dispatch(claimStep(db, runId, stepId, NOW), {
        db,
        workerId: "delegate-test-worker",
        now: NOW + 1,
      });

      const runRoot = path.join(repoPath, ".agent-workflows", runId);
      const scopedRoot = path.join(runRoot, "delegate", stepId);
      fs.copyFileSync(
        path.join(scopedRoot, "delegate-external-state.json"),
        path.join(runRoot, "delegate-external-state.json"),
      );
      fs.copyFileSync(
        path.join(scopedRoot, "result.json"),
        path.join(runRoot, "result.json"),
      );
      fs.copyFileSync(
        path.join(scopedRoot, "executor.log"),
        path.join(runRoot, "executor.log"),
      );
      fs.rmSync(path.join(runRoot, "delegate"), {
        recursive: true,
        force: true,
      });
      reopenInterruptedHandoff(db, runId, stepId);

      await resolved.dispatch(claimStep(db, runId, stepId, NOW + 2), {
        db,
        workerId: "delegate-test-worker",
        now: NOW + 3,
      });

      expect(
        db
          .prepare(
            "SELECT state, attempt FROM executor_invocations WHERE workflow_run_id = ?",
          )
          .get(runId),
      ).toEqual({ state: "succeeded", attempt: 2 });
      expect(
        fs.readFileSync(path.join(runRoot, "gnhf-launch-count"), "utf8"),
      ).toBe("1\n");
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(scopedRoot, "delegate-handoff.json"),
            "utf8",
          ),
        ),
      ).toMatchObject({
        phase: "finalized",
        externalState: { externalRunId: `${runId}::${stepId}::dispatch` },
      });
      db.close();
    });

    it("preserves worktree changes that do not match a finalization receipt", async () => {
      const dataDir = tempDir();
      const repoPath = initRepo();
      const runId = "delegate-worktree-mismatch";
      const stepId = "implementation";
      const profilePath = writeProfile(tempDir());
      const db = prepareRun({
        dataDir,
        repoPath,
        runId,
        stepKeys: [stepId],
      });
      const resolved = resolveDaemonWorkflowStepDispatch(
        { [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: profilePath },
        executeWorkflowStepDispatch,
        {},
      );
      if (!resolved.ok) throw new Error(resolved.message);
      await resolved.dispatch(claimStep(db, runId, stepId, NOW), {
        db,
        workerId: "delegate-test-worker",
        now: NOW + 1,
      });

      const stepRoot = path.join(
        repoPath,
        ".agent-workflows",
        runId,
        "delegate",
        stepId,
      );
      const receiptPath = path.join(stepRoot, "delegate-handoff.json");
      const receipt = JSON.parse(
        fs.readFileSync(receiptPath, "utf8"),
      ) as Record<string, unknown>;
      const baseHead = String(receipt["baseHead"]);
      runGit(repoPath, ["reset", "--hard", baseHead]);
      delete receipt["externalState"];
      receipt["phase"] = "finalizing";
      fs.writeFileSync(receiptPath, JSON.stringify(receipt));
      fs.rmSync(path.join(stepRoot, "delegate-external-state.json"));
      const unrelatedPath = path.join(repoPath, "unrelated.txt");
      fs.writeFileSync(unrelatedPath, "preserve me\n");
      reopenInterruptedHandoff(db, runId, stepId);

      await resolved.dispatch(claimStep(db, runId, stepId, NOW + 2), {
        db,
        workerId: "delegate-test-worker",
        now: NOW + 3,
      });

      expect(
        db
          .prepare(
            "SELECT state, attempt FROM executor_invocations WHERE workflow_run_id = ?",
          )
          .get(runId),
      ).toEqual({ state: "manual_recovery_required", attempt: 2 });
      expect(fs.readFileSync(unrelatedPath, "utf8")).toBe("preserve me\n");
      expect(runGit(repoPath, ["rev-parse", "HEAD"])).toBe(baseHead);
      expect(
        fs.readFileSync(
          path.join(repoPath, ".agent-workflows", runId, "gnhf-launch-count"),
          "utf8",
        ),
      ).toBe("1\n");
      db.close();
    });

    it("refuses to finalize from a launch-only receipt", async () => {
      const dataDir = tempDir();
      const repoPath = initRepo();
      const runId = "delegate-launch-only-recovery";
      const stepId = "implementation";
      const profilePath = writeProfile(tempDir());
      const db = prepareRun({
        dataDir,
        repoPath,
        runId,
        stepKeys: [stepId],
      });
      const resolved = resolveDaemonWorkflowStepDispatch(
        { [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: profilePath },
        executeWorkflowStepDispatch,
        {},
      );
      if (!resolved.ok) throw new Error(resolved.message);
      await resolved.dispatch(claimStep(db, runId, stepId, NOW), {
        db,
        workerId: "delegate-test-worker",
        now: NOW + 1,
      });

      const stepRoot = path.join(
        repoPath,
        ".agent-workflows",
        runId,
        "delegate",
        stepId,
      );
      const receiptPath = path.join(stepRoot, "delegate-handoff.json");
      const receipt = JSON.parse(
        fs.readFileSync(receiptPath, "utf8"),
      ) as Record<string, unknown>;
      for (const key of [
        "dispatchOutcome",
        "expectedMessage",
        "expectedTree",
        "externalState",
        "resultDigest",
      ]) {
        delete receipt[key];
      }
      receipt["phase"] = "launched";
      fs.writeFileSync(receiptPath, JSON.stringify(receipt));
      fs.rmSync(path.join(stepRoot, "delegate-external-state.json"));
      reopenInterruptedHandoff(db, runId, stepId);

      await resolved.dispatch(claimStep(db, runId, stepId, NOW + 2), {
        db,
        workerId: "delegate-test-worker",
        now: NOW + 3,
      });

      expect(
        db
          .prepare(
            "SELECT state, attempt FROM executor_invocations WHERE workflow_run_id = ?",
          )
          .get(runId),
      ).toEqual({ state: "manual_recovery_required", attempt: 2 });
      expect(
        db
          .prepare(
            "SELECT recovery_code FROM executor_rounds WHERE workflow_run_id = ? ORDER BY round_index DESC LIMIT 1",
          )
          .get(runId),
      ).toEqual({ recovery_code: "delegate_handoff_failed" });
      expect(
        fs.readFileSync(
          path.join(repoPath, ".agent-workflows", runId, "gnhf-launch-count"),
          "utf8",
        ),
      ).toBe("1\n");
      db.close();
    });
  },
);
