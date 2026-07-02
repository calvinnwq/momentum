import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/cli.js";
import { openDb, type MomentumDb } from "../src/adapters/db.js";
import { MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE } from "../src/core/workflow/run/start.js";
import {
  WORKFLOW_MONITOR_DISPOSITIONS,
  WORKFLOW_MONITOR_REPORT_REASONS
} from "../src/core/workflow/monitor/envelope.js";
import {
  WORKFLOW_MONITOR_CLEANUP_ACTIONS,
  WORKFLOW_MONITOR_PROGRESS_PHASES
} from "../src/core/workflow/monitor/progress.js";
import { WORKFLOW_MONITOR_NEXT_ACTION_CODES } from "../src/core/workflow/monitor/state.js";
import {
  WORKFLOW_WATCH_HUMAN_ACTION_CODES,
  WORKFLOW_WATCH_RECOMMENDED_ACTIONS,
  WORKFLOW_WATCH_STUCK_RISKS
} from "../src/renderers/workflow.js";
import { WORKFLOW_WATCH_REASONS } from "../src/core/workflow/monitor/watch-advisory.js";

type WorkflowGuiWatchContractFixture = {
  watch: {
    envelopeKeys: string[];
    scenarioKeys: {
      activeStep: string[];
      nextAction: string[];
      humanAction: string[];
      recommendedActionPolicy: string[];
    };
    scenarios: Record<
      string,
      {
        emit: boolean;
        reason: string;
        disposition: string;
        phase: string;
        recommendedAction: string;
        recommendedActionPolicy: {
          action: string;
          authority: string;
          risk: string;
        };
        nextPollSeconds: number;
        quietForSeconds?: number;
        quietThresholdSeconds: number;
        stuckRisk: string;
        cleanup: string;
        inspectionCommand?: string | null;
        activeStep?: { [key: string]: unknown } | null;
        nextAction?: { [key: string]: unknown };
        humanAction?: { [key: string]: unknown } | null;
        nextActionCode?: string;
        quietForSecondsMin?: number;
      }
    >;
    nextActionCodes: string[];
    humanActionCodes: string[];
    recommendedActions: string[];
    dispositions: string[];
    phases: string[];
    reasons: string[];
    recommendedActionPolicy: {
      authority: string[];
      risk: string[];
      stuckRisk: string[];
    };
  };
};

const WATCH_CONTRACT = JSON.parse(
  fs.readFileSync(
    path.join(process.cwd(), "test/fixtures/workflow-gui-contract.json"),
    "utf-8"
  )
) as WorkflowGuiWatchContractFixture;

/**
 * Frozen supervisor-envelope contract for `workflow run watch --once --json`
 * (NGX-549 / SUP-02).
 *
 * The supervisor envelope is the wire contract OpenClaw, cron, and a future GUI
 * consume. These tests freeze the envelope so a downstream adapter never has to
 * scrape prose or infer behaviour from terminal output:
 *
 * - the exact top-level field set is pinned, so a required field disappearing
 *   (or an undocumented field appearing) fails the build;
 * - every enum-typed field is constrained to its frozen value set, so an enum
 *   value drifting silently fails the build;
 * - the core contract scenarios (unchanged tick, progress tick, approval
 *   required, recovery required, idle risk, terminal success, and
 *   terminal/recoverable failure) are pinned to their machine-facing
 *   disposition and human-facing action.
 *
 * Behavioural coverage of the dispatcher tick itself lives in
 * `test/workflow-watch.test.ts`; this file owns the shape contract only.
 */

type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

const tempRoots: string[] = [];

const SEED_NOW = 1_730_000_000_000;
const FRESH_EXPIRY = 9_999_999_999_999;

const WATCH_ENVELOPE_KEYS = WATCH_CONTRACT.watch.envelopeKeys.slice().sort();

const WATCH_NEXT_ACTION_KEYS =
  WATCH_CONTRACT.watch.scenarioKeys.nextAction.slice().sort();
const WATCH_ACTIVE_STEP_KEYS =
  WATCH_CONTRACT.watch.scenarioKeys.activeStep.slice().sort();
const WATCH_HUMAN_ACTION_KEYS =
  WATCH_CONTRACT.watch.scenarioKeys.humanAction.slice().sort();
const WATCH_RECOMMENDED_ACTION_POLICY_KEYS =
  WATCH_CONTRACT.watch.scenarioKeys.recommendedActionPolicy.slice().sort();
