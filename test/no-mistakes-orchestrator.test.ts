import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/db.js";
import {
  insertExecutorInvocation,
  insertExecutorRound,
  listExecutorCheckpointsForRound,
  listExecutorDecisionsForRound,
  listExecutorFindingsForRound,
  loadExecutorInvocation,
  loadExecutorRound
} from "../src/executor-loop-persist.js";
import type { ExecutorRoundRecord } from "../src/executor-loop-reducer.js";
import {
  noMistakesInvocationId,
  noMistakesRoundId,
  planNoMistakesInvocation,
  planNoMistakesRoundStart,
  type NoMistakesExternalState
} from "../src/no-mistakes-executor.js";
import { readNoMistakesExternalState } from "../src/no-mistakes-mechanism.js";
import {
  runNoMistakesMirrorRound,
  runNoMistakesMirrorStep,
  type NoMistakesMirrorReader
} from "../src/no-mistakes-orchestrator.js";

// The stateful seam twin of the pure projections (no-mistakes-executor.test.ts)
// and their durable round-trip (no-mistakes-executor-persistence.test.ts): this
// drives the orchestrator — `runNoMistakesMirrorRound` (one poll) and
// `runNoMistakesMirrorStep` (materialize invocation + round + first poll) — that
// wires the injected external-state reader -> the brain's classification -> the
// real M10-03 persistence layer for the single long-lived mirror round. The
// orchestrator is what a daemon scheduler ticks: each tick reads untrusted
// external no-mistakes state and reconciles the durable round, never trusting the
// external claim outright (ticket "evidence to classify, not blindly trusted
// authority"; "Preserve no-mistakes daemon ownership and human-gate semantics").

const WORKFLOW_RUN_ID = "run-1";
const STEP_RUN_ID = "step-1";
const STEP_KEY = "no-mistakes";
const ATTEMPT = 1;
const HEAD_SHA = "a".repeat(40);
const INVOCATION_ID = noMistakesInvocationId(
  WORKFLOW_RUN_ID,
  STEP_RUN_ID,
  ATTEMPT
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
    path.join(os.tmpdir(), "momentum-no-mistakes-orchestrator-")
  );
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

// Foreign keys are enforced, so the invocation needs a real (workflow_run_id,
// step_run_id) parent. Seed just the parents; `runNoMistakesMirrorStep` mints the
// invocation + round itself.
function seedParents(db: MomentumDb): void {
  db.prepare(
    "INSERT INTO workflow_runs (id, source, created_at, updated_at) VALUES ('run-1', 'test', 1, 1)"
  ).run();
  db.prepare(
    `INSERT INTO workflow_steps (run_id, step_id, kind, step_order, created_at, updated_at)
       VALUES ('run-1', 'step-1', 'no-mistakes', 0, 1, 1)`
  ).run();
}

// Seed parents + a durable running invocation + the single mirror round born in
// `mirroring_external_state` — the live starting point `runNoMistakesMirrorRound`
// polls against.
function openMirrorRoundDb(): MomentumDb {
  const db = openDb(makeTempDir());
  seedParents(db);
  const invocation = planNoMistakesInvocation({
    workflowRunId: WORKFLOW_RUN_ID,
    stepRunId: STEP_RUN_ID,
    stepKey: STEP_KEY,
    attempt: ATTEMPT,
    startedAt: 1
  });
  insertExecutorInvocation(db, invocation, { now: 1 });
  const round = planNoMistakesRoundStart({
    invocation,
    runtime: {
      inputDigest: "sha256:seed",
      artifactRoot: "/artifacts/nm-0",
      logPaths: ["/artifacts/nm-0/state.json"]
    },
    startedAt: 1_000
  });
  insertExecutorRound(db, round, { now: 1_000 });
  return db;
}

