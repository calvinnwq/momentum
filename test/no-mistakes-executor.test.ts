import { describe, expect, it } from "vitest";

import {
  EXECUTOR_COMPLETION_CLASSIFICATIONS,
  EXECUTOR_HUMAN_GATE_TYPES,
  EXECUTOR_ATTEMPT_TERMINAL_STATES,
  EXECUTOR_ROUND_TERMINAL_STATES,
  transitionExecutorAttempt,
  transitionExecutorRound,
} from "../src/core/executors/loop/reducer.js";
import { isWorkflowExecutorFamily } from "../src/core/workflow/definition/definition.js";
import {
  NO_MISTAKES_CI_STATES,
  NO_MISTAKES_EXECUTOR_FAMILIES,
  NO_MISTAKES_EXECUTOR_FAMILY,
  NO_MISTAKES_EXTERNAL_STEP_STATUSES,
  NO_MISTAKES_RECOVERY_CODES,
  decideNoMistakesMirror,
  decideNoMistakesUnreadable,
  isNoMistakesExecutorFamily,
  noMistakesAttemptId,
  noMistakesRoundId,
  noMistakesRoundUpdate,
  planNoMistakesAttempt,
  planNoMistakesRoundDecisions,
  planNoMistakesRoundFindings,
  planNoMistakesRoundPersistence,
  planNoMistakesRoundStart,
  type NoMistakesExternalState,
} from "../src/adapters/no-mistakes-executor.js";

const COMPLETION_SET = new Set<string>(EXECUTOR_COMPLETION_CLASSIFICATIONS);
const ROUND_TERMINAL_SET = new Set<string>(EXECUTOR_ROUND_TERMINAL_STATES);
const ATTEMPT_TERMINAL_SET = new Set<string>(EXECUTOR_ATTEMPT_TERMINAL_STATES);
const HUMAN_GATE_SET = new Set<string>(EXECUTOR_HUMAN_GATE_TYPES);

const HEAD_SHA = "a".repeat(40);

/**
 * A well-formed external no-mistakes snapshot. The base is mid-run (`running`)
 * with one selected finding and no open decisions; individual tests override the
 * fields under test.
 */
function externalState(
  overrides: Partial<NoMistakesExternalState> = {},
): NoMistakesExternalState {
  return {
    externalRunId: "nm-run-1",
    branch: "feat/ngx-351",
    headSha: HEAD_SHA,
    activeStep: overrides.stepStatus === "completed" ? null : "review",
    stepStatus: "running",
    findings: [
      {
        externalId: "F-1",
        severity: "high",
        title: "missing test",
        detail: "x",
      },
    ],
    selectedFindingIds: ["F-1"],
    decisions: [],
    prUrl: "https://github.com/x/y/pull/1",
    ciState: "pending",
    ...overrides,
  };
}

describe("no-mistakes executor family", () => {
  it("serves exactly the no-mistakes executor family", () => {
    expect(NO_MISTAKES_EXECUTOR_FAMILY).toBe("no-mistakes");
    expect([...NO_MISTAKES_EXECUTOR_FAMILIES]).toEqual(["no-mistakes"]);
  });

  it("only names a real workflow executor family", () => {
    for (const family of NO_MISTAKES_EXECUTOR_FAMILIES) {
      expect(isWorkflowExecutorFamily(family)).toBe(true);
    }
  });

  it("recognizes the no-mistakes family and rejects the others", () => {
    expect(isNoMistakesExecutorFamily("no-mistakes")).toBe(true);
    expect(isNoMistakesExecutorFamily("goal-loop")).toBe(false);
    expect(isNoMistakesExecutorFamily("one-shot")).toBe(false);
    expect(isNoMistakesExecutorFamily("script")).toBe(false);
    expect(isNoMistakesExecutorFamily("external-apply")).toBe(false);
    expect(isNoMistakesExecutorFamily("subworkflow")).toBe(false);
  });
});

