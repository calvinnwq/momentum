import crypto from "node:crypto";
import { Buffer } from "node:buffer";

import type { MomentumDb } from "../../adapters/db.js";
import { WORKFLOW_RUN_TERMINAL_STATES } from "./run-reducer.js";

export const WORKFLOW_EVENT_TYPES = [
  "step_started",
  "step_succeeded",
  "step_failed",
  "step_skipped",
  "step_canceled",
  "step_blocked",
  "approval_required",
  "approval_resolved",
  "recovery_required",
  "recovery_cleared",
  "gate_opened",
  "gate_resolved",
  "terminal_state",
  "monitor_stuck_risk",
  "monitor_quiet_heartbeat"
] as const;
export type WorkflowEventType = (typeof WORKFLOW_EVENT_TYPES)[number];

export type WorkflowSemanticEvent = {
  id: string;
  cursor: string;
  timestamp: number;
  type: WorkflowEventType;
  stepId: string | null;
  payload: Record<string, unknown>;
};

export type WorkflowRunEvents = {
  runId: string;
  since: string | null;
  cursor: string | null;
  events: WorkflowSemanticEvent[];
};

export type LoadWorkflowRunEventsOptions = {
  since?: string | null | undefined;
};

export type AppendWorkflowEventInput = {
  runId: string;
  type: WorkflowEventType;
  occurredAt: number;
  stepId?: string | null;
  payload?: Record<string, unknown>;
  eventId?: string;
};

