import { describe, expect, it } from "vitest";

import type {
  WorkflowRunEvents,
  WorkflowSemanticEvent
} from "../src/core/workflow/events.js";
import {
  buildWorkflowWatchStreamTick,
  type WorkflowWatchStreamRecord
} from "../src/core/workflow/watch-stream.js";

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
