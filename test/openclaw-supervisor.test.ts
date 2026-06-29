import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildOpenClawSupervisorTick,
  loadOpenClawSupervisorState,
  saveOpenClawSupervisorState,
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