describe("no-mistakes external vocabulary", () => {
  it("pins the external step statuses it can mirror", () => {
    expect([...NO_MISTAKES_EXTERNAL_STEP_STATUSES].sort()).toEqual(
      [
        "awaiting_approval",
        "awaiting_decision",
        "blocked",
        "cancelled",
        "completed",
        "failed",
        "running",
      ].sort(),
    );
  });

  it("pins the CI states it can mirror", () => {
    expect([...NO_MISTAKES_CI_STATES].sort()).toEqual(
      ["failed", "none", "passed", "pending"].sort(),
    );
  });

  it("pins the recovery taxonomy for untrusted external state", () => {
    expect([...NO_MISTAKES_RECOVERY_CODES].sort()).toEqual(
      [
        "external_run_failed",
        "external_state_blocked",
        "external_state_inconsistent",
        "external_state_unreadable",
      ].sort(),
    );
  });
});

describe("decideNoMistakesMirror — still running", () => {
  it("keeps mirroring an in-progress external run without a gate", () => {
    const decision = decideNoMistakesMirror(
      externalState({ stepStatus: "running" }),
    );
    expect(decision.classification).toBe("continue");
    expect(decision.roundState).toBe("mirroring_external_state");
    expect(decision.attemptState).toBe("running");
    expect(decision.humanGate).toBeNull();
    expect(decision.recoveryCode).toBeNull();
    expect(decision.reason.length).toBeGreaterThan(0);
  });
});

describe("decideNoMistakesMirror — human gates (daemon ownership preserved)", () => {
  it("surfaces an operator decision as a durable waiting_operator gate", () => {
    const decision = decideNoMistakesMirror(
      externalState({
        stepStatus: "awaiting_decision",
        decisions: [
          {
            externalId: "D-1",
            summary: "merge now or hold for review",
            allowedActions: ["merge", "hold"],
            recommendedAction: "hold",
          },
        ],
      }),
    );
    expect(decision.classification).toBe("operator_decision_required");
    expect(decision.roundState).toBe("waiting_operator");
    expect(decision.attemptState).toBe("waiting_operator");
    expect(decision.humanGate).toBe("operator_decision_required");
    expect(decision.recoveryCode).toBeNull();
  });

  it("surfaces an approval boundary as a durable waiting_operator gate", () => {
    const decision = decideNoMistakesMirror(
      externalState({ stepStatus: "awaiting_approval" }),
    );
    expect(decision.classification).toBe("approval_required");
    expect(decision.roundState).toBe("waiting_operator");
    expect(decision.attemptState).toBe("waiting_operator");
    expect(decision.humanGate).toBe("approval_required");
    expect(decision.recoveryCode).toBeNull();
  });

  it("never auto-resolves a decision: an awaiting_decision with no surfaced decision is inconsistent", () => {
    const decision = decideNoMistakesMirror(
      externalState({ stepStatus: "awaiting_decision", decisions: [] }),
    );
    expect(decision.classification).toBe("manual_recovery_required");
    expect(decision.recoveryCode).toBe("external_state_inconsistent");
    expect(decision.humanGate).toBe("manual_recovery_required");
  });

  it("does not gate on awaiting_decision when every surfaced decision is already resolved", () => {
    const decision = decideNoMistakesMirror(
      externalState({
        stepStatus: "awaiting_decision",
        decisions: [
          {
            externalId: "D-1",
            summary: "merge now or hold for review",
            allowedActions: ["merge", "hold"],
            chosenAction: "merge",
            resolution: "operator:merge",
          },
        ],
      }),
    );
    expect(decision.classification).toBe("manual_recovery_required");
    expect(decision.recoveryCode).toBe("external_state_inconsistent");
    expect(decision.humanGate).toBe("manual_recovery_required");
  });
});