export function appendWorkflowEvent(
  db: MomentumDb,
  input: AppendWorkflowEventInput
): WorkflowSemanticEvent {
  const event: WorkflowSemanticEvent = {
    id:
      input.eventId ??
      `${padTimestamp(input.occurredAt)}:${input.type}:${crypto.randomUUID()}`,
    cursor: "",
    timestamp: input.occurredAt,
    type: input.type,
    stepId: input.stepId ?? null,
    payload: input.payload ?? {}
  };
  event.cursor = event.id;
  db.prepare(
    `INSERT INTO workflow_events
       (event_id, run_id, step_id, occurred_at, type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    event.id,
    input.runId,
    event.stepId,
    event.timestamp,
    event.type,
    JSON.stringify(event.payload),
    event.timestamp
  );
  return event;
}

export function buildWorkflowEventId(input: {
  runId: string;
  type: WorkflowEventType;
  timestamp: number;
  stepId: string | null;
  payload: Record<string, unknown>;
  source: string;
}): string {
  const identity = canonicalStringify({
    runId: input.runId,
    type: input.type,
    stepId: input.stepId,
    payload: input.payload,
    source: input.source
  });
  const digest = crypto.createHash("sha256").update(identity).digest("hex");
  return `${padTimestamp(input.timestamp)}:${input.type}:${digest.slice(0, 16)}`;
}

export function loadWorkflowRunEvents(
  db: MomentumDb,
  runId: string,
  options: LoadWorkflowRunEventsOptions = {}
): WorkflowRunEvents | null {
  if (!tableExists(db, "workflow_runs")) return null;
  const run = db
    .prepare(
      `SELECT id, state, finished_at, updated_at
         FROM workflow_runs WHERE id = ?`
    )
    .get(runId) as
    | {
        id: string;
        state: string;
        finished_at: number | null;
        updated_at: number;
      }
    | undefined;
  if (run === undefined) return null;

  const since = normalizeCursor(options.since);
  const candidates = [
    ...projectStepEvents(db, runId),
    ...projectApprovalEvents(db, runId),
    ...projectGateEvents(db, runId),
    ...projectTerminalRunEvent(run),
    ...loadStoredWorkflowEvents(db, runId)
  ].sort(compareEvents);

  const cursorState = decodeReplayCursor(since);
  const filtered = filterEventsAfterCursor(candidates, since, cursorState);
  const events = attachReplayCursors(filtered, cursorState);
  const cursor = events.at(-1)?.cursor ?? since;
  return { runId, since, cursor, events };
}

function projectStepEvents(
  db: MomentumDb,
  runId: string
): WorkflowSemanticEvent[] {
  if (!tableExists(db, "workflow_steps")) return [];
  const storedBlockedAtByStep = loadStoredStepBlockedAtByStep(db, runId);
  const rows = db
    .prepare(
      `SELECT step_id, kind, state, step_order, required, result_digest,
              error_code, error_message, started_at, finished_at, updated_at
         FROM workflow_steps
        WHERE run_id = ?
        ORDER BY step_order, step_id`
    )
    .all(runId) as StepRow[];
  const events: WorkflowSemanticEvent[] = [];
  for (const row of rows) {
    const basePayload = {
      kind: row.kind,
      order: row.step_order,
      required: row.required === 1
    };
    if (row.started_at !== null) {
      events.push(
        buildEvent({
          runId,
          type: "step_started",
          timestamp: row.started_at,
          stepId: row.step_id,
          payload: basePayload,
          source: "step"
        })
      );
    }

    const terminalType = stepTerminalEventType(row.state);
    if (terminalType !== null) {
      const payload = compactPayload({
        ...basePayload,
        resultDigest: row.result_digest,
        errorCode: row.error_code,
        errorMessage: row.error_message
      });
      events.push(
        buildEvent({
          runId,
          type: terminalType,
          timestamp: row.finished_at ?? row.updated_at,
          stepId: row.step_id,
          payload,
          source: "step"
        })
      );
    } else if (
      row.state === "blocked" &&
      (storedBlockedAtByStep.get(row.step_id) ?? -1) < row.updated_at
    ) {
      events.push(
        buildEvent({
          runId,
          type: "step_blocked",
          timestamp: row.updated_at,
          stepId: row.step_id,
          payload: basePayload,
          source: "step"
        })
      );
    }
  }
  return events;
}

function loadStoredStepBlockedAtByStep(
  db: MomentumDb,
  runId: string
): Map<string, number> {
  if (!tableExists(db, "workflow_events")) return new Map();
  const rows = db
    .prepare(
      `SELECT step_id, MAX(occurred_at) AS occurred_at
         FROM workflow_events
        WHERE run_id = ?
          AND type = 'step_blocked'
          AND step_id IS NOT NULL
        GROUP BY step_id`
    )
    .all(runId) as { step_id: string; occurred_at: number }[];
  return new Map(rows.map((row) => [row.step_id, row.occurred_at]));
}

function projectApprovalEvents(
  db: MomentumDb,
  runId: string
): WorkflowSemanticEvent[] {
  if (!tableExists(db, "workflow_approvals")) return [];
  const rows = db
    .prepare(
      `SELECT boundary, actor, artifact_path, artifact_digest, recorded_at
         FROM workflow_approvals
        WHERE run_id = ?
        ORDER BY recorded_at, boundary`
    )
    .all(runId) as ApprovalRow[];
  return rows.map((row) =>
    buildEvent({
      runId,
      type: "approval_resolved",
      timestamp: row.recorded_at,
      stepId: null,
      payload: compactPayload({
        boundary: row.boundary,
        actor: row.actor,
        artifactPath: row.artifact_path,
        artifactDigest: row.artifact_digest
      }),
      source: "approval"
    })
  );
}

function projectGateEvents(
  db: MomentumDb,
  runId: string
): WorkflowSemanticEvent[] {
  if (!tableExists(db, "workflow_gates")) return [];
  const rows = db
    .prepare(
      `SELECT gate_id, step_run_id, target_scope, gate_type, reason, evidence,
              allowed_actions, recommended_action, resolved_at, resolved_by,
              resolution_mode, chosen_action, resolution, created_at
         FROM workflow_gates
        WHERE workflow_run_id = ?
        ORDER BY created_at, gate_id`
    )
    .all(runId) as GateRow[];
  const events: WorkflowSemanticEvent[] = [];
  for (const row of rows) {
    const openedPayload = compactPayload({
      gateId: row.gate_id,
      targetScope: row.target_scope,
      gateType: row.gate_type,
      reason: row.reason,
      evidence: row.evidence,
      allowedActions: parseJsonArray(row.allowed_actions),
      recommendedAction: row.recommended_action
    });
    if (row.gate_type === "approval_required") {
      events.push(
        buildEvent({
          runId,
          type: "approval_required",
          timestamp: row.created_at,
          stepId: row.step_run_id,
          payload: openedPayload,
          source: "gate"
        })
      );
    }
    events.push(
      buildEvent({
        runId,
        type: "gate_opened",
        timestamp: row.created_at,
        stepId: row.step_run_id,
        payload: openedPayload,
        source: "gate"
      })
    );
    if (row.resolved_at !== null) {
      events.push(
        buildEvent({
          runId,
          type: "gate_resolved",
          timestamp: row.resolved_at,
          stepId: row.step_run_id,
          payload: compactPayload({
            gateId: row.gate_id,
            targetScope: row.target_scope,
            gateType: row.gate_type,
            resolvedBy: row.resolved_by,
            resolutionMode: row.resolution_mode,
            chosenAction: row.chosen_action,
            resolution: row.resolution
          }),
          source: "gate"
        })
      );
    }
  }
  return events;
}

function projectTerminalRunEvent(run: {
  id: string;
  state: string;
  finished_at: number | null;
  updated_at: number;
}): WorkflowSemanticEvent[] {
  if (!(WORKFLOW_RUN_TERMINAL_STATES as readonly string[]).includes(run.state)) {
    return [];
  }
  const timestamp = run.finished_at ?? run.updated_at;
  return [
    buildEvent({
      runId: run.id,
      type: "terminal_state",
      timestamp,
      stepId: null,
      payload: { state: run.state },
      source: "run"
    })
  ];
}

function loadStoredWorkflowEvents(
  db: MomentumDb,
  runId: string
): WorkflowSemanticEvent[] {
  if (!tableExists(db, "workflow_events")) return [];
  const rows = db
    .prepare(
      `SELECT rowid AS event_rowid, event_id, step_id, occurred_at, type, payload_json
         FROM workflow_events
        WHERE run_id = ?
        ORDER BY occurred_at, event_id`
    )
    .all(runId) as StoredEventRow[];
  return rows.map((row) => ({
    id: row.event_id,
    cursor: storedEventCursor(row),
    timestamp: row.occurred_at,
    type: row.type as WorkflowEventType,
    stepId: row.step_id,
    payload: parsePayload(row.payload_json)
  }));
}

function buildEvent(input: {
  runId: string;
  type: WorkflowEventType;
  timestamp: number;
  stepId: string | null;
  payload: Record<string, unknown>;
  source: string;
}): WorkflowSemanticEvent {
  const id = buildWorkflowEventId(input);
  return {
    id,
    cursor: id,
    timestamp: input.timestamp,
    type: input.type,
    stepId: input.stepId,
    payload: input.payload
  };
}

function tableExists(db: MomentumDb, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { name: string } | undefined;
  return row !== undefined;
}

function stepTerminalEventType(state: string): WorkflowEventType | null {
  switch (state) {
    case "succeeded":
      return "step_succeeded";
    case "failed":
      return "step_failed";
    case "skipped":
      return "step_skipped";
    case "canceled":
      return "step_canceled";
    default:
      return null;
  }
}

function normalizeCursor(cursor: string | null | undefined): string | null {
  if (cursor === undefined || cursor === null || cursor.length === 0) {
    return null;
  }
  return cursor;
}

function filterEventsAfterCursor(
  events: WorkflowSemanticEvent[],
  since: string | null,
  state: ReplayCursorState | null
): WorkflowSemanticEvent[] {
  if (since === null) return events;
  if (state !== null) {
    return events.filter(
      (event) =>
        event.timestamp > state.timestamp ||
        (event.timestamp === state.timestamp && !state.seenIds.has(event.id))
    );
  }
  return events.filter((event) => event.cursor > since);
}

function attachReplayCursors(
  events: WorkflowSemanticEvent[],
  prior: ReplayCursorState | null
): WorkflowSemanticEvent[] {
  let activeTimestamp = prior?.timestamp ?? null;
  let seenIds =
    activeTimestamp === null ? new Set<string>() : new Set(prior?.seenIds);
  return events.map((event) => {
    if (activeTimestamp !== event.timestamp) {
      activeTimestamp = event.timestamp;
      seenIds = new Set<string>();
    }
    seenIds.add(event.id);
    return {
      ...event,
      cursor: encodeReplayCursor({
        timestamp: event.timestamp,
        seenIds: new Set(seenIds)
      })
    };
  });
}

function storedEventCursor(row: StoredEventRow): string {
  return [
    padTimestamp(row.occurred_at),
    "zz",
    Math.max(0, Math.floor(row.event_rowid)).toString().padStart(16, "0"),
    row.event_id
  ].join(":");
}

type ReplayCursorState = {
  timestamp: number;
  seenIds: Set<string>;
};

function encodeReplayCursor(state: ReplayCursorState): string {
  const payload = JSON.stringify({
    t: state.timestamp,
    ids: [...state.seenIds].sort()
  });
  return `wfcur1.${Buffer.from(payload, "utf8").toString("base64url")}`;
}

function decodeReplayCursor(cursor: string | null): ReplayCursorState | null {
  if (cursor === null || !cursor.startsWith("wfcur1.")) return null;
  try {
    const raw = Buffer.from(cursor.slice("wfcur1.".length), "base64url").toString(
      "utf8"
    );
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object") return null;
    const record = parsed as { t?: unknown; ids?: unknown };
    if (typeof record.t !== "number" || !Array.isArray(record.ids)) return null;
    const ids = record.ids.filter((id): id is string => typeof id === "string");
    return {
      timestamp: record.t as number,
      seenIds: new Set(ids)
    };
  } catch {
    return null;
  }
}

function compareEvents(a: WorkflowSemanticEvent, b: WorkflowSemanticEvent): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  const rankDelta = eventTypeRank(a.type) - eventTypeRank(b.type);
  if (rankDelta !== 0) return rankDelta;
  return a.cursor < b.cursor ? -1 : a.cursor > b.cursor ? 1 : 0;
}

function eventTypeRank(type: WorkflowEventType): number {
  switch (type) {
    case "step_started":
      return 10;
    case "approval_required":
    case "gate_opened":
      return 20;
    case "step_blocked":
      return 30;
    case "step_succeeded":
    case "step_failed":
    case "step_skipped":
    case "step_canceled":
      return 40;
    case "approval_resolved":
    case "gate_resolved":
    case "recovery_required":
    case "recovery_cleared":
      return 50;
    case "monitor_stuck_risk":
    case "monitor_quiet_heartbeat":
      return 60;
    case "terminal_state":
      return 70;
  }
}

function padTimestamp(timestamp: number): string {
  return Math.max(0, Math.floor(timestamp)).toString().padStart(13, "0");
}

function compactPayload(
  payload: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== null)
  );
}

function parsePayload(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to an empty payload for corrupt legacy rows.
  }
  return {};
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, val]) => `${JSON.stringify(key)}:${canonicalStringify(val)}`)
    .join(",")}}`;
}

type StepRow = {
  step_id: string;
  kind: string;
  state: string;
  step_order: number;
  required: number;
  result_digest: string | null;
  error_code: string | null;
  error_message: string | null;
  started_at: number | null;
  finished_at: number | null;
  updated_at: number;
};

type ApprovalRow = {
  boundary: string;
  actor: string | null;
  artifact_path: string;
  artifact_digest: string;
  recorded_at: number;
};

type GateRow = {
  gate_id: string;
  step_run_id: string | null;
  target_scope: string;
  gate_type: string;
  reason: string;
  evidence: string | null;
  allowed_actions: string;
  recommended_action: string | null;
  resolved_at: number | null;
  resolved_by: string | null;
  resolution_mode: string | null;
  chosen_action: string | null;
  resolution: string | null;
  created_at: number;
};

type StoredEventRow = {
  event_rowid: number;
  event_id: string;
  step_id: string | null;
  occurred_at: number;
  type: string;
  payload_json: string;
};
