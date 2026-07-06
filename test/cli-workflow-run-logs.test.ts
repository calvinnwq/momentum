import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/cli.js";
import { openDb, type MomentumDb } from "../src/adapters/db.js";
import {
  insertExecutorArtifact,
  insertExecutorCheckpoint,
  insertExecutorDecision,
  insertExecutorFinding,
  insertExecutorInvocation,
  insertExecutorRound
} from "../src/core/executors/loop/persist.js";
import type {
  ExecutorArtifactRecord,
  ExecutorCheckpointRecord,
  ExecutorDecisionRecord,
  ExecutorFindingRecord,
  ExecutorInvocationRecord,
  ExecutorRoundRecord
} from "../src/core/executors/loop/reducer.js";
import { insertWorkflowGate } from "../src/core/workflow/gate/persist.js";

type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-cli-workflow-run-logs-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

async function run(argv: string[]): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    stdout: {
      write(chunk: string) {
        stdout += chunk;
        return true;
      }
    },
    stderr: {
      write(chunk: string) {
        stderr += chunk;
        return true;
      }
    },
    env: {}
  });
  return { code, stdout, stderr };
}

function makeInvocation(runId: string): ExecutorInvocationRecord {
  return {
    invocationId: "inv-1",
    workflowRunId: runId,
    stepRunId: "implementation",
    stepKey: "implementation",
    executorFamily: "goal-loop",
    state: "running",
    attempt: 1,
    startedAt: 10,
    heartbeatAt: 10,
    finishedAt: null
  };
}

function makeRound(
  runId: string,
  overrides: Partial<ExecutorRoundRecord> = {}
): ExecutorRoundRecord {
  return {
    roundId: "round-1",
    invocationId: "inv-1",
    workflowRunId: runId,
    stepRunId: "implementation",
    stepKey: "implementation",
    executorFamily: "goal-loop",
    attempt: 1,
    roundIndex: 0,
    state: "succeeded",
    classification: "complete",
    startedAt: 20,
    heartbeatAt: 25,
    finishedAt: 30,
    agentProvider: "claude",
    model: "claude-opus-4-8",
    effort: "high",
    inputDigest: "in-1",
    resultDigest: "res-1",
    artifactRoot: `/runs/${runId}/round-1`,
    logPaths: [`/runs/${runId}/round-1/agent.log`],
    summary: "implemented the slice",
    keyChanges: ["added reader"],
    keyLearnings: ["operator readback needs durable learnings"],
    remainingWork: ["wire additional consumers"],
    changedFiles: ["src/core/workflow/run/logs.ts"],
    verificationStatus: "passed",
    verificationResults: [
      {
        command: "pnpm test",
        exitCode: 0,
        durationMs: 1200,
        timedOut: false
      }
    ],
    commitSha: "abc123",
    recoveryCode: null,
    humanGate: null,
    ...overrides
  };
}

function makeArtifact(runId: string): ExecutorArtifactRecord {
  return {
    artifactId: "artifact-1",
    roundId: "round-1",
    artifactClass: "verification_output",
    path: `/runs/${runId}/round-1/verify.txt`,
    digest: "sha256:verify",
    description: "verification output"
  };
}

function makeCheckpoint(): ExecutorCheckpointRecord {
  return {
    checkpointId: "checkpoint-1",
    roundId: "round-1",
    sequence: 0,
    stage: "verify",
    detail: "pnpm test passed"
  };
}

function makeFinding(): ExecutorFindingRecord {
  return {
    findingId: "finding-1",
    roundId: "round-1",
    severity: "warning",
    title: "missing evidence",
    detail: "round evidence was not attached",
    selected: true,
    externalRef: "nomistakes:F-1"
  };
}

function makeDecision(): ExecutorDecisionRecord {
  return {
    decisionId: "decision-1",
    roundId: "round-1",
    summary: "choose recovery path",
    allowedActions: ["retry", "hold"],
    recommendedAction: "retry",
    chosenAction: "retry",
    resolution: "delegated:within-envelope",
    externalRef: "nomistakes:D-1"
  };
}

