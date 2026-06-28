import type {
  WorkflowEventType,
  WorkflowRunEvents,
  WorkflowSemanticEvent
} from "./events.js";

/**
 * SUP-05 (NGX-552) JSONL watch-stream record kinds.
 *
 * `event` records carry one durable semantic event; `heartbeat` records are
 * synthetic liveness ticks emitted when a poll observed no new events.
 */
export const WORKFLOW_WATCH_STREAM_RECORD_KINDS = [
  "event",
  "heartbeat"
] as const;
export type WorkflowWatchStreamRecordKind =
  (typeof WORKFLOW_WATCH_STREAM_RECORD_KINDS)[number];

/** A human-worthy record carrying one durable semantic event. */
export type WorkflowWatchStreamEventRecord = {
  ok: true;
  command: "workflow run watch";
  mode: "stream";
  kind: "event";
  emit: true;
  runId: string;
  cursor: string;
  terminal: boolean;
  event: {
    id: string;
    cursor: string;
    timestamp: number;
    type: WorkflowEventType;
    stepId: string | null;
    payload: Record<string, unknown>;
  };
};

/** A synthetic liveness record emitted when a poll saw no new events. */
export type WorkflowWatchStreamHeartbeatRecord = {
  ok: true;
  command: "workflow run watch";
  mode: "stream";
  kind: "heartbeat";
  emit: false;
  runId: string;
  cursor: string | null;
  generatedAt: number;
  terminal: boolean;
};

export type WorkflowWatchStreamRecord =
  | WorkflowWatchStreamEventRecord
  | WorkflowWatchStreamHeartbeatRecord;

export type WorkflowWatchStreamTick = {
  records: WorkflowWatchStreamRecord[];
  cursor: string | null;
  terminal: boolean;
};

export type BuildWorkflowWatchStreamTickOptions = {
  /** Wall-clock millisecond timestamp stamped onto synthetic heartbeats. */
  now: number;
  /** Emit a heartbeat when a poll saw no new events. Defaults to `true`. */
  heartbeat?: boolean;
  /** Whether the durable run row is already in a terminal state. */
  runTerminal?: boolean;
};

/**
 * Translate one durable event poll into newline-delimited JSON stream records.
 *
 * The reducer is pure and stateless: it consumes only the events returned after
 * the caller's resume cursor, so a long-running stream calls it once per tick
 * without accumulating event history. Each new semantic event becomes an
 * `emit:true` `event` record; a poll with no new events becomes a single
 * `emit:false` `heartbeat` record unless heartbeats are disabled. The returned
 * `cursor` is the durable resume token for the next poll, and `terminal` is true
 * once the run has reached (or is already in) a terminal state.
 */
export function buildWorkflowWatchStreamTick(
  events: WorkflowRunEvents,
  options: BuildWorkflowWatchStreamTickOptions
): WorkflowWatchStreamTick {
  const heartbeatEnabled = options.heartbeat ?? true;
  const cursor = events.cursor ?? events.since ?? null;

  let sawTerminalEvent = false;
  const records: WorkflowWatchStreamRecord[] = events.events.map((event) => {
    const isTerminal = event.type === "terminal_state";
    if (isTerminal) sawTerminalEvent = true;
    return buildEventRecord(events.runId, event, isTerminal);
  });

  const terminal = sawTerminalEvent || (options.runTerminal ?? false);

  if (records.length === 0 && heartbeatEnabled) {
    records.push({
      ok: true,
      command: "workflow run watch",
      mode: "stream",
      kind: "heartbeat",
      emit: false,
      runId: events.runId,
      cursor,
      generatedAt: options.now,
      terminal
    });
  }

  return { records, cursor, terminal };
}

function buildEventRecord(
  runId: string,
  event: WorkflowSemanticEvent,
  terminal: boolean
): WorkflowWatchStreamEventRecord {
  return {
    ok: true,
    command: "workflow run watch",
    mode: "stream",
    kind: "event",
    emit: true,
    runId,
    cursor: event.cursor,
    terminal,
    event: {
      id: event.id,
      cursor: event.cursor,
      timestamp: event.timestamp,
      type: event.type,
      stepId: event.stepId,
      payload: event.payload
    }
  };
}
