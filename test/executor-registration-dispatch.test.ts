import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openDb } from "../src/adapters/db.js";
import { runCli } from "../src/cli.js";
import {
  buildProfileBackedSdkExecutors,
  resolveDaemonWorkflowStepDispatch,
  resolveProfileBackedDelegateToolStepKind,
} from "../src/core/daemon/workflow-dispatch.js";
import { DAEMON_EXECUTOR_CONFIG_ENV_VAR } from "../src/core/executors/sdk/daemon-config.js";
import { SingleShotExecutor } from "../src/core/executors/single-shot/sdk.js";
import { GoalLoopSdkExecutor } from "../src/core/executors/goal-loop/sdk.js";
import { goalLoopRoundMechanismFromResultFile } from "../src/core/executors/goal-loop/mechanism.js";
import { resolveGoalLoopRoundSelection } from "../src/core/executors/goal-loop/executor.js";
import {
  LiveStepSdkExecutor,
  liveStepBuiltInConfigSchema,
} from "../src/core/executors/live-step/sdk-executor.js";
import { createDurableExecutorEnvelope } from "../src/core/executors/sdk/envelope.js";
import { driveExecutorTicks } from "../src/core/executors/sdk/driver.js";
import { insertExecutorInvocation } from "../src/core/executors/loop/persist.js";
import { acquireRepoLock } from "../src/core/repo/locks.js";
import { validateExecutorConfig } from "../src/core/executors/sdk/config-schema.js";
import {
  loadExecutorRegistry,
  parseExecutorModuleConfig,
  registerExecutor,
} from "../src/core/executors/sdk/registry.js";
import { persistWorkflowDefinition } from "../src/core/workflow/definition/persist.js";
import {
  CODING_WORKFLOW_DEFINITION,
  type WorkflowDefinition,
} from "../src/core/workflow/definition/definition.js";
import { createRegisteredExecutorWorkflowDispatch } from "../src/core/workflow/dispatch/registered-executor.js";
import { executeWorkflowStepDispatch } from "../src/core/workflow/dispatch/execute.js";
import {
  claimRunnableWorkflowStep,
  runWorkflowSchedulerOnceAsync,
} from "../src/core/workflow/dispatch/scheduler.js";
import { preflightWorkflowExecutorConfigs } from "../src/core/workflow/preflight/structural.js";
import { persistWorkflowRunStart } from "../src/core/workflow/run/start-persist.js";
import { MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE } from "../src/core/workflow/run/start.js";
import { clearWorkflowRunManualRecoveryGuarded } from "../src/core/workflow/run/recovery.js";
import type { ExecutorTickContext } from "../src/core/executors/sdk/types.js";
import { DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR } from "../src/core/workflow/live-wrapper/daemon-profile.js";

const NOW = 1_700_000_000_000;
const tempDirs: string[] = [];
const NATIVE_ONE_SHOT_SCRIPT = `printf 'native dispatch\\n' > "$MOMENTUM_REPO_PATH/native-dispatch.txt"
cat > "$MOMENTUM_RESULT_PATH" <<'JSON'
{"success":true,"summary":"native one-shot completed","key_changes_made":["native-dispatch.txt"],"key_learnings":[],"remaining_work":[],"goal_complete":true,"commit":{"type":"test","subject":"complete native one-shot","body":"","breaking":false}}
JSON`;
const NATIVE_SCRIPT_COMMAND = `test "$MOMENTUM_RUN_ID" = "native-script-run" || exit 8
test "$MOMENTUM_STEP_ID" = "preflight" || exit 9
test "$MOMENTUM_STEP_KIND" = "preflight" || exit 10
test "$MOMENTUM_ATTEMPT" = "1" || exit 11
test "$MOMENTUM_REPO_PATH" = "$PWD" || exit 12
test -n "$MOMENTUM_ITERATION_DIR" || exit 13
printf 'native script\\n' > native-script.txt`;
const NATIVE_ITERATION_SCRIPT_COMMAND = `test "$MOMENTUM_RUN_ID" = "native-script-run" || exit 8
test "$MOMENTUM_STEP_ID" = "preflight" || exit 9
test "$MOMENTUM_STEP_KIND" = "preflight" || exit 10
test "$MOMENTUM_ATTEMPT" = "1" || exit 11
test "$MOMENTUM_ITERATION_DIR" = "$PWD" || exit 12
test "$MOMENTUM_REPO_PATH" != "$PWD" || exit 13
printf 'native script\\n' > "$MOMENTUM_REPO_PATH/native-script.txt"`;
const NATIVE_GOAL_LOOP_SCRIPT = `count_file="$MOMENTUM_REPO_PATH/.agent-workflows/$MOMENTUM_RUN_ID/goal-loop-count"
count=0
test ! -f "$count_file" || count=$(cat "$count_file")
count=$((count + 1))
printf '%s\\n' "$count" > "$count_file"
printf 'round %s\\n' "$count" > "$MOMENTUM_REPO_PATH/goal-round-$count.txt"
goal_complete=false
test "$count" -lt 2 || goal_complete=true
cat > "$MOMENTUM_RESULT_PATH" <<JSON
{"success":true,"summary":"goal-loop round $count","key_changes_made":["goal-round-$count.txt"],"key_learnings":["round $count"],"remaining_work":[],"goal_complete":$goal_complete,"commit":{"type":"test","subject":"complete goal-loop round $count","body":"","breaking":false}}
JSON`;

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("profile-backed delegated tool dispatch", () => {
  it("selects the live-wrapper kind from portable tool config", () => {
    expect(resolveProfileBackedDelegateToolStepKind("gnhf")).toBe(
      "implementation",
    );
    expect(resolveProfileBackedDelegateToolStepKind("no-mistakes")).toBe(
      "no-mistakes",
    );
    expect(resolveProfileBackedDelegateToolStepKind("custom-tool")).toBeNull();
  });
});