describe("decideNoMistakesMirror — completion reconciled against evidence", () => {
  it("completes when CI passed and every decision is resolved", () => {
    const decision = decideNoMistakesMirror(
      externalState({
        stepStatus: "completed",
        ciState: "passed",
        findings: [],
        selectedFindingIds: [],
        decisions: [
          {
            externalId: "D-1",
            summary: "hold for review",
            allowedActions: ["merge", "hold"],
            chosenAction: "merge",
            resolution: "operator:merge",
          },
        ],
      }),
    );
    expect(decision.classification).toBe("complete");
    expect(decision.roundState).toBe("succeeded");
    expect(decision.attemptState).toBe("succeeded");
    expect(decision.humanGate).toBeNull();
    expect(decision.recoveryCode).toBeNull();
  });

  it("completes when no CI is configured and no decisions were needed", () => {
    const decision = decideNoMistakesMirror(
      externalState({
        stepStatus: "completed",
        ciState: "none",
        findings: [],
        selectedFindingIds: [],
        decisions: [],
      }),
    );
    expect(decision.classification).toBe("complete");
    expect(decision.roundState).toBe("succeeded");
  });

  it("accepts a delegated-policy resolution as a resolved decision", () => {
    const decision = decideNoMistakesMirror(
      externalState({
        stepStatus: "completed",
        ciState: "passed",
        findings: [],
        selectedFindingIds: [],
        decisions: [
          {
            externalId: "D-1",
            summary: "apply low-risk fix",
            allowedActions: ["apply", "hold"],
            chosenAction: "apply",
            resolution: "delegated:within-envelope",
          },
        ],
      }),
    );
    expect(decision.classification).toBe("complete");
  });

  it("refuses to trust a completed claim while CI is still failing", () => {
    const decision = decideNoMistakesMirror(
      externalState({ stepStatus: "completed", ciState: "failed" }),
    );
    expect(decision.classification).toBe("manual_recovery_required");
    expect(decision.recoveryCode).toBe("external_state_inconsistent");
    expect(decision.humanGate).toBe("manual_recovery_required");
  });

  it("refuses to trust a completed claim while CI is still pending", () => {
    const decision = decideNoMistakesMirror(
      externalState({ stepStatus: "completed", ciState: "pending" }),
    );
    expect(decision.classification).toBe("manual_recovery_required");
    expect(decision.recoveryCode).toBe("external_state_inconsistent");
  });

  it("refuses to trust a completed claim with an unresolved decision", () => {
    const decision = decideNoMistakesMirror(
      externalState({
        stepStatus: "completed",
        ciState: "passed",
        decisions: [
          {
            externalId: "D-1",
            summary: "merge now or hold",
            allowedActions: ["merge", "hold"],
          },
        ],
      }),
    );
    expect(decision.classification).toBe("manual_recovery_required");
    expect(decision.recoveryCode).toBe("external_state_inconsistent");
  });
});

describe("decideNoMistakesMirror — failure and blockage", () => {
  it("mirrors an external failure as a failed round", () => {
    const decision = decideNoMistakesMirror(
      externalState({ stepStatus: "failed" }),
    );
    expect(decision.classification).toBe("failed");
    expect(decision.roundState).toBe("failed");
    expect(decision.attemptState).toBe("failed");
    expect(decision.recoveryCode).toBe("external_run_failed");
    expect(decision.humanGate).toBeNull();
  });

  it("mirrors an external blockage as a blocked round awaiting external state", () => {
    const decision = decideNoMistakesMirror(
      externalState({ stepStatus: "blocked" }),
    );
    expect(decision.classification).toBe("blocked");
    expect(decision.roundState).toBe("blocked");
    expect(decision.attemptState).toBe("blocked");
    expect(decision.recoveryCode).toBe("external_state_blocked");
    expect(decision.humanGate).toBe("external_state_required");
  });
});

