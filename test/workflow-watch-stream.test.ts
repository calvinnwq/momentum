import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import type {
  WorkflowRunEvents,
  WorkflowSemanticEvent
} from "../src/core/workflow/events.js";
import {
  buildWorkflowWatchStreamTick,
  runWorkflowWatchStream,
  type RunWorkflowWatchStreamResult,
  type WorkflowWatchStreamPollResult,
  type WorkflowWatchStreamRecord
} from "../src/core/workflow/watch-stream.js";
import {
  createWorkflowWatchStreamDbPoll,
  WorkflowWatchStreamRunNotFoundError
} from "../src/core/workflow/watch-stream-source.js";

/**
 * SUP-05 (NGX-552) JSONL stream tick reducer.
 *
 * `workflow run watch <run-id> --stream --jsonl` polls the durable event cursor
 * API (SUP-04) and turns each poll into newline-delimited JSON records. This
 * reducer owns the per-tick translation: which records emit, how heartbeats are
 * suppressed, where the durable resume cursor advances, and when the stream is
 * behaviourally terminal. It is pure and stateless so a long-running stream can
 * call it once per tick without retaining event history.
 */

const NOW = 1_730_000_500_000;

function event(
  input: Partial<WorkflowSemanticEvent> & {
    type: WorkflowSemanticEvent["type"];
    cursor: string;
  }
): WorkflowSemanticEvent {
  return {
    id: input.id ?? `${input.type}:${input.cursor}`,
    cursor: input.cursor,
    timestamp: input.timestamp ?? NOW,
    type: input.type,
    stepId: input.stepId ?? null,
    payload: input.payload ?? {}
  };
}

function eventsEnvelope(
  input: Partial<WorkflowRunEvents> & { events: WorkflowSemanticEvent[] }
): WorkflowRunEvents {
  return {
    runId: input.runId ?? "cwfp-stream",
    since: input.since ?? null,
    cursor: input.cursor ?? input.events.at(-1)?.cursor ?? input.since ?? null,
    events: input.events
  };
}

