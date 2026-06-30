import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildOpenClawSupervisorDisabledTick,
  buildOpenClawSupervisorTick,
  saveOpenClawSupervisorState,
  type OpenClawSupervisorWatchEnvelope
} from "../src/core/openclaw/supervisor.js";
import {
  executeOpenClawSupervisorAutoAction,
  loadOpenClawSupervisorAutoActionAudit,
  recordOpenClawSupervisorAutoActionStatePersistence
} from "../src/core/openclaw/auto-actions.js";

const NOW = 1_730_002_000_000;
const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momentum-auto-actions-"));
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
    runId: input.runId ?? "mwf-auto-actions",
    emit: input.emit ?? true,
    reason: input.reason ?? "in_progress",
    recommendedAction: input.recommendedAction ?? "poll",
    recommendedActionPolicy: input.recommendedActionPolicy ?? {
      action: "watch_recheck",
      authority: "auto_allowed",
      risk: "low",
      evidenceRequired: ["fresh watch envelope", "durable workflow rows"],
      rollback: "Stop polling; no external state was changed by the policy.",
      rationale:
        "Supervisor watch rechecks are explicitly allowlisted for local/read-only polling metadata."
    },
    nextPollSeconds: input.nextPollSeconds ?? 15,
    humanAction: input.humanAction ?? null,
    cleanup: input.cleanup ?? "none",
    digest: input.digest ?? "sha256:auto-progress",
    cursor: input.cursor ?? null,
    phase: input.phase ?? "advancing",
    stuckRisk: input.stuckRisk ?? "low",
    inspectionCommand: input.inspectionCommand ?? null
  };
}

function releasePolicy() {
  return {
    action: "release_monitor",
    authority: "auto_allowed" as const,
    risk: "low" as const,
    evidenceRequired: ["terminal run state", "cleanup release signal"],
    rollback:
      "Re-register or resume the external monitor if more observation is needed.",
    rationale:
      "Releasing a supervisor monitor after terminal evidence only affects local/host polling registration."
  };
}