describe("decideNoMistakesMirror — untrusted external evidence routes to manual recovery", () => {
  it("rejects a malformed head SHA", () => {
    const decision = decideNoMistakesMirror(
      externalState({ headSha: "not-a-sha" }),
    );
    expect(decision.classification).toBe("manual_recovery_required");
    expect(decision.recoveryCode).toBe("external_state_unreadable");
    expect(decision.humanGate).toBe("manual_recovery_required");
  });

  it("rejects an empty external run id", () => {
    const decision = decideNoMistakesMirror(
      externalState({ externalRunId: "  " }),
    );
    expect(decision.recoveryCode).toBe("external_state_unreadable");
  });

  it("rejects a selected finding id that references no surfaced finding", () => {
    const decision = decideNoMistakesMirror(
      externalState({
        findings: [{ externalId: "F-1", title: "a" }],
        selectedFindingIds: ["F-2"],
      }),
    );
    expect(decision.recoveryCode).toBe("external_state_unreadable");
  });

  it("rejects a finding with an empty title", () => {
    const decision = decideNoMistakesMirror(
      externalState({
        findings: [{ externalId: "F-1", title: "  " }],
        selectedFindingIds: [],
      }),
    );
    expect(decision.recoveryCode).toBe("external_state_unreadable");
  });

  it("rejects a decision with no allowed actions", () => {
    const decision = decideNoMistakesMirror(
      externalState({
        stepStatus: "awaiting_decision",
        decisions: [{ externalId: "D-1", summary: "x", allowedActions: [] }],
      }),
    );
    expect(decision.recoveryCode).toBe("external_state_unreadable");
  });

  it("rejects a decision with only blank allowed actions", () => {
    const decision = decideNoMistakesMirror(
      externalState({
        stepStatus: "awaiting_decision",
        decisions: [
          { externalId: "D-1", summary: "x", allowedActions: ["  ", "\t"] },
        ],
      }),
    );
    expect(decision.classification).toBe("manual_recovery_required");
    expect(decision.recoveryCode).toBe("external_state_unreadable");
  });

  it("rejects duplicate finding ids", () => {
    const decision = decideNoMistakesMirror(
      externalState({
        findings: [
          { externalId: "F-1", title: "a" },
          { externalId: "F-1", title: "b" },
        ],
        selectedFindingIds: [],
      }),
    );
    expect(decision.recoveryCode).toBe("external_state_unreadable");
  });

  it("does not blindly trust an unknown external step status", () => {
    const decision = decideNoMistakesMirror(
      externalState({
        stepStatus: "totally_made_up" as NoMistakesExternalState["stepStatus"],
      }),
    );
    expect(decision.classification).toBe("manual_recovery_required");
    expect(decision.recoveryCode).toBe("external_state_unreadable");
  });
});

describe("decideNoMistakesMirror — totality", () => {
  it("maps every external step status to a coherent, reachable decision", () => {
    for (const stepStatus of NO_MISTAKES_EXTERNAL_STEP_STATUSES) {
      // Build a well-formed snapshot tailored so each status is self-consistent.
      const decision = decideNoMistakesMirror(
        externalState({
          stepStatus,
          ciState: stepStatus === "completed" ? "passed" : "pending",
          decisions:
            stepStatus === "awaiting_decision"
              ? [
                  {
                    externalId: "D-1",
                    summary: "decide",
                    allowedActions: ["a", "b"],
                  },
                ]
              : [],
        }),
      );
      expect(COMPLETION_SET.has(decision.classification)).toBe(true);
      if (decision.humanGate !== null) {
        expect(HUMAN_GATE_SET.has(decision.humanGate)).toBe(true);
      }
      // The mirror round lives in mirroring_external_state; every decided round
      // state must be reachable from there.
      const roundHop = transitionExecutorRound(
        "mirroring_external_state",
        decision.roundState,
      );
      expect(roundHop.ok).toBe(true);
      // The mirror attempt runs; every decided attempt state must be
      // reachable from running.
      const attemptHop = transitionExecutorAttempt(
        "running",
        decision.attemptState,
      );
      expect(attemptHop.ok).toBe(true);
      expect(decision.reason.length).toBeGreaterThan(0);
    }
  });

  it("only ever settles into terminal states that are actually terminal", () => {
    const terminal = decideNoMistakesMirror(
      externalState({ stepStatus: "failed" }),
    );
    expect(ROUND_TERMINAL_SET.has(terminal.roundState)).toBe(true);
    expect(ATTEMPT_TERMINAL_SET.has(terminal.attemptState)).toBe(true);
  });
});

describe("noMistakesAttemptId / noMistakesRoundId", () => {
  it("embeds the step-run identity, the family, and the attempt", () => {
    expect(noMistakesAttemptId("run1", "step1", 0)).toBe(
      "run1::step1::no-mistakes::0",
    );
    expect(noMistakesAttemptId("run1", "step1", 2)).toBe(
      "run1::step1::no-mistakes::2",
    );
  });

  it("distinguishes attempts so re-runs never collide", () => {
    const a = noMistakesAttemptId("run1", "step1", 0);
    const b = noMistakesAttemptId("run1", "step1", 1);
    expect(a).not.toBe(b);
  });

  it("mints a single deterministic round id under an attempt", () => {
    const attemptId = noMistakesAttemptId("run1", "step1", 0);
    const roundId = noMistakesRoundId(attemptId);
    expect(roundId).toContain(attemptId);
    expect(noMistakesRoundId(attemptId)).toBe(roundId);
  });
});

