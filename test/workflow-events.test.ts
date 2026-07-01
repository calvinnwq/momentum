import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/cli.js";
import { openDb, type MomentumDb } from "../src/adapters/db.js";
import { insertWorkflowGate, resolveWorkflowGate } from "../src/core/workflow/gate-persist.js";
import {
  clearWorkflowRunManualRecoveryGuarded,
  markWorkflowRunNeedsManualRecovery
} from "../src/core/workflow/run-recovery.js";
import {
  WORKFLOW_EVENT_TYPES,
  appendWorkflowEvent
} from "../src/core/workflow/events.js";

type WorkflowGuiEventsContractFixture = {
  events: {
    envelopeKeys: string[];
    eventKeys: string[];
    types: string[];
    cursorPrefix: string;
    replayPolicy: string;
  };
};

const EVENTS_CONTRACT = JSON.parse(
  fs.readFileSync(
    path.join(process.cwd(), "test/fixtures/workflow-gui-contract.json"),
    "utf-8"
  )
) as WorkflowGuiEventsContractFixture;

type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

const EVENT_ENVELOPE_KEYS = EVENTS_CONTRACT.events.envelopeKeys.slice().sort();
const EVENT_KEYS = EVENTS_CONTRACT.events.eventKeys.slice().sort();


type WorkflowEvent = {
  id: string;
  cursor: string;
  timestamp: number;
  type: string;
  stepId: string | null;
  payload: Record<string, unknown>;
};

type WorkflowEventsEnvelope = {
  ok: true;
  command: "workflow run events";
  dataDir: string;
  runId: string;
  since: string | null;
  cursor: string | null;
  events: WorkflowEvent[];
  counts: { events: number };
};

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-workflow-events-"): string {
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

async function readEvents(
  dataDir: string,
  runId: string,
  since?: string | null
): Promise<WorkflowEventsEnvelope> {
  const argv = [
    "workflow",
    "run",
    "events",
    runId,
    "--data-dir",
    dataDir,
    "--json"
  ];
  if (since !== undefined) {
    argv.push("--since", since ?? "");
  }
  const result = await run(argv);
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as WorkflowEventsEnvelope;
}

function assertWorkflowEventsEnvelopeContract(
  envelope: WorkflowEventsEnvelope
): void {
  expect(Object.keys(envelope).sort()).toEqual(EVENT_ENVELOPE_KEYS);
  expect(envelope.command).toBe("workflow run events");
  expect(typeof envelope.runId).toBe("string");
  expect(
    envelope.since === null || typeof envelope.since === "string"
  ).toBe(true);
  expect(envelope.cursor === null || envelope.cursor.startsWith(EVENTS_CONTRACT.events.cursorPrefix)).toBe(true);
  for (const event of envelope.events) {
    expect(Object.keys(event).sort()).toEqual(EVENT_KEYS);
    expect(typeof event.id).toBe("string");
    expect(event.id.length).toBeGreaterThan(0);
    expect(typeof event.cursor).toBe("string");
    expect(event.cursor.startsWith(EVENTS_CONTRACT.events.cursorPrefix)).toBe(true);
    expect(typeof event.timestamp).toBe("number");
    expect(typeof event.type).toBe("string");
    expect(EVENTS_CONTRACT.events.types).toContain(event.type);
  }
  if (envelope.events.length === 0) {
    expect(envelope.cursor).toBe(envelope.since);
  } else {
    expect(envelope.events.at(-1)?.cursor).toBe(envelope.cursor);
  }
  expect(envelope.counts.events).toBe(envelope.events.length);
}