const WATCH_MONITOR_REASONS = WATCH_CONTRACT.watch.reasons.filter(
  (reason) => reason !== "quiet_heartbeat" && reason !== "stuck_risk"
);

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "momentum-watch-contract-")
  );
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

async function run(
  argv: string[],
  env: Record<string, string | undefined> = {}
): Promise<RunResult> {
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
    env
  });
  return { code, stdout, stderr };
}

function seedRun(
  db: MomentumDb,
  input: {
    runId: string;
    state: string;
    needsManualRecovery?: boolean;
    manualRecoveryReason?: string | null;
  }
): void {
  db.prepare(
    `INSERT INTO workflow_runs
       (id, state, source, source_artifact_path, plan_json,
        repo_path, objective, issue_scope_json, route_json,
        approval_boundary, skill_revision,
        needs_manual_recovery, manual_recovery_reason, manual_recovery_at,
        started_at, finished_at,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.runId,
    input.state,
    MOMENTUM_NATIVE_CODING_WORKFLOW_SOURCE,
    null,
    "{}",
    null,
    null,
    "{}",
    "{}",
    null,
    null,
    input.needsManualRecovery ? 1 : 0,
    input.manualRecoveryReason ?? null,
    input.needsManualRecovery ? SEED_NOW : null,
    null,
    input.state === "succeeded" ? SEED_NOW + 1 : null,
    SEED_NOW,
    SEED_NOW
  );
}

function seedStep(
  db: MomentumDb,
  input: {
    runId: string;
    stepId: string;
    kind: string;
    state: string;
    order: number;
  }
): void {
  db.prepare(
    `INSERT INTO workflow_steps
       (run_id, step_id, kind, state, step_order, required,
        ledger_offset, result_digest, error_code, error_message,
        started_at, finished_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.runId,
    input.stepId,
    input.kind,
    input.state,
    input.order,
    1,
    null,
    null,
    null,
    null,
    input.state === "succeeded" ? SEED_NOW : null,
    input.state === "succeeded" ? SEED_NOW + 1 : null,
    SEED_NOW,
    SEED_NOW
  );
}

function seedLease(
  db: MomentumDb,
  input: { runId: string; expiresAt: number }
): void {
  db.prepare(
    `INSERT INTO workflow_leases
       (run_id, lease_kind, holder, acquired_at, expires_at, heartbeat_at,
        released_at, stale_policy, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.runId,
    "managed-step",
    `holder:${input.runId}`,
    1_000,
    input.expiresAt,
    1_000,
    null,
    "auto-release",
    SEED_NOW,
    SEED_NOW
  );
}

async function watchOnce(
  dataDir: string,
  runId: string
): Promise<Record<string, unknown>> {
  const result = await run([
    "workflow",
    "run",
    "watch",
    runId,
    "--once",
    "--data-dir",
    dataDir,
    "--json"
  ]);
  expect(result.code, `stderr: ${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function isMember(frozen: readonly string[], value: unknown): boolean {
  return typeof value === "string" && frozen.includes(value);
}

function expectedHumanActionCommand(template: unknown, runId: string): unknown {
  return typeof template === "string"
    ? template.replaceAll("${runId}", runId)
    : template;
}

function expectedInspectionCommand(
  template: unknown,
  runId: string,
  dataDir: string | undefined
): unknown {
  if (typeof template !== "string") return template;
  if (template.includes("${dataDir}") && dataDir === undefined) {
    throw new Error("Missing dataDir for inspection command fixture");
  }
  return template
    .replaceAll("${runId}", shellQuote(runId))
    .replaceAll("${dataDir}", shellQuote(dataDir ?? ""));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Assert the envelope's frozen shape: stable header, exact key set, and every
 * enum-typed field constrained to its frozen value set. Returns the payload so
 * callers can chain scenario-specific assertions.
 */
function assertWatchEnvelopeContract(
  payload: Record<string, unknown>,
  runId: string
): void {
  expect(Object.keys(payload).sort()).toEqual(WATCH_ENVELOPE_KEYS);

  expect(payload["ok"]).toBe(true);
  expect(payload["command"]).toBe("workflow run watch");
  expect(payload["mode"]).toBe("once");
  expect(payload["runId"]).toBe(runId);
  expect(payload["schemaVersion"]).toBe(1);
  expect(typeof payload["generatedAt"]).toBe("number");
  expect(typeof payload["dataDir"]).toBe("string");
  expect(typeof payload["runState"]).toBe("string");
  expect(typeof payload["emit"]).toBe("boolean");

  expect(isMember(WORKFLOW_WATCH_REASONS, payload["reason"])).toBe(true);
  expect(isMember(WORKFLOW_MONITOR_DISPOSITIONS, payload["disposition"])).toBe(
    true
  );
  expect(isMember(WORKFLOW_MONITOR_PROGRESS_PHASES, payload["phase"])).toBe(
    true
  );
  expect(isMember(WORKFLOW_MONITOR_CLEANUP_ACTIONS, payload["cleanup"])).toBe(
    true
  );
  expect(
    isMember(WORKFLOW_WATCH_RECOMMENDED_ACTIONS, payload["recommendedAction"])
  ).toBe(true);
  const recommendedActionPolicy = payload[
    "recommendedActionPolicy"
  ] as Record<string, unknown>;
  expect(Object.keys(recommendedActionPolicy).sort()).toEqual(
    WATCH_RECOMMENDED_ACTION_POLICY_KEYS
  );
  expect(typeof recommendedActionPolicy["action"]).toBe("string");
  expect(typeof recommendedActionPolicy["authority"]).toBe("string");
  expect(typeof recommendedActionPolicy["risk"]).toBe("string");
  expect(Array.isArray(recommendedActionPolicy["evidenceRequired"])).toBe(true);
  expect(typeof recommendedActionPolicy["rollback"]).toBe("string");
  expect(typeof recommendedActionPolicy["rationale"]).toBe("string");
  expect(isMember(WORKFLOW_WATCH_STUCK_RISKS, payload["stuckRisk"])).toBe(true);

  expect([0, 15, 30]).toContain(payload["nextPollSeconds"]);
  expect(typeof payload["quietForSeconds"]).toBe("number");
  expect(typeof payload["quietThresholdSeconds"]).toBe("number");
  expect(
    payload["inspectionCommand"] === null ||
      typeof payload["inspectionCommand"] === "string"
  ).toBe(true);
  expect(typeof payload["digest"]).toBe("string");
  expect((payload["digest"] as string).startsWith("sha256:")).toBe(true);

  const nextAction = payload["nextAction"] as Record<string, unknown>;
  expect(Object.keys(nextAction).sort()).toEqual(WATCH_NEXT_ACTION_KEYS);
  expect(isMember(WORKFLOW_MONITOR_NEXT_ACTION_CODES, nextAction["code"])).toBe(
    true
  );

  const activeStep = payload["activeStep"];
  if (activeStep !== null) {
    expect(Object.keys(activeStep as Record<string, unknown>).sort()).toEqual(
      WATCH_ACTIVE_STEP_KEYS
    );
  }

  const humanAction = payload["humanAction"];
  if (humanAction !== null) {
    const human = humanAction as Record<string, unknown>;
    expect(Object.keys(human).sort()).toEqual(WATCH_HUMAN_ACTION_KEYS);
    expect(isMember(WORKFLOW_WATCH_HUMAN_ACTION_CODES, human["code"])).toBe(
      true
    );
    expect(typeof human["command"]).toBe("string");
  }
}

function assertWatchScenario(
  payload: Record<string, unknown>,
  runId: string,
  scenarioName: string,
  dataDir?: string
): void {
  const scenario = WATCH_CONTRACT.watch.scenarios[scenarioName];
  if (scenario === undefined) {
    throw new Error(`Missing fixture scenario ${scenarioName}`);
  }

  assertWatchEnvelopeContract(payload, runId);
  expect(payload["emit"]).toBe(scenario.emit);
  expect(payload["reason"]).toBe(scenario.reason);
  expect(payload["disposition"]).toBe(scenario.disposition);
  expect(payload["phase"]).toBe(scenario.phase);
  expect(payload["recommendedAction"]).toBe(scenario.recommendedAction);
  expect(payload["nextPollSeconds"]).toBe(scenario.nextPollSeconds);
  if (scenario.quietForSeconds !== undefined) {
    expect(payload["quietForSeconds"]).toBe(scenario.quietForSeconds);
  } else if (scenario.quietForSecondsMin !== undefined) {
    expect(payload["quietForSeconds"] as number).toBeGreaterThanOrEqual(
      scenario.quietForSecondsMin
    );
  } else {
    expect(typeof payload["quietForSeconds"]).toBe("number");
  }
  expect(payload["quietThresholdSeconds"]).toBe(scenario.quietThresholdSeconds);
  expect(payload["stuckRisk"]).toBe(scenario.stuckRisk);
  expect(payload["cleanup"]).toBe(scenario.cleanup);
  if (scenario.inspectionCommand !== undefined) {
    expect(payload["inspectionCommand"]).toBe(
      expectedInspectionCommand(scenario.inspectionCommand, runId, dataDir)
    );
  }
  expect(payload["recommendedActionPolicy"]).toMatchObject(
    scenario.recommendedActionPolicy
  );

  if (scenario.activeStep === null) {
    expect(payload["activeStep"]).toBeNull();
  } else if (scenario.activeStep !== undefined) {
    expect(payload["activeStep"]).toMatchObject(scenario.activeStep);
  }

  if (scenario.nextActionCode !== undefined) {
    const nextAction = payload["nextAction"] as Record<string, unknown>;
    expect(nextAction["code"]).toBe(scenario.nextActionCode);
  } else if (scenario.nextAction !== undefined) {
    expect(payload["nextAction"]).toMatchObject(scenario.nextAction);
  }

  if (scenario.humanAction === null) {
    expect(payload["humanAction"]).toBeNull();
  } else if (scenario.humanAction !== undefined) {
    const humanAction = payload["humanAction"] as Record<string, unknown>;
    if ("code" in scenario.humanAction) {
      expect(humanAction["code"]).toBe(scenario.humanAction["code"]);
    }
    if ("detail" in scenario.humanAction) {
      expect(humanAction["detail"]).toBe(scenario.humanAction["detail"]);
    }
    if ("command" in scenario.humanAction) {
      expect(humanAction["command"]).toBe(
        expectedHumanActionCommand(scenario.humanAction["command"], runId)
      );
    }
  }
}

describe("workflow run watch supervisor envelope contract", () => {
  it("freezes the supervisor enum vocabularies so a value cannot drift silently", () => {
    expect([...WORKFLOW_MONITOR_REPORT_REASONS]).toEqual(WATCH_MONITOR_REASONS);
    expect([...WORKFLOW_MONITOR_DISPOSITIONS]).toEqual(
      WATCH_CONTRACT.watch.dispositions
    );
    expect([...WORKFLOW_MONITOR_PROGRESS_PHASES]).toEqual([
      "advancing",
      "idle",
      "awaiting_approval",
      "blocked",
      "terminal"
    ]);
    expect([...WORKFLOW_MONITOR_CLEANUP_ACTIONS]).toEqual(["none", "release"]);
    expect([...WORKFLOW_WATCH_RECOMMENDED_ACTIONS]).toEqual(
      WATCH_CONTRACT.watch.recommendedActions
    );
    expect([...WORKFLOW_WATCH_STUCK_RISKS]).toEqual(
      WATCH_CONTRACT.watch.recommendedActionPolicy.stuckRisk
    );
    expect([...WORKFLOW_WATCH_HUMAN_ACTION_CODES]).toEqual([
      "approve",
      "resolve_gate",
      "clear_recovery"
    ]);
    expect([...WORKFLOW_WATCH_REASONS]).toEqual(WATCH_CONTRACT.watch.reasons);
    expect([...WORKFLOW_MONITOR_NEXT_ACTION_CODES]).toEqual(
      WATCH_CONTRACT.watch.nextActionCodes
    );
  });

  it("progress tick: an advancing run reports a pollable machine update with no human action", async () => {
    const dataDir = makeTempDir();
    const runId = "mwf-contract-progress";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "running" });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "running",
        order: 1
      });
      seedLease(db, { runId, expiresAt: FRESH_EXPIRY });
    } finally {
      db.close();
    }

    const payload = await watchOnce(dataDir, runId);
    assertWatchScenario(payload, runId, "progress");
    expect(payload["nextAction"]).toMatchObject({
      code: "resume_running",
      stepId: "implementation"
    });
  });

  it("unchanged tick: a repeated identical tick suppresses emit while the digest holds steady", async () => {
    const dataDir = makeTempDir();
    const runId = "mwf-contract-unchanged";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "running" });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "running",
        order: 1
      });
      seedLease(db, { runId, expiresAt: FRESH_EXPIRY });
    } finally {
      db.close();
    }

    const first = await watchOnce(dataDir, runId);
    const second = await watchOnce(dataDir, runId);
    assertWatchScenario(first, runId, "progress");
    assertWatchEnvelopeContract(second, runId);

    expect(first).toMatchObject({ emit: true, quietForSeconds: 0 });
    expect(second).toMatchObject({ emit: false, quietForSeconds: 0 });
    expect(second["digest"]).toBe(first["digest"]);
    // The machine-polling signal (emit) flips while the human-facing reason is
    // unchanged, so a consumer suppresses a duplicate update without re-reading.
    expect(second["reason"]).toBe(first["reason"]);
  });

  it("approval required: an approval-gated tick recommends the approve command", async () => {
    const dataDir = makeTempDir();
    const runId = "mwf-contract-approval";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "pending" });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "pending",
        order: 1
      });
    } finally {
      db.close();
    }

    const payload = await watchOnce(dataDir, runId);
    assertWatchScenario(payload, runId, "approval");
  });

  it("recovery required: a durable manual-recovery tick recommends clear-recovery", async () => {
    const dataDir = makeTempDir();
    const runId = "mwf-contract-recovery";
    const db = openDb(dataDir);
    try {
      seedRun(db, {
        runId,
        state: "running",
        needsManualRecovery: true,
        manualRecoveryReason: "dispatch lease requires operator recovery"
      });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "approved",
        order: 1
      });
    } finally {
      db.close();
    }

    const payload = await watchOnce(dataDir, runId);
    assertWatchScenario(payload, runId, "manualRecovery");
  });

  it("stuck risk: an idle run with no active step reports medium stuck risk and keeps polling", async () => {
    const dataDir = makeTempDir();
    const runId = "mwf-contract-idle";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "running" });
    } finally {
      db.close();
    }

    const payload = await watchOnce(dataDir, runId);
    assertWatchScenario(payload, runId, "idle");
  });

  it("terminal canceled: a canceled run signals terminal cleanup", async () => {
    const dataDir = makeTempDir();
    const runId = "mwf-contract-terminal-canceled";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "canceled" });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "canceled",
        order: 1
      });
    } finally {
      db.close();
    }

    const payload = await watchOnce(dataDir, runId);
    assertWatchScenario(payload, runId, "terminalCanceled");
  });

  it("terminal success: a clean terminal run signals release and stops polling", async () => {
    const dataDir = makeTempDir();
    const runId = "mwf-contract-terminal-success";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "succeeded" });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "succeeded",
        order: 1
      });
    } finally {
      db.close();
    }

    const payload = await watchOnce(dataDir, runId);
    assertWatchScenario(payload, runId, "terminalSuccess");
  });

  it("recoverable failure: a failed required step recovers via operator decision and keeps polling", async () => {
    const dataDir = makeTempDir();
    const runId = "mwf-contract-failed";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "failed" });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "failed",
        order: 1
      });
    } finally {
      db.close();
    }

    const payload = await watchOnce(dataDir, runId);
    assertWatchScenario(payload, runId, "failedRecovery");
  });

  it("stuck-risk advisory: unchanged active execution emits an inspection reminder", async () => {
    const dataDir = makeTempDir();
    const runId = "mwf-contract-stuck-risk";
    const db = openDb(dataDir);
    try {
      seedRun(db, { runId, state: "running" });
      seedStep(db, {
        runId,
        stepId: "implementation",
        kind: "implementation",
        state: "running",
        order: 1
      });
      seedLease(db, { runId, expiresAt: FRESH_EXPIRY });
    } finally {
      db.close();
    }

    const first = await watchOnce(dataDir, runId);
    const staleDb = openDb(dataDir);
    try {
      const digest = first["digest"] as string;
      staleDb
        .prepare(
          `UPDATE workflow_runs
             SET monitor_last_seen_digest = ?,
                 monitor_last_seen_at = 1,
                 monitor_last_emitted_digest = ?,
           monitor_last_emitted_at = 1
           WHERE id = ?`
        )
        .run(digest, digest, runId);
    } finally {
      staleDb.close();
    }

    const payload = await watchOnce(dataDir, runId);
    assertWatchScenario(payload, runId, "stuckRisk", dataDir);
  });
});