describe("planNoMistakesRoundFindings", () => {
  it("projects each external finding into a durable record marking the selected ones", () => {
    const records = planNoMistakesRoundFindings({
      roundId: "round-0",
      findings: [
        {
          externalId: "F-1",
          severity: "high",
          title: "missing test",
          detail: "x",
        },
        { externalId: "F-2", title: "naming nit" },
      ],
      selectedFindingIds: ["F-1"],
    });
    expect(records).toEqual([
      {
        findingId: "round-0-finding-F-1",
        roundId: "round-0",
        severity: "high",
        title: "missing test",
        detail: "x",
        selected: true,
        externalRef: "nomistakes:F-1",
      },
      {
        findingId: "round-0-finding-F-2",
        roundId: "round-0",
        severity: null,
        title: "naming nit",
        detail: null,
        selected: false,
        externalRef: "nomistakes:F-2",
      },
    ]);
  });

  it("returns no records when the external run surfaced no findings", () => {
    expect(
      planNoMistakesRoundFindings({
        roundId: "round-0",
        findings: [],
        selectedFindingIds: [],
      }),
    ).toEqual([]);
  });
});

describe("planNoMistakesRoundDecisions", () => {
  it("projects each external decision, mirroring its delegated-policy resolution", () => {
    const records = planNoMistakesRoundDecisions({
      roundId: "round-0",
      decisions: [
        {
          externalId: "D-1",
          summary: "merge now or hold for review",
          allowedActions: ["merge", "hold"],
          recommendedAction: "hold",
          chosenAction: "hold",
          resolution: "delegated:within-envelope",
        },
        {
          externalId: "D-2",
          summary: "apply low-risk fix",
          allowedActions: ["apply", "skip"],
        },
      ],
    });
    expect(records).toEqual([
      {
        decisionId: "round-0-decision-D-1",
        roundId: "round-0",
        summary: "merge now or hold for review",
        allowedActions: ["merge", "hold"],
        recommendedAction: "hold",
        chosenAction: "hold",
        resolution: "delegated:within-envelope",
        externalRef: "nomistakes:D-1",
      },
      {
        decisionId: "round-0-decision-D-2",
        roundId: "round-0",
        summary: "apply low-risk fix",
        allowedActions: ["apply", "skip"],
        recommendedAction: null,
        chosenAction: null,
        resolution: null,
        externalRef: "nomistakes:D-2",
      },
    ]);
  });

  it("returns no records when the external run surfaced no decisions", () => {
    expect(
      planNoMistakesRoundDecisions({ roundId: "round-0", decisions: [] }),
    ).toEqual([]);
  });
});

describe("planNoMistakesAttempt", () => {
  it("projects a step-run identity into a running no-mistakes attempt record", () => {
    const attempt = planNoMistakesAttempt({
      workflowRunId: "run1",
      stepRunId: "step1",
      stepKey: "no-mistakes",
      attemptNumber: 0,
      startedAt: 1000,
    });
    expect(attempt.attemptId).toBe(noMistakesAttemptId("run1", "step1", 0));
    expect(attempt.workflowRunId).toBe("run1");
    expect(attempt.stepRunId).toBe("step1");
    expect(attempt.stepKey).toBe("no-mistakes");
    expect(attempt.executorFamily).toBe("no-mistakes");
    expect(attempt.attemptNumber).toBe(0);
    expect(attempt.state).toBe("running");
    expect(attempt.startedAt).toBe(1000);
    expect(attempt.heartbeatAt).toBe(1000);
    expect(attempt.finishedAt).toBeNull();
  });

  it("mints a fresh attempt per attempt so a re-mirror never collides", () => {
    const first = planNoMistakesAttempt({
      workflowRunId: "run1",
      stepRunId: "step1",
      stepKey: "no-mistakes",
      attemptNumber: 0,
      startedAt: 1,
    });
    const second = planNoMistakesAttempt({
      workflowRunId: "run1",
      stepRunId: "step1",
      stepKey: "no-mistakes",
      attemptNumber: 1,
      startedAt: 2,
    });
    expect(first.attemptId).not.toBe(second.attemptId);
    expect(second.attemptNumber).toBe(1);
  });

  it("starts a running attempt that can legally settle to a terminal state", () => {
    const attempt = planNoMistakesAttempt({
      workflowRunId: "run1",
      stepRunId: "step1",
      stepKey: "no-mistakes",
      attemptNumber: 0,
      startedAt: 1,
    });
    const decision = decideNoMistakesMirror(
      externalState({ stepStatus: "failed" }),
    );
    const transition = transitionExecutorAttempt(
      attempt.state,
      decision.attemptState,
    );
    expect(transition.ok).toBe(true);
    expect(ATTEMPT_TERMINAL_SET.has(decision.attemptState)).toBe(true);
  });
});

