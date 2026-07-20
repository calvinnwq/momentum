import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import {
  insertExecutorDecision,
  insertExecutorFinding,
  insertExecutorAttempt,
  insertExecutorRound,
  listExecutorDecisionsForRound,
  listExecutorFindingsForRound,
  loadExecutorRound,
  updateExecutorRound,
} from "../src/core/executors/loop/persist.js";
import {
  noMistakesInvocationId,
  noMistakesRoundId,
  planNoMistakesInvocation,
  planNoMistakesRoundDecisions,
  planNoMistakesRoundFindings,
  planNoMistakesRoundPersistence,
  planNoMistakesRoundStart,
  type NoMistakesExternalState,
} from "../src/adapters/no-mistakes-executor.js";

// Integration twin of the pure projections in no-mistakes-executor.test.ts: this
// drives the mirror's durable invocation + round-start records and the per-poll
// round persistence plan through the *real* M10-03 executor-loop persistence layer
// and round transition graph, and round-trips the findings / decisions projections
// through real SQLite. The pure tests assert the decision/projection *shape*; this
// asserts that the real durable layer actually honors the mirror-specific lifecycle:
//
//   - The single long-lived round is born directly in `mirroring_external_state`
//     with no agent/model/effort and no result document (no-mistakes owns its own
//     pipeline; the mirror only reflects external state).
//   - A still-`running` external run heartbeats the round *in place* — a same-state
//     `mirroring_external_state` -> `mirroring_external_state` transition the graph
//     allows via its `from === to` shortcut, the mirror's `continue`.
//   - A trustworthy `completed` snapshot reaches `succeeded` *directly* from
//     `mirroring_external_state` with no intervening capture — the mirror crux,
//     parallel to (but simpler than) the single-shot `script` family's bare capture,
//     because the round is already in the capture/mirror phase.
//   - A gate settles into a durable, *non-terminal* `waiting_operator` (finished_at
//     stays null) that Momentum never auto-resolves — preserving no-mistakes daemon
//     and operator ownership of the decision/approval.
//   - Failure / blockage settle to their terminal abort states with the mirror
//     recovery code (and, for a blockage, the `external_state_required` gate).
//   - Untrusted evidence — a `completed` claim contradicting its own CI, or a
//     structurally unreadable snapshot — routes to `manual_recovery_required`
//     rather than being trusted: "evidence to classify, not blindly trusted
//     authority."
//   - Review findings (with their selected flags / external refs) and decisions
//     (with their delegated-policy resolutions) survive a durable round-trip.

const WORKFLOW_RUN_ID = "run-1";
const STEP_RUN_ID = "step-1";
const STEP_KEY = "no-mistakes";
const ATTEMPT = 1;
const HEAD_SHA = "a".repeat(40);
const INVOCATION_ID = noMistakesInvocationId(
  WORKFLOW_RUN_ID,
  STEP_RUN_ID,
  ATTEMPT,
);
const ROUND_ID = noMistakesRoundId(INVOCATION_ID);

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "momentum-no-mistakes-persistence-"),
  );
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

// Foreign keys are enforced, so the invocation needs a real (workflow_run_id,
// step_run_id) and the round needs a real invocation. Seed the minimal parent rows,
// the durable `running` mirror invocation, and the single mirror round born in
// `mirroring_external_state` — the live starting point every poll updates.
function openMirrorRoundDb(): MomentumDb {
  const db = openDb(makeTempDir());
  db.prepare(
    "INSERT INTO workflow_runs (id, source, created_at, updated_at) VALUES ('run-1', 'test', 1, 1)",
  ).run();
  db.prepare(
    `INSERT INTO workflow_steps (run_id, step_id, kind, step_order, created_at, updated_at)
       VALUES ('run-1', 'step-1', 'no-mistakes', 0, 1, 1)`,
  ).run();
  const invocation = planNoMistakesInvocation({
    workflowRunId: WORKFLOW_RUN_ID,
    stepRunId: STEP_RUN_ID,
    stepKey: STEP_KEY,
    attempt: ATTEMPT,
    startedAt: 1,
  });
  insertExecutorAttempt(db, invocation, { now: 1 });
  const round = planNoMistakesRoundStart({
    invocation,
    runtime: {
      inputDigest: "sha256:poll-0",
      artifactRoot: "/artifacts/nm-0",
      logPaths: ["/artifacts/nm-0/state.json"],
    },
    startedAt: 1_000,
  });
  insertExecutorRound(db, round, { now: 1_000 });
  return db;
}