// A well-formed external no-mistakes snapshot; each test overrides the fields its
// status path exercises. Empty findings/decisions by default so the status-path
// tests stay focused.
function externalState(
  overrides: Partial<NoMistakesExternalState> = {}
): NoMistakesExternalState {
  return {
    externalRunId: "nm-run-9",
    branch: "feat/x",
    headSha: HEAD_SHA,
    activeStep: "review",
    stepStatus: "running",
    findings: [],
    selectedFindingIds: [],
    decisions: [],
    prUrl: null,
    ciState: "none",
    ...overrides
  };
}

// A reader that hands back a typed snapshot (the mechanism's success shape).
function okReader(
  overrides: Partial<NoMistakesExternalState> = {},
  digest = "sha256:poll"
): NoMistakesMirrorReader {
  return () => ({ ok: true, value: externalState(overrides), digest });
}

// A reader whose underlying store could not be read into a typed snapshot at all
// (missing file, non-JSON bytes, wrong-typed field) — the mechanism's error shape.
function failReader(error: string): NoMistakesMirrorReader {
  return () => ({ ok: false, error });
}

describe("runNoMistakesMirrorRound — one poll on an existing mirror round", () => {
  it("heartbeats the round in place on a still-running snapshot (continue)", () => {
    const db = openMirrorRoundDb();

    const result = runNoMistakesMirrorRound({
      db,
      roundId: ROUND_ID,
      read: okReader({ stepStatus: "running" }),
      polledAt: 2_000
    });

    expect(result.decision.classification).toBe("continue");
    expect(result.round.state).toBe("mirroring_external_state");
    expect(result.round.classification).toBe("continue");
    expect(result.round.recoveryCode).toBeNull();
    expect(result.round.humanGate).toBeNull();
    // continue is not terminal: the round stays live for the next poll.
    expect(result.round.finishedAt).toBeNull();
    expect(result.round.heartbeatAt).toBe(2_000);
    // The decision reason is the mirror's durable summary (no result document).
    expect(result.round.summary).toBe(result.decision.reason);
    expect(loadExecutorRound(db, ROUND_ID)).toEqual(result.round);
  });

  it("reaches succeeded directly from mirroring_external_state on a corroborated completed snapshot", () => {
    const db = openMirrorRoundDb();

    const result = runNoMistakesMirrorRound({
      db,
      roundId: ROUND_ID,
      read: okReader({
        stepStatus: "completed",
        ciState: "passed",
        decisions: [
          {
            externalId: "D-1",
            summary: "ship it",
            allowedActions: ["approve"],
            resolution: "approved"
          }
        ]
      }),
      polledAt: 3_000
    });

    expect(result.decision.classification).toBe("complete");
    // No intervening capture: the round is already in the mirror phase, from which
    // the transition graph allows a direct hop to succeeded.
    expect(result.round.state).toBe("succeeded");
    expect(result.round.finishedAt).toBe(3_000);
  });

  it("pauses in a durable non-terminal waiting_operator on an operator decision", () => {
    const db = openMirrorRoundDb();

    const result = runNoMistakesMirrorRound({
      db,
      roundId: ROUND_ID,
      read: okReader({
        stepStatus: "awaiting_decision",
        decisions: [
          { externalId: "D-1", summary: "pick a fix", allowedActions: ["a", "b"] }
        ]
      }),
      polledAt: 2_000
    });

    expect(result.round.state).toBe("waiting_operator");
    expect(result.round.humanGate).toBe("operator_decision_required");
    expect(result.round.recoveryCode).toBeNull();
    // waiting_operator is not terminal — Momentum never auto-resolves it.
    expect(result.round.finishedAt).toBeNull();
  });

  it("pauses in waiting_operator on an approval boundary", () => {
    const db = openMirrorRoundDb();

    const result = runNoMistakesMirrorRound({
      db,
      roundId: ROUND_ID,
      read: okReader({ stepStatus: "awaiting_approval" }),
      polledAt: 2_000
    });

    expect(result.round.state).toBe("waiting_operator");
    expect(result.round.humanGate).toBe("approval_required");
    expect(result.round.finishedAt).toBeNull();
  });

  it("settles failed with the external_run_failed recovery code", () => {
    const db = openMirrorRoundDb();

    const result = runNoMistakesMirrorRound({
      db,
      roundId: ROUND_ID,
      read: okReader({ stepStatus: "failed" }),
      polledAt: 2_000
    });

    expect(result.round.state).toBe("failed");
    expect(result.round.recoveryCode).toBe("external_run_failed");
    expect(result.round.finishedAt).toBe(2_000);
  });

  it("settles blocked with external_state_blocked and an external_state_required gate", () => {
    const db = openMirrorRoundDb();

    const result = runNoMistakesMirrorRound({
      db,
      roundId: ROUND_ID,
      read: okReader({ stepStatus: "blocked" }),
      polledAt: 2_000
    });

    expect(result.round.state).toBe("blocked");
    expect(result.round.recoveryCode).toBe("external_state_blocked");
    expect(result.round.humanGate).toBe("external_state_required");
    expect(result.round.finishedAt).toBe(2_000);
  });

  it("routes a completed-but-CI-failed contradiction to manual_recovery_required", () => {
    const db = openMirrorRoundDb();

    const result = runNoMistakesMirrorRound({
      db,
      roundId: ROUND_ID,
      read: okReader({ stepStatus: "completed", ciState: "failed" }),
      polledAt: 2_000
    });

    expect(result.round.state).toBe("manual_recovery_required");
    expect(result.round.recoveryCode).toBe("external_state_inconsistent");
    expect(result.round.humanGate).toBe("manual_recovery_required");
  });

  it("routes a structurally unreadable snapshot (bad head SHA) to manual_recovery_required", () => {
    const db = openMirrorRoundDb();

    const result = runNoMistakesMirrorRound({
      db,
      roundId: ROUND_ID,
      read: okReader({ headSha: "not-a-sha" }),
      polledAt: 2_000
    });

    expect(result.round.state).toBe("manual_recovery_required");
    expect(result.round.recoveryCode).toBe("external_state_unreadable");
    expect(result.round.humanGate).toBe("manual_recovery_required");
  });

  it("routes a reader IO/JSON failure (unreadable store) to manual_recovery_required", () => {
    const db = openMirrorRoundDb();

    const result = runNoMistakesMirrorRound({
      db,
      roundId: ROUND_ID,
      read: failReader(
        "external no-mistakes state file is unreadable: ENOENT no such file"
      ),
      polledAt: 2_000
    });

    // A reader failure is untrusted evidence too: it settles the same way as a
    // semantically broken snapshot, never crashing the daemon poll.
    expect(result.decision.classification).toBe("manual_recovery_required");
    expect(result.round.state).toBe("manual_recovery_required");
    expect(result.round.recoveryCode).toBe("external_state_unreadable");
    expect(result.round.humanGate).toBe("manual_recovery_required");
    expect(result.round.summary).toBe(
      "external no-mistakes state file is unreadable: ENOENT no such file"
    );
  });

  it("threads the read content digest onto the round's inputDigest each poll", () => {
    const db = openMirrorRoundDb();
    // The seed froze a placeholder inputDigest; a successful poll re-fingerprints
    // the round with the exact external bytes it mirrored this tick.
    expect(loadExecutorRound(db, ROUND_ID)!.inputDigest).toBe("sha256:seed");

    const result = runNoMistakesMirrorRound({
      db,
      roundId: ROUND_ID,
      read: okReader({ stepStatus: "running" }, "sha256:tick-7"),
      polledAt: 2_000
    });

    expect(result.round.inputDigest).toBe("sha256:tick-7");
  });

  it("leaves the round's frozen inputDigest intact on a reader failure (nothing to fingerprint)", () => {
    const db = openMirrorRoundDb();

    const result = runNoMistakesMirrorRound({
      db,
      roundId: ROUND_ID,
      read: failReader("external no-mistakes state must be a JSON object"),
      polledAt: 2_000
    });

    expect(result.round.inputDigest).toBe("sha256:seed");
  });

  it("passes the live round record to the reader so the daemon can locate the external store", () => {
    const db = openMirrorRoundDb();
    let seen: ExecutorRoundRecord | null = null;

    runNoMistakesMirrorRound({
      db,
      roundId: ROUND_ID,
      read: (round) => {
        seen = round;
        return { ok: true, value: externalState(), digest: "sha256:poll" };
      },
      polledAt: 2_000
    });

    expect(seen).not.toBeNull();
    expect(seen!.roundId).toBe(ROUND_ID);
    // The daemon reads the store from the round's frozen artifact root.
    expect(seen!.artifactRoot).toBe("/artifacts/nm-0");
  });
});