function seedRunWithRound(db: MomentumDb, runId: string): void {
  db.prepare(
    `INSERT INTO workflow_runs
       (id, state, source, plan_json, objective, issue_scope_json, route_json,
        needs_manual_recovery, created_at, updated_at)
       VALUES (?, 'running', 'agent-workflow', '{}', 'logs read-back', '{}', '{}', 0, 1, 1)`
  ).run(runId);
  db.prepare(
    `INSERT INTO workflow_steps
       (run_id, step_id, kind, state, step_order, required, created_at, updated_at)
       VALUES (?, 'implementation', 'implementation', 'running', 1, 1, 1, 1)`
  ).run(runId);
  insertExecutorInvocation(db, makeInvocation(runId), { now: 1 });
  insertExecutorRound(db, makeRound(runId), { now: 1 });
  insertExecutorArtifact(db, makeArtifact(runId), { now: 5 });
  insertExecutorCheckpoint(db, makeCheckpoint(), { now: 3 });
  insertExecutorFinding(db, makeFinding(), { now: 7 });
  insertExecutorDecision(db, makeDecision(), { now: 9 });
}

function seedRunDetailCategories(db: MomentumDb, runId: string): void {
  db.prepare(
    `INSERT INTO workflow_approvals
       (run_id, boundary, actor, phrase, artifact_path, artifact_digest,
        recorded_at, discharged_at, created_at, updated_at)
       VALUES (?, 'implementation', 'calvin', 'approve implementation',
        '/runs/approval.json', 'sha256:approval', 11, NULL, 11, 11)`
  ).run(runId);
  db.prepare(
    `INSERT INTO workflow_leases
       (run_id, lease_kind, holder, acquired_at, expires_at, heartbeat_at,
        released_at, stale_policy, created_at, updated_at)
       VALUES (?, 'managed-step', 'worker-1', 12, 9999999999999, 12,
        NULL, 'auto-release', 12, 12)`
  ).run(runId);
  insertWorkflowGate(
    db,
    {
      gateId: "gate-open-1",
      workflowRunId: runId,
      targetScope: "workflow",
      gateType: "approval_required",
      reason: "operator must approve external apply",
      allowedActions: ["approve", "reject"],
      recommendedAction: "approve",
      policyEnvelope: []
    },
    { now: 13 }
  );
}