// A well-formed external no-mistakes snapshot; each test overrides the fields its
// status path exercises.
function externalState(
  overrides: Partial<NoMistakesExternalState> = {},
): NoMistakesExternalState {
  return {
    externalRunId: "nm-run-9",
    branch: "feat/x",
    headSha: HEAD_SHA,
    activeStep: overrides.stepStatus === "completed" ? null : "review",
    stepStatus: "running",
    findings: [],
    selectedFindingIds: [],
    decisions: [],
    prUrl: null,
    ciState: "none",
    ...overrides,
  };
}

describe("no-mistakes mirror round persistence — round-start", () => {
  it("inserts a durable mirror round born in mirroring_external_state with no agent/model and no result", () => {
    const db = openMirrorRoundDb();

    const round = loadExecutorRound(db, ROUND_ID);
    expect(round).not.toBeUndefined();
    // Born directly in the capture/mirror phase, not `running`.
    expect(round!.state).toBe("mirroring_external_state");
    expect(round!.executorFamily).toBe("no-mistakes");
    expect(round!.roundIndex).toBe(0);
    expect(round!.classification).toBeNull();
    // No-mistakes owns its own pipeline, so Momentum resolves no agent/model/effort
    // and the mirror never produces a normalized result document.
    expect(round!.agentProvider).toBeNull();
    expect(round!.model).toBeNull();
    expect(round!.effort).toBeNull();
    expect(round!.resultDigest).toBeNull();
    // The runtime evidence the daemon supplied is frozen in at start.
    expect(round!.inputDigest).toBe("sha256:poll-0");
    expect(round!.artifactRoot).toBe("/artifacts/nm-0");
    expect(round!.recoveryCode).toBeNull();
    expect(round!.humanGate).toBeNull();
  });
});

describe("no-mistakes mirror round persistence — running snapshot", () => {
  it("heartbeats the round in place (mirroring_external_state -> mirroring_external_state) on continue", () => {
    const db = openMirrorRoundDb();

    const plan = planNoMistakesRoundPersistence({
      state: externalState({ stepStatus: "running" }),
    });
    expect(plan.decision.classification).toBe("continue");

    const final = updateExecutorRound(
      db,
      ROUND_ID,
      { ...plan.roundUpdate, heartbeatAt: 2_000, finishedAt: null },
      { now: 2_000 },
    );

    // The same-state transition is legal and keeps the round live for the next poll.
    expect(final.state).toBe("mirroring_external_state");
    expect(final.classification).toBe("continue");
    expect(final.recoveryCode).toBeNull();
    expect(final.humanGate).toBeNull();
    expect(final.finishedAt).toBeNull();
    // The decision reason is the mirror's durable summary (no result document).
    expect(final.summary).toBe(plan.decision.reason);
    expect(loadExecutorRound(db, ROUND_ID)).toEqual(final);
  });
});

describe("no-mistakes mirror round persistence — completed snapshot", () => {
  it("reaches succeeded directly from mirroring_external_state when CI agrees and decisions are resolved", () => {
    const db = openMirrorRoundDb();

    const plan = planNoMistakesRoundPersistence({
      state: externalState({
        stepStatus: "completed",
        ciState: "passed",
        decisions: [
          {
            externalId: "D-1",
            summary: "ship it",
            allowedActions: ["approve"],
            resolution: "approved",
          },
        ],
      }),
    });
    expect(plan.decision.classification).toBe("complete");

    // Unlike the single-shot families, the mirror needs no bare capture to reach
    // succeeded: the round is already in mirroring_external_state, from which the
    // transition graph allows a direct hop to succeeded.
    const final = updateExecutorRound(
      db,
      ROUND_ID,
      { ...plan.roundUpdate, heartbeatAt: 3_000, finishedAt: 3_000 },
      { now: 3_000 },
    );

    expect(final.state).toBe("succeeded");
    expect(final.classification).toBe("complete");
    expect(final.recoveryCode).toBeNull();
    expect(final.humanGate).toBeNull();
    expect(final.finishedAt).toBe(3_000);
    expect(loadExecutorRound(db, ROUND_ID)).toEqual(final);
  });
});