describe("planNoMistakesRoundStart", () => {
  function attempt() {
    return planNoMistakesAttempt({
      workflowRunId: "run1",
      stepRunId: "step1",
      stepKey: "no-mistakes",
      attemptNumber: 0,
      startedAt: 1000,
    });
  }

  it("projects a single mirror round born in mirroring_external_state at index 0", () => {
    const round = planNoMistakesRoundStart({
      attempt: attempt(),
      runtime: {
        inputDigest: "sha256:abc",
        artifactRoot: "/tmp/run1/step1",
        logPaths: ["/tmp/run1/step1/mirror.log"],
      },
      startedAt: 2000,
    });

    expect(round.roundId).toBe(noMistakesRoundId(attempt().attemptId));
    expect(round.attemptId).toBe(attempt().attemptId);
    expect(round.workflowRunId).toBe("run1");
    expect(round.stepRunId).toBe("step1");
    expect(round.stepKey).toBe("no-mistakes");
    expect(round.executorFamily).toBe("no-mistakes");
    expect(round.attemptNumber).toBe(0);
    // The mirror is one long-lived round.
    expect(round.roundIndex).toBe(0);
    expect(round.state).toBe("mirroring_external_state");
    expect(round.classification).toBeNull();
    expect(round.startedAt).toBe(2000);
    expect(round.heartbeatAt).toBe(2000);
    expect(round.finishedAt).toBeNull();
    expect(round.inputDigest).toBe("sha256:abc");
    expect(round.artifactRoot).toBe("/tmp/run1/step1");
    expect(round.logPaths).toEqual(["/tmp/run1/step1/mirror.log"]);
    expect(round.summary).toBeNull();
    expect(round.keyChanges).toEqual([]);
    expect(round.remainingWork).toEqual([]);
    expect(round.changedFiles).toEqual([]);
    expect(round.verificationStatus).toBeNull();
    expect(round.commitSha).toBeNull();
    expect(round.recoveryCode).toBeNull();
    expect(round.humanGate).toBeNull();
  });

  it("resolves no Momentum agent/model/effort — no-mistakes owns its own pipeline", () => {
    const round = planNoMistakesRoundStart({
      attempt: attempt(),
      runtime: { inputDigest: null, artifactRoot: null },
      startedAt: 2000,
    });
    expect(round.agentProvider).toBeNull();
    expect(round.model).toBeNull();
    expect(round.effort).toBeNull();
    expect(round.logPaths).toEqual([]);
  });

  it("refuses to mirror a round under a non-no-mistakes attempt", () => {
    const foreign = { ...attempt(), executorFamily: "goal-loop" as const };
    expect(() =>
      planNoMistakesRoundStart({
        attempt: foreign,
        runtime: { inputDigest: null, artifactRoot: null },
        startedAt: 2000,
      }),
    ).toThrow(/non-no-mistakes family/);
  });

  it("is born in a state from which every decided round state is reachable", () => {
    const round = planNoMistakesRoundStart({
      attempt: attempt(),
      runtime: { inputDigest: null, artifactRoot: null },
      startedAt: 2000,
    });
    for (const stepStatus of NO_MISTAKES_EXTERNAL_STEP_STATUSES) {
      const decision = decideNoMistakesMirror(
        externalState({
          stepStatus,
          ciState: stepStatus === "completed" ? "passed" : "pending",
          decisions:
            stepStatus === "awaiting_decision"
              ? [
                  {
                    externalId: "D-1",
                    summary: "decide",
                    allowedActions: ["a"],
                  },
                ]
              : [],
        }),
      );
      const hop = transitionExecutorRound(round.state, decision.roundState);
      expect(hop.ok).toBe(true);
    }
  });
});

