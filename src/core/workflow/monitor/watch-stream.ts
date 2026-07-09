import type {
  WorkflowEventType,
  WorkflowRunEvents,
  WorkflowSemanticEvent
} from "../run/events.js";

/**
 * JSONL watch-stream record kinds.
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
  const runTerminal = options.runTerminal ?? false;
  const terminalEventIndex = events.events.findIndex(
    (event) => event.type === "terminal_state"
  );
  const sawTerminalEvent = terminalEventIndex !== -1;
  const lastEventIndex = events.events.length - 1;

  const records: WorkflowWatchStreamRecord[] = events.events.map((event, index) => {
    const isTerminal = event.type === "terminal_state";
    const terminal =
      isTerminal ||
      (sawTerminalEvent && index > terminalEventIndex) ||
      (runTerminal && !sawTerminalEvent && index === lastEventIndex);
    return buildEventRecord(events.runId, event, terminal);
  });

  const terminal = sawTerminalEvent || runTerminal;

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

/** Default sleep between non-terminal stream polls. */
export const DEFAULT_WORKFLOW_WATCH_STREAM_POLL_INTERVAL_MS = 1_000;

type MaybePromise<T> = T | Promise<T>;

/**
 * One durable poll observed by the stream driver: the events after the resume
 * cursor plus whether the durable run row is already terminal. The terminal flag
 * lets a reconnecting stream recognize a finished run even when it resumes from a
 * cursor at or past the terminal event (so no `terminal_state` event reappears).
 */
export type WorkflowWatchStreamPollResult = {
  events: WorkflowRunEvents;
  runTerminal: boolean;
};

export type WorkflowWatchStreamPoll = (
  since: string | null
) => MaybePromise<WorkflowWatchStreamPollResult>;

export type WorkflowWatchStreamWrite = (
  record: WorkflowWatchStreamRecord
) => void;

export type WorkflowWatchStreamNow = () => number;
export type WorkflowWatchStreamSleep = (ms: number) => Promise<void>;

export type WorkflowWatchStreamExitReason = "terminal" | "max_ticks" | "aborted";

export type RunWorkflowWatchStreamInput = {
  /** Durable event poll keyed by the caller's resume cursor (event-cursor). */
  poll: WorkflowWatchStreamPoll;
  /** Sink for each newline-delimited record, called as it is produced. */
  write: WorkflowWatchStreamWrite;
  /** Resume cursor; `null`/omitted starts from the run's first durable event. */
  since?: string | null;
  /** Emit `emit:false` heartbeats on no-change polls. Defaults to `true`. */
  heartbeat?: boolean;
  /** Exit once the run is terminal, after emitting its record. Defaults `true`. */
  exitOnTerminal?: boolean;
  /** Sleep between non-terminal polls. Defaults to the module default. */
  pollIntervalMs?: number;
  /** Safety bound on poll ticks. Defaults to `Infinity`. */
  maxTicks?: number;
  /** Cancellation signal checked between ticks. */
  signal?: AbortSignal;
  now?: WorkflowWatchStreamNow;
  sleep?: WorkflowWatchStreamSleep;
};

export type RunWorkflowWatchStreamResult = {
  /** Durable resume cursor after the final poll. */
  cursor: string | null;
  /** Number of polls performed. */
  ticks: number;
  /** Number of records written across the session. */
  recordsWritten: number;
  /** Whether the run reached (or was already in) a terminal state. */
  terminal: boolean;
  exitReason: WorkflowWatchStreamExitReason;
};

/**
 * Drive a long-running JSONL watch stream over the durable event cursor API.
 *
 * The driver is the loop layer above {@link buildWorkflowWatchStreamTick}: each
 * tick polls events after the current resume cursor, writes every record the
 * reducer produces, advances the cursor, and sleeps before the next poll. It
 * exits on a terminal run (emitting that tick's records first) unless
 * `exitOnTerminal` is disabled, honours an abort signal between ticks, and is
 * bounded by `maxTicks`. Memory stays flat for the lifetime of the stream: only
 * the resume cursor and counters are retained between ticks - records are handed
 * to `write` and released, never accumulated.
 */
export async function runWorkflowWatchStream(
  input: RunWorkflowWatchStreamInput
): Promise<RunWorkflowWatchStreamResult> {
  const now = input.now ?? (() => Date.now());
  const sleep = input.sleep ?? defaultStreamSleep;
  const heartbeat = input.heartbeat ?? true;
  const exitOnTerminal = input.exitOnTerminal ?? true;
  const maxTicks = input.maxTicks ?? Infinity;
  const pollIntervalMs = normalizePositive(
    input.pollIntervalMs ?? DEFAULT_WORKFLOW_WATCH_STREAM_POLL_INTERVAL_MS,
    "pollIntervalMs"
  );

  const aborted = (): boolean => input.signal?.aborted === true;

  let cursor: string | null = input.since ?? null;
  let ticks = 0;
  let recordsWritten = 0;
  let terminal = false;
  let exitReason: WorkflowWatchStreamExitReason | null = null;

  while (exitReason === null) {
    if (aborted()) {
      exitReason = "aborted";
      break;
    }
    if (ticks >= maxTicks) {
      exitReason = "max_ticks";
      break;
    }

    const { events, runTerminal } = await input.poll(cursor);
    const tick = buildWorkflowWatchStreamTick(events, {
      now: now(),
      heartbeat,
      runTerminal
    });
    for (const record of tick.records) {
      input.write(record);
      recordsWritten += 1;
    }
    cursor = tick.cursor;
    ticks += 1;
    if (tick.terminal) terminal = true;

    if (terminal && exitOnTerminal) {
      exitReason = "terminal";
      break;
    }
    // Re-check the bounds before sleeping so a satisfied `maxTicks` or a signal
    // that fired during the poll exits immediately rather than after a wasted
    // poll-interval sleep.
    if (ticks >= maxTicks) {
      exitReason = "max_ticks";
      break;
    }
    if (aborted()) {
      exitReason = "aborted";
      break;
    }
    await sleep(pollIntervalMs);
  }

  return { cursor, ticks, recordsWritten, terminal, exitReason };
}

function defaultStreamSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizePositive(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `runWorkflowWatchStream: ${name} must be a non-negative finite number`
    );
  }
  return value;
}