describe("runNoMistakesMirrorRound — findings and decisions projection", () => {
  it("projects review findings with their selected flags and external refs in surfaced order", () => {
    const db = openMirrorRoundDb();

    const result = runNoMistakesMirrorRound({
      db,
      roundId: ROUND_ID,
      read: okReader({
        stepStatus: "running",
        findings: [
          {
            externalId: "F-1",
            title: "missing regression test",
            severity: "high",
            detail: "cover the empty-input path"
          },
          { externalId: "F-2", title: "typo in comment", severity: "low" }
        ],
        selectedFindingIds: ["F-1"]
      }),
      polledAt: 2_000
    });

    expect(result.findings.map((f) => f.findingId)).toEqual([
      `${ROUND_ID}-finding-F-1`,
      `${ROUND_ID}-finding-F-2`
    ]);
    expect(result.findings[0]!.selected).toBe(true);
    expect(result.findings[1]!.selected).toBe(false);
    expect(result.findings[0]!.externalRef).toBe("nomistakes:F-1");
    // Durable rows match the returned projection exactly.
    expect(listExecutorFindingsForRound(db, ROUND_ID)).toEqual(result.findings);
  });

  it("projects decisions with their delegated-policy resolutions and open state", () => {
    const db = openMirrorRoundDb();

    const result = runNoMistakesMirrorRound({
      db,
      roundId: ROUND_ID,
      read: okReader({
        stepStatus: "awaiting_decision",
        decisions: [
          {
            externalId: "D-1",
            summary: "auto-approved inside the delegated policy envelope",
            allowedActions: ["approve", "reject"],
            recommendedAction: "approve",
            chosenAction: "approve",
            resolution: "approved"
          },
          {
            externalId: "D-2",
            summary: "still open — outside the delegated envelope",
            allowedActions: ["merge", "hold"]
          }
        ]
      }),
      polledAt: 2_000
    });

    expect(result.decisions[0]!.resolution).toBe("approved");
    expect(result.decisions[0]!.chosenAction).toBe("approve");
    expect(result.decisions[1]!.resolution).toBeNull();
    expect(result.decisions[1]!.allowedActions).toEqual(["merge", "hold"]);
    expect(listExecutorDecisionsForRound(db, ROUND_ID)).toEqual(
      result.decisions
    );
  });

  it("invents no findings or decisions on a reader failure (prior evidence preserved)", () => {
    const db = openMirrorRoundDb();

    const result = runNoMistakesMirrorRound({
      db,
      roundId: ROUND_ID,
      read: failReader("external no-mistakes state headSha must be a string"),
      polledAt: 2_000
    });

    expect(result.findings).toEqual([]);
    expect(result.decisions).toEqual([]);
  });

  it("does not mirror evidence from a semantically unreadable snapshot", () => {
    const db = openMirrorRoundDb();

    const result = runNoMistakesMirrorRound({
      db,
      roundId: ROUND_ID,
      read: okReader({
        stepStatus: "running",
        findings: [
          { externalId: "F-1", title: "first duplicate" },
          { externalId: "F-1", title: "second duplicate" }
        ],
        selectedFindingIds: ["F-1"],
        decisions: [
          { externalId: "D-1", summary: "first", allowedActions: ["a"] },
          { externalId: "D-1", summary: "second", allowedActions: ["b"] }
        ]
      }),
      polledAt: 2_000
    });

    expect(result.decision.recoveryCode).toBe("external_state_unreadable");
    expect(result.findings).toEqual([]);
    expect(result.decisions).toEqual([]);
  });

  it("refreshes mirrored finding selections and decision resolutions across polls", () => {
    const db = openMirrorRoundDb();

    runNoMistakesMirrorRound({
      db,
      roundId: ROUND_ID,
      read: okReader({
        stepStatus: "running",
        findings: [{ externalId: "F-1", title: "needs fix" }],
        selectedFindingIds: [],
        decisions: [
          { externalId: "D-1", summary: "choose path", allowedActions: ["a", "b"] }
        ]
      }),
      polledAt: 2_000
    });
    const second = runNoMistakesMirrorRound({
      db,
      roundId: ROUND_ID,
      read: okReader({
        stepStatus: "completed",
        ciState: "passed",
        findings: [{ externalId: "F-1", title: "needs fix", severity: "high" }],
        selectedFindingIds: ["F-1"],
        decisions: [
          {
            externalId: "D-1",
            summary: "choose path",
            allowedActions: ["a", "b"],
            chosenAction: "a",
            resolution: "approved"
          }
        ]
      }),
      polledAt: 3_000
    });

    expect(second.findings).toHaveLength(1);
    expect(second.findings[0]!.selected).toBe(true);
    expect(second.findings[0]!.severity).toBe("high");
    expect(second.decisions).toHaveLength(1);
    expect(second.decisions[0]!.chosenAction).toBe("a");
    expect(second.decisions[0]!.resolution).toBe("approved");
  });

  it("persists a durable checkpoint snapshot of mirrored external state", () => {
    const db = openMirrorRoundDb();

    runNoMistakesMirrorRound({
      db,
      roundId: ROUND_ID,
      read: okReader({
        externalRunId: "nm-run-123",
        branch: "feat/mirror",
        headSha: "b".repeat(40),
        activeStep: "ci",
        stepStatus: "running",
        prUrl: "https://github.com/acme/repo/pull/7",
        ciState: "pending"
      }),
      polledAt: 2_000
    });

    const checkpoints = listExecutorCheckpointsForRound(db, ROUND_ID);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]!.stage).toBe("external_state_mirrored");
    expect(JSON.parse(checkpoints[0]!.detail!)).toEqual({
      externalRunId: "nm-run-123",
      branch: "feat/mirror",
      headSha: "b".repeat(40),
      activeStep: "ci",
      stepStatus: "running",
      prUrl: "https://github.com/acme/repo/pull/7",
      ciState: "pending"
    });
  });
});