describe("no-mistakes mirror round persistence — human gates", () => {
  it("pauses in a durable, non-terminal waiting_operator on an operator decision", () => {
    const db = openMirrorRoundDb();

    const plan = planNoMistakesRoundPersistence({
      state: externalState({
        stepStatus: "awaiting_decision",
        decisions: [
          {
            externalId: "D-1",
            summary: "pick a fix",
            allowedActions: ["fix-a", "fix-b"],
          },
        ],
      }),
    });
    expect(plan.decision.classification).toBe("operator_decision_required");

    const final = updateExecutorRound(
      db,
      ROUND_ID,
      { ...plan.roundUpdate, heartbeatAt: 2_000, finishedAt: null },
      { now: 2_000 },
    );

    expect(final.state).toBe("waiting_operator");
    expect(final.humanGate).toBe("operator_decision_required");
    expect(final.recoveryCode).toBeNull();
    // waiting_operator is not terminal — Momentum never auto-resolves it.
    expect(final.finishedAt).toBeNull();
    expect(loadExecutorRound(db, ROUND_ID)).toEqual(final);
  });

  it("pauses in waiting_operator on an approval boundary", () => {
    const db = openMirrorRoundDb();

    const plan = planNoMistakesRoundPersistence({
      state: externalState({ stepStatus: "awaiting_approval" }),
    });
    expect(plan.decision.classification).toBe("approval_required");

    const final = updateExecutorRound(
      db,
      ROUND_ID,
      { ...plan.roundUpdate, heartbeatAt: 2_000, finishedAt: null },
      { now: 2_000 },
    );

    expect(final.state).toBe("waiting_operator");
    expect(final.humanGate).toBe("approval_required");
    expect(final.recoveryCode).toBeNull();
    expect(final.finishedAt).toBeNull();
  });
});

describe("no-mistakes mirror round persistence — failure and blockage", () => {
  it("settles failed with the external_run_failed recovery code", () => {
    const db = openMirrorRoundDb();

    const plan = planNoMistakesRoundPersistence({
      state: externalState({ stepStatus: "failed" }),
    });

    const final = updateExecutorRound(
      db,
      ROUND_ID,
      { ...plan.roundUpdate, heartbeatAt: 2_000, finishedAt: 2_000 },
      { now: 2_000 },
    );

    expect(final.state).toBe("failed");
    expect(final.classification).toBe("failed");
    expect(final.recoveryCode).toBe("external_run_failed");
    expect(final.humanGate).toBeNull();
    expect(final.finishedAt).toBe(2_000);
  });

  it("settles blocked with the external_state_blocked code and an external_state_required gate", () => {
    const db = openMirrorRoundDb();

    const plan = planNoMistakesRoundPersistence({
      state: externalState({ stepStatus: "blocked" }),
    });

    const final = updateExecutorRound(
      db,
      ROUND_ID,
      { ...plan.roundUpdate, heartbeatAt: 2_000, finishedAt: 2_000 },
      { now: 2_000 },
    );

    expect(final.state).toBe("blocked");
    expect(final.classification).toBe("blocked");
    expect(final.recoveryCode).toBe("external_state_blocked");
    expect(final.humanGate).toBe("external_state_required");
  });
});