describe("planNoMistakesRoundPersistence", () => {
  function planFor(overrides: Partial<NoMistakesExternalState> = {}) {
    return planNoMistakesRoundPersistence({ state: externalState(overrides) });
  }

  it("keeps a still-running run mirroring with a continue classification", () => {
    const plan = planFor({ stepStatus: "running" });
    expect(plan.decision.classification).toBe("continue");
    expect(plan.roundUpdate.toState).toBe("mirroring_external_state");
    expect(plan.roundUpdate.classification).toBe("continue");
    expect(plan.roundUpdate.recoveryCode).toBeNull();
    expect(plan.roundUpdate.humanGate).toBeNull();
    expect(plan.roundUpdate.summary).toBe(plan.decision.reason);
  });

  it("re-mirroring a still-running round is a legal same-state heartbeat", () => {
    const round = planNoMistakesRoundStart({
      attempt: planNoMistakesAttempt({
        workflowRunId: "run1",
        stepRunId: "step1",
        stepKey: "no-mistakes",
        attemptNumber: 0,
        startedAt: 1,
      }),
      runtime: { inputDigest: null, artifactRoot: null },
      startedAt: 2,
    });
    const plan = planFor({ stepStatus: "running" });
    const hop = transitionExecutorRound(round.state, plan.roundUpdate.toState);
    expect(hop.ok).toBe(true);
  });

  it("turns an operator decision into a durable waiting_operator gate", () => {
    const plan = planFor({
      stepStatus: "awaiting_decision",
      decisions: [
        {
          externalId: "D-1",
          summary: "merge or hold",
          allowedActions: ["merge", "hold"],
        },
      ],
    });
    expect(plan.roundUpdate.toState).toBe("waiting_operator");
    expect(plan.roundUpdate.classification).toBe("operator_decision_required");
    expect(plan.roundUpdate.humanGate).toBe("operator_decision_required");
    expect(plan.roundUpdate.recoveryCode).toBeNull();
  });

  it("turns an approval boundary into a durable waiting_operator gate", () => {
    const plan = planFor({ stepStatus: "awaiting_approval" });
    expect(plan.roundUpdate.toState).toBe("waiting_operator");
    expect(plan.roundUpdate.classification).toBe("approval_required");
    expect(plan.roundUpdate.humanGate).toBe("approval_required");
  });

  it("completes a corroborated run into a succeeded round", () => {
    const plan = planFor({
      stepStatus: "completed",
      ciState: "passed",
      findings: [],
      selectedFindingIds: [],
      decisions: [],
    });
    expect(plan.roundUpdate.toState).toBe("succeeded");
    expect(plan.roundUpdate.classification).toBe("complete");
    expect(plan.roundUpdate.recoveryCode).toBeNull();
    expect(plan.roundUpdate.humanGate).toBeNull();
  });

  it("mirrors an external failure into a failed round with the failure recovery code", () => {
    const plan = planFor({ stepStatus: "failed" });
    expect(plan.roundUpdate.toState).toBe("failed");
    expect(plan.roundUpdate.classification).toBe("failed");
    expect(plan.roundUpdate.recoveryCode).toBe("external_run_failed");
  });

  it("mirrors an external blockage into a blocked round awaiting external state", () => {
    const plan = planFor({ stepStatus: "blocked" });
    expect(plan.roundUpdate.toState).toBe("blocked");
    expect(plan.roundUpdate.classification).toBe("blocked");
    expect(plan.roundUpdate.recoveryCode).toBe("external_state_blocked");
    expect(plan.roundUpdate.humanGate).toBe("external_state_required");
  });

  it("routes untrusted external state to a manual-recovery round", () => {
    const plan = planFor({ headSha: "not-a-sha" });
    expect(plan.roundUpdate.toState).toBe("manual_recovery_required");
    expect(plan.roundUpdate.classification).toBe("manual_recovery_required");
    expect(plan.roundUpdate.recoveryCode).toBe("external_state_unreadable");
    expect(plan.roundUpdate.humanGate).toBe("manual_recovery_required");
  });

  it("derives the patch from the decision so the two can never disagree", () => {
    for (const stepStatus of NO_MISTAKES_EXTERNAL_STEP_STATUSES) {
      const plan = planFor({
        stepStatus,
        ciState: stepStatus === "completed" ? "passed" : "pending",
        decisions:
          stepStatus === "awaiting_decision"
            ? [{ externalId: "D-1", summary: "decide", allowedActions: ["a"] }]
            : [],
      });
      expect(plan.roundUpdate.toState).toBe(plan.decision.roundState);
      expect(plan.roundUpdate.classification).toBe(
        plan.decision.classification,
      );
      expect(plan.roundUpdate.recoveryCode).toBe(plan.decision.recoveryCode);
      expect(plan.roundUpdate.humanGate).toBe(plan.decision.humanGate);
    }
  });
});