describe("runNoMistakesMirrorRound — idempotent across repeated polls", () => {
  it("re-projecting the same findings across polls does not double-insert or throw", () => {
    const db = openMirrorRoundDb();
    const read = okReader({
      stepStatus: "running",
      findings: [{ externalId: "F-1", title: "missing test" }],
      selectedFindingIds: ["F-1"]
    });

    runNoMistakesMirrorRound({ db, roundId: ROUND_ID, read, polledAt: 2_000 });
    // A second poll of the same long-lived round re-derives the same finding ids;
    // the append-only evidence table must not be re-inserted (it would throw).
    const second = runNoMistakesMirrorRound({
      db,
      roundId: ROUND_ID,
      read,
      polledAt: 3_000
    });

    expect(second.findings.map((f) => f.findingId)).toEqual([
      `${ROUND_ID}-finding-F-1`
    ]);
    expect(listExecutorFindingsForRound(db, ROUND_ID)).toHaveLength(1);
  });

  it("surfaces newly-appearing findings on a later poll without re-inserting earlier ones", () => {
    const db = openMirrorRoundDb();

    runNoMistakesMirrorRound({
      db,
      roundId: ROUND_ID,
      read: okReader({
        stepStatus: "running",
        findings: [{ externalId: "F-1", title: "first finding" }]
      }),
      polledAt: 2_000
    });
    const second = runNoMistakesMirrorRound({
      db,
      roundId: ROUND_ID,
      read: okReader({
        stepStatus: "running",
        findings: [
          { externalId: "F-1", title: "first finding" },
          { externalId: "F-2", title: "second finding surfaced later" }
        ]
      }),
      polledAt: 3_000
    });

    expect(second.findings.map((f) => f.findingId)).toEqual([
      `${ROUND_ID}-finding-F-1`,
      `${ROUND_ID}-finding-F-2`
    ]);
  });

  it("re-projecting the same decisions across polls does not double-insert", () => {
    const db = openMirrorRoundDb();
    const read = okReader({
      stepStatus: "awaiting_decision",
      decisions: [
        { externalId: "D-1", summary: "decide", allowedActions: ["a", "b"] }
      ]
    });

    runNoMistakesMirrorRound({ db, roundId: ROUND_ID, read, polledAt: 2_000 });
    runNoMistakesMirrorRound({ db, roundId: ROUND_ID, read, polledAt: 3_000 });

    expect(listExecutorDecisionsForRound(db, ROUND_ID)).toHaveLength(1);
  });
});

