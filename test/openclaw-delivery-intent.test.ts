import { describe, expect, it } from "vitest";

import {
  buildOpenClawSupervisorTick,
  type OpenClawSupervisorWatchEnvelope
} from "../src/core/openclaw/supervisor.js";
import { buildOpenClawDeliveryIntent } from "../src/core/openclaw/delivery-intent.js";

const NOW = 1_730_001_000_000;

function watch(
  input: Partial<OpenClawSupervisorWatchEnvelope>
): OpenClawSupervisorWatchEnvelope {
  return {
    ok: true,
    command: "workflow run watch",
    mode: "once",
    runId: input.runId ?? "cwfp-openclaw-delivery",
    emit: input.emit ?? true,
    reason: input.reason ?? "in_progress",
    recommendedAction: input.recommendedAction ?? "poll",
    nextPollSeconds: input.nextPollSeconds ?? 15,
    humanAction: input.humanAction ?? null,
    cleanup: input.cleanup ?? "none",
    digest: input.digest ?? "sha256:delivery",
    cursor: input.cursor ?? null,
    phase: input.phase ?? "advancing",
    stuckRisk: input.stuckRisk ?? "low",
    inspectionCommand: input.inspectionCommand ?? null
  };
}

function tick(input: Partial<OpenClawSupervisorWatchEnvelope>) {
  return buildOpenClawSupervisorTick({
    priorState: null,
    watch: watch(input),
    now: NOW
  });
}