describe("no-mistakes mirror round persistence — untrusted evidence routes to manual recovery", () => {
  it("routes a completed-but-CI-failed contradiction to manual_recovery_required", () => {
    const db = openMirrorRoundDb();

    const plan = planNoMistakesRoundPersistence({
      state: externalState({ stepStatus: "completed", ciState: "failed" }),
    });
    expect(plan.decision.classification).toBe("manual_recovery_required");

    const final = updateExecutorRound(
      db,
      ROUND_ID,
      { ...plan.roundUpdate, heartbeatAt: 2_000, finishedAt: 2_000 },
      { now: 2_000 },
    );

    expect(final.state).toBe("manual_recovery_required");
    expect(final.recoveryCode).toBe("external_state_inconsistent");
    expect(final.humanGate).toBe("manual_recovery_required");
  });

  it("routes a structurally unreadable snapshot (bad head SHA) to manual_recovery_required", () => {
    const db = openMirrorRoundDb();

    const plan = planNoMistakesRoundPersistence({
      state: externalState({ headSha: "not-a-sha" }),
    });

    const final = updateExecutorRound(
      db,
      ROUND_ID,
      { ...plan.roundUpdate, heartbeatAt: 2_000, finishedAt: 2_000 },
      { now: 2_000 },
    );

    expect(final.state).toBe("manual_recovery_required");
    expect(final.recoveryCode).toBe("external_state_unreadable");
    expect(final.humanGate).toBe("manual_recovery_required");
  });
});

describe("no-mistakes mirror findings — durable round-trip", () => {
  it("round-trips review findings with their selected flags and external refs in surfaced order", () => {
    const db = openMirrorRoundDb();

    const findings = planNoMistakesRoundFindings({
      roundId: ROUND_ID,
      findings: [
        {
          externalId: "F-1",
          title: "missing regression test",
          severity: "high",
          detail: "cover the empty-input path",
        },
        { externalId: "F-2", title: "typo in comment", severity: "low" },
      ],
      selectedFindingIds: ["F-1"],
    });
    findings.forEach((finding, index) => {
      insertExecutorFinding(db, finding, { now: 2_000 + index });
    });

    const loaded = listExecutorFindingsForRound(db, ROUND_ID);
    // The durable rows match the projection exactly, in surfaced order.
    expect(loaded).toEqual(findings);
    expect(loaded.map((finding) => finding.findingId)).toEqual([
      `${ROUND_ID}-finding-F-1`,
      `${ROUND_ID}-finding-F-2`,
    ]);
    // The selected finding ids survive as durable booleans.
    expect(loaded[0]!.selected).toBe(true);
    expect(loaded[1]!.selected).toBe(false);
    // The external ref ties the mirror row back to no-mistakes' own finding id.
    expect(loaded[0]!.externalRef).toBe("nomistakes:F-1");
    expect(loaded[1]!.detail).toBeNull();
  });
});

describe("no-mistakes mirror decisions — durable round-trip", () => {
  it("round-trips decisions with their delegated-policy resolutions and open state", () => {
    const db = openMirrorRoundDb();

    const decisions = planNoMistakesRoundDecisions({
      roundId: ROUND_ID,
      decisions: [
        {
          externalId: "D-1",
          summary: "auto-approved inside the delegated policy envelope",
          allowedActions: ["approve", "reject"],
          recommendedAction: "approve",
          chosenAction: "approve",
          resolution: "approved",
        },
        {
          externalId: "D-2",
          summary: "still open — outside the delegated envelope",
          allowedActions: ["merge", "hold"],
        },
      ],
    });
    decisions.forEach((decision, index) => {
      insertExecutorDecision(db, decision, { now: 2_000 + index });
    });

    const loaded = listExecutorDecisionsForRound(db, ROUND_ID);
    expect(loaded).toEqual(decisions);
    // A resolved decision mirrors the delegated-policy result; the mirror reflects
    // it, never drives it.
    expect(loaded[0]!.resolution).toBe("approved");
    expect(loaded[0]!.chosenAction).toBe("approve");
    // An unresolved decision stays open with its allowed actions intact.
    expect(loaded[1]!.resolution).toBeNull();
    expect(loaded[1]!.chosenAction).toBeNull();
    expect(loaded[1]!.allowedActions).toEqual(["merge", "hold"]);
  });
});