describe("momentum workflow run logs", () => {
  it("advertises the command in top-level help", async () => {
    const result = await run(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "momentum workflow run logs <run-id> [--data-dir <path>] [--json]"
    );
    expect(result.stderr).toBe("");
  });

  it("requires <run-id>", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "run",
      "logs",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run logs",
      code: "run_id_required"
    });
  });

  it("returns run_not_found for an unknown run-id", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "run",
      "logs",
      "cwfp-missing",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run logs",
      code: "run_not_found",
      runId: "cwfp-missing"
    });
  });

  it("returns data_dir_failed when the database cannot be opened", async () => {
    const dataDir = path.join(makeTempDir(), "not-a-directory");
    fs.writeFileSync(dataDir, "not a directory");

    const result = await run([
      "workflow",
      "run",
      "logs",
      "cwfp-db-failed",
      "--data-dir",
      dataDir,
      "--json"
    ]);

    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      command: "workflow run logs",
      code: "data_dir_failed",
      dataDir,
      runId: "cwfp-db-failed"
    });
  });

  it("rejects an unexpected positional argument", async () => {
    const dataDir = makeTempDir();
    const result = await run([
      "workflow",
      "run",
      "logs",
      "cwfp-x",
      "extra",
      "--data-dir",
      dataDir
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      "Unexpected argument for workflow run logs: extra"
    );
  });

  it("emits a machine-readable logs envelope with run, steps, and executor rounds", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRunWithRound(db, "cwfp-logs01");
      seedRunDetailCategories(db, "cwfp-logs01");
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "logs",
      "cwfp-logs01",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      command: string;
      schemaVersion: number;
      generatedAt: number;
      run: { runId: string; state: string };
      steps: Array<{ stepId: string }>;
      approvals: Array<{ boundary: string; actor: string | null }>;
      leases: Array<{ leaseKind: string; holder: string }>;
      gates: Array<{
        gateId: string;
        open: boolean;
        allowedActions: string[];
        recommendedActionPolicy: {
          action: string;
          authority: string;
          risk: string;
        };
      }>;
      invocations: Array<{
        invocationId: string;
        stepKey: string;
        executorFamily: string;
        attempt: number;
        state: string;
        startedAt: number | null;
        heartbeatAt: number | null;
        finishedAt: number | null;
      }>;
      rounds: Array<{
        roundId: string;
        summary: string | null;
        keyLearnings: string[];
        learnings: string[];
      nativeRoundEvidence: {
        schema: string;
        summary: string | null;
        keyChanges: string[];
        learnings: string[];
        completionRecommendation: string;
        daemonClassification: string | null;
        verificationResult: {
          status: string;
          commands: unknown[];
        };
          artifacts: Array<{
            class: string;
            path: string;
            digest: string | null;
          }>;
          checkpoints: Array<{
            stage: string;
            detail: string | null;
          }>;
          changedFiles: string[];
          commitSha: string | null;
          recoveryReason: string | null;
          remainingWork: string[];
        };
        verificationStatus: string | null;
        commitSha: string | null;
        recoveryCode: string | null;
        recoveryReason: string | null;
        logPaths: string[];
        changedFiles: string[];
        artifacts: ExecutorArtifactRecord[];
        checkpoints: ExecutorCheckpointRecord[];
        findings: ExecutorFindingRecord[];
        decisions: ExecutorDecisionRecord[];
      }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.command).toBe("workflow run logs");
    expect(payload.schemaVersion).toBe(1);
    expect(typeof payload.generatedAt).toBe("number");
    expect(payload.run.runId).toBe("cwfp-logs01");
    expect(payload.steps.map((s) => s.stepId)).toEqual(["implementation"]);
    expect(payload.approvals).toEqual([
      expect.objectContaining({
        boundary: "implementation",
        actor: "calvin"
      })
    ]);
    expect(payload.leases).toEqual([
      expect.objectContaining({
        leaseKind: "managed-step",
        holder: "worker-1"
      })
    ]);
    expect(payload.gates).toEqual([
      expect.objectContaining({
        gateId: "gate-open-1",
        open: true,
        allowedActions: ["approve", "reject"],
        recommendedActionPolicy: expect.objectContaining({
          action: "approval_decision",
          authority: "human_required",
          risk: "medium"
        })
      })
    ]);
    expect(payload.invocations).toEqual([
      expect.objectContaining({
        invocationId: "inv-1",
        stepKey: "implementation",
        executorFamily: "goal-loop",
        attempt: 1,
        state: "running",
        startedAt: 10,
        heartbeatAt: 10,
        finishedAt: null
      })
    ]);
    expect(payload.rounds).toHaveLength(1);
    const round = payload.rounds[0]!;
    expect(round.roundId).toBe("round-1");
    expect(round.summary).toBe("implemented the slice");
    expect(round.keyLearnings).toEqual([
      "operator readback needs durable learnings"
    ]);
    expect(round.learnings).toEqual([
      "operator readback needs durable learnings"
    ]);
    expect(round.nativeRoundEvidence).toEqual({
      schema: "momentum.native-goal-loop.round-result.v1",
      summary: "implemented the slice",
      keyChanges: ["added reader"],
      learnings: ["operator readback needs durable learnings"],
      completionRecommendation: "complete",
      daemonClassification: "complete",
      verificationResult: {
        status: "passed",
        commands: [
          {
            command: "pnpm test",
            exitCode: 0,
            durationMs: 1200,
            timedOut: false
          }
        ]
      },
      artifacts: [
        {
          class: "verification_output",
          path: "/runs/cwfp-logs01/round-1/verify.txt",
          digest: "sha256:verify"
        }
      ],
      checkpoints: [
        {
          stage: "verify",
          detail: "pnpm test passed"
        }
      ],
      changedFiles: ["src/core/workflow/run/logs.ts"],
      commitSha: "abc123",
      recoveryReason: null,
      remainingWork: ["wire additional consumers"]
    });
    expect(round.verificationStatus).toBe("passed");
    expect(round.commitSha).toBe("abc123");
    expect(round.recoveryCode).toBeNull();
    expect(round.recoveryReason).toBeNull();
    expect(round.logPaths).toEqual(["/runs/cwfp-logs01/round-1/agent.log"]);
    expect(round.changedFiles).toEqual(["src/core/workflow/run/logs.ts"]);
    expect(round.artifacts).toEqual([makeArtifact("cwfp-logs01")]);
    expect(round.checkpoints).toEqual([makeCheckpoint()]);
    expect(round.findings).toEqual([makeFinding()]);
    expect(round.decisions).toEqual([makeDecision()]);
  });

  it("projects queryable native round outcomes from durable round evidence", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-logs-outcomes";
    const db = openDb(dataDir);
    try {
      db.prepare(
        `INSERT INTO workflow_runs
           (id, state, source, plan_json, objective, issue_scope_json, route_json,
            needs_manual_recovery, created_at, updated_at)
           VALUES (?, 'running', 'agent-workflow', '{}', 'logs read-back', '{}', '{}', 0, 1, 1)`
      ).run(runId);
      db.prepare(
        `INSERT INTO workflow_steps
           (run_id, step_id, kind, state, step_order, required, created_at, updated_at)
           VALUES (?, 'implementation', 'implementation', 'running', 1, 1, 1, 1)`
      ).run(runId);
      insertExecutorInvocation(db, makeInvocation(runId), { now: 1 });

      const cases: Array<
        [
          string,
          Partial<ExecutorRoundRecord>,
          | "successful"
          | "failed"
          | "no_op"
          | "invalid_result"
          | "verification_failed"
          | "manual_recovery"
          | "operator_decision_required"
        ]
      > = [
        [
          "successful",
          {
            state: "succeeded",
            classification: "complete",
            commitSha: "abc123",
            verificationStatus: "passed"
          },
          "successful"
        ],
        [
          "failed",
          {
            state: "failed",
            classification: "continue",
            commitSha: null,
            verificationStatus: null
          },
          "failed"
        ],
        [
          "no-op",
          {
            state: "manual_recovery_required",
            classification: "manual_recovery_required",
            commitSha: null,
            verificationStatus: "skipped",
            recoveryCode: "nothing_to_commit",
            humanGate: "manual_recovery_required"
          },
          "no_op"
        ],
        [
          "invalid-result",
          {
            state: "manual_recovery_required",
            classification: "manual_recovery_required",
            commitSha: null,
            verificationStatus: null,
            recoveryCode: "result_invalid",
            humanGate: "manual_recovery_required"
          },
          "invalid_result"
        ],
        [
          "verification-failed",
          {
            state: "failed",
            classification: "continue",
            commitSha: null,
            verificationStatus: "failed"
          },
          "verification_failed"
        ],
        [
          "manual-recovery",
          {
            state: "manual_recovery_required",
            classification: "manual_recovery_required",
            commitSha: null,
            verificationStatus: null,
            recoveryCode: "head_mismatch",
            humanGate: "manual_recovery_required"
          },
          "manual_recovery"
        ],
        [
          "manual-recovery-after-verification-failed",
          {
            state: "manual_recovery_required",
            classification: "manual_recovery_required",
            commitSha: null,
            verificationStatus: "failed",
            recoveryCode: "reset_failed",
            humanGate: "manual_recovery_required"
          },
          "manual_recovery"
        ],
        [
          "operator-gated-after-progress",
          {
            state: "succeeded",
            classification: "operator_decision_required",
            commitSha: "abc123",
            verificationStatus: "passed",
            humanGate: "quota_exhausted"
          },
          "operator_decision_required"
        ]
      ];

      cases.forEach(([id, overrides], index) => {
        insertExecutorRound(
          db,
          makeRound(runId, {
            roundId: `round-${id}`,
            roundIndex: index,
            summary: id,
            changedFiles: [],
            ...overrides
          }),
          { now: index + 1 }
        );
      });
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "logs",
      runId,
      "--data-dir",
      dataDir,
      "--json"
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      rounds: Array<{ summary: string | null; outcome: string }>;
    };
    expect(payload.rounds.map((round) => [round.summary, round.outcome])).toEqual(
      [
        ["successful", "successful"],
        ["failed", "failed"],
        ["no-op", "no_op"],
        ["invalid-result", "invalid_result"],
        ["verification-failed", "verification_failed"],
        ["manual-recovery", "manual_recovery"],
        [
          "manual-recovery-after-verification-failed",
          "manual_recovery"
        ],
        [
          "operator-gated-after-progress",
          "operator_decision_required"
        ]
      ]
    );
  });

  it("keeps executor recommendation separate from gated classification", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-logs-gated";
    const db = openDb(dataDir);
    try {
      db.prepare(
        `INSERT INTO workflow_runs
           (id, state, source, plan_json, objective, issue_scope_json, route_json,
            needs_manual_recovery, created_at, updated_at)
           VALUES (?, 'running', 'agent-workflow', '{}', 'logs read-back', '{}', '{}', 0, 1, 1)`
      ).run(runId);
      db.prepare(
        `INSERT INTO workflow_steps
           (run_id, step_id, kind, state, step_order, required, created_at, updated_at)
           VALUES (?, 'implementation', 'implementation', 'running', 1, 1, 1, 1)`
      ).run(runId);
      insertExecutorInvocation(db, makeInvocation(runId), { now: 1 });
      insertExecutorRound(
        db,
        makeRound(runId, {
          classification: "operator_decision_required",
          humanGate: "quota_exhausted",
          commitSha: "abc123",
          verificationStatus: "passed"
        }),
        { now: 1 }
      );
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "logs",
      runId,
      "--data-dir",
      dataDir,
      "--json"
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      rounds: Array<{
        outcome: string;
        nativeRoundEvidence: {
          completionRecommendation: string;
          daemonClassification: string | null;
        };
      }>;
    };
    expect(payload.rounds[0]).toMatchObject({
      outcome: "operator_decision_required",
      nativeRoundEvidence: {
        completionRecommendation: "continue",
        daemonClassification: "operator_decision_required"
      }
    });
  });

  it("renders text output with schema version and round log lines", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRunWithRound(db, "cwfp-logs-text");
      seedRunDetailCategories(db, "cwfp-logs-text");
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "logs",
      "cwfp-logs-text",
      "--data-dir",
      dataDir
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Workflow run logs: cwfp-logs-text");
    expect(result.stdout).toContain("Schema version: 1");
    expect(result.stdout).toContain("round-1");
    expect(result.stdout).toContain("implemented the slice");
    expect(result.stdout).toContain("key changes: added reader");
    expect(result.stdout).toContain(
      "learnings: operator readback needs durable learnings"
    );
    expect(result.stdout).toContain("remaining work: wire additional consumers");
    expect(result.stdout).toContain(
      "verification commands: pnpm test (exit=0, duration=1200ms, timedOut=false)"
    );
    expect(result.stdout).toContain("input digest: in-1");
    expect(result.stdout).toContain("result digest: res-1");
    expect(result.stdout).toContain("Executor invocations: 1");
    expect(result.stdout).toContain(
      "- inv-1 [implementation/running] attempt=1"
    );
    expect(result.stdout).toContain("Approvals: 1");
    expect(result.stdout).toContain("Leases: 1");
    expect(result.stdout).toContain("Gates: 1 (open: 1)");
    expect(result.stdout).toContain("gate-open-1");
  });

  it("renders the selected implementation engine in text readback when route evidence exists", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedRunWithRound(db, "cwfp-logs-engine");
      db.prepare(
        "UPDATE workflow_runs SET route_json = ? WHERE id = ?"
      ).run(
        JSON.stringify({ implementationEngine: "native-goal-loop" }),
        "cwfp-logs-engine"
      );
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "logs",
      "cwfp-logs-engine",
      "--data-dir",
      dataDir
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Implementation engine: native-goal-loop");
  });
});