describe("profile-backed built-in registration", () => {
  it("selects the native single-shot lifecycle for one-shot and script", () => {
    const executors = new Map(
      buildProfileBackedSdkExecutors().map((executor) => [
        executor.name,
        executor,
      ]),
    );

    expect(executors.get("one-shot")).toBeInstanceOf(SingleShotExecutor);
    expect(executors.get("goal-loop")).toBeInstanceOf(GoalLoopSdkExecutor);
    expect(executors.get("script")).toBeInstanceOf(SingleShotExecutor);
  });

  it("runs one native one-shot round through production registered dispatch", async () => {
    const repoPath = initNativeDispatchRepo();
    const profilePath = writeNativeDispatchProfile(tempDir());
    const definition: WorkflowDefinition = {
      key: "native-one-shot-workflow",
      title: "Native One-shot Workflow",
      version: 1,
      steps: [
        {
          key: "preflight",
          kind: "preflight",
          executor: "one-shot",
          config: { policyEnvelope: "native-dispatch-test" },
          order: 0,
          required: true,
        },
      ],
    };
    const db = openDb(tempDir());
    persistWorkflowDefinition(db, definition, { now: NOW });
    persistWorkflowRunStart(db, {
      definition,
      runId: "native-one-shot-run",
      repoPath,
      objective: "Run one bounded native agent turn",
      now: NOW,
    });
    db.prepare(
      "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ?",
    ).run("native-one-shot-run");
    const claim = claimRunnableWorkflowStep(db, {
      runId: "native-one-shot-run",
      stepId: "preflight",
      holder: "native-one-shot-worker",
      leaseExpiresAt: NOW + 30_000,
      now: NOW,
    });
    if (!claim.ok) throw new Error(claim.reason);
    const production = resolveDaemonWorkflowStepDispatch(
      { [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: profilePath },
      executeWorkflowStepDispatch,
      {},
    );
    if (!production.ok) throw new Error(production.message);

    await production.dispatch(claim.claim, {
      db,
      workerId: "native-one-shot-worker",
      now: NOW + 1,
    });

    expect(
      db
        .prepare(
          "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = ?",
        )
        .get("native-one-shot-run", "preflight"),
    ).toEqual({ state: "succeeded" });
    expect(
      db
        .prepare(
          "SELECT round_id, state, summary FROM executor_rounds WHERE workflow_run_id = ?",
        )
        .get("native-one-shot-run"),
    ).toEqual({
      round_id: "native-one-shot-run::preflight::dispatch::round::0",
      state: "succeeded",
      summary: "native one-shot completed",
    });
    expect(
      db
        .prepare(
          "SELECT stage FROM executor_checkpoints WHERE round_id = ? ORDER BY sequence",
        )
        .all("native-one-shot-run::preflight::dispatch::round::0"),
    ).toEqual([
      { stage: "round_started" },
      { stage: "mechanism_completed" },
      { stage: "result_captured" },
      { stage: "classified" },
    ]);
    db.close();
  });

  it("fails closed when native host bindings have no live-wrapper profile", async () => {
    const repoPath = initNativeDispatchRepo();
    const definition: WorkflowDefinition = {
      key: "missing-native-profile-workflow",
      title: "Missing Native Profile Workflow",
      version: 1,
      steps: [
        {
          key: "preflight",
          kind: "preflight",
          executor: "one-shot",
          order: 0,
          required: true,
        },
      ],
    };
    const db = openDb(tempDir());
    persistWorkflowDefinition(db, definition, { now: NOW });
    persistWorkflowRunStart(db, {
      definition,
      runId: "missing-native-profile-run",
      repoPath,
      objective: "Refuse missing native host bindings",
      now: NOW,
    });
    db.prepare(
      "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ?",
    ).run("missing-native-profile-run");
    const claim = claimRunnableWorkflowStep(db, {
      runId: "missing-native-profile-run",
      stepId: "preflight",
      holder: "missing-native-profile-worker",
      leaseExpiresAt: NOW + 30_000,
      now: NOW,
    });
    if (!claim.ok) throw new Error(claim.reason);
    const production = resolveDaemonWorkflowStepDispatch(
      {},
      executeWorkflowStepDispatch,
      {},
    );
    if (!production.ok) throw new Error(production.message);

    await production.dispatch(claim.claim, {
      db,
      workerId: "missing-native-profile-worker",
      now: NOW + 1,
    });

    expect(
      db
        .prepare(
          "SELECT state, recovery_code, summary FROM executor_rounds WHERE workflow_run_id = ?",
        )
        .get("missing-native-profile-run"),
    ).toEqual({
      state: "manual_recovery_required",
      recovery_code: "runtime_unavailable",
      summary: expect.stringContaining(DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR),
    });
    db.close();
  });

  it.each([
    { family: "one-shot", config: {} },
    { family: "script", config: { command: "sh" } },
    { family: "goal-loop", config: {} },
  ] as const)(
    "resumes a roundless native $family invocation through the scheduler",
    async ({ family, config }) => {
      const runId = `roundless-${family}-run`;
      const definition: WorkflowDefinition = {
        key: `roundless-${family}-workflow`,
        title: `Roundless ${family} Workflow`,
        version: 1,
        steps: [
          {
            key: "preflight",
            kind: "preflight",
            executor: family,
            config,
            order: 0,
            required: true,
          },
        ],
      };
      const db = openDb(tempDir());
      persistWorkflowDefinition(db, definition, { now: NOW });
      persistWorkflowRunStart(db, {
        definition,
        runId,
        repoPath: "/repos/fixture",
        objective: "Resume a native invocation scaffold",
        now: NOW,
      });
      db.prepare(
        "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ?",
      ).run(runId);
      const claim = claimRunnableWorkflowStep(db, {
        runId,
        stepId: "preflight",
        holder: "roundless-native-worker",
        leaseExpiresAt: NOW + 30_000,
        now: NOW,
      });
      if (!claim.ok) throw new Error(claim.reason);
      executeWorkflowStepDispatch(claim.claim, {
        db,
        workerId: "roundless-native-worker",
        now: NOW,
        executorOwnsRounds: true,
      });
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM executor_rounds WHERE workflow_run_id = ?",
          )
          .get(runId),
      ).toEqual({ count: 0 });
      const dispatch = vi.fn(() => ({ status: "native_roundless_resumed" }));

      const resumed = await runWorkflowSchedulerOnceAsync({
        db,
        workerId: "roundless-native-worker",
        continuationPollIntervalMs: 1,
        dispatch,
        now: () => NOW + 1,
      });

      expect(resumed.code).toBe("dispatched");
      expect(dispatch).toHaveBeenCalledTimes(1);
      db.close();
    },
  );

  it("forwards native coding route identity into the one-shot wrapper", async () => {
    const repoPath = initNativeDispatchRepo();
    const profilePath = path.join(tempDir(), "agent-route-profile.json");
    fs.writeFileSync(
      profilePath,
      JSON.stringify({
        name: "native-dispatch-test",
        wrappers: {
          postflight: {
            command: "/bin/sh",
            args: [
              "-c",
              `printf '%s|%s|%s\\n' "$MOMENTUM_AGENT_PROVIDER" "$MOMENTUM_MODEL" "$MOMENTUM_EFFORT" > "$MOMENTUM_REPO_PATH/native-agent-env.txt"
${NATIVE_ONE_SHOT_SCRIPT}`,
            ],
            cwd: "repo",
            timeout_sec: 5,
            env_allow: [],
            result_file: "result.json",
          },
        },
      }),
    );
    const db = openDb(tempDir());
    persistWorkflowDefinition(db, CODING_WORKFLOW_DEFINITION, { now: NOW });
    persistWorkflowRunStart(db, {
      definition: CODING_WORKFLOW_DEFINITION,
      runId: "native-agent-route-run",
      repoPath,
      objective: "Forward native agent route identity",
      route: {
        steps: {
          postflight: {
            harness: "codex",
            model: "gpt-native",
            effort: "high",
          },
        },
      },
      source: MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE,
      now: NOW,
    });
    db.prepare(
      `UPDATE workflow_steps
          SET state = CASE
            WHEN step_id IN ('preflight', 'implementation') THEN 'succeeded'
            WHEN step_id = 'postflight' THEN 'approved'
            ELSE state
          END
        WHERE run_id = ?`,
    ).run("native-agent-route-run");
    const claim = claimRunnableWorkflowStep(db, {
      runId: "native-agent-route-run",
      stepId: "postflight",
      holder: "native-agent-route-worker",
      leaseExpiresAt: NOW + 30_000,
      now: NOW,
    });
    if (!claim.ok) throw new Error(claim.reason);
    const production = resolveDaemonWorkflowStepDispatch(
      { [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: profilePath },
      executeWorkflowStepDispatch,
      {},
    );
    if (!production.ok) throw new Error(production.message);

    await production.dispatch(claim.claim, {
      db,
      workerId: "native-agent-route-worker",
      now: NOW + 1,
    });

    expect(
      fs.readFileSync(path.join(repoPath, "native-agent-env.txt"), "utf8"),
    ).toBe("codex|gpt-native|high\n");
    expect(
      db
        .prepare(
          "SELECT agent_provider, model, effort FROM executor_rounds WHERE workflow_run_id = ?",
        )
        .get("native-agent-route-run"),
    ).toEqual({
      agent_provider: "codex",
      model: "gpt-native",
      effort: "high",
    });
    db.close();
  });

  it("resolves a portable script identity through production host bindings", async () => {
    const repoPath = initNativeDispatchRepo();
    const profilePath = writeNativeDispatchProfile(
      tempDir(),
      NATIVE_ITERATION_SCRIPT_COMMAND,
      "repo-cleanup",
      "iteration",
    );
    const definition: WorkflowDefinition = {
      key: "native-script-workflow",
      title: "Native Script Workflow",
      version: 1,
      steps: [
        {
          key: "preflight",
          kind: "preflight",
          executor: "script",
          config: {
            command: "repo-cleanup",
            timeoutMs: 5_000,
          },
          order: 0,
          required: true,
        },
      ],
    };
    const db = openDb(tempDir());
    persistWorkflowDefinition(db, definition, { now: NOW });
    persistWorkflowRunStart(db, {
      definition,
      runId: "native-script-run",
      repoPath,
      objective: "Run one bounded native script",
      now: NOW,
    });
    db.prepare(
      "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ?",
    ).run("native-script-run");
    const claim = claimRunnableWorkflowStep(db, {
      runId: "native-script-run",
      stepId: "preflight",
      holder: "native-script-worker",
      leaseExpiresAt: NOW + 30_000,
      now: NOW,
    });
    if (!claim.ok) throw new Error(claim.reason);
    const production = resolveDaemonWorkflowStepDispatch(
      { [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: profilePath },
      executeWorkflowStepDispatch,
      {},
    );
    if (!production.ok) throw new Error(production.message);

    await production.dispatch(claim.claim, {
      db,
      workerId: "native-script-worker",
      now: NOW + 1,
    });

    expect(
      db
        .prepare(
          `SELECT workflow_steps.state,
                  executor_rounds.recovery_code,
                  executor_rounds.summary
             FROM workflow_steps
             LEFT JOIN executor_rounds
               ON executor_rounds.workflow_run_id = workflow_steps.run_id
              AND executor_rounds.step_run_id = workflow_steps.step_id
            WHERE workflow_steps.run_id = ? AND workflow_steps.step_id = ?`,
        )
        .get("native-script-run", "preflight"),
    ).toEqual({ state: "succeeded", recovery_code: null, summary: null });
    expect(
      db
        .prepare(
          "SELECT round_id, state, result_digest FROM executor_rounds WHERE workflow_run_id = ?",
        )
        .get("native-script-run"),
    ).toEqual({
      round_id: "native-script-run::preflight::dispatch::round::0",
      state: "succeeded",
      result_digest: null,
    });
    expect(
      fs.readFileSync(path.join(repoPath, "native-script.txt"), "utf8"),
    ).toBe("native script\n");
    db.close();
  });

  it.each([
    {
      label: "command identity",
      config: {
        command: "other-command",
        timeoutMs: 5_000,
      },
    },
    {
      label: "timeout",
      config: {
        command: "preflight",
        timeoutMs: 4_000,
      },
    },
  ])(
    "fails closed before process execution on mismatched script $label",
    async ({ config }) => {
      const repoPath = initNativeDispatchRepo();
      const profilePath = writeNativeDispatchProfile(
        tempDir(),
        NATIVE_SCRIPT_COMMAND,
      );
      const definition: WorkflowDefinition = {
        key: "refused-native-script-workflow",
        title: "Refused Native Script Workflow",
        version: 1,
        steps: [
          {
            key: "preflight",
            kind: "preflight",
            executor: "script",
            config,
            order: 0,
            required: true,
          },
        ],
      };
      const runId = `refused-native-script-${config.command}-${config.timeoutMs}`;
      const db = openDb(tempDir());
      persistWorkflowDefinition(db, definition, { now: NOW });
      persistWorkflowRunStart(db, {
        definition,
        runId,
        repoPath,
        objective: "Refuse mismatched native script bindings",
        now: NOW,
      });
      db.prepare(
        "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ?",
      ).run(runId);
      const claim = claimRunnableWorkflowStep(db, {
        runId,
        stepId: "preflight",
        holder: "refused-native-script-worker",
        leaseExpiresAt: NOW + 30_000,
        now: NOW,
      });
      if (!claim.ok) throw new Error(claim.reason);
      const production = resolveDaemonWorkflowStepDispatch(
        { [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: profilePath },
        executeWorkflowStepDispatch,
        {},
      );
      if (!production.ok) throw new Error(production.message);

      await production.dispatch(claim.claim, {
        db,
        workerId: "refused-native-script-worker",
        now: NOW + 1,
      });

      expect(
        db
          .prepare(
            "SELECT state, recovery_code FROM executor_rounds WHERE workflow_run_id = ?",
          )
          .get(runId),
      ).toEqual({
        state: "manual_recovery_required",
        recovery_code: "invalid_input",
      });
      expect(fs.existsSync(path.join(repoPath, "native-script.txt"))).toBe(
        false,
      );
      db.close();
    },
  );

  it("persists continue then complete across two native goal-loop dispatch turns", async () => {
    const repoPath = initNativeDispatchRepo();
    const profilePath = writeGoalLoopDispatchProfile(tempDir());
    const definition: WorkflowDefinition = {
      key: "native-goal-loop-workflow",
      title: "Native Goal-loop Workflow",
      version: 1,
      steps: [
        {
          key: "implementation",
          kind: "implementation",
          executor: "goal-loop",
          config: { maxRounds: 3 },
          order: 0,
          required: true,
        },
      ],
    };
    const db = openDb(tempDir());
    persistWorkflowDefinition(db, definition, { now: NOW });
    persistWorkflowRunStart(db, {
      definition,
      runId: "native-goal-loop-run",
      repoPath,
      objective: "Complete two durable native rounds",
      now: NOW,
    });
    db.prepare(
      "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ?",
    ).run("native-goal-loop-run");
    const claim = claimRunnableWorkflowStep(db, {
      runId: "native-goal-loop-run",
      stepId: "implementation",
      holder: "native-goal-loop-worker",
      leaseExpiresAt: NOW + 30_000,
      now: NOW,
    });
    if (!claim.ok) throw new Error(claim.reason);
    const production = resolveDaemonWorkflowStepDispatch(
      { [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: profilePath },
      executeWorkflowStepDispatch,
      {},
    );
    if (!production.ok) throw new Error(production.message);

    await production.dispatch(claim.claim, {
      db,
      workerId: "native-goal-loop-worker",
      now: NOW + 1,
    });
    expect(
      db
        .prepare(
          "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = ?",
        )
        .get("native-goal-loop-run", "implementation"),
    ).toEqual({ state: "running" });
    expect(
      db
        .prepare(
          "SELECT state FROM executor_invocations WHERE workflow_run_id = ?",
        )
        .get("native-goal-loop-run"),
    ).toEqual({ state: "running" });
    expect(
      db
        .prepare(
          "SELECT classification, state, commit_sha FROM executor_rounds WHERE workflow_run_id = ? ORDER BY round_index",
        )
        .all("native-goal-loop-run"),
    ).toEqual([
      {
        classification: "continue",
        state: "succeeded",
        commit_sha: expect.stringMatching(/^[0-9a-f]{40}$/),
      },
    ]);

    await production.dispatch(claim.claim, {
      db,
      workerId: "native-goal-loop-worker",
      now: NOW + 2,
    });

    expect(
      db
        .prepare(
          "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = ?",
        )
        .get("native-goal-loop-run", "implementation"),
    ).toEqual({ state: "succeeded" });
    expect(
      db
        .prepare(
          "SELECT round_index, classification, state, commit_sha FROM executor_rounds WHERE workflow_run_id = ? ORDER BY round_index",
        )
        .all("native-goal-loop-run"),
    ).toEqual([
      {
        round_index: 0,
        classification: "continue",
        state: "succeeded",
        commit_sha: expect.stringMatching(/^[0-9a-f]{40}$/),
      },
      {
        round_index: 1,
        classification: "complete",
        state: "succeeded",
        commit_sha: expect.stringMatching(/^[0-9a-f]{40}$/),
      },
    ]);
    expect(
      fs.readFileSync(
        path.join(
          repoPath,
          ".agent-workflows/native-goal-loop-run/goal-loop-count",
        ),
        "utf8",
      ),
    ).toBe("2\n");
    db.close();
  });

  it("refuses a symlinked native goal-loop round directory", async () => {
    const repoPath = initNativeDispatchRepo();
    const profilePath = writeGoalLoopDispatchProfile(tempDir());
    const runId = "symlinked-native-goal-loop-run";
    const definition: WorkflowDefinition = {
      key: "symlinked-native-goal-loop-workflow",
      title: "Symlinked Native Goal-loop Workflow",
      version: 1,
      steps: [
        {
          key: "implementation",
          kind: "implementation",
          executor: "goal-loop",
          order: 0,
          required: true,
        },
      ],
    };
    const db = openDb(tempDir());
    persistWorkflowDefinition(db, definition, { now: NOW });
    persistWorkflowRunStart(db, {
      definition,
      runId,
      repoPath,
      objective: "Refuse escaped native round artifacts",
      now: NOW,
    });
    db.prepare(
      "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ?",
    ).run(runId);
    const runDir = path.join(repoPath, ".agent-workflows", runId);
    const escapedDir = tempDir();
    fs.mkdirSync(runDir, { recursive: true });
    fs.symlinkSync(escapedDir, path.join(runDir, "round-1"), "dir");
    const claim = claimRunnableWorkflowStep(db, {
      runId,
      stepId: "implementation",
      holder: "symlinked-native-goal-loop-worker",
      leaseExpiresAt: NOW + 30_000,
      now: NOW,
    });
    if (!claim.ok) throw new Error(claim.reason);
    const production = resolveDaemonWorkflowStepDispatch(
      { [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: profilePath },
      executeWorkflowStepDispatch,
      {},
    );
    if (!production.ok) throw new Error(production.message);

    await production.dispatch(claim.claim, {
      db,
      workerId: "symlinked-native-goal-loop-worker",
      now: NOW + 1,
    });

    expect(
      db
        .prepare(
          "SELECT state, recovery_code, summary FROM executor_rounds WHERE workflow_run_id = ?",
        )
        .get(runId),
    ).toEqual({
      state: "manual_recovery_required",
      recovery_code: "runtime_unavailable",
      summary: expect.stringContaining("round path is not a regular directory"),
    });
    expect(fs.readdirSync(escapedDir)).toEqual([]);
    db.close();
  });

  it.each([
    {
      binding: "host timeout",
      config: { timeoutMs: 4_000 },
    },
    {
      binding: "policy envelope",
      config: { policyEnvelope: "different-policy" },
    },
    {
      binding: "agent identity",
      config: { agent: { harness: "portable-agent" } },
    },
  ])(
    "fails closed before goal-loop execution on a mismatched $binding",
    async ({ config }) => {
      const repoPath = initNativeDispatchRepo();
      const profilePath = writeGoalLoopDispatchProfile(tempDir());
      const definition: WorkflowDefinition = {
        key: "refused-native-goal-loop-workflow",
        title: "Refused Native Goal-loop Workflow",
        version: 1,
        steps: [
          {
            key: "implementation",
            kind: "implementation",
            executor: "goal-loop",
            config,
            order: 0,
            required: true,
          },
        ],
      };
      const db = openDb(tempDir());
      persistWorkflowDefinition(db, definition, { now: NOW });
      persistWorkflowRunStart(db, {
        definition,
        runId: "refused-native-goal-loop-run",
        repoPath,
        objective: "Refuse mismatched native goal-loop bindings",
        now: NOW,
      });
      db.prepare(
        "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ?",
      ).run("refused-native-goal-loop-run");
      const claim = claimRunnableWorkflowStep(db, {
        runId: "refused-native-goal-loop-run",
        stepId: "implementation",
        holder: "refused-native-goal-loop-worker",
        leaseExpiresAt: NOW + 30_000,
        now: NOW,
      });
      if (!claim.ok) throw new Error(claim.reason);
      const production = resolveDaemonWorkflowStepDispatch(
        { [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: profilePath },
        executeWorkflowStepDispatch,
        {},
      );
      if (!production.ok) throw new Error(production.message);

      await production.dispatch(claim.claim, {
        db,
        workerId: "refused-native-goal-loop-worker",
        now: NOW + 1,
      });

      expect(
        db
          .prepare(
            "SELECT state, recovery_code FROM executor_rounds WHERE workflow_run_id = ?",
          )
          .get("refused-native-goal-loop-run"),
      ).toEqual({
        state: "manual_recovery_required",
        recovery_code: "invalid_input",
      });
      expect(
        fs.existsSync(
          path.join(
            repoPath,
            ".agent-workflows/refused-native-goal-loop-run/goal-loop-count",
          ),
        ),
      ).toBe(false);
      db.close();
    },
  );

  it("reattaches a checkpointed goal-loop mechanism without rerunning or recommitting", async () => {
    const repoPath = initNativeDispatchRepo();
    const definition: WorkflowDefinition = {
      key: "reattach-goal-loop-workflow",
      title: "Reattach Goal-loop Workflow",
      version: 1,
      steps: [
        {
          key: "implementation",
          kind: "implementation",
          executor: "goal-loop",
          order: 0,
          required: true,
        },
      ],
    };
    const db = openDb(tempDir());
    persistWorkflowDefinition(db, definition, { now: NOW });
    persistWorkflowRunStart(db, {
      definition,
      runId: "reattach-goal-loop-run",
      repoPath,
      objective: "Reattach completed native work",
      now: NOW,
    });
    const invocationId = "reattach-goal-loop-run::implementation::dispatch";
    insertExecutorInvocation(
      db,
      {
        invocationId,
        workflowRunId: "reattach-goal-loop-run",
        stepRunId: "implementation",
        stepKey: "implementation",
        executorFamily: "goal-loop",
        state: "running",
        attempt: 1,
        startedAt: NOW,
        heartbeatAt: NOW,
        finishedAt: null,
      },
      { now: NOW },
    );
    const artifactRoot = path.join(
      repoPath,
      ".agent-workflows/reattach-goal-loop-run/round-1",
    );
    fs.mkdirSync(artifactRoot, { recursive: true });
    const resultFilePath = path.join(artifactRoot, "result.json");
    const verificationLogPath = path.join(artifactRoot, "verification.log");
    const baseHead = execFileSync(
      "git",
      ["-C", repoPath, "rev-parse", "HEAD"],
      {
        encoding: "utf8",
      },
    ).trim();
    let mechanisms = 0;
    const runRound = () => {
      mechanisms += 1;
      fs.writeFileSync(
        path.join(repoPath, "reattached.txt"),
        "committed once\n",
      );
      fs.writeFileSync(
        resultFilePath,
        JSON.stringify({
          success: true,
          summary: "checkpointed native goal-loop work",
          key_changes_made: ["reattached.txt"],
          key_learnings: [],
          remaining_work: [],
          goal_complete: true,
          commit: {
            type: "test",
            subject: "checkpoint native goal-loop work",
            body: "",
            breaking: false,
          },
        }),
      );
      return goalLoopRoundMechanismFromResultFile({
        repoPath,
        baseHead,
        resultFilePath,
        verificationCommands: [],
        verificationTimeoutSec: 5,
        verificationLogPath,
      });
    };
    const hostBindings = {
      start: {
        roundId: `${invocationId}::round::0`,
        invocationId,
        workflowRunId: "reattach-goal-loop-run",
        stepRunId: "implementation",
        stepKey: "implementation",
        attempt: 1,
        roundIndex: 0,
        inputDigest: "sha256:reattach",
        artifactRoot,
        logPaths: [path.join(artifactRoot, "executor.log")],
        startedAt: NOW + 1,
      },
      selection: resolveGoalLoopRoundSelection({
        stepConfig: {
          agentProvider: "codex",
          model: "gpt-native",
          effort: "high",
        },
      }),
      runRound,
    };
    const executor = new GoalLoopSdkExecutor();
    const envelope = createDurableExecutorEnvelope({
      db,
      invocationId,
      now: () => NOW + 1,
    });

    await executor.tick({
      state: envelope.snapshot(),
      config: {},
      hostBindings,
      envelope: envelope.facade,
      signal: new AbortController().signal,
    });
    expect(mechanisms).toBe(1);
    expect(
      execFileSync("git", ["-C", repoPath, "rev-list", "--count", "HEAD"], {
        encoding: "utf8",
      }).trim(),
    ).toBe("2");

    expect(() =>
      executor.tick({
        state: envelope.snapshot(),
        config: {},
        hostBindings: {
          ...hostBindings,
          selection: resolveGoalLoopRoundSelection({
            stepConfig: {
              agentProvider: "claude",
              model: "claude-native",
              effort: "high",
            },
          }),
        },
        envelope: envelope.facade,
        signal: new AbortController().signal,
      }),
    ).toThrow("changed dispatch inputs: agentProvider, model");

    for (const changedHostBindings of [
      {
        ...hostBindings,
        selection: {
          ...hostBindings.selection,
          timeoutMs: 6_000,
        },
      },
      {
        ...hostBindings,
        selection: {
          ...hostBindings.selection,
          maxRounds: 9,
        },
      },
      {
        ...hostBindings,
        selection: {
          ...hostBindings.selection,
          policyEnvelope: "changed-policy",
        },
      },
      {
        ...hostBindings,
        hostBindingIdentity: "sha256:changed-runner",
      },
    ]) {
      expect(() =>
        executor.tick({
          state: envelope.snapshot(),
          config: {},
          hostBindings: changedHostBindings,
          envelope: envelope.facade,
          signal: new AbortController().signal,
        }),
      ).toThrow("changed portable config or host inputs");
    }

    await driveExecutorTicks({
      db,
      invocationId,
      executor,
      config: {},
      hostBindings: {
        ...hostBindings,
        runRound: () => {
          mechanisms += 1;
          throw new Error("checkpointed mechanism reran");
        },
      },
      now: () => NOW + 2,
    });

    expect(mechanisms).toBe(1);
    expect(
      execFileSync("git", ["-C", repoPath, "rev-list", "--count", "HEAD"], {
        encoding: "utf8",
      }).trim(),
    ).toBe("2");
    expect(
      db
        .prepare(
          "SELECT state FROM executor_invocations WHERE invocation_id = ?",
        )
        .get(invocationId),
    ).toEqual({ state: "succeeded" });
    db.close();
  });

  it("resumes checkpointed native work through the scheduler and releases its retained lock", async () => {
    const repoPath = initNativeDispatchRepo();
    const profilePath = writeGoalLoopDispatchProfile(tempDir());
    const definition: WorkflowDefinition = {
      key: "native-lock-recovery-workflow",
      title: "Native Lock Recovery Workflow",
      version: 1,
      steps: [
        {
          key: "implementation",
          kind: "implementation",
          executor: "goal-loop",
          order: 0,
          required: true,
        },
      ],
    };
    const db = openDb(tempDir());
    persistWorkflowDefinition(db, definition, { now: NOW });
    persistWorkflowRunStart(db, {
      definition,
      runId: "native-lock-recovery-run",
      repoPath,
      objective: "Resume native work without repeating it",
      now: NOW,
    });
    db.prepare(
      "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ?",
    ).run("native-lock-recovery-run");
    const claim = claimRunnableWorkflowStep(db, {
      runId: "native-lock-recovery-run",
      stepId: "implementation",
      holder: "native-lock-recovery-worker",
      leaseExpiresAt: NOW + 30_000,
      now: NOW,
    });
    if (!claim.ok) throw new Error(claim.reason);
    executeWorkflowStepDispatch(claim.claim, {
      db,
      workerId: "native-lock-recovery-worker",
      now: NOW + 1,
      executorOwnsRounds: true,
    });
    const invocationId = "native-lock-recovery-run::implementation::dispatch";
    const artifactRoot = path.join(
      repoPath,
      ".agent-workflows/native-lock-recovery-run/round-1",
    );
    fs.mkdirSync(artifactRoot, { recursive: true });
    const baseHead = execFileSync(
      "git",
      ["-C", repoPath, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    ).trim();
    const inputDigest = `sha256:${crypto
      .createHash("sha256")
      .update(JSON.stringify({ config: {}, priorRounds: [] }))
      .digest("hex")}`;
    const envelope = createDurableExecutorEnvelope({
      db,
      invocationId,
      now: () => NOW + 2,
    });
    await new GoalLoopSdkExecutor().tick({
      state: envelope.snapshot(),
      config: {},
      hostBindings: {
        start: {
          roundId: `${invocationId}::round::0`,
          invocationId,
          workflowRunId: "native-lock-recovery-run",
          stepRunId: "implementation",
          stepKey: "implementation",
          attempt: 1,
          roundIndex: 0,
          inputDigest,
          artifactRoot,
          logPaths: [path.join(artifactRoot, "executor.log")],
          startedAt: NOW + 2,
        },
        runRound: () => {
          fs.writeFileSync(
            path.join(repoPath, "native-lock-recovery.txt"),
            "committed once\n",
          );
          const resultFilePath = path.join(artifactRoot, "result.json");
          fs.writeFileSync(
            resultFilePath,
            JSON.stringify({
              success: true,
              summary: "checkpointed native lock recovery",
              key_changes_made: ["native-lock-recovery.txt"],
              key_learnings: [],
              remaining_work: [],
              goal_complete: true,
              commit: {
                type: "test",
                subject: "checkpoint native lock recovery",
                body: "",
                breaking: false,
              },
            }),
          );
          return goalLoopRoundMechanismFromResultFile({
            repoPath,
            baseHead,
            resultFilePath,
            verificationCommands: [],
            verificationTimeoutSec: 5,
            verificationLogPath: path.join(artifactRoot, "verification.log"),
          });
        },
      },
      envelope: envelope.facade,
      signal: new AbortController().signal,
    });
    db.prepare(
      "UPDATE executor_checkpoints SET detail = NULL WHERE round_id = ? AND stage = 'round_started'",
    ).run(`${invocationId}::round::0`);
    const retained = acquireRepoLock(db, {
      repoRoot: repoPath,
      holder: "crashed-native-worker",
      goalId: "native-lock-recovery-run",
      iteration: 1,
      jobId: invocationId,
      leaseExpiresAt: NOW + 60_000,
      now: NOW + 2,
    });
    if (!retained.ok) throw new Error(retained.reason);
    const commitCount = execFileSync(
      "git",
      ["-C", repoPath, "rev-list", "--count", "HEAD"],
      { encoding: "utf8" },
    ).trim();
    const production = resolveDaemonWorkflowStepDispatch(
      { [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: profilePath },
      executeWorkflowStepDispatch,
      {},
    );
    if (!production.ok) throw new Error(production.message);

    const resumed = await runWorkflowSchedulerOnceAsync({
      db,
      workerId: "native-lock-recovery-worker",
      continuationPollIntervalMs: 1,
      dispatch: production.dispatch,
      now: () => NOW + 3,
    });

    expect(resumed.code).toBe("dispatched");
    expect(
      db
        .prepare(
          "SELECT state FROM executor_invocations WHERE invocation_id = ?",
        )
        .get(invocationId),
    ).toEqual({ state: "succeeded" });
    expect(
      db
        .prepare("SELECT state FROM repo_locks WHERE id = ?")
        .get(retained.lockId),
    ).toEqual({ state: "released" });
    expect(
      execFileSync("git", ["-C", repoPath, "rev-list", "--count", "HEAD"], {
        encoding: "utf8",
      }).trim(),
    ).toBe(commitCount);
    expect(
      fs.existsSync(
        path.join(
          repoPath,
          ".agent-workflows/native-lock-recovery-run/goal-loop-count",
        ),
      ),
    ).toBe(false);
    db.close();
  });

  it("refuses an incomplete legacy goal-loop round without a dispatch binding through scheduler recovery", async () => {
    const repoPath = initNativeDispatchRepo();
    const profilePath = writeGoalLoopDispatchProfile(tempDir());
    const runId = "legacy-null-binding";
    const db = openDb(tempDir());
    const definition: WorkflowDefinition = {
      key: "legacy-null-binding-workflow",
      title: "Legacy Null Binding Workflow",
      version: 1,
      steps: [
        {
          key: "implementation",
          kind: "implementation",
          executor: "goal-loop",
          order: 0,
          required: true,
        },
      ],
    };
    persistWorkflowDefinition(db, definition, { now: NOW });
    persistWorkflowRunStart(db, {
      definition,
      runId,
      repoPath,
      objective: "Refuse an unbound legacy relaunch",
      now: NOW,
    });
    db.prepare(
      "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ?",
    ).run(runId);
    const claim = claimRunnableWorkflowStep(db, {
      runId,
      stepId: "implementation",
      holder: "legacy-null-binding-worker",
      leaseExpiresAt: NOW + 30_000,
      now: NOW,
    });
    if (!claim.ok) throw new Error(claim.reason);
    executeWorkflowStepDispatch(claim.claim, {
      db,
      workerId: "legacy-null-binding-worker",
      now: NOW + 1,
      executorOwnsRounds: true,
    });
    const invocationId = `${runId}::implementation::dispatch`;
    const artifactRoot = path.join(
      repoPath,
      `.agent-workflows/${runId}/round-1`,
    );
    fs.mkdirSync(artifactRoot, { recursive: true });
    const inputDigest = `sha256:${crypto
      .createHash("sha256")
      .update(JSON.stringify({ config: {}, priorRounds: [] }))
      .digest("hex")}`;
    const envelope = createDurableExecutorEnvelope({
      db,
      invocationId,
      now: () => NOW + 2,
    });
    const roundId = `${invocationId}::round::0`;
    envelope.facade.startRound({
      roundId,
      invocationId,
      workflowRunId: runId,
      stepRunId: "implementation",
      stepKey: "implementation",
      executorFamily: "goal-loop",
      attempt: 1,
      roundIndex: 0,
      state: "running",
      agentProvider: null,
      model: null,
      effort: null,
      inputDigest,
      resultDigest: null,
      artifactRoot,
      logPaths: [path.join(artifactRoot, "executor.log")],
      summary: null,
      keyChanges: [],
      keyLearnings: [],
      remainingWork: [],
      changedFiles: [],
      verificationStatus: null,
      commitSha: null,
    });
    envelope.facade.recordCheckpoint(roundId, {
      checkpointId: `${roundId}-checkpoint-0`,
      sequence: 0,
      stage: "round_started",
      detail: null,
    });
    const production = resolveDaemonWorkflowStepDispatch(
      { [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: profilePath },
      executeWorkflowStepDispatch,
      {},
    );
    if (!production.ok) throw new Error(production.message);

    const resumed = await runWorkflowSchedulerOnceAsync({
      db,
      workerId: "legacy-null-binding-worker",
      continuationPollIntervalMs: 1,
      dispatch: production.dispatch,
      now: () => NOW + 3,
    });

    expect(resumed.code).toBe("dispatched");
    expect(
      fs.existsSync(
        path.join(repoPath, `.agent-workflows/${runId}/goal-loop-count`),
      ),
    ).toBe(false);
    expect(
      db
        .prepare(
          "SELECT state, recovery_code FROM executor_rounds WHERE round_id = ?",
        )
        .get(roundId),
    ).toEqual({
      state: "manual_recovery_required",
      recovery_code: "executor_threw",
    });
    db.close();
  });

  it("classifies a checkpointed native round and settles its lock when host bindings disappear", async () => {
    const repoPath = initNativeDispatchRepo();
    const definition: WorkflowDefinition = {
      key: "missing-binding-native-recovery-workflow",
      title: "Missing Binding Native Recovery Workflow",
      version: 1,
      steps: [
        {
          key: "implementation",
          kind: "implementation",
          executor: "goal-loop",
          order: 0,
          required: true,
        },
      ],
    };
    const runId = "missing-binding-native-recovery-run";
    const db = openDb(tempDir());
    persistWorkflowDefinition(db, definition, { now: NOW });
    persistWorkflowRunStart(db, {
      definition,
      runId,
      repoPath,
      objective: "Classify completed work without host bindings",
      now: NOW,
    });
    db.prepare(
      "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ?",
    ).run(runId);
    const claim = claimRunnableWorkflowStep(db, {
      runId,
      stepId: "implementation",
      holder: "missing-binding-native-worker",
      leaseExpiresAt: NOW + 30_000,
      now: NOW,
    });
    if (!claim.ok) throw new Error(claim.reason);
    executeWorkflowStepDispatch(claim.claim, {
      db,
      workerId: "missing-binding-native-worker",
      now: NOW + 1,
      executorOwnsRounds: true,
    });
    const invocationId = `${runId}::implementation::dispatch`;
    const envelope = createDurableExecutorEnvelope({
      db,
      invocationId,
      now: () => NOW + 2,
    });
    const round = envelope.facade.startRound({
      roundId: `${invocationId}::round::0`,
      invocationId,
      workflowRunId: runId,
      stepRunId: "implementation",
      stepKey: "implementation",
      executorFamily: "goal-loop",
      attempt: 1,
      roundIndex: 0,
      state: "running",
      agentProvider: null,
      model: null,
      effort: null,
      inputDigest: "sha256:checkpointed",
      resultDigest: null,
      artifactRoot: null,
      logPaths: [],
      summary: null,
      keyChanges: [],
      keyLearnings: [],
      remainingWork: [],
      changedFiles: [],
      verificationStatus: null,
      commitSha: null,
    });
    envelope.facade.recordCheckpoint(round.roundId, {
      checkpointId: `${round.roundId}-checkpoint-0`,
      sequence: 0,
      stage: "mechanism_completed",
      detail: "durable native completion",
    });
    const retained = acquireRepoLock(db, {
      repoRoot: repoPath,
      holder: "crashed-native-worker",
      goalId: runId,
      iteration: 1,
      jobId: invocationId,
      leaseExpiresAt: NOW + 60_000,
      now: NOW + 2,
    });
    if (!retained.ok) throw new Error(retained.reason);
    const production = resolveDaemonWorkflowStepDispatch(
      {},
      executeWorkflowStepDispatch,
      {},
    );
    if (!production.ok) throw new Error(production.message);

    const resumed = await runWorkflowSchedulerOnceAsync({
      db,
      workerId: "missing-binding-native-worker",
      continuationPollIntervalMs: 1,
      dispatch: production.dispatch,
      now: () => NOW + 3,
    });

    expect(resumed.code).toBe("dispatched");
    expect(
      db
        .prepare(
          "SELECT state FROM executor_invocations WHERE invocation_id = ?",
        )
        .get(invocationId),
    ).toEqual({ state: "manual_recovery_required" });
    expect(
      db
        .prepare(
          "SELECT state, recovery_code FROM executor_rounds WHERE round_id = ?",
        )
        .get(round.roundId),
    ).toEqual({
      state: "manual_recovery_required",
      recovery_code: "runtime_unavailable",
    });
    expect(
      db
        .prepare("SELECT state FROM repo_locks WHERE id = ?")
        .get(retained.lockId),
    ).toEqual({ state: "needs_manual_recovery" });
    db.close();
  });
});

function tempDir(): string {
  const value = fs.mkdtempSync(
    path.join(os.tmpdir(), "momentum-executor-sdk-"),
  );
  tempDirs.push(value);
  return value;
}

function initNativeDispatchRepo(): string {
  const repoPath = tempDir();
  execFileSync("git", ["-C", repoPath, "init", "--quiet"]);
  execFileSync("git", ["-C", repoPath, "config", "user.name", "Momentum Test"]);
  execFileSync("git", [
    "-C",
    repoPath,
    "config",
    "user.email",
    "momentum@example.test",
  ]);
  fs.writeFileSync(path.join(repoPath, ".gitignore"), ".agent-workflows/\n");
  fs.writeFileSync(path.join(repoPath, "README.md"), "fixture\n");
  execFileSync("git", ["-C", repoPath, "add", ".gitignore", "README.md"]);
  execFileSync("git", [
    "-C",
    repoPath,
    "commit",
    "--quiet",
    "-m",
    "test: initialize fixture",
  ]);
  return repoPath;
}

function writeNativeDispatchProfile(
  profileDir: string,
  script = NATIVE_ONE_SHOT_SCRIPT,
  commandIdentity = "preflight",
  cwd: "repo" | "iteration" = "repo",
): string {
  const profilePath = path.join(profileDir, "profile.json");
  fs.writeFileSync(
    profilePath,
    JSON.stringify({
      name: "native-dispatch-test",
      wrappers: {
        preflight: {
          command_identity: commandIdentity,
          command: "/bin/sh",
          args: ["-c", script],
          cwd,
          timeout_sec: 5,
          env_allow: [],
          result_file: "result.json",
        },
      },
    }),
  );
  return profilePath;
}

function writeGoalLoopDispatchProfile(profileDir: string): string {
  const profilePath = path.join(profileDir, "goal-loop-profile.json");
  fs.writeFileSync(
    profilePath,
    JSON.stringify({
      name: "native-goal-loop-test",
      wrappers: {
        implementation: {
          command: "/bin/sh",
          args: ["-c", NATIVE_GOAL_LOOP_SCRIPT],
          cwd: "repo",
          timeout_sec: 5,
          env_allow: [],
          result_file: "result.json",
        },
      },
    }),
  );
  return profilePath;
}

function fixtureDefinition(
  config: Record<string, unknown>,
): WorkflowDefinition {
  return {
    key: "fixture-workflow",
    title: "Fixture Workflow",
    version: 1,
    steps: [
      {
        key: "preflight",
        kind: "preflight",
        executor: "fixture-executor",
        config,
        order: 0,
        required: true,
      },
    ],
  };
}

async function fixtureRegistry() {
  const parsed = parseExecutorModuleConfig({
    executors: {
      "fixture-executor": path.join(
        import.meta.dirname,
        "fixtures/third-party-executor.mjs",
      ),
    },
  });
  if (!parsed.ok) throw new Error(parsed.diagnostics[0]?.message);
  const loaded = await loadExecutorRegistry({
    config: parsed.config,
    configDir: import.meta.dirname,
  });
  if (!loaded.ok) throw new Error(loaded.diagnostics[0]?.message);
  return loaded.registry;
}

function completeRegisteredExecutorTick(
  context: ExecutorTickContext<Record<string, never>, Record<string, never>>,
  summary: string,
) {
  const invocation = context.state.invocation;
  const roundIndex = context.state.rounds.length;
  const round = context.envelope.startRound({
    roundId: `${invocation.invocationId}::round-${roundIndex + 1}`,
    invocationId: invocation.invocationId,
    workflowRunId: invocation.workflowRunId,
    stepRunId: invocation.stepRunId,
    stepKey: invocation.stepKey,
    executorFamily: invocation.executorFamily,
    attempt: invocation.attempt,
    roundIndex,
    state: "capturing_result",
    agentProvider: null,
    model: null,
    effort: null,
    inputDigest: null,
    resultDigest: null,
    artifactRoot: null,
    logPaths: [],
    summary,
    keyChanges: [],
    keyLearnings: [],
    remainingWork: [],
    changedFiles: [],
    verificationStatus: "passed",
    commitSha: null,
  });
  return {
    roundId: round.roundId,
    recommendation: "complete" as const,
    recommendedRoundState: "succeeded" as const,
    recommendedInvocationState: "succeeded" as const,
    recoveryCode: null,
    humanGate: null,
    reason: summary,
  };
}

describe("executor registration and SDK dispatch", () => {
  it("loads a config-named third-party module and executes it end to end", async () => {
    const registry = await fixtureRegistry();
    const definition = fixtureDefinition({
      message: "third-party complete",
      turns: 2,
    });
    expect(preflightWorkflowExecutorConfigs(definition, registry).ok).toBe(
      true,
    );

    const db = openDb(tempDir());
    persistWorkflowDefinition(db, definition, { now: NOW });
    persistWorkflowRunStart(db, {
      definition,
      runId: "fixture-run",
      repoPath: "/repos/fixture",
      objective: "Prove third-party executor dispatch",
      now: NOW,
    });
    db.prepare(
      "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ? AND step_id = ?",
    ).run("fixture-run", "preflight");
    const claim = claimRunnableWorkflowStep(db, {
      runId: "fixture-run",
      stepId: "preflight",
      holder: "fixture-worker",
      leaseExpiresAt: NOW + 30_000,
      now: NOW,
    });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    const configPath = path.join(tempDir(), "executors.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        executors: {
          "fixture-executor": path.join(
            import.meta.dirname,
            "fixtures/third-party-executor.mjs",
          ),
        },
      }),
    );
    const production = resolveDaemonWorkflowStepDispatch(
      { [DAEMON_EXECUTOR_CONFIG_ENV_VAR]: configPath },
      executeWorkflowStepDispatch,
      {},
    );
    expect(production.ok).toBe(true);
    if (!production.ok) return;
    await production.dispatch(claim.claim, {
      db,
      workerId: "fixture-worker",
      now: NOW + 1,
    });
    expect(
      db
        .prepare(
          "SELECT state FROM executor_invocations WHERE workflow_run_id = ?",
        )
        .get("fixture-run"),
    ).toEqual({ state: "running" });
    const lease = db
      .prepare(
        "SELECT heartbeat_at FROM workflow_leases WHERE run_id = ? AND lease_kind = 'dispatch'",
      )
      .get("fixture-run") as { heartbeat_at: number };
    const continuation = await runWorkflowSchedulerOnceAsync({
      db,
      workerId: "fixture-worker",
      dispatch: production.dispatch,
      now: () => lease.heartbeat_at + 15_000,
    });
    expect(continuation.code).toBe("dispatched");

    expect(
      db
        .prepare(
          "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = ?",
        )
        .get("fixture-run", "preflight"),
    ).toEqual({ state: "succeeded" });
    expect(
      db
        .prepare(
          "SELECT executor_family, state FROM executor_invocations WHERE workflow_run_id = ?",
        )
        .get("fixture-run"),
    ).toEqual({ executor_family: "fixture-executor", state: "succeeded" });
    expect(
      db
        .prepare(
          "SELECT summary FROM executor_rounds WHERE workflow_run_id = ? ORDER BY round_index DESC LIMIT 1",
        )
        .get("fixture-run"),
    ).toEqual({ summary: "third-party complete" });
    db.close();
  });

  it("heartbeats independently while a synchronous executor blocks the event loop", async () => {
    const workerRef = vi.spyOn(Worker.prototype, "ref");
    const registry = await fixtureRegistry();
    const definition = fixtureDefinition({
      message: "long synchronous turn completed",
      blockMs: 1_250,
    });
    const db = openDb(tempDir());
    persistWorkflowDefinition(db, definition, { now: NOW });
    persistWorkflowRunStart(db, {
      definition,
      runId: "blocking-fixture-run",
      repoPath: "/repos/fixture",
      objective: "Keep the dispatch fence alive",
      now: NOW,
    });
    db.prepare(
      "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ?",
    ).run("blocking-fixture-run");
    const claim = claimRunnableWorkflowStep(db, {
      runId: "blocking-fixture-run",
      stepId: "preflight",
      holder: "blocking-worker",
      leaseExpiresAt: NOW + 500,
      now: NOW,
    });
    if (!claim.ok) throw new Error(claim.reason);

    const dispatch = createRegisteredExecutorWorkflowDispatch(
      executeWorkflowStepDispatch,
      { registry },
    );
    await dispatch(claim.claim, {
      db,
      workerId: "blocking-worker",
      now: NOW + 1,
    });

    expect(
      db
        .prepare(
          "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = ?",
        )
        .get("blocking-fixture-run", "preflight"),
    ).toEqual({ state: "succeeded" });
    expect(
      db
        .prepare(
          "SELECT state FROM executor_invocations WHERE workflow_run_id = ?",
        )
        .get("blocking-fixture-run"),
    ).toEqual({ state: "succeeded" });
    expect(workerRef).toHaveBeenCalledOnce();
    db.close();
  });

  it("registers a built-in through the same contract guard", () => {
    const registry = new Map();
    const builtIn = new SingleShotExecutor("script", () => ({
      outcome: { ok: true },
    }));
    expect(registerExecutor(registry, "script", builtIn)).toBeNull();
    expect(registry.get("script")).toBe(builtIn);
  });

  it("uses an explicitly configured module instead of a same-named built-in", async () => {
    const builtIn = new SingleShotExecutor("script", () => ({
      outcome: { ok: true },
    }));
    const configured = {
      name: "script",
      configSchema: {
        type: "object" as const,
        properties: {},
        additionalProperties: false as const,
      },
      tick: () => {
        throw new Error("not executed");
      },
    };
    const loaded = await loadExecutorRegistry({
      config: { executors: { script: "virtual:script" } },
      configDir: tempDir(),
      builtIns: [builtIn],
      importModule: async () => ({ default: configured }),
    });
    expect(loaded.ok).toBe(true);
    expect(loaded.registry.get("script")).toBe(configured);
  });

  it("does not fall back to a built-in when its configured override is broken", async () => {
    const builtIn = new SingleShotExecutor("script", () => ({
      outcome: { ok: true },
    }));
    const loaded = await loadExecutorRegistry({
      config: { executors: { script: "virtual:missing-script" } },
      configDir: tempDir(),
      builtIns: [builtIn],
      importModule: async () => {
        throw new Error("module missing");
      },
    });
    expect(loaded.ok).toBe(false);
    expect(loaded.registry.has("script")).toBe(false);
    expect(loaded).toMatchObject({
      diagnostics: [
        { code: "executor_module_unavailable", executor: "script" },
      ],
    });
  });

  it("reattaches a profile-backed built-in from mechanism_completed without rerunning", async () => {
    const db = openDb(tempDir());
    const definition: WorkflowDefinition = {
      key: "live-sdk-workflow",
      title: "Live SDK Workflow",
      version: 1,
      steps: [
        {
          key: "preflight",
          kind: "preflight",
          executor: "one-shot",
          order: 0,
          required: true,
        },
      ],
    };
    persistWorkflowDefinition(db, definition, { now: NOW });
    persistWorkflowRunStart(db, {
      definition,
      runId: "live-sdk-run",
      repoPath: "/repos/fixture",
      objective: "Prove replay-safe built-in dispatch",
      now: NOW,
    });
    insertExecutorInvocation(
      db,
      {
        invocationId: "live-sdk-invocation",
        workflowRunId: "live-sdk-run",
        stepRunId: "preflight",
        stepKey: "preflight",
        executorFamily: "one-shot",
        state: "running",
        attempt: 1,
        startedAt: NOW,
        heartbeatAt: NOW,
        finishedAt: null,
      },
      { now: NOW },
    );
    let runs = 0;
    const executor = new LiveStepSdkExecutor(
      "one-shot",
      liveStepBuiltInConfigSchema("one-shot"),
    );
    const hostBindings = {
      repoPath: "/repos/fixture",
      run: () => {
        runs += 1;
        return {
          ok: true as const,
          result: {
            state: "succeeded" as const,
            summary: "bounded work completed",
            checkpoints: [],
            artifacts: [],
            resultDigest: "sha256:result",
            errorCode: null,
            errorMessage: null,
            retryHint: null,
            recoveryHint: null,
          },
          executorLogPath: "/tmp/executor.log",
          resultJsonPath: "/tmp/result.json",
        };
      },
    };
    const envelope = createDurableExecutorEnvelope({
      db,
      invocationId: "live-sdk-invocation",
      now: () => NOW + 1,
    });
    await executor.tick({
      state: envelope.snapshot(),
      config: {},
      hostBindings,
      envelope: envelope.facade,
      signal: new AbortController().signal,
    });
    expect(runs).toBe(1);
    let replaySettledClean: boolean | undefined;
    await driveExecutorTicks({
      db,
      invocationId: "live-sdk-invocation",
      executor,
      config: {},
      hostBindings: {
        ...hostBindings,
        settleRepoOwnership: (provenClean: boolean) => {
          replaySettledClean = provenClean;
        },
      },
      now: () => NOW + 2,
    });
    expect(runs).toBe(1);
    expect(replaySettledClean).toBe(true);
    expect(
      db
        .prepare(
          "SELECT stage FROM executor_checkpoints WHERE round_id = ? ORDER BY sequence",
        )
        .all("live-sdk-invocation::round-1"),
    ).toEqual([
      { stage: "round_started" },
      { stage: "mechanism_completed" },
      { stage: "classified" },
    ]);
    db.prepare(
      `UPDATE executor_invocations
          SET state = 'running', attempt = 2, finished_at = NULL
        WHERE invocation_id = ?`,
    ).run("live-sdk-invocation");
    await driveExecutorTicks({
      db,
      invocationId: "live-sdk-invocation",
      executor,
      config: {},
      hostBindings,
      now: () => NOW + 3,
    });
    expect(runs).toBe(2);
    expect(
      db
        .prepare(
          "SELECT attempt FROM executor_rounds WHERE invocation_id = ? ORDER BY round_index",
        )
        .all("live-sdk-invocation"),
    ).toEqual([{ attempt: 1 }, { attempt: 2 }]);

    db.prepare(
      `UPDATE executor_invocations
          SET state = 'running', attempt = 3, finished_at = NULL
        WHERE invocation_id = ?`,
    ).run("live-sdk-invocation");
    const incompleteEnvelope = createDurableExecutorEnvelope({
      db,
      invocationId: "live-sdk-invocation",
      now: () => NOW + 4,
    });
    incompleteEnvelope.facade.startRound({
      roundId: "live-sdk-invocation::round-3",
      invocationId: "live-sdk-invocation",
      workflowRunId: "live-sdk-run",
      stepRunId: "preflight",
      stepKey: "preflight",
      executorFamily: "one-shot",
      attempt: 3,
      roundIndex: 2,
      state: "running",
      agentProvider: null,
      model: null,
      effort: null,
      inputDigest: null,
      resultDigest: null,
      artifactRoot: null,
      logPaths: [],
      summary: null,
      keyChanges: [],
      keyLearnings: [],
      remainingWork: [],
      changedFiles: [],
      verificationStatus: null,
      commitSha: null,
    });
    let settledClean: boolean | undefined;
    await expect(
      executor.tick({
        state: incompleteEnvelope.snapshot(),
        config: {},
        hostBindings: {
          ...hostBindings,
          settleRepoOwnership: (provenClean: boolean) => {
            settledClean = provenClean;
          },
        },
        envelope: incompleteEnvelope.facade,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("no durable mechanism_completed outcome");
    expect(settledClean).toBe(false);

    db.prepare(
      `UPDATE executor_invocations
          SET state = 'running', attempt = 4, finished_at = NULL
        WHERE invocation_id = ?`,
    ).run("live-sdk-invocation");
    await driveExecutorTicks({
      db,
      invocationId: "live-sdk-invocation",
      executor: {
        name: "one-shot",
        configSchema: liveStepBuiltInConfigSchema("one-shot"),
        tick: () => ({
          roundId: "live-sdk-invocation::round-3",
          recommendation: "complete",
          recommendedRoundState: "succeeded",
          recommendedInvocationState: "succeeded",
          recoveryCode: null,
          humanGate: null,
          reason: "malformed cross-attempt result",
        }),
      },
      config: {},
      hostBindings: {},
      now: () => NOW + 5,
    });
    expect(
      db
        .prepare(
          "SELECT attempt, state FROM executor_rounds WHERE invocation_id = ? ORDER BY round_index",
        )
        .all("live-sdk-invocation"),
    ).toEqual([
      { attempt: 1, state: "succeeded" },
      { attempt: 2, state: "succeeded" },
      { attempt: 3, state: "running" },
      { attempt: 4, state: "manual_recovery_required" },
    ]);
    expect(
      db
        .prepare(
          "SELECT recovery_code FROM executor_rounds WHERE invocation_id = ? AND attempt = 4",
        )
        .get("live-sdk-invocation"),
    ).toEqual({ recovery_code: "executor_contract_invalid" });
    db.close();
  });

  it.each([
    {
      errorCode: "command_timed_out" as const,
      expectedRecoveryCode: "command_timed_out",
    },
    { errorCode: null, expectedRecoveryCode: "command_failed" },
  ])(
    "classifies a profile-backed built-in failure as $expectedRecoveryCode",
    async ({ errorCode, expectedRecoveryCode }) => {
      const db = openDb(tempDir());
      const runId = `failed-live-sdk-run-${expectedRecoveryCode}`;
      const invocationId = `failed-live-sdk-invocation-${expectedRecoveryCode}`;
      const definition: WorkflowDefinition = {
        key: "failed-live-sdk-workflow",
        title: "Failed Live SDK Workflow",
        version: 1,
        steps: [
          {
            key: "preflight",
            kind: "preflight",
            executor: "one-shot",
            order: 0,
            required: true,
          },
        ],
      };
      persistWorkflowDefinition(db, definition, { now: NOW });
      persistWorkflowRunStart(db, {
        definition,
        runId,
        repoPath: "/repos/fixture",
        objective: "Classify a built-in failure",
        now: NOW,
      });
      insertExecutorInvocation(
        db,
        {
          invocationId,
          workflowRunId: runId,
          stepRunId: "preflight",
          stepKey: "preflight",
          executorFamily: "one-shot",
          state: "running",
          attempt: 1,
          startedAt: NOW,
          heartbeatAt: NOW,
          finishedAt: null,
        },
        { now: NOW },
      );

      const result = await driveExecutorTicks({
        db,
        invocationId,
        executor: new LiveStepSdkExecutor(
          "one-shot",
          liveStepBuiltInConfigSchema("one-shot"),
        ),
        config: {},
        hostBindings: {
          repoPath: "/repos/fixture",
          run: () => ({
            ok: true,
            result: {
              state: "failed",
              summary: "bounded work failed",
              checkpoints: [],
              artifacts: [],
              resultDigest: "sha256:failed-result",
              errorCode,
              errorMessage: "verification failed",
              retryHint: null,
              recoveryHint: null,
            },
            executorLogPath: "/tmp/executor.log",
            resultJsonPath: "/tmp/result.json",
          }),
        },
        now: () => NOW + 1,
      });

      expect(result.invocation.state).toBe("failed");
      expect(result.lastRound).toMatchObject({
        state: "failed",
        recoveryCode: expectedRecoveryCode,
      });
      db.close();
    },
  );

  it("retains repo ownership when completion checkpoint persistence is refused", async () => {
    const db = openDb(tempDir());
    const definition: WorkflowDefinition = {
      key: "checkpoint-failure-workflow",
      title: "Checkpoint Failure Workflow",
      version: 1,
      steps: [
        {
          key: "preflight",
          kind: "preflight",
          executor: "one-shot",
          order: 0,
          required: true,
        },
      ],
    };
    persistWorkflowDefinition(db, definition, { now: NOW });
    persistWorkflowRunStart(db, {
      definition,
      runId: "checkpoint-failure-run",
      repoPath: "/repos/fixture",
      objective: "Refuse torn completion evidence",
      now: NOW,
    });
    insertExecutorInvocation(
      db,
      {
        invocationId: "checkpoint-failure-invocation",
        workflowRunId: "checkpoint-failure-run",
        stepRunId: "preflight",
        stepKey: "preflight",
        executorFamily: "one-shot",
        state: "running",
        attempt: 1,
        startedAt: NOW,
        heartbeatAt: NOW,
        finishedAt: null,
      },
      { now: NOW },
    );
    let writes = 0;
    const envelope = createDurableExecutorEnvelope({
      db,
      invocationId: "checkpoint-failure-invocation",
      now: () => NOW + 1,
      authorizeWrite: () => {
        writes += 1;
        if (writes >= 3) throw new Error("dispatch lease lost");
      },
    });
    let settledClean: boolean | undefined;
    const executor = new LiveStepSdkExecutor(
      "one-shot",
      liveStepBuiltInConfigSchema("one-shot"),
    );
    await expect(
      executor.tick({
        state: envelope.snapshot(),
        config: {},
        hostBindings: {
          repoPath: "/repos/fixture",
          run: () => ({
            ok: true,
            result: {
              state: "succeeded",
              summary: "mechanism completed",
              checkpoints: [],
              artifacts: [],
              resultDigest: null,
              errorCode: null,
              errorMessage: null,
              retryHint: null,
              recoveryHint: null,
            },
            executorLogPath: "/tmp/executor.log",
            resultJsonPath: "/tmp/result.json",
          }),
          settleRepoOwnership: (provenClean) => {
            settledClean = provenClean;
          },
        },
        envelope: envelope.facade,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("dispatch lease lost");
    expect(settledClean).toBe(false);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM executor_checkpoints WHERE stage = 'mechanism_completed' AND round_id LIKE 'checkpoint-failure-invocation%'",
        )
        .get(),
    ).toEqual({ count: 0 });
    db.close();
  });

  it("fails closed on broken and contract-invalid modules with precise diagnostics", async () => {
    const missing = await loadExecutorRegistry({
      config: { executors: { broken: "./missing.mjs" } },
      configDir: tempDir(),
    });
    expect(missing).toMatchObject({
      ok: false,
      diagnostics: [
        { code: "executor_module_unavailable", executor: "broken" },
      ],
    });
    const invalid = await loadExecutorRegistry({
      config: { executors: { broken: "virtual:broken" } },
      configDir: tempDir(),
      importModule: async () => ({
        default: { name: "broken", configSchema: {}, tick: "not-a-function" },
      }),
    });
    expect(invalid).toMatchObject({
      ok: false,
      diagnostics: [
        {
          code: "executor_module_invalid",
          executor: "broken",
          message: expect.stringContaining("configSchema"),
        },
      ],
    });
    const invalidPattern = await loadExecutorRegistry({
      config: { executors: { broken: "virtual:pattern" } },
      configDir: tempDir(),
      importModule: async () => ({
        default: {
          name: "broken",
          configSchema: {
            type: "object",
            properties: { value: { type: "string", pattern: "[" } },
            additionalProperties: false,
          },
          tick: () => undefined,
        },
      }),
    });
    expect(invalidPattern).toMatchObject({
      ok: false,
      diagnostics: [
        {
          code: "executor_module_invalid",
          message: expect.stringContaining("configSchema"),
        },
      ],
    });
    const unsupportedKeyword = await loadExecutorRegistry({
      config: { executors: { broken: "virtual:keyword" } },
      configDir: tempDir(),
      importModule: async () => ({
        default: {
          name: "broken",
          configSchema: {
            type: "object",
            properties: {
              value: { type: "string", minLenght: 1 },
            },
            additionalProperties: false,
          },
          tick: () => undefined,
        },
      }),
    });
    expect(unsupportedKeyword).toMatchObject({
      ok: false,
      diagnostics: [{ code: "executor_module_invalid" }],
    });
    const throwingExport = await loadExecutorRegistry({
      config: { executors: { broken: "virtual:throwing-export" } },
      configDir: tempDir(),
      importModule: async () =>
        new Proxy(
          {},
          {
            getPrototypeOf() {
              throw new Error("hostile module namespace");
            },
          },
        ),
    });
    expect(throwingExport).toMatchObject({
      ok: false,
      diagnostics: [
        {
          code: "executor_module_invalid",
          executor: "broken",
          message: expect.stringContaining("hostile module namespace"),
        },
      ],
    });
    const hostileThrownValue = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("nested hostile inspection");
        },
        get() {
          throw new Error("nested hostile coercion");
        },
      },
    );
    const doublyHostileExport = await loadExecutorRegistry({
      config: { executors: { broken: "virtual:doubly-hostile" } },
      configDir: tempDir(),
      importModule: async () =>
        new Proxy(
          {},
          {
            getPrototypeOf() {
              throw hostileThrownValue;
            },
          },
        ),
    });
    expect(doublyHostileExport).toMatchObject({
      ok: false,
      diagnostics: [
        {
          code: "executor_module_invalid",
          message: expect.stringContaining("uninspectable thrown value"),
        },
      ],
    });
  });

  it("accepts the documented named executor export from a CommonJS namespace", async () => {
    const executor = {
      name: "commonjs-executor",
      configSchema: {
        type: "object" as const,
        properties: {},
        additionalProperties: false as const,
      },
      tick: () => {
        throw new Error("not executed");
      },
    };
    const loaded = await loadExecutorRegistry({
      config: {
        executors: { "commonjs-executor": "virtual:commonjs-executor" },
      },
      configDir: tempDir(),
      importModule: async () => ({
        default: { executor },
        executor,
      }),
    });
    expect(loaded.ok).toBe(true);
    expect(loaded.registry.get("commonjs-executor")).toBe(executor);

    const wrappedOnly = await loadExecutorRegistry({
      config: {
        executors: { "commonjs-executor": "virtual:wrapped-commonjs" },
      },
      configDir: tempDir(),
      importModule: async () => ({ default: { executor } }),
    });
    expect(wrappedOnly.ok).toBe(true);
    expect(wrappedOnly.registry.get("commonjs-executor")).toBe(executor);
  });

  it("reloads a repaired CommonJS executor with a fresh import identity", async () => {
    const root = tempDir();
    const modulePath = path.join(root, "repairable.cjs");
    const config = {
      executors: { "commonjs-executor": modulePath },
    };
    fs.writeFileSync(
      modulePath,
      'module.exports = { name: "commonjs-executor" };\n',
    );
    const invalid = await loadExecutorRegistry({
      config,
      configDir: root,
      importCacheKey: "before-repair",
    });
    expect(invalid.ok).toBe(false);

    fs.writeFileSync(
      modulePath,
      'module.exports = { name: "commonjs-executor", configSchema: { type: "object", properties: {}, additionalProperties: false }, tick() {} };\n',
    );
    const repaired = await loadExecutorRegistry({
      config,
      configDir: root,
      importCacheKey: "after-repair",
    });
    expect(repaired.ok).toBe(true);
    expect(repaired.registry.has("commonjs-executor")).toBe(true);
  });

  it("reloads a repaired CommonJS package through a node_modules symlink", async () => {
    const root = tempDir();
    const packageDir = path.join(root, "store", "repairable-package");
    const nodeModules = path.join(root, "node_modules");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.mkdirSync(nodeModules, { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "repairable-package",
        main: "./index.cjs",
      }),
    );
    const modulePath = path.join(packageDir, "index.cjs");
    fs.writeFileSync(
      modulePath,
      'module.exports = { name: "commonjs-executor" };\n',
    );
    fs.symlinkSync(
      packageDir,
      path.join(nodeModules, "repairable-package"),
      "dir",
    );
    const config = {
      executors: { "commonjs-executor": "repairable-package" },
    };
    const invalid = await loadExecutorRegistry({
      config,
      configDir: root,
      importCacheKey: "before-package-repair",
    });
    expect(invalid.ok).toBe(false);

    fs.writeFileSync(
      modulePath,
      'module.exports = { name: "commonjs-executor", configSchema: { type: "object", properties: {}, additionalProperties: false }, tick() {} };\n',
    );
    const repaired = await loadExecutorRegistry({
      config,
      configDir: root,
      importCacheKey: "after-package-repair",
    });
    expect(repaired.ok).toBe(true);
    expect(repaired.registry.has("commonjs-executor")).toBe(true);
  });

  it("resolves npm package specifiers from the executor config directory", async () => {
    const root = tempDir();
    const packageDir = path.join(root, "node_modules", "fixture-package");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "fixture-package",
        type: "module",
        exports: {
          ".": { import: "./index.mjs" },
          "./features/*": { import: "./features/*.mjs" },
        },
      }),
    );
    fs.writeFileSync(
      path.join(packageDir, "index.mjs"),
      `export default {
        name: "fixture-package",
        configSchema: { type: "object", properties: {}, additionalProperties: false },
        tick() { throw new Error("not executed"); }
      };`,
    );
    const loaded = await loadExecutorRegistry({
      config: { executors: { "fixture-package": "fixture-package" } },
      configDir: root,
    });
    expect(loaded.ok).toBe(true);
    expect(loaded.registry.get("fixture-package")?.name).toBe(
      "fixture-package",
    );
    fs.mkdirSync(path.join(packageDir, "features"), { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "features", "executor.mjs"),
      `export default {
        name: "fixture-package-feature",
        configSchema: { type: "object", properties: {}, additionalProperties: false },
        tick() { throw new Error("not executed"); }
      };`,
    );
    const patternLoaded = await loadExecutorRegistry({
      config: {
        executors: {
          "fixture-package-feature": "fixture-package/features/executor",
        },
      },
      configDir: root,
    });
    expect(patternLoaded.ok).toBe(true);
    expect(patternLoaded.registry.get("fixture-package-feature")?.name).toBe(
      "fixture-package-feature",
    );

    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "fixture-package",
        type: "module",
        exports: {
          ".": "./index.mjs",
          "./private": null,
          "./*": "./features/*.mjs",
        },
      }),
    );
    fs.writeFileSync(
      path.join(packageDir, "features", "private.mjs"),
      `export default {
        name: "blocked-package-feature",
        configSchema: { type: "object", properties: {}, additionalProperties: false },
        tick() { throw new Error("not executed"); }
      };`,
    );
    const blocked = await loadExecutorRegistry({
      config: {
        executors: { "blocked-package-feature": "fixture-package/private" },
      },
      configDir: root,
    });
    expect(blocked).toMatchObject({
      ok: false,
      diagnostics: [{ code: "executor_module_unavailable" }],
    });

    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "fixture-package",
        type: "module",
        exports: {
          "./private/*": null,
          "./*": "./features/*.mjs",
        },
      }),
    );
    const wildcardBlocked = await loadExecutorRegistry({
      config: {
        executors: {
          "blocked-package-feature": "fixture-package/private/executor",
        },
      },
      configDir: root,
    });
    expect(wildcardBlocked).toMatchObject({
      ok: false,
      diagnostics: [{ code: "executor_module_unavailable" }],
    });

    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "fixture-package",
        type: "module",
        exports: {
          "./conditional": {
            import: null,
            default: "./features/executor.mjs",
          },
        },
      }),
    );
    const conditionalBlocked = await loadExecutorRegistry({
      config: {
        executors: {
          "fixture-package-feature": "fixture-package/conditional",
        },
      },
      configDir: root,
    });
    expect(conditionalBlocked).toMatchObject({
      ok: false,
      diagnostics: [{ code: "executor_module_unavailable" }],
    });

    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "fixture-package",
        type: "module",
        exports: [null, "./index.mjs"],
      }),
    );
    const arrayBlocked = await loadExecutorRegistry({
      config: { executors: { "fixture-package": "fixture-package" } },
      configDir: root,
    });
    expect(arrayBlocked).toMatchObject({
      ok: false,
      diagnostics: [{ code: "executor_module_unavailable" }],
    });

    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "fixture-package",
        type: "module",
        exports: ["not:valid", "./index.mjs"],
      }),
    );
    const arrayFallback = await loadExecutorRegistry({
      config: { executors: { "fixture-package": "fixture-package" } },
      configDir: root,
    });
    expect(arrayFallback.ok).toBe(true);
    expect(arrayFallback.registry.get("fixture-package")?.name).toBe(
      "fixture-package",
    );

    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "fixture-package",
        type: "module",
        exports: ["./../outside.mjs", "./index.mjs"],
      }),
    );
    const escapingArrayFallback = await loadExecutorRegistry({
      config: { executors: { "fixture-package": "fixture-package" } },
      configDir: root,
    });
    expect(escapingArrayFallback.ok).toBe(true);
    expect(escapingArrayFallback.registry.get("fixture-package")?.name).toBe(
      "fixture-package",
    );

    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "fixture-package",
        type: "module",
        exports: { import: "./index.mjs" },
      }),
    );
    const rootOnlyBlocked = await loadExecutorRegistry({
      config: {
        executors: { "fixture-package": "fixture-package/private" },
      },
      configDir: root,
    });
    expect(rootOnlyBlocked).toMatchObject({
      ok: false,
      diagnostics: [{ code: "executor_module_unavailable" }],
    });

    fs.writeFileSync(
      path.join(packageDir, "features", "addon.mjs"),
      `export default {
        name: "addon-executor",
        configSchema: { type: "object", properties: {}, additionalProperties: false },
        tick() { throw new Error("not executed"); }
      };`,
    );
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "fixture-package",
        type: "module",
        exports: {
          ".": {
            "node-addons": "./features/addon.mjs",
            default: "./index.mjs",
          },
        },
      }),
    );
    const addon = await loadExecutorRegistry({
      config: { executors: { "addon-executor": "fixture-package" } },
      configDir: root,
    });
    expect(addon.ok).toBe(true);
    expect(addon.registry.get("addon-executor")?.name).toBe("addon-executor");

    fs.writeFileSync(
      path.join(packageDir, "features", "bundler.mjs"),
      `throw new Error("the nonstandard module field must not be selected");`,
    );
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "fixture-package",
        type: "module",
        module: "./features/bundler.mjs",
        main: "./index.mjs",
      }),
    );
    const mainEntry = await loadExecutorRegistry({
      config: { executors: { "fixture-package": "fixture-package" } },
      configDir: root,
    });
    expect(mainEntry.ok).toBe(true);
    expect(mainEntry.registry.get("fixture-package")?.name).toBe(
      "fixture-package",
    );

    fs.mkdirSync(path.join(packageDir, "legacy"), { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "legacy", "executor.js"),
      `export default {
        name: "legacy-main-executor",
        configSchema: { type: "object", properties: {}, additionalProperties: false },
        tick() { throw new Error("not executed"); }
      };`,
    );
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "fixture-package",
        type: "module",
        main: "./legacy/executor",
      }),
    );
    const extensionlessMain = await loadExecutorRegistry({
      config: {
        executors: { "legacy-main-executor": "fixture-package" },
      },
      configDir: root,
    });
    expect(extensionlessMain.ok).toBe(true);
    expect(extensionlessMain.registry.get("legacy-main-executor")?.name).toBe(
      "legacy-main-executor",
    );
  });

  it("reports schema-invalid step config before durable run writes", async () => {
    const registry = await fixtureRegistry();
    const definition = fixtureDefinition({ message: 42 });
    const preflight = preflightWorkflowExecutorConfigs(definition, registry);
    expect(preflight).toMatchObject({
      ok: false,
      evidence: [
        {
          checkId: "executor.config",
          status: "failed",
          path: "workflow.definition.steps[0].config.message",
        },
      ],
    });
    const dataDir = tempDir();
    const repoDir = tempDir();
    const configPath = path.join(tempDir(), "executors.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        executors: {
          "fixture-executor": path.join(
            import.meta.dirname,
            "fixtures/third-party-executor.mjs",
          ),
        },
      }),
    );
    const db = openDb(dataDir);
    persistWorkflowDefinition(db, definition, { now: NOW });
    db.close();
    let stdout = "";
    let stderr = "";
    const code = await runCli(
      [
        "workflow",
        "run",
        "start",
        "--run-id",
        "schema-invalid-run",
        "--repo",
        repoDir,
        "--objective",
        "Reject invalid executor config",
        "--definition",
        definition.key,
        "--data-dir",
        dataDir,
        "--json",
      ],
      {
        stdout: {
          write(chunk: string) {
            stdout += chunk;
            return true;
          },
        },
        stderr: {
          write(chunk: string) {
            stderr += chunk;
            return true;
          },
        },
        env: { [DAEMON_EXECUTOR_CONFIG_ENV_VAR]: configPath },
      },
    );
    expect(code).toBe(1);
    expect(JSON.parse(stdout || stderr)).toMatchObject({
      ok: false,
      code: "executor_config_invalid",
    });
    const verifyDb = openDb(dataDir);
    expect(
      verifyDb.prepare("SELECT COUNT(*) AS count FROM workflow_runs").get(),
    ).toEqual({ count: 0 });
    expect(
      verifyDb.prepare("SELECT COUNT(*) AS count FROM workflow_steps").get(),
    ).toEqual({ count: 0 });
    verifyDb.close();
  });

  it("starts an unregistered custom executor when no registry is configured", async () => {
    const dataDir = tempDir();
    const repoDir = tempDir();
    const definition = fixtureDefinition({ message: "validate at dispatch" });
    const db = openDb(dataDir);
    persistWorkflowDefinition(db, definition, { now: NOW });
    db.close();
    let stdout = "";
    const code = await runCli(
      [
        "workflow",
        "run",
        "start",
        "--run-id",
        "unregistered-start-run",
        "--repo",
        repoDir,
        "--objective",
        "Persist custom identity without local wiring",
        "--definition",
        definition.key,
        "--data-dir",
        dataDir,
        "--json",
      ],
      {
        stdout: {
          write(chunk: string) {
            stdout += chunk;
            return true;
          },
        },
        stderr: { write: () => true },
        env: {},
      },
    );
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      runId: "unregistered-start-run",
    });
    const verifyDb = openDb(dataDir);
    expect(
      verifyDb
        .prepare("SELECT id FROM workflow_runs WHERE id = ?")
        .get("unregistered-start-run"),
    ).toEqual({ id: "unregistered-start-run" });
    verifyDb.close();
  });

  it("rejects inherited property names under additionalProperties false", () => {
    const config = JSON.parse('{"constructor":"not-declared"}') as unknown;
    expect(
      validateExecutorConfig(config, {
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
    ).toMatchObject({
      ok: false,
      issues: [{ path: "config.constructor", message: "is not supported" }],
    });
  });

  it("validates multiples against the canonical decimal values", () => {
    expect(
      validateExecutorConfig(
        { ratio: 0.3 },
        {
          type: "object",
          properties: {
            ratio: { type: "number", multipleOf: 0.1 },
          },
          required: ["ratio"],
          additionalProperties: false,
        },
      ),
    ).toEqual({ ok: true });
    expect(
      validateExecutorConfig(
        { value: 1_000_000.000_000_000_1 },
        {
          type: "object",
          properties: { value: { type: "number", multipleOf: 1 } },
          required: ["value"],
          additionalProperties: false,
        },
      ).ok,
    ).toBe(false);
    expect(
      validateExecutorConfig(
        { value: 1_000_000_000_000_001 },
        {
          type: "object",
          properties: { value: { type: "integer", multipleOf: 2 } },
          required: ["value"],
          additionalProperties: false,
        },
      ).ok,
    ).toBe(false);
    expect(
      validateExecutorConfig(
        { ratio: 100_000_000_000_000.02 },
        {
          type: "object",
          properties: {
            ratio: { type: "number", multipleOf: 0.1 },
          },
          required: ["ratio"],
          additionalProperties: false,
        },
      ).ok,
    ).toBe(false);
    expect(
      validateExecutorConfig(
        { value: 1e20 },
        {
          type: "object",
          properties: { value: { type: "number", multipleOf: 3 } },
          required: ["value"],
          additionalProperties: false,
        },
      ).ok,
    ).toBe(false);
  });

  it("keeps an unregistered executor as an honest runtime_unavailable refusal", async () => {
    const definition = fixtureDefinition({ message: "never runs" });
    const db = openDb(tempDir());
    persistWorkflowDefinition(db, definition, { now: NOW });
    persistWorkflowRunStart(db, {
      definition,
      runId: "unregistered-run",
      repoPath: "/repos/fixture",
      objective: "Refuse honestly",
      now: NOW,
    });
    db.prepare(
      "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ?",
    ).run("unregistered-run");
    const claim = claimRunnableWorkflowStep(db, {
      runId: "unregistered-run",
      stepId: "preflight",
      holder: "fixture-worker",
      leaseExpiresAt: NOW + 30_000,
      now: NOW,
    });
    if (!claim.ok) throw new Error(claim.reason);
    const production = resolveDaemonWorkflowStepDispatch(
      {},
      executeWorkflowStepDispatch,
      {},
    );
    if (!production.ok) throw new Error(production.message);
    await production.dispatch(claim.claim, {
      db,
      workerId: "fixture-worker",
      now: NOW + 1,
    });
    expect(
      db
        .prepare(
          "SELECT state, recovery_code FROM executor_rounds WHERE workflow_run_id = ? ORDER BY round_index DESC LIMIT 1",
        )
        .get("unregistered-run"),
    ).toEqual({
      state: "manual_recovery_required",
      recovery_code: "runtime_unavailable",
    });
    expect(
      db
        .prepare(
          "SELECT state FROM executor_invocations WHERE workflow_run_id = ?",
        )
        .get("unregistered-run"),
    ).toEqual({ state: "manual_recovery_required" });

    expect(
      clearWorkflowRunManualRecoveryGuarded(db, {
        runId: "unregistered-run",
        now: NOW + 2,
      }),
    ).toMatchObject({ ok: true });

    const registry = await fixtureRegistry();
    const repairedDispatch = createRegisteredExecutorWorkflowDispatch(
      executeWorkflowStepDispatch,
      { registry },
    );
    await runWorkflowSchedulerOnceAsync({
      db,
      workerId: "fixture-worker",
      dispatch: repairedDispatch,
      now: () => NOW + 3,
    });
    expect(
      db
        .prepare(
          "SELECT state, attempt FROM executor_invocations WHERE workflow_run_id = ?",
        )
        .get("unregistered-run"),
    ).toEqual({ state: "succeeded", attempt: 2 });
    expect(
      db
        .prepare(
          "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = ?",
        )
        .get("unregistered-run", "preflight"),
    ).toEqual({ state: "succeeded" });
    db.close();
  });

  it.each([
    {
      classification: "approval_required" as const,
      action: "approve",
      roundState: "waiting_operator" as const,
    },
    {
      classification: "operator_decision_required" as const,
      action: "apply",
      roundState: "waiting_operator" as const,
    },
    {
      classification: "approval_required" as const,
      action: "approve",
      roundState: "succeeded" as const,
    },
    {
      classification: "operator_decision_required" as const,
      action: "apply",
      roundState: "failed" as const,
    },
    {
      classification: "approval_required" as const,
      action: "acknowledge",
      roundState: "waiting_operator" as const,
      legacySelection: true,
    },
  ])(
    "persists and resumes a registered executor $classification gate after a $roundState round",
    async ({ classification, action, roundState, legacySelection = false }) => {
      const dataDir = tempDir();
      const runId = `registered-gate-${classification}`;
      const definition = fixtureDefinition({});
      let db = openDb(dataDir);
      persistWorkflowDefinition(db, definition, { now: NOW });
      persistWorkflowRunStart(db, {
        definition,
        runId,
        repoPath: "/repos/fixture",
        objective: "Resume a durable executor decision",
        now: NOW,
      });
      db.prepare(
        "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ?",
      ).run(runId);

      const registry = new Map();
      expect(
        registerExecutor(registry, "fixture-executor", {
          name: "fixture-executor",
          configSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          tick: (
            context: ExecutorTickContext<
              Record<string, never>,
              Record<string, never>
            >,
          ) => {
            const current = context.state.currentRound;
            const chosen = current?.decisions.find(
              (decision) => decision.chosenAction !== null,
            );
            if (current !== null && chosen !== undefined) {
              const resumedRound =
                current.round.state !== "succeeded" &&
                current.round.state !== "failed"
                  ? context.envelope.observeRound(current.round.roundId, {
                      phase: "capturing_result",
                      summary: `accepted ${chosen.chosenAction}`,
                    })
                  : context.envelope.startRound({
                      roundId: `${context.state.invocation.invocationId}::round-2`,
                      invocationId: context.state.invocation.invocationId,
                      workflowRunId: context.state.invocation.workflowRunId,
                      stepRunId: context.state.invocation.stepRunId,
                      stepKey: context.state.invocation.stepKey,
                      executorFamily: context.state.invocation.executorFamily,
                      attempt: context.state.invocation.attempt,
                      roundIndex: context.state.rounds.length,
                      state: "capturing_result",
                      agentProvider: null,
                      model: null,
                      effort: null,
                      inputDigest: null,
                      resultDigest: null,
                      artifactRoot: null,
                      logPaths: [],
                      summary: `accepted ${chosen.chosenAction}`,
                      keyChanges: [],
                      keyLearnings: [],
                      remainingWork: [],
                      changedFiles: [],
                      verificationStatus: null,
                      commitSha: null,
                    });
              return {
                roundId: resumedRound.roundId,
                recommendation: "complete",
                recommendedRoundState: "succeeded",
                recommendedInvocationState: "succeeded",
                recoveryCode: null,
                humanGate: null,
                reason: "The durable operator decision was applied.",
              };
            }

            const invocation = context.state.invocation;
            const round = context.envelope.startRound({
              roundId: `${invocation.invocationId}::round-1`,
              invocationId: invocation.invocationId,
              workflowRunId: invocation.workflowRunId,
              stepRunId: invocation.stepRunId,
              stepKey: invocation.stepKey,
              executorFamily: invocation.executorFamily,
              attempt: invocation.attempt,
              roundIndex: context.state.rounds.length,
              state: "mirroring_external_state",
              agentProvider: null,
              model: null,
              effort: null,
              inputDigest: null,
              resultDigest: null,
              artifactRoot: null,
              logPaths: [],
              summary: "Waiting for a durable operator decision",
              keyChanges: [],
              keyLearnings: [],
              remainingWork: [],
              changedFiles: [],
              verificationStatus: null,
              commitSha: null,
            });
            const gateDecision = context.envelope.recordDecision(
              round.roundId,
              {
                decisionId: `${round.roundId}::decision-1`,
                summary: "Choose how the executor should continue",
                allowedActions: [action, "cancel"],
                recommendedAction: action,
                chosenAction: null,
                resolution: null,
                externalRef: null,
              },
            );
            context.envelope.recordDecision(round.roundId, {
              decisionId: `${round.roundId}::decision-2`,
              summary: "Mirrored external decision",
              allowedActions: ["acknowledge", "cancel"],
              recommendedAction: "acknowledge",
              chosenAction: null,
              resolution: null,
              externalRef: "external-decision",
            });
            if (legacySelection) {
              context.envelope.recordCheckpoint(round.roundId, {
                checkpointId: `${round.roundId}::stale-gate-selector`,
                sequence: 0,
                stage: "human_gate_decision_selected",
                detail: JSON.stringify({
                  decisionId: gateDecision.decisionId,
                }),
              });
            }
            return {
              roundId: round.roundId,
              recommendation: classification,
              recommendedRoundState: roundState,
              recommendedInvocationState: "waiting_operator",
              recoveryCode: null,
              humanGate: classification,
              humanGateDecisionId: legacySelection
                ? null
                : gateDecision.decisionId,
              reason: "The executor needs an operator decision.",
            };
          },
        }),
      ).toBeNull();
      const dispatch = createRegisteredExecutorWorkflowDispatch(
        executeWorkflowStepDispatch,
        { registry },
      );
      const claim = claimRunnableWorkflowStep(db, {
        runId,
        stepId: "preflight",
        holder: "fixture-worker",
        leaseExpiresAt: NOW + 30_000,
        now: NOW,
      });
      if (!claim.ok) throw new Error(claim.reason);
      await dispatch(claim.claim, {
        db,
        workerId: "fixture-worker",
        now: NOW + 1,
      });

      const gate = db
        .prepare(
          "SELECT gate_id, gate_type, reason, evidence, resolved_at FROM workflow_gates WHERE workflow_run_id = ?",
        )
        .get(runId) as
        | {
            gate_id: string;
            gate_type: string;
            reason: string;
            evidence: string;
            resolved_at: number | null;
          }
        | undefined;
      expect(gate?.reason).toBe(
        legacySelection
          ? "Mirrored external decision"
          : "Choose how the executor should continue",
      );
      expect(gate).toMatchObject({
        gate_type: classification,
        resolved_at: null,
      });
      expect(
        db
          .prepare(
            `SELECT json_extract(detail, '$.decisionId') AS decisionId
              FROM executor_checkpoints
              WHERE stage = 'human_gate_decision_selected'
              ORDER BY sequence DESC
              LIMIT 1`,
          )
          .get(),
      ).toEqual({ decisionId: legacySelection ? null : gate?.evidence });
      expect(
        db
          .prepare(
            "SELECT released_at IS NOT NULL AS released FROM workflow_leases WHERE run_id = ? AND lease_kind = 'dispatch'",
          )
          .get(runId),
      ).toEqual({ released: 1 });
      db.close();

      let stdout = "";
      let stderr = "";
      const exitCode = await runCli(
        [
          "workflow",
          "run",
          "decide",
          gate?.gate_id ?? "missing-gate",
          "--action",
          action,
          "--actor",
          "fixture-operator",
          "--data-dir",
          dataDir,
          "--json",
        ],
        {
          stdout: { write: (chunk) => ((stdout += chunk), true) },
          stderr: { write: (chunk) => ((stderr += chunk), true) },
          env: {},
        },
      );
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      expect(JSON.parse(stdout)).toMatchObject({ chosenAction: action });

      db = openDb(dataDir);
      await runWorkflowSchedulerOnceAsync({
        db,
        workerId: "restarted-worker",
        dispatch,
        now: () => NOW + 3,
      });
      expect(
        db
          .prepare(
            "SELECT state FROM executor_invocations WHERE workflow_run_id = ?",
          )
          .get(runId),
      ).toEqual({ state: "succeeded" });
      expect(
        db
          .prepare(
            "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = ?",
          )
          .get(runId, "preflight"),
      ).toEqual({ state: "succeeded" });
      expect(
        db
          .prepare(
            "SELECT d.chosen_action FROM executor_decisions AS d JOIN executor_rounds AS r ON r.round_id = d.round_id WHERE r.workflow_run_id = ? AND d.chosen_action IS NOT NULL ORDER BY r.round_index DESC LIMIT 1",
          )
          .get(runId),
      ).toEqual({ chosen_action: action });
      db.close();
    },
  );

  it("settles malformed tick results as executor_contract_invalid", async () => {
    const definition = fixtureDefinition({});
    const db = openDb(tempDir());
    persistWorkflowDefinition(db, definition, { now: NOW });
    persistWorkflowRunStart(db, {
      definition,
      runId: "malformed-tick-run",
      repoPath: "/repos/fixture",
      objective: "Refuse malformed executor output",
      now: NOW,
    });
    db.prepare(
      "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ?",
    ).run("malformed-tick-run");
    const claim = claimRunnableWorkflowStep(db, {
      runId: "malformed-tick-run",
      stepId: "preflight",
      holder: "fixture-worker",
      leaseExpiresAt: NOW + 30_000,
      now: NOW,
    });
    if (!claim.ok) throw new Error(claim.reason);
    const registry = new Map();
    let tickCount = 0;
    let repaired = false;
    expect(
      registerExecutor(registry, "fixture-executor", {
        name: "fixture-executor",
        configSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        tick: (
          context: ExecutorTickContext<
            Record<string, never>,
            Record<string, never>
          >,
        ) => {
          if (repaired) {
            return completeRegisteredExecutorTick(context, "repaired tick");
          }
          tickCount += 1;
          if (tickCount > 1) return undefined;
          const invocation = context.state.invocation;
          const round = context.envelope.startRound({
            roundId: `${invocation.invocationId}::round-1`,
            invocationId: invocation.invocationId,
            workflowRunId: invocation.workflowRunId,
            stepRunId: invocation.stepRunId,
            stepKey: invocation.stepKey,
            executorFamily: invocation.executorFamily,
            attempt: invocation.attempt,
            roundIndex: 0,
            state: "capturing_result",
            agentProvider: null,
            model: null,
            effort: null,
            inputDigest: null,
            resultDigest: null,
            artifactRoot: null,
            logPaths: [],
            summary: "first turn",
            keyChanges: [],
            keyLearnings: [],
            remainingWork: [],
            changedFiles: [],
            verificationStatus: null,
            commitSha: null,
          });
          return {
            roundId: round.roundId,
            recommendation: "continue",
            recommendedRoundState: "succeeded",
            recommendedInvocationState: "running",
            recoveryCode: null,
            humanGate: null,
            reason: "continue once",
          };
        },
      }),
    ).toBeNull();
    const dispatch = createRegisteredExecutorWorkflowDispatch(
      executeWorkflowStepDispatch,
      {
        registry,
        resolveMaxTicks: ({ executorName }) =>
          executorName === "fixture-executor" ? 2 : 1,
      },
    );
    await dispatch(claim.claim, {
      db,
      workerId: "fixture-worker",
      now: NOW + 1,
    });
    expect(
      db
        .prepare(
          "SELECT recovery_code FROM executor_rounds WHERE workflow_run_id = ? ORDER BY round_index DESC LIMIT 1",
        )
        .get("malformed-tick-run"),
    ).toEqual({ recovery_code: "executor_contract_invalid" });
    repaired = true;
    expect(
      clearWorkflowRunManualRecoveryGuarded(db, {
        runId: "malformed-tick-run",
        now: NOW + 2,
      }),
    ).toMatchObject({
      ok: true,
      retryPrepared: {
        stepId: "preflight",
        recoveryCode: "executor_contract_invalid",
      },
    });
    await runWorkflowSchedulerOnceAsync({
      db,
      workerId: "fixture-worker",
      dispatch,
      now: () => NOW + 3,
    });
    expect(
      db
        .prepare(
          "SELECT state, attempt FROM executor_invocations WHERE workflow_run_id = ?",
        )
        .get("malformed-tick-run"),
    ).toEqual({ state: "succeeded", attempt: 2 });
    db.close();
  });

  it.each(["executor_threw"])(
    "retries a %s invocation after the registered executor is repaired",
    async (recoveryCode) => {
      const definition = fixtureDefinition({});
      const db = openDb(tempDir());
      persistWorkflowDefinition(db, definition, { now: NOW });
      persistWorkflowRunStart(db, {
        definition,
        runId: "thrown-tick-run",
        repoPath: "/repos/fixture",
        objective: "Retry a repaired executor throw",
        now: NOW,
      });
      db.prepare(
        "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ?",
      ).run("thrown-tick-run");
      const claim = claimRunnableWorkflowStep(db, {
        runId: "thrown-tick-run",
        stepId: "preflight",
        holder: "fixture-worker",
        leaseExpiresAt: NOW + 30_000,
        now: NOW,
      });
      if (!claim.ok) throw new Error(claim.reason);

      let repaired = false;
      const registry = new Map();
      expect(
        registerExecutor(registry, "fixture-executor", {
          name: "fixture-executor",
          configSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          tick: (
            context: ExecutorTickContext<
              Record<string, never>,
              Record<string, never>
            >,
          ) => {
            if (!repaired) throw new Error("broken executor implementation");
            return completeRegisteredExecutorTick(context, "repaired throw");
          },
        }),
      ).toBeNull();
      const dispatch = createRegisteredExecutorWorkflowDispatch(
        executeWorkflowStepDispatch,
        { registry },
      );
      await dispatch(claim.claim, {
        db,
        workerId: "fixture-worker",
        now: NOW + 1,
      });
      expect(
        db
          .prepare(
            "SELECT recovery_code FROM executor_rounds WHERE workflow_run_id = ? ORDER BY round_index DESC LIMIT 1",
          )
          .get("thrown-tick-run"),
      ).toEqual({ recovery_code: "executor_threw" });
      if (recoveryCode !== "executor_threw") {
        db.prepare(
          `UPDATE executor_rounds
            SET recovery_code = ?
          WHERE round_id = (
            SELECT round_id
              FROM executor_rounds
             WHERE workflow_run_id = ?
             ORDER BY round_index DESC
             LIMIT 1
          )`,
        ).run(recoveryCode, "thrown-tick-run");
      }

      repaired = true;
      expect(
        clearWorkflowRunManualRecoveryGuarded(db, {
          runId: "thrown-tick-run",
          now: NOW + 2,
        }),
      ).toMatchObject({
        ok: true,
        retryPrepared: {
          stepId: "preflight",
          recoveryCode,
        },
      });
      await runWorkflowSchedulerOnceAsync({
        db,
        workerId: "fixture-worker",
        dispatch,
        now: () => NOW + 3,
      });
      expect(
        db
          .prepare(
            "SELECT state, attempt FROM executor_invocations WHERE workflow_run_id = ?",
          )
          .get("thrown-tick-run"),
      ).toEqual({ state: "succeeded", attempt: 2 });
      db.close();
    },
  );

  it("durably settles hostile values thrown by executor ticks", async () => {
    const definition = fixtureDefinition({});
    const db = openDb(tempDir());
    persistWorkflowDefinition(db, definition, { now: NOW });
    persistWorkflowRunStart(db, {
      definition,
      runId: "hostile-tick-run",
      repoPath: "/repos/fixture",
      objective: "Contain hostile executor failures",
      now: NOW,
    });
    insertExecutorInvocation(
      db,
      {
        invocationId: "hostile-tick-invocation",
        workflowRunId: "hostile-tick-run",
        stepRunId: "preflight",
        stepKey: "preflight",
        executorFamily: "fixture-executor",
        state: "running",
        attempt: 1,
        startedAt: NOW,
        heartbeatAt: NOW,
        finishedAt: null,
      },
      { now: NOW },
    );
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("hostile tick inspection");
        },
        get() {
          throw new Error("hostile tick coercion");
        },
      },
    );
    const driven = await driveExecutorTicks({
      db,
      invocationId: "hostile-tick-invocation",
      executor: {
        name: "fixture-executor",
        configSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        tick() {
          throw hostile;
        },
      },
      config: {},
      hostBindings: {},
      now: () => NOW + 1,
    });
    expect(driven.invocation.state).toBe("manual_recovery_required");
    expect(driven.lastRound).toMatchObject({
      recoveryCode: "executor_threw",
      summary: expect.stringContaining("uninspectable thrown value"),
    });
    db.close();
  });

  it("retries a repaired configured module without restarting dispatch", async () => {
    const definition = fixtureDefinition({ message: "never runs" });
    const db = openDb(tempDir());
    persistWorkflowDefinition(db, definition, { now: NOW });
    persistWorkflowRunStart(db, {
      definition,
      runId: "module-load-failure-run",
      repoPath: "/repos/fixture",
      objective: "Refuse a missing executor module",
      now: NOW,
    });
    db.prepare(
      "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ?",
    ).run("module-load-failure-run");
    const claim = claimRunnableWorkflowStep(db, {
      runId: "module-load-failure-run",
      stepId: "preflight",
      holder: "fixture-worker",
      leaseExpiresAt: NOW + 30_000,
      now: NOW,
    });
    if (!claim.ok) throw new Error(claim.reason);
    const configPath = path.join(tempDir(), "broken-executors.json");
    const modulePath = path.join(path.dirname(configPath), "repairable.mjs");
    fs.writeFileSync(
      modulePath,
      'export default { name: "fixture-executor" };\n',
    );
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        executors: { "fixture-executor": "./repairable.mjs" },
      }),
    );
    const production = resolveDaemonWorkflowStepDispatch(
      { [DAEMON_EXECUTOR_CONFIG_ENV_VAR]: configPath },
      executeWorkflowStepDispatch,
      {},
    );
    if (!production.ok) throw new Error(production.message);
    await production.dispatch(claim.claim, {
      db,
      workerId: "fixture-worker",
      now: NOW + 1,
    });
    expect(
      db
        .prepare(
          "SELECT recovery_code, summary FROM executor_rounds WHERE workflow_run_id = ?",
        )
        .get("module-load-failure-run"),
    ).toMatchObject({
      recovery_code: "runtime_unavailable",
      summary: expect.stringContaining("executor_module_invalid"),
    });

    fs.copyFileSync(
      path.join(import.meta.dirname, "fixtures/third-party-executor.mjs"),
      modulePath,
    );
    expect(
      clearWorkflowRunManualRecoveryGuarded(db, {
        runId: "module-load-failure-run",
        now: NOW + 2,
      }),
    ).toMatchObject({ ok: true });
    await runWorkflowSchedulerOnceAsync({
      db,
      workerId: "fixture-worker",
      dispatch: production.dispatch,
      now: () => NOW + 3,
    });
    expect(
      db
        .prepare(
          "SELECT state, attempt FROM executor_invocations WHERE workflow_run_id = ?",
        )
        .get("module-load-failure-run"),
    ).toEqual({ state: "succeeded", attempt: 2 });
    expect(
      db
        .prepare(
          "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = ?",
        )
        .get("module-load-failure-run", "preflight"),
    ).toEqual({ state: "succeeded" });
    db.close();
  });
});
