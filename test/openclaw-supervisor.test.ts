import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildOpenClawSupervisorDisabledTick,
  buildOpenClawSupervisorTick,
  loadOpenClawSupervisorState,
  saveOpenClawSupervisorState,
  type OpenClawSupervisorState,
  type OpenClawSupervisorWatchEnvelope
} from "../src/core/openclaw/supervisor.js";

const NOW = 1_730_001_000_000;
const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momentum-openclaw-"));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function watch(
  input: Partial<OpenClawSupervisorWatchEnvelope>
): OpenClawSupervisorWatchEnvelope {
  return {
    ok: true,
    command: "workflow run watch",
    mode: "once",
    runId: input.runId ?? "cwfp-openclaw",
    emit: input.emit ?? true,
    reason: input.reason ?? "in_progress",
    recommendedAction: input.recommendedAction ?? "poll",
    nextPollSeconds: input.nextPollSeconds ?? 15,
    humanAction: input.humanAction ?? null,
    cleanup: input.cleanup ?? "none",
    digest: input.digest ?? "sha256:progress",
    cursor: input.cursor ?? null,
    phase: input.phase ?? "advancing",
    stuckRisk: input.stuckRisk ?? "low",
    inspectionCommand: input.inspectionCommand ?? null
  };
}

describe("buildOpenClawSupervisorTick", () => {
  it("stores unchanged watch ticks without delivering them to chat", () => {
    const tick = buildOpenClawSupervisorTick({
      priorState: null,
      watch: watch({ emit: false, digest: "sha256:unchanged" }),
      now: NOW
    });

    expect(tick.emit).toBe(false);
    expect(tick.suppressedReason).toBe("watch_silent");
    expect(tick.eventType).toBeNull();
    expect(tick.nextState).toMatchObject({
      version: 1,
      runId: "cwfp-openclaw",
      lastCursor: null,
      lastDigest: "sha256:unchanged",
      lastReason: "in_progress",
      lastHumanUpdateAt: null,
      disabled: false
    });
  });

  it("emits progress once and suppresses the same digest after restart", () => {
    const first = buildOpenClawSupervisorTick({
      priorState: null,
      watch: watch({ digest: "sha256:step-1", reason: "in_progress" }),
      now: NOW
    });
    expect(first).toMatchObject({
      emit: true,
      eventType: "progress",
      suppressedReason: null
    });

    const second = buildOpenClawSupervisorTick({
      priorState: first.nextState,
      watch: watch({ digest: "sha256:step-1", reason: "in_progress" }),
      now: NOW + 5_000
    });

    expect(second).toMatchObject({
      emit: false,
      eventType: null,
      suppressedReason: "duplicate_digest"
    });
    expect(second.nextState.lastHumanUpdateAt).toBe(NOW);
  });

  it("emits recovery events with the actionable human command", () => {
    const tick = buildOpenClawSupervisorTick({
      priorState: null,
      watch: watch({
        reason: "recovery_required",
        recommendedAction: "recover",
        humanAction: {
          code: "clear_recovery",
          command: "momentum workflow run clear-recovery cwfp-openclaw",
          detail: "Resolve the failed step evidence first."
        },
        digest: "sha256:recovery"
      }),
      now: NOW
    });

    expect(tick).toMatchObject({
      emit: true,
      eventType: "recovery",
      humanAction: {
        code: "clear_recovery",
        command: "momentum workflow run clear-recovery cwfp-openclaw"
      }
    });
    expect(tick.nextState.lastReason).toBe("recovery_required");
  });

  it("classifies recovery-required operator decisions as recovery events", () => {
    const tick = buildOpenClawSupervisorTick({
      priorState: null,
      watch: watch({
        reason: "recovery_required",
        recommendedAction: "operator_decision",
        humanAction: null,
        digest: "sha256:recovery-decision"
      }),
      now: NOW
    });

    expect(tick).toMatchObject({
      emit: true,
      eventType: "recovery",
      recommendedAction: "operator_decision"
    });
  });

  it("honors due approval quiet heartbeat reminders from the watch reducer", () => {
    const first = buildOpenClawSupervisorTick({
      priorState: null,
      watch: watch({
        reason: "quiet_heartbeat",
        recommendedAction: "approve",
        humanAction: {
          code: "approve",
          command:
            "momentum workflow run approve cwfp-openclaw --approval-boundary through-implementation",
          detail: null
        },
        digest: "sha256:approval-reminder"
      }),
      now: NOW
    });
    const second = buildOpenClawSupervisorTick({
      priorState: first.nextState,
      watch: watch({
        reason: "quiet_heartbeat",
        recommendedAction: "approve",
        humanAction: {
          code: "approve",
          command:
            "momentum workflow run approve cwfp-openclaw --approval-boundary through-implementation",
          detail: null
        },
        digest: "sha256:approval-reminder"
      }),
      now: NOW + 60_000
    });

    expect(second).toMatchObject({
      emit: true,
      eventType: "approval",
      suppressedReason: null
    });
    expect(second.nextState.lastHumanUpdateAt).toBe(NOW + 60_000);
  });

  it("keeps idle-only quiet heartbeats silent", () => {
    const tick = buildOpenClawSupervisorTick({
      priorState: null,
      watch: watch({
        reason: "quiet_heartbeat",
        recommendedAction: "poll",
        digest: "sha256:idle-reminder"
      }),
      now: NOW
    });

    expect(tick).toMatchObject({
      emit: false,
      eventType: null,
      suppressedReason: "heartbeat"
    });
  });

  it("honors repeated stuck risk advisories from the watch reducer", () => {
    const first = buildOpenClawSupervisorTick({
      priorState: null,
      watch: watch({
        reason: "stuck_risk",
        stuckRisk: "high",
        inspectionCommand: "momentum workflow run logs cwfp-openclaw",
        digest: "sha256:stuck"
      }),
      now: NOW
    });
    const second = buildOpenClawSupervisorTick({
      priorState: first.nextState,
      watch: watch({
        reason: "stuck_risk",
        stuckRisk: "high",
        inspectionCommand: "momentum workflow run logs cwfp-openclaw",
        digest: "sha256:stuck"
      }),
      now: NOW + 60_000
    });

    expect(second).toMatchObject({
      emit: true,
      eventType: "stuck-risk",
      suppressedReason: null
    });
    expect(second.nextState.lastHumanUpdateAt).toBe(NOW + 60_000);
  });

  it("marks terminal cleanup so a host can remove the monitor loop", () => {
    const tick = buildOpenClawSupervisorTick({
      priorState: null,
      watch: watch({
        reason: "terminal_succeeded",
        cleanup: "release",
        digest: "sha256:terminal",
        nextPollSeconds: 0
      }),
      now: NOW
    });

    expect(tick).toMatchObject({
      emit: true,
      eventType: "terminal",
      cleanupAction: "remove_monitor",
      monitorEnabled: false
    });
    expect(tick.nextState.disabled).toBe(true);
  });

  it("repeats terminal cleanup for disabled supervisor state retries", () => {
    const disabledState: OpenClawSupervisorState = {
      version: 1,
      runId: "cwfp-openclaw",
      lastCursor: "wfcur1.done",
      lastDigest: "sha256:terminal",
      lastReason: "terminal_succeeded",
      lastHumanUpdateAt: NOW,
      disabled: true,
      updatedAt: NOW
    };

    const tick = buildOpenClawSupervisorDisabledTick({
      runId: "cwfp-openclaw",
      state: disabledState,
      now: NOW + 5_000
    });

    expect(tick).toMatchObject({
      emit: false,
      eventType: null,
      cleanupAction: "remove_monitor",
      monitorEnabled: false,
      suppressedReason: "monitor_disabled"
    });
    expect(tick.nextState.disabled).toBe(true);
  });
});

describe("OpenClaw supervisor state persistence", () => {
  it("round-trips durable cursor, digest, reason, and last human update time", () => {
    const dataDir = makeTempDir();
    saveOpenClawSupervisorState(dataDir, {
      version: 1,
      runId: "cwfp-openclaw",
      lastCursor: "wfcur1.abc",
      lastDigest: "sha256:state",
      lastReason: "stuck_risk",
      lastHumanUpdateAt: NOW,
      disabled: false,
      updatedAt: NOW
    });

    expect(loadOpenClawSupervisorState(dataDir, "cwfp-openclaw")).toEqual({
      version: 1,
      runId: "cwfp-openclaw",
      lastCursor: "wfcur1.abc",
      lastDigest: "sha256:state",
      lastReason: "stuck_risk",
      lastHumanUpdateAt: NOW,
      disabled: false,
      updatedAt: NOW
    });
  });
}
);