describe("runNoMistakesMirrorRound — multi-poll lifecycle", () => {
  it("drives a long-lived round through running -> running -> completed into succeeded", () => {
    const db = openMirrorRoundDb();

    const first = runNoMistakesMirrorRound({
      db,
      roundId: ROUND_ID,
      read: okReader({ stepStatus: "running" }),
      polledAt: 2_000
    });
    expect(first.round.state).toBe("mirroring_external_state");

    const second = runNoMistakesMirrorRound({
      db,
      roundId: ROUND_ID,
      read: okReader({ stepStatus: "running" }),
      polledAt: 3_000
    });
    expect(second.round.state).toBe("mirroring_external_state");

    const third = runNoMistakesMirrorRound({
      db,
      roundId: ROUND_ID,
      read: okReader({ stepStatus: "completed", ciState: "passed" }),
      polledAt: 4_000
    });
    expect(third.round.state).toBe("succeeded");
    expect(third.round.finishedAt).toBe(4_000);
    expect(loadExecutorInvocation(db, INVOCATION_ID)!.state).toBe("succeeded");
    expect(loadExecutorInvocation(db, INVOCATION_ID)!.finishedAt).toBe(4_000);
  });

  it("resumes a waiting_operator round back into mirroring when the decision clears", () => {
    const db = openMirrorRoundDb();

    const gated = runNoMistakesMirrorRound({
      db,
      roundId: ROUND_ID,
      read: okReader({
        stepStatus: "awaiting_decision",
        decisions: [
          { externalId: "D-1", summary: "decide", allowedActions: ["a", "b"] }
        ]
      }),
      polledAt: 2_000
    });
    expect(gated.round.state).toBe("waiting_operator");

    // The operator resolved the decision and the run is moving again: a legal
    // waiting_operator -> mirroring_external_state resume.
    const resumed = runNoMistakesMirrorRound({
      db,
      roundId: ROUND_ID,
      read: okReader({ stepStatus: "running" }),
      polledAt: 3_000
    });
    expect(resumed.round.state).toBe("mirroring_external_state");
    expect(resumed.round.finishedAt).toBeNull();
    expect(loadExecutorInvocation(db, INVOCATION_ID)!.state).toBe("running");
  });
});