describe("buildWorkflowWatchStreamTick", () => {
  it("maps each new semantic event to an emit:true single-line JSON record", () => {
    const envelope = eventsEnvelope({
      runId: "cwfp-stream",
      events: [
        event({ type: "step_started", cursor: "wfcur1.aaa", stepId: "impl" }),
        event({
          type: "step_succeeded",
          cursor: "wfcur1.bbb",
          stepId: "impl",
          payload: { resultDigest: "sha256:1" }
        })
      ]
    });

    const tick = buildWorkflowWatchStreamTick(envelope, { now: NOW });

    expect(tick.records).toHaveLength(2);
    for (const record of tick.records) {
      expect(record).toMatchObject({
        ok: true,
        command: "workflow run watch",
        mode: "stream",
        kind: "event",
        emit: true,
        runId: "cwfp-stream"
      });
      expect(JSON.stringify(record)).not.toContain("\n");
    }
    expect(tick.records[0]).toMatchObject({
      cursor: "wfcur1.aaa",
      event: { type: "step_started", stepId: "impl", cursor: "wfcur1.aaa" }
    });
    expect(tick.records[1]).toMatchObject({
      cursor: "wfcur1.bbb",
      event: {
        type: "step_succeeded",
        stepId: "impl",
        payload: { resultDigest: "sha256:1" }
      }
    });
  });

  it("emits an emit:false heartbeat when there are no new events", () => {
    const envelope = eventsEnvelope({
      runId: "cwfp-stream",
      since: "wfcur1.last",
      cursor: "wfcur1.last",
      events: []
    });

    const tick = buildWorkflowWatchStreamTick(envelope, { now: NOW });

    expect(tick.records).toHaveLength(1);
    const heartbeat = tick.records[0] as WorkflowWatchStreamRecord;
    expect(heartbeat).toMatchObject({
      ok: true,
      command: "workflow run watch",
      mode: "stream",
      kind: "heartbeat",
      emit: false,
      runId: "cwfp-stream",
      cursor: "wfcur1.last",
      generatedAt: NOW,
      terminal: false
    });
    expect(JSON.stringify(heartbeat)).not.toContain("\n");
  });

  it("suppresses heartbeats when the heartbeat option is disabled", () => {
    const envelope = eventsEnvelope({
      since: "wfcur1.last",
      cursor: "wfcur1.last",
      events: []
    });

    const tick = buildWorkflowWatchStreamTick(envelope, {
      now: NOW,
      heartbeat: false
    });

    expect(tick.records).toEqual([]);
    expect(tick.cursor).toBe("wfcur1.last");
    expect(tick.terminal).toBe(false);
  });

  it("marks the terminal_state event and the tick as terminal", () => {
    const envelope = eventsEnvelope({
      events: [
        event({ type: "step_succeeded", cursor: "wfcur1.a", stepId: "merge" }),
        event({
          type: "terminal_state",
          cursor: "wfcur1.z",
          payload: { state: "succeeded" }
        })
      ]
    });

    const tick = buildWorkflowWatchStreamTick(envelope, { now: NOW });

    expect(tick.terminal).toBe(true);
    expect(tick.records[0]).toMatchObject({ terminal: false });
    expect(tick.records[1]).toMatchObject({
      kind: "event",
      emit: true,
      terminal: true,
      event: { type: "terminal_state", payload: { state: "succeeded" } }
    });
  });

  it("reports terminal on a heartbeat when the run is already terminal", () => {
    const envelope = eventsEnvelope({
      since: "wfcur1.done",
      cursor: "wfcur1.done",
      events: []
    });

    const tick = buildWorkflowWatchStreamTick(envelope, {
      now: NOW,
      runTerminal: true
    });

    expect(tick.terminal).toBe(true);
    expect(tick.records[0]).toMatchObject({
      kind: "heartbeat",
      emit: false,
      terminal: true
    });
  });

  it("advances the tick cursor to the last event's durable cursor", () => {
    const envelope = eventsEnvelope({
      since: "wfcur1.start",
      events: [
        event({ type: "step_started", cursor: "wfcur1.a" }),
        event({ type: "step_succeeded", cursor: "wfcur1.b" })
      ]
    });

    const tick = buildWorkflowWatchStreamTick(envelope, { now: NOW });

    expect(tick.cursor).toBe("wfcur1.b");
  });

  it("holds the cursor at the prior since value when already caught up", () => {
    const envelope = eventsEnvelope({
      since: "wfcur1.caughtup",
      cursor: "wfcur1.caughtup",
      events: []
    });

    const tick = buildWorkflowWatchStreamTick(envelope, { now: NOW });

    expect(tick.cursor).toBe("wfcur1.caughtup");
    expect(tick.records[0]).toMatchObject({ cursor: "wfcur1.caughtup" });
  });

  it("stays stateless so an advanced cursor yields only heartbeat ticks", () => {
    const first = buildWorkflowWatchStreamTick(
      eventsEnvelope({
        events: [event({ type: "step_started", cursor: "wfcur1.a" })]
      }),
      { now: NOW }
    );
    expect(first.records).toHaveLength(1);
    expect(first.records[0]).toMatchObject({ kind: "event" });

    const caughtUp = buildWorkflowWatchStreamTick(
      eventsEnvelope({
        since: first.cursor,
        cursor: first.cursor,
        events: []
      }),
      { now: NOW + 1000 }
    );
    expect(caughtUp.records).toHaveLength(1);
    expect(caughtUp.records[0]).toMatchObject({ kind: "heartbeat" });
  });

  it("serializes every record as one parseable JSON line", () => {
    const envelope = eventsEnvelope({
      events: [
        event({ type: "approval_required", cursor: "wfcur1.a", stepId: "plan" }),
        event({ type: "terminal_state", cursor: "wfcur1.z" })
      ]
    });

    const tick = buildWorkflowWatchStreamTick(envelope, { now: NOW });
    const lines = tick.records.map((record) => JSON.stringify(record));

    for (const line of lines) {
      expect(line.split("\n")).toHaveLength(1);
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

/**
 * SUP-05 (NGX-552) JSONL stream-session driver.
 *
 * `runWorkflowWatchStream` is the loop layer between the per-tick reducer and the
 * CLI: it threads the durable resume cursor across polls, writes each record as
 * the reducer produces it, sleeps between non-terminal polls, exits cleanly on a
 * terminal run, and stays memory-bounded by retaining only the cursor (never the
 * event history) between ticks. Every collaborator (poll, write, now, sleep, the
 * abort signal) is injected so the loop is deterministic and free of timers, a
 * database, or process I/O.
 */

type PollStep = {
  events: WorkflowSemanticEvent[];
  runTerminal?: boolean;
};

function scriptedPoll(steps: PollStep[]): {
  poll: (since: string | null) => WorkflowWatchStreamPollResult;
  seenSince: (string | null)[];
} {
  const seenSince: (string | null)[] = [];
  let index = 0;
  const poll = (since: string | null): WorkflowWatchStreamPollResult => {
    seenSince.push(since);
    const step = steps[Math.min(index, steps.length - 1)] ?? { events: [] };
    index += 1;
    return {
      events: eventsEnvelope({
        since,
        cursor: step.events.at(-1)?.cursor ?? since,
        events: step.events
      }),
      runTerminal: step.runTerminal ?? false
    };
  };
  return { poll, seenSince };
}

describe("runWorkflowWatchStream", () => {
  it("writes a JSONL record per semantic event then advances the cursor", async () => {
    const written: WorkflowWatchStreamRecord[] = [];
    const { poll, seenSince } = scriptedPoll([
      {
        events: [
          event({ type: "step_started", cursor: "wfcur1.a", stepId: "impl" }),
          event({ type: "step_succeeded", cursor: "wfcur1.b", stepId: "impl" })
        ]
      },
      { events: [] }
    ]);

    const result: RunWorkflowWatchStreamResult = await runWorkflowWatchStream({
      poll,
      write: (record) => written.push(record),
      now: () => NOW,
      sleep: async () => {},
      maxTicks: 2
    });

    expect(written).toHaveLength(3);
    expect(written.slice(0, 2)).toMatchObject([
      { kind: "event", emit: true, event: { cursor: "wfcur1.a" } },
      { kind: "event", emit: true, event: { cursor: "wfcur1.b" } }
    ]);
    expect(written[2]).toMatchObject({ kind: "heartbeat", emit: false });
    for (const record of written) {
      expect(JSON.stringify(record)).not.toContain("\n");
    }
    expect(seenSince).toEqual([null, "wfcur1.b"]);
    expect(result.cursor).toBe("wfcur1.b");
    expect(result.ticks).toBe(2);
    expect(result.exitReason).toBe("max_ticks");
    expect(result.terminal).toBe(false);
  });

  it("resumes from the provided since cursor on reconnect", async () => {
    const { poll, seenSince } = scriptedPoll([
      { events: [event({ type: "step_succeeded", cursor: "wfcur1.next" })] }
    ]);

    await runWorkflowWatchStream({
      poll,
      write: () => {},
      since: "wfcur1.start",
      now: () => NOW,
      sleep: async () => {},
      maxTicks: 1
    });

    expect(seenSince[0]).toBe("wfcur1.start");
  });

  it("exits on the terminal event and stops polling", async () => {
    const written: WorkflowWatchStreamRecord[] = [];
    const sleeps: number[] = [];
    const { poll, seenSince } = scriptedPoll([
      {
        events: [
          event({ type: "step_succeeded", cursor: "wfcur1.a", stepId: "merge" }),
          event({
            type: "terminal_state",
            cursor: "wfcur1.z",
            payload: { state: "succeeded" }
          })
        ]
      },
      { events: [] }
    ]);

    const result = await runWorkflowWatchStream({
      poll,
      write: (record) => written.push(record),
      now: () => NOW,
      sleep: async (ms) => {
        sleeps.push(ms);
      }
    });

    expect(result.exitReason).toBe("terminal");
    expect(result.terminal).toBe(true);
    expect(seenSince).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
    expect(written.at(-1)).toMatchObject({
      kind: "event",
      emit: true,
      terminal: true,
      event: { type: "terminal_state" }
    });
  });

  it("recognizes an already-terminal run on reconnect and exits via heartbeat", async () => {
    const written: WorkflowWatchStreamRecord[] = [];
    const { poll, seenSince } = scriptedPoll([
      { events: [], runTerminal: true }
    ]);

    const result = await runWorkflowWatchStream({
      poll,
      write: (record) => written.push(record),
      since: "wfcur1.done",
      now: () => NOW,
      sleep: async () => {}
    });

    expect(result.exitReason).toBe("terminal");
    expect(result.terminal).toBe(true);
    expect(seenSince).toEqual(["wfcur1.done"]);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      kind: "heartbeat",
      emit: false,
      terminal: true
    });
  });

  it("suppresses heartbeats when disabled while still bounding the loop", async () => {
    const written: WorkflowWatchStreamRecord[] = [];
    const { poll } = scriptedPoll([{ events: [] }]);

    const result = await runWorkflowWatchStream({
      poll,
      write: (record) => written.push(record),
      heartbeat: false,
      now: () => NOW,
      sleep: async () => {},
      maxTicks: 3
    });

    expect(written).toEqual([]);
    expect(result.ticks).toBe(3);
    expect(result.exitReason).toBe("max_ticks");
  });

  it("stays memory-bounded across many ticks by retaining only the cursor", async () => {
    let written = 0;
    const seenSince: (string | null)[] = [];
    const poll = (since: string | null): WorkflowWatchStreamPollResult => {
      seenSince.push(since);
      const n = seenSince.length;
      return {
        events: eventsEnvelope({
          since,
          events: [event({ type: "step_started", cursor: `wfcur1.${n}` })]
        }),
        runTerminal: false
      };
    };

    const result = await runWorkflowWatchStream({
      poll,
      write: () => {
        written += 1;
      },
      now: () => NOW,
      sleep: async () => {},
      maxTicks: 500
    });

    expect(written).toBe(500);
    expect(result.ticks).toBe(500);
    expect(result.recordsWritten).toBe(500);
    expect(result.cursor).toBe("wfcur1.500");
    // The driver streams forward: each poll resumes from the prior tick's
    // cursor rather than replaying history.
    expect(seenSince[0]).toBeNull();
    expect(seenSince[1]).toBe("wfcur1.1");
    expect(seenSince[499]).toBe("wfcur1.499");
    // The result is a bounded summary, never an accumulated record array.
    expect(Object.keys(result).sort()).toEqual([
      "cursor",
      "exitReason",
      "recordsWritten",
      "terminal",
      "ticks"
    ]);
  });

  it("stops before polling when the abort signal is already aborted", async () => {
    let polled = 0;
    const controller = new AbortController();
    controller.abort();

    const result = await runWorkflowWatchStream({
      poll: () => {
        polled += 1;
        return {
          events: eventsEnvelope({ events: [] }),
          runTerminal: false
        };
      },
      write: () => {},
      now: () => NOW,
      sleep: async () => {},
      signal: controller.signal
    });

    expect(polled).toBe(0);
    expect(result.ticks).toBe(0);
    expect(result.exitReason).toBe("aborted");
  });

  it("stops after the current tick when aborted between polls", async () => {
    const controller = new AbortController();
    const seenSince: (string | null)[] = [];
    const poll = (since: string | null): WorkflowWatchStreamPollResult => {
      seenSince.push(since);
      const n = seenSince.length;
      return {
        events: eventsEnvelope({
          since,
          events: [event({ type: "step_started", cursor: `wfcur1.${n}` })]
        }),
        runTerminal: false
      };
    };

    const result = await runWorkflowWatchStream({
      poll,
      write: () => {},
      now: () => NOW,
      sleep: async () => {
        controller.abort();
      },
      signal: controller.signal
    });

    expect(result.ticks).toBe(1);
    expect(result.exitReason).toBe("aborted");
    expect(seenSince).toHaveLength(1);
  });

  it("keeps streaming past a terminal run when exitOnTerminal is disabled", async () => {
    const { poll } = scriptedPoll([
      {
        events: [
          event({
            type: "terminal_state",
            cursor: "wfcur1.z",
            payload: { state: "succeeded" }
          })
        ]
      },
      { events: [], runTerminal: true }
    ]);

    const result = await runWorkflowWatchStream({
      poll,
      write: () => {},
      exitOnTerminal: false,
      now: () => NOW,
      sleep: async () => {},
      maxTicks: 3
    });

    expect(result.terminal).toBe(true);
    expect(result.ticks).toBe(3);
    expect(result.exitReason).toBe("max_ticks");
  });

  it("rejects a negative poll interval before polling", async () => {
    let polled = 0;
    await expect(
      runWorkflowWatchStream({
        poll: () => {
          polled += 1;
          return { events: eventsEnvelope({ events: [] }), runTerminal: false };
        },
        write: () => {},
        pollIntervalMs: -1,
        now: () => NOW,
        sleep: async () => {}
      })
    ).rejects.toThrow(/pollIntervalMs/);
    expect(polled).toBe(0);
  });
});

/**
 * SUP-05 (NGX-552) durable DB-backed poll source.
 *
 * `createWorkflowWatchStreamDbPoll` is the impure edge that bridges the SUP-04
 * event cursor API ({@link loadWorkflowRunEvents}) and the run row's terminal
 * state into the {@link runWorkflowWatchStream} driver's injected poll seam. It
 * is the piece that lets a reconnecting stream recognise an already-terminal run
 * even when it resumes from a cursor at or past the projected `terminal_state`
 * event - the events envelope alone never re-surfaces that event, so the run
 * row's state is read out-of-band per poll.
 */

const streamSourceTempRoots: string[] = [];

afterEach(() => {
  while (streamSourceTempRoots.length > 0) {
    const dir = streamSourceTempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeStreamSourceTempDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "momentum-watch-stream-source-")
  );
  streamSourceTempRoots.push(dir);
  return fs.realpathSync(dir);
}

function seedStreamRun(
  db: MomentumDb,
  input: {
    runId: string;
    state?: string;
    startedAt?: number | null;
    finishedAt?: number | null;
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
    input.state ?? "running",
    input.startedAt ?? null,
    input.finishedAt ?? null,
    1,
    input.updatedAt ?? 1
  );
}

function seedStreamEvent(
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

describe("createWorkflowWatchStreamDbPoll", () => {
  it("returns durable events after the resume cursor for a live run", () => {
    const dataDir = makeStreamSourceTempDir();
    const db = openDb(dataDir);
    try {
      seedStreamRun(db, { runId: "run-live", state: "running" });
      seedStreamEvent(db, {
        eventId: "000000000070:recovery_required:run-live",
        runId: "run-live",
        type: "recovery_required",
        timestamp: 70,
        payload: { reason: "manual inspection required" }
      });

      const poll = createWorkflowWatchStreamDbPoll(db, "run-live");
      const result = poll(null);

      expect(result.runTerminal).toBe(false);
      expect(result.events.runId).toBe("run-live");
      expect(result.events.since).toBeNull();
      expect(result.events.events.map((event) => event.type)).toContain(
        "recovery_required"
      );
      expect(result.events.cursor).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it("advances past consumed events when resuming from the prior cursor", () => {
    const dataDir = makeStreamSourceTempDir();
    const db = openDb(dataDir);
    try {
      seedStreamRun(db, { runId: "run-advance", state: "running" });
      seedStreamEvent(db, {
        eventId: "000000000070:recovery_required:run-advance",
        runId: "run-advance",
        type: "recovery_required",
        timestamp: 70
      });

      const poll = createWorkflowWatchStreamDbPoll(db, "run-advance");
      const first = poll(null);
      expect(first.events.events).toHaveLength(1);

      const second = poll(first.events.cursor);
      expect(second.events.events).toEqual([]);
      expect(second.events.since).toBe(first.events.cursor);
      expect(second.events.cursor).toBe(first.events.cursor);
      expect(second.runTerminal).toBe(false);
    } finally {
      db.close();
    }
  });

  it("reports a terminal run out-of-band even when reconnecting past the terminal event", () => {
    const dataDir = makeStreamSourceTempDir();
    const db = openDb(dataDir);
    try {
      seedStreamRun(db, {
        runId: "run-term",
        state: "succeeded",
        startedAt: 5,
        finishedAt: 80,
        updatedAt: 80
      });

      const poll = createWorkflowWatchStreamDbPoll(db, "run-term");
      const first = poll(null);
      expect(first.runTerminal).toBe(true);
      expect(first.events.events.map((event) => event.type)).toContain(
        "terminal_state"
      );

      // Reconnecting from a cursor at/past the terminal event yields no new
      // events, so the run row's state is the only terminal signal left.
      const reconnect = poll(first.events.cursor);
      expect(reconnect.events.events).toEqual([]);
      expect(reconnect.runTerminal).toBe(true);
    } finally {
      db.close();
    }
  });

  it("throws WorkflowWatchStreamRunNotFoundError for an unknown run", () => {
    const dataDir = makeStreamSourceTempDir();
    const db = openDb(dataDir);
    try {
      seedStreamRun(db, { runId: "run-present", state: "running" });
      const poll = createWorkflowWatchStreamDbPoll(db, "run-missing");
      expect(() => poll(null)).toThrow(WorkflowWatchStreamRunNotFoundError);
    } finally {
      db.close();
    }
  });

  it("drives runWorkflowWatchStream to a clean terminal exit against a real db", async () => {
    const dataDir = makeStreamSourceTempDir();
    const db = openDb(dataDir);
    try {
      seedStreamRun(db, {
        runId: "run-drive",
        state: "succeeded",
        startedAt: 5,
        finishedAt: 80,
        updatedAt: 80
      });

      const written: WorkflowWatchStreamRecord[] = [];
      const result = await runWorkflowWatchStream({
        poll: createWorkflowWatchStreamDbPoll(db, "run-drive"),
        write: (record) => written.push(record),
        now: () => NOW,
        sleep: async () => {}
      });

      expect(result.exitReason).toBe("terminal");
      expect(result.terminal).toBe(true);
      expect(
        written.some(
          (record) =>
            record.kind === "event" &&
            record.event.type === "terminal_state"
        )
      ).toBe(true);
      for (const record of written) {
        expect(JSON.stringify(record)).not.toContain("\n");
      }
    } finally {
      db.close();
    }
  });
});