function seedRun(
  db: MomentumDb,
  input: {
    runId: string;
    state?: string;
    startedAt?: number | null;
    finishedAt?: number | null;
    createdAt?: number;
    updatedAt?: number;
  }
): void {
  db.prepare(
    `INSERT INTO workflow_runs
       (id, state, source, plan_json, issue_scope_json, route_json,
        needs_manual_recovery, started_at, finished_at, created_at, updated_at)
       VALUES (?, ?, 'momentum-native-coding', '{}', '{}', '{}',
        0, ?, ?, ?, ?)`
  ).run(
    input.runId,
    input.state ?? "pending",
    input.startedAt ?? null,
    input.finishedAt ?? null,
    input.createdAt ?? 1,
    input.updatedAt ?? 1
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
    startedAt?: number | null;
    finishedAt?: number | null;
    createdAt?: number;
    updatedAt?: number;
    errorCode?: string | null;
    errorMessage?: string | null;
    resultDigest?: string | null;
  }
): void {
  db.prepare(
    `INSERT INTO workflow_steps
       (run_id, step_id, kind, state, step_order, required,
        ledger_offset, result_digest, error_code, error_message,
        started_at, finished_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.runId,
    input.stepId,
    input.kind,
    input.state,
    input.order,
    input.resultDigest ?? null,
    input.errorCode ?? null,
    input.errorMessage ?? null,
    input.startedAt ?? null,
    input.finishedAt ?? null,
    input.createdAt ?? 1,
    input.updatedAt ?? 1
  );
}

function seedWorkflowEvent(
  db: MomentumDb,
  input: {
    eventId: string;
    runId: string;
    type: string;
    timestamp: number;
    stepId?: string | null;
    payload?: Record<string, unknown>;
  }
): void {
  db.prepare(
    `INSERT INTO workflow_events
       (event_id, run_id, step_id, occurred_at, type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.eventId,
    input.runId,
    input.stepId ?? null,
    input.timestamp,
    input.type,
    JSON.stringify(input.payload ?? {}),
    input.timestamp
  );
}

describe("workflow run events", () => {
  it("freezes the GUI event vocabulary against the production tuple", () => {
    expect([...WORKFLOW_EVENT_TYPES]).toEqual(EVENTS_CONTRACT.events.types);
  });

  it("returns an empty deterministic event set for a run with no semantic transitions", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    seedRun(db, { runId: "run-empty" });
    db.close();

    const first = await readEvents(dataDir, "run-empty");
    const second = await readEvents(dataDir, "run-empty");

    assertWorkflowEventsEnvelopeContract(first);
    assertWorkflowEventsEnvelopeContract(second);
    expect(first).toEqual({
      ok: true,
      command: "workflow run events",
      dataDir,
      runId: "run-empty",
      since: null,
      cursor: null,
      events: [],
      counts: { events: 0 }
    });
    expect(second).toEqual(first);
  });

  it("replays initial durable workflow events in cursor order", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    seedRun(db, {
      runId: "run-replay",
      state: "succeeded",
      startedAt: 5,
      finishedAt: 80,
      updatedAt: 80
    });
    seedStep(db, {
      runId: "run-replay",
      stepId: "implementation",
      kind: "implementation",
      state: "succeeded",
      order: 1,
      startedAt: 10,
      finishedAt: 30,
      resultDigest: "sha256:implementation"
    });
    db.prepare(
      `INSERT INTO workflow_approvals
         (run_id, boundary, actor, phrase, artifact_path, artifact_digest,
          recorded_at, discharged_at, created_at, updated_at)
         VALUES ('run-replay', 'implementation', 'calvin',
          'approve implementation', '/approval.json', 'sha256:approval',
          40, NULL, 40, 40)`
    ).run();
    insertWorkflowGate(
      db,
      {
        gateId: "gate-1",
        workflowRunId: "run-replay",
        targetScope: "workflow",
        gateType: "approval_required",
        reason: "operator approval required",
        allowedActions: ["approve", "reject"],
        recommendedAction: "approve"
      },
      { now: 50 }
    );
    resolveWorkflowGate(
      db,
      "gate-1",
      { action: "approve", actor: "calvin", mode: "operator" },
      { now: 60 }
    );
    seedWorkflowEvent(db, {
      eventId: "000000000070:recovery_required:run-replay",
      runId: "run-replay",
      type: "recovery_required",
      timestamp: 70,
      payload: { reason: "manual inspection required" }
    });
    seedWorkflowEvent(db, {
      eventId: "000000000075:recovery_cleared:run-replay",
      runId: "run-replay",
      type: "recovery_cleared",
      timestamp: 75,
      payload: { previousReason: "manual inspection required" }
    });
    seedWorkflowEvent(db, {
      eventId: "000000000076:monitor_stuck_risk:run-replay",
      runId: "run-replay",
      type: "monitor_stuck_risk",
      timestamp: 76,
      stepId: "implementation",
      payload: { stuckRisk: "medium" }
    });
    db.close();

    const envelope = await readEvents(dataDir, "run-replay");

    assertWorkflowEventsEnvelopeContract(envelope);
    expect(envelope.since).toBeNull();
    expect(envelope.events.map((event) => event.type)).toEqual([
      "step_started",
      "step_succeeded",
      "approval_resolved",
      "approval_required",
      "gate_opened",
      "gate_resolved",
      "recovery_required",
      "recovery_cleared",
      "monitor_stuck_risk",
      "terminal_state"
    ]);
    for (const event of envelope.events) {
      expect(event.id.length).toBeGreaterThan(0);
      expect(event.cursor.length).toBeGreaterThan(0);
    }
    for (const eventType of envelope.events.map((event) => event.type)) {
      expect(EVENTS_CONTRACT.events.types).toContain(eventType);
    }
    expect(envelope.events.at(-1)).toMatchObject({
      timestamp: 80,
      type: "terminal_state",
      stepId: null,
      payload: { state: "succeeded" }
    });
    expect(envelope.cursor).toBe(envelope.events.at(-1)?.cursor);
    expect(envelope.counts.events).toBe(envelope.events.length);
  });

  it("replays terminal imported runs without a finished timestamp", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    seedRun(db, {
      runId: "run-imported-terminal",
      state: "succeeded",
      finishedAt: null,
      updatedAt: 95
    });
    db.close();

    const envelope = await readEvents(dataDir, "run-imported-terminal");

    assertWorkflowEventsEnvelopeContract(envelope);
    expect(envelope.events).toHaveLength(1);
    expect(envelope.events[0]).toMatchObject({
      timestamp: 95,
      type: "terminal_state",
      stepId: null,
      payload: { state: "succeeded" }
    });
    expect(envelope.cursor).toBe(envelope.events[0]?.cursor);
  });

  it("continues from the returned cursor without replaying earlier events", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    seedRun(db, { runId: "run-continue", state: "running", updatedAt: 20 });
    seedStep(db, {
      runId: "run-continue",
      stepId: "implementation",
      kind: "implementation",
      state: "running",
      order: 1,
      startedAt: 10
    });
    db.close();

    const first = await readEvents(dataDir, "run-continue");
    assertWorkflowEventsEnvelopeContract(first);
    expect(first.events.map((event) => event.type)).toEqual(["step_started"]);
    expect(first.cursor).toBe(first.events[0]?.cursor);

    const writeDb = openDb(dataDir);
    writeDb
      .prepare(
        `UPDATE workflow_steps
           SET state = 'failed', error_code = 'runner_failed',
               error_message = 'runner exited non-zero',
               finished_at = 25, updated_at = 25
         WHERE run_id = 'run-continue' AND step_id = 'implementation'`
      )
      .run();
    writeDb.close();

    const next = await readEvents(dataDir, "run-continue", first.cursor);
    assertWorkflowEventsEnvelopeContract(next);
    expect(next.since).toBe(first.cursor);
    expect(next.events.map((event) => event.type)).toEqual(["step_failed"]);
    expect(next.events[0]).toMatchObject({
      timestamp: 25,
      stepId: "implementation",
      payload: {
        kind: "implementation",
        errorCode: "runner_failed",
        errorMessage: "runner exited non-zero"
      }
    });
    expect(next.cursor).toBe(next.events[0]?.cursor);
  });

  it("orders same-timestamp step starts before terminal step events", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    seedRun(db, { runId: "run-same-timestamp-step", state: "failed", updatedAt: 10 });
    seedStep(db, {
      runId: "run-same-timestamp-step",
      stepId: "implementation",
      kind: "implementation",
      state: "failed",
      order: 1,
      startedAt: 10,
      finishedAt: 10,
      errorCode: "runner_failed",
      errorMessage: "runner exited non-zero"
    });
    db.close();

    const envelope = await readEvents(dataDir, "run-same-timestamp-step");
    assertWorkflowEventsEnvelopeContract(envelope);

    expect(envelope.events.map((event) => event.type)).toEqual([
      "step_started",
      "step_failed",
      "terminal_state"
    ]);
    expect(envelope.events.map((event) => event.timestamp)).toEqual([10, 10, 10]);
  });

  it("replays recovery reason changes while the run remains marked", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    seedRun(db, { runId: "run-recovery-remark", state: "blocked" });
    expect(
      markWorkflowRunNeedsManualRecovery(db, {
        runId: "run-recovery-remark",
        reason: "first recovery reason",
        now: 100
      })
    ).toEqual({ ok: true, previouslyMarked: false });
    db.close();

    const first = await readEvents(dataDir, "run-recovery-remark");
    assertWorkflowEventsEnvelopeContract(first);
    expect(first.events.map((event) => event.type)).toEqual([
      "recovery_required"
    ]);

    const writeDb = openDb(dataDir);
    expect(
      markWorkflowRunNeedsManualRecovery(writeDb, {
        runId: "run-recovery-remark",
        reason: "updated recovery reason",
        now: 200
      })
    ).toEqual({ ok: true, previouslyMarked: true });
    writeDb.close();

    const next = await readEvents(
      dataDir,
      "run-recovery-remark",
      first.cursor
    );
    assertWorkflowEventsEnvelopeContract(next);
    expect(next.events).toHaveLength(1);
    expect(next.events[0]).toMatchObject({
      type: "recovery_required",
      timestamp: 200,
      payload: {
        reason: "updated recovery reason",
        previousReason: "first recovery reason",
        previousMarkedAt: 100
      }
    });
  });

  it("does not replay idempotent recovery re-marks as new semantic events", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    seedRun(db, { runId: "run-recovery-idempotent", state: "blocked" });
    expect(
      markWorkflowRunNeedsManualRecovery(db, {
        runId: "run-recovery-idempotent",
        reason: "same recovery reason",
        now: 100
      })
    ).toEqual({ ok: true, previouslyMarked: false });
    db.close();

    const first = await readEvents(dataDir, "run-recovery-idempotent");
    assertWorkflowEventsEnvelopeContract(first);
    expect(first.events.map((event) => event.type)).toEqual([
      "recovery_required"
    ]);

    const writeDb = openDb(dataDir);
    expect(
      markWorkflowRunNeedsManualRecovery(writeDb, {
        runId: "run-recovery-idempotent",
        reason: "same recovery reason",
        now: 200
      })
    ).toEqual({ ok: true, previouslyMarked: true });
    writeDb.close();

    const next = await readEvents(
      dataDir,
      "run-recovery-idempotent",
      first.cursor
    );
    assertWorkflowEventsEnvelopeContract(next);
    expect(next.events).toEqual([]);
  });

  it("replays a blocked step transition after the step is approved again", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    seedRun(db, { runId: "run-blocked-transition", state: "approved" });
    seedStep(db, {
      runId: "run-blocked-transition",
      stepId: "implementation",
      kind: "implementation",
      state: "approved",
      order: 1
    });
    db.close();

    const blocked = await run([
      "workflow",
      "run",
      "update-step",
      "run-blocked-transition",
      "--step",
      "implementation",
      "--state",
      "blocked",
      "--reason",
      "waiting on external state",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(blocked.code, blocked.stderr).toBe(0);

    const approved = await run([
      "workflow",
      "run",
      "update-step",
      "run-blocked-transition",
      "--step",
      "implementation",
      "--state",
      "approved",
      "--reason",
      "external state resolved",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(approved.code, approved.stderr).toBe(0);

    const envelope = await readEvents(dataDir, "run-blocked-transition");
    assertWorkflowEventsEnvelopeContract(envelope);
    expect(envelope.events.map((event) => event.type)).toEqual([
      "step_blocked"
    ]);
    expect(envelope.events[0]).toMatchObject({
      stepId: "implementation",
      payload: {
        kind: "implementation",
        order: 1,
        required: true,
        reason: "waiting on external state",
        previousState: "approved"
      }
    });
  });

  it("projects blocked rows with persisted operator metadata", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    seedRun(db, { runId: "run-projected-blocked", state: "blocked" });
    seedStep(db, {
      runId: "run-projected-blocked",
      stepId: "implementation",
      kind: "implementation",
      state: "blocked",
      order: 1,
      updatedAt: 120
    });
    db.prepare(
      `UPDATE workflow_steps
          SET operator_reason = 'waiting on external state',
              operator_actor = 'calvin',
              operator_evidence_pointer = 'evidence://blocked',
              operator_ledger_pointer = 'ledger://blocked',
              operator_transition_at = 120
        WHERE run_id = 'run-projected-blocked'
          AND step_id = 'implementation'`
    ).run();
    db.close();

    const envelope = await readEvents(dataDir, "run-projected-blocked");
    assertWorkflowEventsEnvelopeContract(envelope);

    expect(envelope.events.map((event) => event.type)).toEqual([
      "step_blocked"
    ]);
    expect(envelope.events[0]).toMatchObject({
      stepId: "implementation",
      timestamp: 120,
      payload: {
        kind: "implementation",
        order: 1,
        required: true,
        reason: "waiting on external state",
        actor: "calvin",
        evidencePointer: "evidence://blocked",
        ledgerPointer: "ledger://blocked"
      }
    });
  });

  it("preserves a retry-cleared step start with stable identity", async () => {
    const dataDir = makeTempDir();
    const runId = "run-retry-start-preserved";
    const stepId = "no-mistakes";
    const invocationId = `${runId}::${stepId}::dispatch`;
    const db = openDb(dataDir);
    seedRun(db, {
      runId,
      state: "running",
      updatedAt: 200
    });
    seedStep(db, {
      runId,
      stepId,
      kind: "no-mistakes",
      state: "running",
      order: 3,
      startedAt: 100
    });
    markWorkflowRunNeedsManualRecovery(db, {
      runId,
      reason: "runtime_unavailable",
      now: 150
    });
    db.prepare(
      `INSERT INTO executor_invocations
         (invocation_id, workflow_run_id, step_run_id, step_key,
          executor_family, state, attempt, started_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      invocationId,
      runId,
      stepId,
      stepId,
      "no-mistakes",
      "manual_recovery_required",
      1,
      100,
      100,
      150
    );
    db.prepare(
      `INSERT INTO executor_rounds
         (round_id, invocation_id, workflow_run_id, step_run_id, step_key,
          executor_family, attempt, round_index, state, recovery_code,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      `${invocationId}::round-0`,
      invocationId,
      runId,
      stepId,
      stepId,
      "no-mistakes",
      1,
      0,
      "manual_recovery_required",
      "runtime_unavailable",
      100,
      150
    );
    db.close();

    const beforeClear = await readEvents(dataDir, runId);
    assertWorkflowEventsEnvelopeContract(beforeClear);
    const beforeStart = beforeClear.events.find(
      (event) => event.stepId === stepId && event.type === "step_started"
    );
    expect(beforeStart).toBeDefined();

    const writeDb = openDb(dataDir);
    const clear = clearWorkflowRunManualRecoveryGuarded(writeDb, {
      runId,
      now: 200
    });
    writeDb.close();
    expect(clear).toMatchObject({
      ok: true,
      retryPrepared: {
        stepId,
        recoveryCode: "runtime_unavailable"
      }
    });

    const fullReplay = await readEvents(dataDir, runId);
    assertWorkflowEventsEnvelopeContract(fullReplay);
    const afterStart = fullReplay.events.find(
      (event) => event.stepId === stepId && event.type === "step_started"
    );
    expect(afterStart?.id).toBe(beforeStart?.id);

    const catchup = await readEvents(dataDir, runId, beforeClear.cursor);
    assertWorkflowEventsEnvelopeContract(catchup);
    expect(
      catchup.events.some(
        (event) => event.stepId === stepId && event.type === "step_started"
      )
    ).toBe(false);
  });

  it("keeps repeated stored transitions with the same timestamp and payload", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    seedRun(db, { runId: "run-repeat-stored", state: "running" });
    appendWorkflowEvent(db, {
      runId: "run-repeat-stored",
      stepId: "implementation",
      type: "step_blocked",
      occurredAt: 100,
      payload: { reason: "external state missing" }
    });
    appendWorkflowEvent(db, {
      runId: "run-repeat-stored",
      stepId: "implementation",
      type: "step_blocked",
      occurredAt: 100,
      payload: { reason: "external state missing" }
    });
    db.close();

    const envelope = await readEvents(dataDir, "run-repeat-stored");
    assertWorkflowEventsEnvelopeContract(envelope);
    expect(envelope.events.map((event) => event.type)).toEqual([
      "step_blocked",
      "step_blocked"
    ]);
    expect(new Set(envelope.events.map((event) => event.id)).size).toBe(2);
    expect(envelope.events[0]?.payload).toEqual(envelope.events[1]?.payload);

    const next = await readEvents(dataDir, "run-repeat-stored", envelope.cursor);
    assertWorkflowEventsEnvelopeContract(next);
    expect(next.events).toEqual([]);
  });

  it("does not skip later inserted events that share the previous cursor timestamp", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    seedRun(db, {
      runId: "run-same-timestamp",
      state: "succeeded",
      finishedAt: 80,
      updatedAt: 80
    });
    db.close();

    const first = await readEvents(dataDir, "run-same-timestamp");
    assertWorkflowEventsEnvelopeContract(first);
    expect(first.events.map((event) => event.type)).toEqual([
      "terminal_state"
    ]);
    const terminalCursor = first.cursor;
    expect(terminalCursor).not.toBeNull();

    const writeDb = openDb(dataDir);
    seedWorkflowEvent(writeDb, {
      eventId: "0000000000080:monitor_stuck_risk:run-same-timestamp",
      runId: "run-same-timestamp",
      type: "monitor_stuck_risk",
      timestamp: 80,
      payload: { stuckRisk: "medium" }
    });
    writeDb.close();

    const next = await readEvents(dataDir, "run-same-timestamp", terminalCursor);
    assertWorkflowEventsEnvelopeContract(next);
    expect(next.events.map((event) => event.type)).toContain(
      "monitor_stuck_risk"
    );
    const quiesced = await readEvents(
      dataDir,
      "run-same-timestamp",
      next.cursor
    );
    assertWorkflowEventsEnvelopeContract(quiesced);
    expect(quiesced.events).toEqual([]);
  });

  it("advances to the highest replay cursor when stored and projected events share a timestamp", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    seedRun(db, {
      runId: "run-same-response",
      state: "succeeded",
      finishedAt: 80,
      updatedAt: 80
    });
    seedWorkflowEvent(db, {
      eventId: "0000000000080:monitor_stuck_risk:run-same-response",
      runId: "run-same-response",
      type: "monitor_stuck_risk",
      timestamp: 80,
      payload: { stuckRisk: "medium" }
    });
    db.close();

    const first = await readEvents(dataDir, "run-same-response");
    expect(first.events.map((event) => event.type)).toEqual([
      "monitor_stuck_risk",
      "terminal_state"
    ]);

    const next = await readEvents(dataDir, "run-same-response", first.cursor);
    expect(next.events).toEqual([]);
  });

  it("rereads deterministically from the same cursor", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    seedRun(db, { runId: "run-deterministic", state: "running", updatedAt: 40 });
    seedStep(db, {
      runId: "run-deterministic",
      stepId: "implementation",
      kind: "implementation",
      state: "failed",
      order: 1,
      startedAt: 10,
      finishedAt: 40,
      errorCode: "verification_failed",
      errorMessage: "pnpm test failed"
    });
    db.close();

    const first = await readEvents(dataDir, "run-deterministic");
    const reread = await readEvents(dataDir, "run-deterministic");

    expect(reread.cursor).toBe(first.cursor);
    expect(reread.events).toEqual(first.events);
  });

  it("rejects malformed current replay cursors", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    seedRun(db, { runId: "run-malformed-cursor", state: "running" });
    seedStep(db, {
      runId: "run-malformed-cursor",
      stepId: "implementation",
      kind: "implementation",
      state: "running",
      order: 1,
      startedAt: 10
    });
    db.close();

    const result = await run([
      "workflow",
      "run",
      "events",
      "run-malformed-cursor",
      "--since",
      "wfcur1.not-json",
      "--data-dir",
      dataDir,
      "--json"
    ]);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      command: "workflow run events",
      code: "invalid_cursor",
      dataDir,
      runId: "run-malformed-cursor"
    });
    expect(result.stdout).toBe("");
  });

  it("rejects arbitrary non-replay cursors instead of silently skipping events", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    seedRun(db, { runId: "run-legacy-cursor", state: "running" });
    seedStep(db, {
      runId: "run-legacy-cursor",
      stepId: "implementation",
      kind: "implementation",
      state: "running",
      order: 1,
      startedAt: 10
    });
    db.close();

    const result = await run([
      "workflow",
      "run",
      "events",
      "run-legacy-cursor",
      "--since",
      "zzz",
      "--data-dir",
      dataDir,
      "--json"
    ]);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      command: "workflow run events",
      code: "invalid_cursor",
      dataDir,
      runId: "run-legacy-cursor"
    });
    expect(result.stdout).toBe("");
  });

  it("returns a compact not-found error for missing workflow runs", async () => {
    const dataDir = makeTempDir();
    openDb(dataDir).close();

    const result = await run([
      "workflow",
      "run",
      "events",
      "missing-run",
      "--data-dir",
      dataDir,
      "--json"
    ]);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      command: "workflow run events",
      code: "run_not_found",
      dataDir,
      runId: "missing-run"
    });
    expect(result.stdout).toBe("");
  });

  it("returns not-found instead of crashing for pre-workflow databases", async () => {
    const root = makeTempDir();
    const dataDir = path.join(root, "legacy-data");
    fs.mkdirSync(dataDir);
    const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      db.exec(`
        CREATE TABLE events (
          id INTEGER PRIMARY KEY,
          goal_id TEXT NOT NULL,
          type TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at INTEGER NOT NULL
        ) STRICT;
      `);
    } finally {
      db.close();
    }

    const result = await run([
      "workflow",
      "run",
      "events",
      "missing-run",
      "--data-dir",
      dataDir,
      "--json"
    ]);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      command: "workflow run events",
      code: "run_not_found",
      dataDir,
      runId: "missing-run"
    });
    expect(result.stdout).toBe("");
  });

  it("does not create a missing data directory on read-only misses", async () => {
    const root = makeTempDir();
    const dataDir = path.join(root, "missing-data-dir");

    const result = await run([
      "workflow",
      "run",
      "events",
      "missing-run",
      "--data-dir",
      dataDir,
      "--json"
    ]);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      command: "workflow run events",
      code: "run_not_found",
      dataDir,
      runId: "missing-run"
    });
    expect(fs.existsSync(dataDir)).toBe(false);
  });

  it("replays reproducible events from a pre-workflow-events database", async () => {
    const root = makeTempDir();
    const dataDir = path.join(root, "legacy-data");
    fs.mkdirSync(dataDir);
    const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      db.exec(`
        CREATE TABLE workflow_runs (
          id TEXT PRIMARY KEY,
          state TEXT NOT NULL DEFAULT 'pending',
          source TEXT NOT NULL,
          plan_json TEXT NOT NULL DEFAULT '{}',
          issue_scope_json TEXT NOT NULL DEFAULT '{}',
          route_json TEXT NOT NULL DEFAULT '{}',
          needs_manual_recovery INTEGER NOT NULL DEFAULT 0,
          started_at INTEGER,
          finished_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE workflow_steps (
          run_id TEXT NOT NULL,
          step_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'pending',
          step_order INTEGER NOT NULL,
          required INTEGER NOT NULL DEFAULT 1,
          ledger_offset INTEGER,
          result_digest TEXT,
          error_code TEXT,
          error_message TEXT,
          started_at INTEGER,
          finished_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (run_id, step_id)
        ) STRICT;
        CREATE TABLE workflow_approvals (
          run_id TEXT NOT NULL,
          boundary TEXT NOT NULL,
          actor TEXT,
          phrase TEXT NOT NULL,
          artifact_path TEXT NOT NULL,
          artifact_digest TEXT NOT NULL,
          recorded_at INTEGER NOT NULL,
          discharged_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (run_id, boundary)
        ) STRICT;
        CREATE TABLE workflow_gates (
          gate_id TEXT PRIMARY KEY,
          workflow_run_id TEXT NOT NULL,
          step_run_id TEXT,
          invocation_id TEXT,
          round_id TEXT,
          target_scope TEXT NOT NULL,
          gate_type TEXT NOT NULL,
          reason TEXT NOT NULL,
          evidence TEXT,
          allowed_actions TEXT NOT NULL DEFAULT '[]',
          recommended_action TEXT,
          policy_envelope TEXT NOT NULL DEFAULT '[]',
          resolved_at INTEGER,
          resolved_by TEXT,
          resolution_mode TEXT,
          chosen_action TEXT,
          resolution TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
      `);
      db.prepare(
        `INSERT INTO workflow_runs
           (id, state, source, created_at, updated_at)
         VALUES ('legacy-run', 'running', 'momentum-native-coding', 1, 10)`
      ).run();
      db.prepare(
        `INSERT INTO workflow_steps
           (run_id, step_id, kind, state, step_order, started_at, created_at, updated_at)
         VALUES ('legacy-run', 'implementation', 'implementation', 'running', 1, 10, 1, 10)`
      ).run();
    } finally {
      db.close();
    }

    const envelope = await readEvents(dataDir, "legacy-run");
    expect(envelope.events.map((event) => event.type)).toEqual([
      "step_started"
    ]);
    expect(fs.existsSync(path.join(dataDir, "momentum.db"))).toBe(true);
  });

  it("replays reproducible events from a pre-workflow-gates database", async () => {
    const root = makeTempDir();
    const dataDir = path.join(root, "legacy-data");
    fs.mkdirSync(dataDir);
    const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      db.exec(`
        CREATE TABLE workflow_runs (
          id TEXT PRIMARY KEY,
          state TEXT NOT NULL DEFAULT 'pending',
          source TEXT NOT NULL,
          plan_json TEXT NOT NULL DEFAULT '{}',
          issue_scope_json TEXT NOT NULL DEFAULT '{}',
          route_json TEXT NOT NULL DEFAULT '{}',
          needs_manual_recovery INTEGER NOT NULL DEFAULT 0,
          started_at INTEGER,
          finished_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE workflow_steps (
          run_id TEXT NOT NULL,
          step_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'pending',
          step_order INTEGER NOT NULL,
          required INTEGER NOT NULL DEFAULT 1,
          ledger_offset INTEGER,
          result_digest TEXT,
          error_code TEXT,
          error_message TEXT,
          started_at INTEGER,
          finished_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (run_id, step_id)
        ) STRICT;
        CREATE TABLE workflow_approvals (
          run_id TEXT NOT NULL,
          boundary TEXT NOT NULL,
          actor TEXT,
          phrase TEXT NOT NULL,
          artifact_path TEXT NOT NULL,
          artifact_digest TEXT NOT NULL,
          recorded_at INTEGER NOT NULL,
          discharged_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (run_id, boundary)
        ) STRICT;
      `);
      db.prepare(
        `INSERT INTO workflow_runs
           (id, state, source, created_at, updated_at)
         VALUES ('legacy-run', 'running', 'momentum-native-coding', 1, 10)`
      ).run();
      db.prepare(
        `INSERT INTO workflow_steps
           (run_id, step_id, kind, state, step_order, started_at, created_at, updated_at)
         VALUES ('legacy-run', 'implementation', 'implementation', 'running', 1, 10, 1, 10)`
      ).run();
    } finally {
      db.close();
    }

    const envelope = await readEvents(dataDir, "legacy-run");
    expect(envelope.events.map((event) => event.type)).toEqual([
      "step_started"
    ]);
    expect(fs.existsSync(path.join(dataDir, "momentum.db"))).toBe(true);
  });
});