describe("runNoMistakesMirrorStep — materialize invocation + round + first poll", () => {
  function resolveRoundInputs() {
    return {
      inputDigest: "sha256:start",
      artifactRoot: "/artifacts/nm-step",
      logPaths: ["/artifacts/nm-step/state.json"]
    };
  }

  function runStep(read: NoMistakesMirrorReader, now = stubClock()) {
    const db = openDb(makeTempDir());
    seedParents(db);
    const result = runNoMistakesMirrorStep({
      db,
      workflowRunId: WORKFLOW_RUN_ID,
      stepRunId: STEP_RUN_ID,
      stepKey: STEP_KEY,
      attempt: ATTEMPT,
      read,
      resolveRoundInputs,
      now
    });
    return { db, result };
  }

  // A monotonic deterministic clock so timestamps are predictable.
  function stubClock(): () => number {
    let t = 1_000;
    return () => (t += 1_000);
  }

  it("materializes a durable running invocation and a mirror round born in mirroring_external_state with deterministic ids", () => {
    const { db, result } = runStep(okReader({ stepStatus: "running" }));

    expect(result.invocation.invocationId).toBe(INVOCATION_ID);
    expect(result.invocation.executorFamily).toBe("no-mistakes");
    expect(result.round.round.roundId).toBe(ROUND_ID);
    expect(result.round.round.roundIndex).toBe(0);
    // No-mistakes owns its own pipeline: Momentum resolves no agent/model/effort.
    expect(result.round.round.agentProvider).toBeNull();
    expect(result.round.round.model).toBeNull();
    expect(result.round.round.effort).toBeNull();
    // Both rows are durable.
    expect(loadExecutorInvocation(db, INVOCATION_ID)).toEqual(result.invocation);
    expect(loadExecutorRound(db, ROUND_ID)).toEqual(result.round.round);
  });

  it("freezes the daemon-resolved runtime inputs into the round-start", () => {
    const { result } = runStep(okReader({ stepStatus: "running" }));
    expect(result.round.round.artifactRoot).toBe("/artifacts/nm-step");
    expect(result.round.round.logPaths).toEqual([
      "/artifacts/nm-step/state.json"
    ]);
  });

  it("leaves both the round mirroring and the invocation running on a still-running first poll", () => {
    const { result } = runStep(okReader({ stepStatus: "running" }));

    expect(result.round.round.state).toBe("mirroring_external_state");
    expect(result.invocation.state).toBe("running");
    // Neither is terminal — the daemon scheduler ticks the round again later.
    expect(result.invocation.finishedAt).toBeNull();
    expect(result.round.round.finishedAt).toBeNull();
  });

  it("settles the round succeeded and the invocation succeeded on a corroborated completed first poll", () => {
    const { result } = runStep(
      okReader({ stepStatus: "completed", ciState: "passed" })
    );

    expect(result.round.round.state).toBe("succeeded");
    expect(result.invocation.state).toBe("succeeded");
    expect(result.invocation.finishedAt).not.toBeNull();
  });

  it("pauses the invocation in a durable non-terminal waiting_operator on an operator-decision first poll", () => {
    const { result } = runStep(
      okReader({
        stepStatus: "awaiting_decision",
        decisions: [
          { externalId: "D-1", summary: "decide", allowedActions: ["a", "b"] }
        ]
      })
    );

    expect(result.invocation.state).toBe("waiting_operator");
    expect(result.invocation.finishedAt).toBeNull();
  });

  it("settles the invocation failed on a failed first poll", () => {
    const { result } = runStep(okReader({ stepStatus: "failed" }));
    expect(result.invocation.state).toBe("failed");
    expect(result.invocation.finishedAt).not.toBeNull();
  });

  it("settles the invocation manual_recovery_required on an unreadable first poll", () => {
    const { result } = runStep(
      failReader("external no-mistakes state is not valid JSON: Unexpected token")
    );
    expect(result.invocation.state).toBe("manual_recovery_required");
    expect(result.round.round.state).toBe("manual_recovery_required");
  });

  it("projects the first poll's findings and decisions below the round", () => {
    const { db } = runStep(
      okReader({
        stepStatus: "awaiting_decision",
        findings: [{ externalId: "F-1", title: "missing test" }],
        selectedFindingIds: ["F-1"],
        decisions: [
          { externalId: "D-1", summary: "decide", allowedActions: ["a"] }
        ]
      })
    );

    expect(listExecutorFindingsForRound(db, ROUND_ID)).toHaveLength(1);
    expect(listExecutorDecisionsForRound(db, ROUND_ID)).toHaveLength(1);
  });

  it("mints a fresh invocation and round for a re-run attempt", () => {
    const db = openDb(makeTempDir());
    seedParents(db);
    const base = {
      db,
      workflowRunId: WORKFLOW_RUN_ID,
      stepRunId: STEP_RUN_ID,
      stepKey: STEP_KEY,
      read: okReader({ stepStatus: "failed" }),
      resolveRoundInputs
    };

    const first = runNoMistakesMirrorStep({ ...base, attempt: 1, now: stubClock() });
    const second = runNoMistakesMirrorStep({ ...base, attempt: 2, now: stubClock() });

    // A re-run is a fresh attempt minting a fresh invocation, never mutating the prior one.
    expect(first.invocation.invocationId).not.toBe(
      second.invocation.invocationId
    );
    expect(second.invocation.invocationId).toBe(
      noMistakesInvocationId(WORKFLOW_RUN_ID, STEP_RUN_ID, 2)
    );
  });
});