describe("buildOpenClawDeliveryIntent", () => {
  it("formats progress as a concise Discord-safe message intent", () => {
    const intent = buildOpenClawDeliveryIntent(
      tick({
        reason: "in_progress",
        recommendedAction: "poll",
        nextPollSeconds: 30,
        digest: "sha256:progress"
      })
    );

    expect(intent).toMatchObject({
      kind: "progress",
      severity: "info",
      text:
        "cwfp-openclaw-delivery is progressing. Next check in 30s.",
      action: null,
      cleanup: null,
      message: {
        platform: "discord",
        format: "plain_text",
        allowedMentions: "none"
      },
      wake: {
        target: "openclaw",
        intent: "message",
        reason: "progress"
      },
      dedupeKey:
        "openclaw-delivery:cwfp-openclaw-delivery:in_progress:sha256:progress",
      reminderKey: null,
      failure: {
        retryable: true,
        logLevel: "warn",
        stateImpact: "none"
      }
    });
    expect(intent?.text.length).toBeLessThanOrEqual(280);
  });

  it("formats approval asks with the exact operator command and reminder key", () => {
    const intent = buildOpenClawDeliveryIntent(
      tick({
        reason: "quiet_heartbeat",
        recommendedAction: "approve",
        humanAction: {
          code: "approve",
          command:
            "momentum workflow run approve cwfp-openclaw-delivery --approval-boundary through-implementation",
          detail: null
        },
        digest: "sha256:approval"
      })
    );

    expect(intent).toMatchObject({
      kind: "approval",
      severity: "action_required",
      text:
        "Approval needed for cwfp-openclaw-delivery. Run: momentum workflow run approve cwfp-openclaw-delivery --approval-boundary through-implementation",
      action: {
        command:
          "momentum workflow run approve cwfp-openclaw-delivery --approval-boundary through-implementation",
        evidence: null
      },
      wake: {
        intent: "wake",
        reason: "approval"
      },
      reminderKey: "openclaw-reminder:cwfp-openclaw-delivery:approval"
    });
  });

  it("formats recovery asks with evidence and a safe command", () => {
    const intent = buildOpenClawDeliveryIntent(
      tick({
        reason: "recovery_required",
        recommendedAction: "recover",
        humanAction: {
          code: "clear_recovery",
          command:
            "momentum workflow run clear-recovery cwfp-openclaw-delivery --evidence-pointer ledger:abc",
          detail: "Attach failing-step evidence before clearing recovery."
        },
        digest: "sha256:recovery"
      })
    );

    expect(intent).toMatchObject({
      kind: "recovery",
      severity: "action_required",
      text:
        "Recovery evidence needed for cwfp-openclaw-delivery. Evidence: Attach failing-step evidence before clearing recovery. Safe command: momentum workflow run clear-recovery cwfp-openclaw-delivery --evidence-pointer ledger:abc",
      action: {
        command:
          "momentum workflow run clear-recovery cwfp-openclaw-delivery --evidence-pointer ledger:abc",
        evidence: "Attach failing-step evidence before clearing recovery."
      },
      wake: {
        intent: "wake",
        reason: "recovery"
      },
      reminderKey: "openclaw-reminder:cwfp-openclaw-delivery:recovery"
    });
  });

  it("clamps Discord text to the advertised max length", () => {
    const intent = buildOpenClawDeliveryIntent(
      tick({
        reason: "recovery_required",
        recommendedAction: "recover",
        humanAction: {
          code: "clear_recovery",
          command: `momentum workflow run clear-recovery cwfp-openclaw-delivery --evidence-pointer ${"ledger-long".repeat(250)}`,
          detail: "Evidence ".repeat(300)
        },
        digest: "sha256:recovery-long"
      })
    );

    expect(intent).not.toBeNull();
    expect(intent?.text.length).toBeLessThanOrEqual(
      intent?.message.maxLength ?? 0
    );
    expect(intent?.text.endsWith("... [truncated]")).toBe(true);
  });

  it("formats stuck-risk diagnostics with an inspection command", () => {
    const intent = buildOpenClawDeliveryIntent(
      tick({
        reason: "stuck_risk",
        stuckRisk: "high",
        inspectionCommand:
          "momentum workflow run monitor cwfp-openclaw-delivery --advance --json",
        digest: "sha256:stuck"
      })
    );

    expect(intent).toMatchObject({
      kind: "stuck-risk",
      severity: "warning",
      text:
        "Stuck risk is high for cwfp-openclaw-delivery. Inspect: momentum workflow run monitor cwfp-openclaw-delivery --advance --json",
      action: {
        command:
          "momentum workflow run monitor cwfp-openclaw-delivery --advance --json",
        evidence: "stuckRisk=high"
      },
      wake: {
        intent: "wake",
        reason: "stuck-risk"
      },
      reminderKey: "openclaw-reminder:cwfp-openclaw-delivery:stuck-risk"
    });
  });

  it("formats terminal cleanup as a final summary and remove-monitor hint", () => {
    const intent = buildOpenClawDeliveryIntent(
      tick({
        reason: "terminal_succeeded",
        cleanup: "release",
        digest: "sha256:done",
        nextPollSeconds: 0
      })
    );

    expect(intent).toMatchObject({
      kind: "terminal",
      severity: "success",
      text:
        "cwfp-openclaw-delivery finished successfully. Remove the OpenClaw monitor.",
      action: null,
      cleanup: {
        action: "remove_monitor",
        hint: "Stop polling this run and remove the external monitor registration."
      },
      wake: {
        intent: "message",
        reason: "terminal"
      },
      reminderKey: null
    });
  });

  it("returns null for repeated unchanged ticks but preserves due reminders", () => {
    const first = buildOpenClawSupervisorTick({
      priorState: null,
      watch: watch({
        reason: "in_progress",
        digest: "sha256:repeat"
      }),
      now: NOW
    });
    const duplicate = buildOpenClawSupervisorTick({
      priorState: first.nextState,
      watch: watch({
        reason: "in_progress",
        digest: "sha256:repeat"
      }),
      now: NOW + 1_000
    });
    const reminder = buildOpenClawSupervisorTick({
      priorState: first.nextState,
      watch: watch({
        reason: "quiet_heartbeat",
        recommendedAction: "approve",
        humanAction: {
          code: "approve",
          command:
            "momentum workflow run approve cwfp-openclaw-delivery --approval-boundary through-implementation",
          detail: null
        },
        digest: "sha256:repeat"
      }),
      now: NOW + 60_000
    });

    expect(buildOpenClawDeliveryIntent(duplicate)).toBeNull();
    expect(buildOpenClawDeliveryIntent(reminder)).toMatchObject({
      kind: "approval",
      reminderKey: "openclaw-reminder:cwfp-openclaw-delivery:approval"
    });
  });

  it("uses distinct dedupe keys for intentionally repeated reminders", () => {
    const firstApproval = buildOpenClawSupervisorTick({
      priorState: null,
      watch: watch({
        reason: "quiet_heartbeat",
        recommendedAction: "approve",
        humanAction: {
          code: "approve",
          command:
            "momentum workflow run approve cwfp-openclaw-delivery --approval-boundary through-implementation",
          detail: null
        },
        digest: "sha256:approval-repeat"
      }),
      now: NOW
    });
    const secondApproval = buildOpenClawSupervisorTick({
      priorState: firstApproval.nextState,
      watch: watch({
        reason: "quiet_heartbeat",
        recommendedAction: "approve",
        humanAction: {
          code: "approve",
          command:
            "momentum workflow run approve cwfp-openclaw-delivery --approval-boundary through-implementation",
          detail: null
        },
        digest: "sha256:approval-repeat"
      }),
      now: NOW + 60_000
    });

    expect(firstApproval.deliveryIntent?.reminderKey).toBe(
      secondApproval.deliveryIntent?.reminderKey
    );
    expect(firstApproval.deliveryIntent?.dedupeKey).not.toBe(
      secondApproval.deliveryIntent?.dedupeKey
    );
    expect(secondApproval.deliveryIntent?.dedupeKey).toContain(
      String(NOW + 60_000)
    );

    const firstStuck = buildOpenClawSupervisorTick({
      priorState: null,
      watch: watch({
        reason: "stuck_risk",
        stuckRisk: "high",
        inspectionCommand:
          "momentum workflow run monitor cwfp-openclaw-delivery --advance --json",
        digest: "sha256:stuck-repeat"
      }),
      now: NOW
    });
    const secondStuck = buildOpenClawSupervisorTick({
      priorState: firstStuck.nextState,
      watch: watch({
        reason: "stuck_risk",
        stuckRisk: "high",
        inspectionCommand:
          "momentum workflow run monitor cwfp-openclaw-delivery --advance --json",
        digest: "sha256:stuck-repeat"
      }),
      now: NOW + 120_000
    });

    expect(firstStuck.deliveryIntent?.reminderKey).toBe(
      secondStuck.deliveryIntent?.reminderKey
    );
    expect(firstStuck.deliveryIntent?.dedupeKey).not.toBe(
      secondStuck.deliveryIntent?.dedupeKey
    );
    expect(secondStuck.deliveryIntent?.dedupeKey).toContain(
      String(NOW + 120_000)
    );
  });
});