describe("OpenClaw supervisor auto-actions", () => {
  it("records durable audit evidence before applying an auto-allowed monitor release", () => {
    const dataDir = makeTempDir();
    const tick = buildOpenClawSupervisorTick({
      priorState: null,
      watch: watch({
        reason: "terminal_succeeded",
        recommendedAction: "release",
        recommendedActionPolicy: releasePolicy(),
        cleanup: "release",
        digest: "sha256:terminal",
        nextPollSeconds: 0,
        phase: "terminal"
      }),
      now: NOW
    });

    const result = executeOpenClawSupervisorAutoAction({
      dataDir,
      priorState: null,
      tick,
      now: NOW,
      enabled: true
    });

    expect(result.tick).toMatchObject({
      cleanupAction: "remove_monitor",
      monitorEnabled: false,
      nextState: {
        disabled: true
      }
    });
    expect(result.autoAction).toMatchObject({
      actionType: "release_monitor",
      policyAction: "release_monitor",
      reason: "terminal_succeeded",
      result: "success",
      escalation: null
    });

    const records = loadOpenClawSupervisorAutoActionAudit(
      dataDir,
      "mwf-auto-actions"
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      actionType: "release_monitor",
      policyAction: "release_monitor",
      reason: "terminal_succeeded",
      beforeDigest: null,
      afterDigest: "sha256:terminal",
      beforeState: null,
      afterState: {
        disabled: true,
        lastDigest: "sha256:terminal"
      },
      timestamp: NOW,
      result: "success",
      escalation: null
    });
  });

  it("keeps the monitor enabled and audits when auto-actions are disabled", () => {
    const dataDir = makeTempDir();
    const tick = buildOpenClawSupervisorTick({
      priorState: null,
      watch: watch({
        reason: "terminal_succeeded",
        recommendedAction: "release",
        recommendedActionPolicy: releasePolicy(),
        cleanup: "release",
        digest: "sha256:terminal-disabled",
        nextPollSeconds: 0,
        phase: "terminal"
      }),
      now: NOW
    });

    const result = executeOpenClawSupervisorAutoAction({
      dataDir,
      priorState: null,
      tick,
      now: NOW,
      enabled: false
    });

    expect(result.tick).toMatchObject({
      emit: true,
      cleanupAction: null,
      monitorEnabled: true,
      nextPollSeconds: 30,
      deliveryIntent: {
        severity: "action_required",
        cleanup: null
      },
      nextState: {
        disabled: false
      }
    });
    expect(result.autoAction).toMatchObject({
      actionType: "release_monitor",
      result: "skipped",
      escalation: "human_required"
    });
    expect(result.tick.recommendedActionPolicy).toMatchObject({
      action: "release_monitor",
      authority: "human_required",
      risk: "high"
    });
    expect(
      loadOpenClawSupervisorAutoActionAudit(dataDir, "mwf-auto-actions")
    ).toMatchObject([
      {
        actionType: "release_monitor",
        result: "skipped",
        afterState: {
          disabled: false
        }
      }
    ]);
  });

  it("leaves benign polling recommendations unchanged when auto-actions are disabled", () => {
    const dataDir = makeTempDir();
    const tick = buildOpenClawSupervisorTick({
      priorState: null,
      watch: watch({
        recommendedAction: "poll",
        recommendedActionPolicy: {
          action: "watch_recheck",
          authority: "auto_allowed",
          risk: "low",
          evidenceRequired: ["fresh watch envelope", "durable workflow rows"],
          rollback: "Stop polling; no external state was changed by the policy.",
          rationale:
            "Supervisor watch rechecks are explicitly allowlisted for local/read-only polling metadata."
        },
        digest: "sha256:poll-disabled"
      }),
      now: NOW
    });

    const result = executeOpenClawSupervisorAutoAction({
      dataDir,
      priorState: null,
      tick,
      now: NOW,
      enabled: false
    });

    expect(result.tick).toBe(tick);
    expect(result.autoAction).toBeNull();
    expect(result.tick.recommendedActionPolicy).toMatchObject({
      action: "watch_recheck",
      authority: "auto_allowed",
      risk: "low"
    });
  });

  it("fails closed when required escalation audit evidence cannot be written", () => {
    const dataDir = makeTempDir();
    const auditDir = path.join(dataDir, "openclaw-supervisor");
    fs.mkdirSync(
      path.join(auditDir, `${encodeURIComponent("mwf-auto-actions")}.auto-actions.jsonl`),
      { recursive: true }
    );
    const tick = buildOpenClawSupervisorTick({
      priorState: null,
      watch: watch({
        recommendedActionPolicy: {
          action: "future_auto_unblock",
          authority: "auto_allowed",
          risk: "low",
          evidenceRequired: ["future policy evidence"],
          rollback: "Stop polling.",
          rationale: "Future policy has not been implemented locally."
        },
        digest: "sha256:unsupported-audit-failed"
      }),
      now: NOW
    });

    const result = executeOpenClawSupervisorAutoAction({
      dataDir,
      priorState: null,
      tick,
      now: NOW,
      enabled: true
    });

    expect(result.autoAction).toMatchObject({
      actionType: "future_auto_unblock",
      result: "failed",
      escalation: "human_required"
    });
    expect(result.autoAction?.error).toContain("auto-actions.jsonl");
  });

  it("does not run or audit human-required recommendations", () => {
    const dataDir = makeTempDir();
    const tick = buildOpenClawSupervisorTick({
      priorState: null,
      watch: watch({
        reason: "awaiting_approval",
        recommendedAction: "approve",
        recommendedActionPolicy: {
          action: "approval_decision",
          authority: "human_required",
          risk: "medium",
          evidenceRequired: ["open approval gate", "operator approval phrase"],
          rollback:
            "Clear or supersede the approval through the normal workflow gate path.",
          rationale:
            "Approval changes the authorized execution envelope and must remain operator-gated."
        },
        humanAction: {
          code: "approve",
          command:
            "momentum workflow run approve mwf-auto-actions --approval-boundary through-implementation",
          detail: null
        },
        digest: "sha256:approval"
      }),
      now: NOW
    });

    const result = executeOpenClawSupervisorAutoAction({
      dataDir,
      priorState: null,
      tick,
      now: NOW,
      enabled: true
    });

    expect(result.tick).toBe(tick);
    expect(result.autoAction).toBeNull();
    expect(
      loadOpenClawSupervisorAutoActionAudit(dataDir, "mwf-auto-actions")
    ).toEqual([]);
  });

  it("fails closed when an auto-allowed policy action is unsupported", () => {
    const dataDir = makeTempDir();
    const tick = buildOpenClawSupervisorTick({
      priorState: null,
      watch: watch({
        recommendedActionPolicy: {
          action: "future_auto_unblock",
          authority: "auto_allowed",
          risk: "low",
          evidenceRequired: ["future policy evidence"],
          rollback: "Stop polling.",
          rationale: "Future policy has not been implemented locally."
        },
        digest: "sha256:future"
      }),
      now: NOW
    });

    const result = executeOpenClawSupervisorAutoAction({
      dataDir,
      priorState: null,
      tick,
      now: NOW,
      enabled: true
    });

    expect(result.autoAction).toMatchObject({
      actionType: "future_auto_unblock",
      result: "skipped",
      escalation: "human_required",
      error: "Unsupported auto-allowed supervisor action."
    });
    expect(result.tick.recommendedActionPolicy).toMatchObject({
      action: "future_auto_unblock",
      authority: "human_required",
      risk: "high"
    });
    expect(result.tick.stateChanged).toBe(true);
  });

  it("fails closed for unsupported auto-allowed actions when auto-actions are disabled", () => {
    const dataDir = makeTempDir();
    const tick = buildOpenClawSupervisorTick({
      priorState: null,
      watch: watch({
        recommendedActionPolicy: {
          action: "future_auto_unblock",
          authority: "auto_allowed",
          risk: "low",
          evidenceRequired: ["future policy evidence"],
          rollback: "Stop polling.",
          rationale: "Future policy has not been implemented locally."
        },
        digest: "sha256:future-disabled"
      }),
      now: NOW
    });

    const result = executeOpenClawSupervisorAutoAction({
      dataDir,
      priorState: null,
      tick,
      now: NOW,
      enabled: false
    });

    expect(result.autoAction).toMatchObject({
      actionType: "future_auto_unblock",
      result: "skipped",
      escalation: "human_required",
      error: "Unsupported auto-allowed supervisor action."
    });
    expect(result.tick.recommendedActionPolicy).toMatchObject({
      action: "future_auto_unblock",
      authority: "human_required",
      risk: "high"
    });
    expect(result.tick.stateChanged).toBe(true);
  });

  it("escalates when repeated release attempts pass the bounded limit", () => {
    const dataDir = makeTempDir();
    const firstTick = buildOpenClawSupervisorTick({
      priorState: null,
      watch: watch({
        reason: "terminal_succeeded",
        recommendedAction: "release",
        recommendedActionPolicy: releasePolicy(),
        cleanup: "release",
        digest: "sha256:terminal-repeat",
        nextPollSeconds: 0,
        phase: "terminal"
      }),
      now: NOW
    });

    for (let index = 0; index < 3; index += 1) {
      const attempt = executeOpenClawSupervisorAutoAction({
        dataDir,
        priorState: null,
        tick: firstTick,
        now: NOW + index,
        enabled: true
      });
      if (attempt.autoAction !== null) {
        recordOpenClawSupervisorAutoActionStatePersistence(
          dataDir,
          "mwf-auto-actions",
          attempt.autoAction,
          "saved"
        );
      }
    }

    const result = executeOpenClawSupervisorAutoAction({
      dataDir,
      priorState: null,
      tick: firstTick,
      now: NOW + 10_000,
      enabled: true
    });

    expect(result.autoAction).toMatchObject({
      actionType: "release_monitor",
      result: "skipped",
      escalation: "human_required",
      error: "Auto-action repeat limit exceeded."
    });
    expect(result.tick.recommendedActionPolicy).toMatchObject({
      action: "release_monitor",
      authority: "human_required",
      risk: "high"
    });
    expect(result.tick).toMatchObject({
      cleanupAction: null,
      monitorEnabled: true,
      nextPollSeconds: 30,
      nextState: {
        disabled: false
      }
    });
    const records = loadOpenClawSupervisorAutoActionAudit(
      dataDir,
      "mwf-auto-actions"
    );
    expect(records.at(-1)).toMatchObject({
      result: "skipped",
      afterState: {
        disabled: false
      }
    });
  });

  it("does not let the repeat limit re-enable an already disabled monitor", () => {
    const dataDir = makeTempDir();
    const disabledState = {
      version: 1 as const,
      runId: "mwf-auto-actions",
      lastCursor: "wfcur1.done",
      lastDigest: "sha256:terminal-disabled-repeat",
      lastReason: "terminal_succeeded",
      lastHumanUpdateAt: NOW,
      disabled: true,
      updatedAt: NOW
    };
    saveOpenClawSupervisorState(dataDir, disabledState);
    const disabledTick = buildOpenClawSupervisorDisabledTick({
      runId: "mwf-auto-actions",
      state: disabledState,
      now: NOW + 1_000
    });

    for (let index = 0; index < 3; index += 1) {
      executeOpenClawSupervisorAutoAction({
        dataDir,
        priorState: disabledState,
        tick: disabledTick,
        now: NOW + index,
        enabled: true
      });
    }

    const result = executeOpenClawSupervisorAutoAction({
      dataDir,
      priorState: disabledState,
      tick: disabledTick,
      now: NOW + 10_000,
      enabled: true
    });

    expect(result.tick).toMatchObject({
      monitorEnabled: false,
      cleanupAction: "remove_monitor",
      nextState: {
        disabled: true
      }
    });
    expect(result.autoAction).toMatchObject({
      actionType: "release_monitor",
      result: "success",
      escalation: null
    });
  });

  it("does not let unreadable audit evidence re-enable an already disabled monitor", () => {
    const dataDir = makeTempDir();
    const disabledState = {
      version: 1 as const,
      runId: "mwf-auto-actions",
      lastCursor: "wfcur1.done",
      lastDigest: "sha256:terminal-disabled-corrupt-audit",
      lastReason: "terminal_succeeded",
      lastHumanUpdateAt: NOW,
      disabled: true,
      updatedAt: NOW
    };
    const auditDir = path.join(dataDir, "openclaw-supervisor");
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(
      path.join(auditDir, `${encodeURIComponent("mwf-auto-actions")}.auto-actions.jsonl`),
      "{not-json}\n"
    );
    const disabledTick = buildOpenClawSupervisorDisabledTick({
      runId: "mwf-auto-actions",
      state: disabledState,
      now: NOW + 1_000
    });

    const result = executeOpenClawSupervisorAutoAction({
      dataDir,
      priorState: disabledState,
      tick: disabledTick,
      now: NOW + 10_000,
      enabled: true
    });

    expect(result.tick).toMatchObject({
      emit: true,
      eventType: "terminal",
      monitorEnabled: false,
      cleanupAction: "remove_monitor",
      recommendedActionPolicy: {
        authority: "human_required",
        risk: "high"
      },
      deliveryIntent: {
        kind: "terminal",
        severity: "action_required",
        cleanup: {
          action: "remove_monitor"
        }
      },
      nextState: {
        disabled: true
      }
    });
    expect(result.autoAction).toMatchObject({
      actionType: "release_monitor",
      result: "skipped",
      escalation: "human_required",
      error: "Auto-action audit evidence is unreadable."
    });
  });

  it("escalates when prior audit evidence is unreadable", () => {
    const dataDir = makeTempDir();
    const auditDir = path.join(dataDir, "openclaw-supervisor");
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(
      path.join(auditDir, `${encodeURIComponent("mwf-auto-actions")}.auto-actions.jsonl`),
      "{not-json}\n"
    );
    const tick = buildOpenClawSupervisorTick({
      priorState: null,
      watch: watch({
        reason: "terminal_succeeded",
        recommendedAction: "release",
        recommendedActionPolicy: releasePolicy(),
        cleanup: "release",
        digest: "sha256:terminal-corrupt-audit",
        nextPollSeconds: 0,
        phase: "terminal"
      }),
      now: NOW
    });

    const result = executeOpenClawSupervisorAutoAction({
      dataDir,
      priorState: null,
      tick,
      now: NOW,
      enabled: true
    });

    expect(result.autoAction).toMatchObject({
      actionType: "release_monitor",
      result: "skipped",
      escalation: "human_required",
      error: "Auto-action audit evidence is unreadable."
    });
    expect(result.tick.recommendedActionPolicy).toMatchObject({
      action: "release_monitor",
      authority: "human_required",
      risk: "high"
    });
    expect(result.tick).toMatchObject({
      emit: true,
      deliveryIntent: {
        severity: "action_required"
      },
      cleanupAction: null,
      monitorEnabled: true,
      nextState: {
        disabled: false
      }
    });
  });

  it("escalates and preserves the monitor when audit evidence cannot be written", () => {
    const dataDir = makeTempDir();
    fs.writeFileSync(path.join(dataDir, "openclaw-supervisor"), "blocked");
    const tick = buildOpenClawSupervisorTick({
      priorState: null,
      watch: watch({
        reason: "terminal_succeeded",
        recommendedAction: "release",
        recommendedActionPolicy: releasePolicy(),
        cleanup: "release",
        digest: "sha256:audit-failed",
        nextPollSeconds: 0,
        phase: "terminal"
      }),
      now: NOW
    });

    const result = executeOpenClawSupervisorAutoAction({
      dataDir,
      priorState: null,
      tick,
      now: NOW,
      enabled: true
    });

    expect(result.autoAction).toMatchObject({
      actionType: "release_monitor",
      result: "failed",
      escalation: "human_required"
    });
    expect(result.tick.recommendedActionPolicy).toMatchObject({
      action: "release_monitor",
      authority: "human_required",
      risk: "high"
    });
    expect(result.autoAction?.error).toContain("openclaw-supervisor");
    expect(result.autoAction?.afterState).toMatchObject({
      disabled: false
    });
    expect(result.tick).toMatchObject({
      emit: true,
      deliveryIntent: {
        severity: "action_required"
      },
      cleanupAction: null,
      monitorEnabled: true,
      nextState: {
        disabled: false
      }
    });
  });
});