describe("runNoMistakesMirrorStep — composes the real external-state reader end to end", () => {
  it("reads a real state file through readNoMistakesExternalState and settles the round", () => {
    const db = openDb(makeTempDir());
    seedParents(db);
    const dir = makeTempDir();
    const statePath = path.join(dir, "no-mistakes-state.json");
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        externalRunId: "nm-run-42",
        branch: "feat/x",
        headSha: HEAD_SHA,
        activeStep: "merge",
        stepStatus: "completed",
        findings: [],
        selectedFindingIds: [],
        decisions: [],
        prUrl: "https://github.com/x/y/pull/1",
        ciState: "passed"
      })
    );

    const result = runNoMistakesMirrorStep({
      db,
      workflowRunId: WORKFLOW_RUN_ID,
      stepRunId: STEP_RUN_ID,
      stepKey: STEP_KEY,
      attempt: ATTEMPT,
      read: () => readNoMistakesExternalState({ statePath }),
      resolveRoundInputs: () => ({
        inputDigest: null,
        artifactRoot: dir,
        logPaths: []
      })
    });

    // The full M10-07 stack — reader -> brain -> persistence — composes.
    expect(result.round.round.state).toBe("succeeded");
    expect(result.invocation.state).toBe("succeeded");
    // The durable round fingerprints the exact external bytes it mirrored.
    expect(result.round.round.inputDigest).toMatch(/^sha256:/);
  });

  it("settles to manual recovery when the real state file is missing", () => {
    const db = openDb(makeTempDir());
    seedParents(db);

    const result = runNoMistakesMirrorStep({
      db,
      workflowRunId: WORKFLOW_RUN_ID,
      stepRunId: STEP_RUN_ID,
      stepKey: STEP_KEY,
      attempt: ATTEMPT,
      read: () =>
        readNoMistakesExternalState({
          statePath: path.join(makeTempDir(), "does-not-exist.json")
        }),
      resolveRoundInputs: () => ({
        inputDigest: null,
        artifactRoot: null,
        logPaths: []
      })
    });

    expect(result.round.round.state).toBe("manual_recovery_required");
    expect(result.round.round.recoveryCode).toBe("external_state_unreadable");
    expect(result.invocation.state).toBe("manual_recovery_required");
  });
});