describe("noMistakesRoundUpdate", () => {
  it("projects a decision into the round patch fields verbatim", () => {
    const decision = decideNoMistakesMirror(
      externalState({ stepStatus: "running" }),
    );
    const update = noMistakesRoundUpdate(decision);
    expect(update.toState).toBe(decision.roundState);
    expect(update.classification).toBe(decision.classification);
    expect(update.recoveryCode).toBe(decision.recoveryCode);
    expect(update.humanGate).toBe(decision.humanGate);
    // The mirror has no normalized result document, so the decision reason is the
    // round's durable summary.
    expect(update.summary).toBe(decision.reason);
  });

  it("is exactly the patch planNoMistakesRoundPersistence carries, for every step status", () => {
    for (const stepStatus of NO_MISTAKES_EXTERNAL_STEP_STATUSES) {
      const state = externalState({
        stepStatus,
        ciState: stepStatus === "completed" ? "passed" : "pending",
        decisions:
          stepStatus === "awaiting_decision"
            ? [{ externalId: "D-1", summary: "decide", allowedActions: ["a"] }]
            : [],
      });
      const plan = planNoMistakesRoundPersistence({ state });
      // One source of truth: the persistence plan's patch is this projection of
      // its decision.
      expect(noMistakesRoundUpdate(plan.decision)).toEqual(plan.roundUpdate);
    }
  });
});

describe("decideNoMistakesUnreadable", () => {
  it("routes an external-state read failure to manual recovery as unreadable evidence", () => {
    const decision = decideNoMistakesUnreadable(
      "external no-mistakes state file is unreadable: ENOENT",
    );
    expect(decision.classification).toBe("manual_recovery_required");
    expect(decision.roundState).toBe("manual_recovery_required");
    expect(decision.attemptState).toBe("manual_recovery_required");
    expect(decision.humanGate).toBe("manual_recovery_required");
    expect(decision.recoveryCode).toBe("external_state_unreadable");
    // The reader's error is already a full sentence; it is preserved verbatim as
    // the decision reason rather than double-prefixed.
    expect(decision.reason).toBe(
      "external no-mistakes state file is unreadable: ENOENT",
    );
  });

  it("settles identically to a semantically unreadable snapshot (one classification authority)", () => {
    const fromReadFailure = decideNoMistakesUnreadable("bad bytes");
    const fromBadSnapshot = decideNoMistakesMirror(
      externalState({ headSha: "not-a-sha" }),
    );
    // A reader IO/JSON failure and a semantically broken snapshot are both
    // untrusted external evidence and settle the same way (modulo the reason).
    expect(fromReadFailure.classification).toBe(fromBadSnapshot.classification);
    expect(fromReadFailure.roundState).toBe(fromBadSnapshot.roundState);
    expect(fromReadFailure.attemptState).toBe(fromBadSnapshot.attemptState);
    expect(fromReadFailure.humanGate).toBe(fromBadSnapshot.humanGate);
    expect(fromReadFailure.recoveryCode).toBe(fromBadSnapshot.recoveryCode);
  });
});
