import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import {
  finishWorkflowStep,
  getWorkflowStep,
  startWorkflowStep
} from "../src/core/workflow/step-transitions.js";
import {
  deriveWorkflowRunState,
  type WorkflowStepKind,
  type WorkflowStepState
} from "../src/core/workflow/run-reducer.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix = "momentum-workflow-step-transitions-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

const SEED_AT = 1_730_000_000_000;

function seedRun(db: MomentumDb, id: string): void {
  db.prepare(
    `INSERT INTO workflow_runs (id, source, created_at, updated_at)
     VALUES (?, ?, ?, ?)`
  ).run(id, "agent-workflow", SEED_AT, SEED_AT);
}

type SeedStepOptions = {
  kind?: WorkflowStepKind;
  order?: number;
  required?: boolean;
  startedAt?: number | null;
  finishedAt?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  resultDigest?: string | null;
  operatorTransitionAt?: number | null;
};

function seedStep(
  db: MomentumDb,
  runId: string,
  stepId: string,
  state: WorkflowStepState,
  opts: SeedStepOptions = {}
): void {
  db.prepare(
    `INSERT INTO workflow_steps (
       run_id, step_id, kind, state, step_order, required,
       result_digest, error_code, error_message, started_at, finished_at,
       operator_transition_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    runId,
    stepId,
    opts.kind ?? "implementation",
    state,
    opts.order ?? 1,
    (opts.required ?? true) ? 1 : 0,
    opts.resultDigest ?? null,
    opts.errorCode ?? null,
    opts.errorMessage ?? null,
    opts.startedAt ?? null,
    opts.finishedAt ?? null,
    opts.operatorTransitionAt ?? null,
    SEED_AT,
    SEED_AT
  );
}

type RawStepRow = {
  state: string;
  started_at: number | null;
  finished_at: number | null;
  error_code: string | null;
  error_message: string | null;
  result_digest: string | null;
  operator_transition_at: number | null;
  operator_reason: string | null;
  updated_at: number;
};

function readRawStep(
  db: MomentumDb,
  runId: string,
  stepId: string
): RawStepRow | undefined {
  return db
    .prepare("SELECT * FROM workflow_steps WHERE run_id = ? AND step_id = ?")
    .get(runId, stepId) as RawStepRow | undefined;
}

function openSeededDb(runId = "run-1"): { db: MomentumDb } {
  const db = openDb(makeTempDir());
  seedRun(db, runId);
  return { db };
}

describe("startWorkflowStep", () => {
  it("transitions approved -> running and stamps started_at without touching the operator gate", () => {
    const { db } = openSeededDb();
    try {
      seedStep(db, "run-1", "step-impl", "approved");

      const out = startWorkflowStep(db, {
        runId: "run-1",
        stepId: "step-impl",
        now: 5_000
      });

      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.state).toBe("running");
      expect(out.startedAt).toBe(5_000);
      expect(out.finishedAt).toBeNull();
      expect(out.idempotent).toBe(false);

      const raw = readRawStep(db, "run-1", "step-impl");
      expect(raw?.state).toBe("running");
      expect(raw?.started_at).toBe(5_000);
      expect(raw?.finished_at).toBeNull();
      expect(raw?.updated_at).toBe(5_000);
      // A live/system transition must never engage the M8 operator override gate.
      expect(raw?.operator_transition_at).toBeNull();
      expect(raw?.operator_reason).toBeNull();
    } finally {
      db.close();
    }
  });

  it("refuses to start a step that is already running", () => {
    const { db } = openSeededDb();
    try {
      seedStep(db, "run-1", "step-impl", "running", { startedAt: 4_000 });

      const out = startWorkflowStep(db, {
        runId: "run-1",
        stepId: "step-impl",
        now: 9_000
      });

      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.reason).toBe("invalid_transition");
      if (out.reason !== "invalid_transition") return;
      expect(out.from).toBe("running");
      expect(out.to).toBe("running");
      expect(out.errorMessage).toContain("expected approved");

      const raw = readRawStep(db, "run-1", "step-impl");
      expect(raw?.started_at).toBe(4_000);
      expect(raw?.updated_at).toBe(SEED_AT);
    } finally {
      db.close();
    }
  });

  it("refuses an invalid transition from pending and leaves the row untouched", () => {
    const { db } = openSeededDb();
    try {
      seedStep(db, "run-1", "step-impl", "pending");

      const out = startWorkflowStep(db, {
        runId: "run-1",
        stepId: "step-impl",
        now: 5_000
      });

      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.reason).toBe("invalid_transition");
      if (out.reason !== "invalid_transition") return;
      expect(out.from).toBe("pending");
      expect(out.to).toBe("running");
      expect(out.errorCode).toBe("workflow_step_invalid_transition");

      const raw = readRawStep(db, "run-1", "step-impl");
      expect(raw?.state).toBe("pending");
      expect(raw?.started_at).toBeNull();
      expect(raw?.updated_at).toBe(SEED_AT);
    } finally {
      db.close();
    }
  });

  it("refuses to restart a terminal step with the terminal error code", () => {
    const { db } = openSeededDb();
    try {
      seedStep(db, "run-1", "step-impl", "succeeded", {
        startedAt: 1_000,
        finishedAt: 2_000
      });

      const out = startWorkflowStep(db, {
        runId: "run-1",
        stepId: "step-impl",
        now: 5_000
      });

      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.reason).toBe("invalid_transition");
      if (out.reason !== "invalid_transition") return;
      expect(out.errorCode).toBe("workflow_step_terminal");
    } finally {
      db.close();
    }
  });

  it("returns step_not_found for an absent step", () => {
    const { db } = openSeededDb();
    try {
      const out = startWorkflowStep(db, {
        runId: "run-1",
        stepId: "missing",
        now: 5_000
      });
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.reason).toBe("step_not_found");
    } finally {
      db.close();
    }
  });
});

describe("finishWorkflowStep", () => {
  it("transitions running -> succeeded, stamps finished_at, clears error fields, and records the result digest", () => {
    const { db } = openSeededDb();
    try {
      seedStep(db, "run-1", "step-impl", "running", {
        startedAt: 4_000,
        errorCode: "stale",
        errorMessage: "stale message"
      });

      const out = finishWorkflowStep(db, {
        runId: "run-1",
        stepId: "step-impl",
        state: "succeeded",
        resultDigest: "sha256:abc",
        now: 8_000
      });

      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.state).toBe("succeeded");
      expect(out.startedAt).toBe(4_000);
      expect(out.finishedAt).toBe(8_000);
      expect(out.idempotent).toBe(false);

      const raw = readRawStep(db, "run-1", "step-impl");
      expect(raw?.state).toBe("succeeded");
      expect(raw?.finished_at).toBe(8_000);
      expect(raw?.error_code).toBeNull();
      expect(raw?.error_message).toBeNull();
      expect(raw?.result_digest).toBe("sha256:abc");
      expect(raw?.updated_at).toBe(8_000);
      expect(raw?.operator_transition_at).toBeNull();
    } finally {
      db.close();
    }
  });

  it("transitions running -> failed and persists the error code and message", () => {
    const { db } = openSeededDb();
    try {
      seedStep(db, "run-1", "step-impl", "running", { startedAt: 4_000 });

      const out = finishWorkflowStep(db, {
        runId: "run-1",
        stepId: "step-impl",
        state: "failed",
        errorCode: "command_failed",
        errorMessage: "exit 1",
        now: 8_000
      });

      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.state).toBe("failed");

      const raw = readRawStep(db, "run-1", "step-impl");
      expect(raw?.state).toBe("failed");
      expect(raw?.error_code).toBe("command_failed");
      expect(raw?.error_message).toBe("exit 1");
      expect(raw?.finished_at).toBe(8_000);
    } finally {
      db.close();
    }
  });

  it("is idempotent when already in the target terminal state and does not rewrite durable fields", () => {
    const { db } = openSeededDb();
    try {
      seedStep(db, "run-1", "step-impl", "succeeded", {
        startedAt: 4_000,
        finishedAt: 6_000,
        resultDigest: "sha256:original"
      });

      const out = finishWorkflowStep(db, {
        runId: "run-1",
        stepId: "step-impl",
        state: "succeeded",
        resultDigest: "sha256:different",
        now: 9_000
      });

      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.idempotent).toBe(true);
      expect(out.finishedAt).toBe(6_000);

      const raw = readRawStep(db, "run-1", "step-impl");
      // The original terminal record is immutable: no rewrite happened.
      expect(raw?.finished_at).toBe(6_000);
      expect(raw?.result_digest).toBe("sha256:original");
      expect(raw?.updated_at).toBe(SEED_AT);
    } finally {
      db.close();
    }
  });

  it("refuses to move from one terminal state to a different terminal state", () => {
    const { db } = openSeededDb();
    try {
      seedStep(db, "run-1", "step-impl", "succeeded", {
        startedAt: 4_000,
        finishedAt: 6_000
      });

      const out = finishWorkflowStep(db, {
        runId: "run-1",
        stepId: "step-impl",
        state: "failed",
        now: 9_000
      });

      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.reason).toBe("invalid_transition");
      if (out.reason !== "invalid_transition") return;
      expect(out.errorCode).toBe("workflow_step_terminal");

      const raw = readRawStep(db, "run-1", "step-impl");
      expect(raw?.state).toBe("succeeded");
    } finally {
      db.close();
    }
  });

  it("refuses to succeed a step that never ran (approved -> succeeded)", () => {
    const { db } = openSeededDb();
    try {
      seedStep(db, "run-1", "step-impl", "approved");

      const out = finishWorkflowStep(db, {
        runId: "run-1",
        stepId: "step-impl",
        state: "succeeded",
        now: 9_000
      });

      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.reason).toBe("invalid_transition");
      if (out.reason !== "invalid_transition") return;
      expect(out.errorCode).toBe("workflow_step_invalid_transition");
    } finally {
      db.close();
    }
  });

  it("allows skipping an approved step and stamps finished_at with a null started_at", () => {
    const { db } = openSeededDb();
    try {
      seedStep(db, "run-1", "step-impl", "approved");

      const out = finishWorkflowStep(db, {
        runId: "run-1",
        stepId: "step-impl",
        state: "skipped",
        now: 9_000
      });

      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.state).toBe("skipped");
      expect(out.startedAt).toBeNull();
      expect(out.finishedAt).toBe(9_000);

      const raw = readRawStep(db, "run-1", "step-impl");
      expect(raw?.state).toBe("skipped");
      expect(raw?.started_at).toBeNull();
      expect(raw?.finished_at).toBe(9_000);
    } finally {
      db.close();
    }
  });

  it("throws when asked to finish into a non-terminal state", () => {
    const { db } = openSeededDb();
    try {
      seedStep(db, "run-1", "step-impl", "running", { startedAt: 4_000 });
      expect(() =>
        finishWorkflowStep(db, {
          runId: "run-1",
          stepId: "step-impl",
          // @ts-expect-error non-terminal target is a misuse
          state: "running",
          now: 9_000
        })
      ).toThrow(/terminal/);
    } finally {
      db.close();
    }
  });

  it("returns step_not_found for an absent step", () => {
    const { db } = openSeededDb();
    try {
      const out = finishWorkflowStep(db, {
        runId: "run-1",
        stepId: "missing",
        state: "succeeded",
        now: 9_000
      });
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.reason).toBe("step_not_found");
    } finally {
      db.close();
    }
  });
});

describe("getWorkflowStep", () => {
  it("returns undefined when absent and the mapped durable row when present", () => {
    const { db } = openSeededDb();
    try {
      expect(getWorkflowStep(db, "run-1", "step-impl")).toBeUndefined();

      seedStep(db, "run-1", "step-impl", "running", {
        kind: "implementation",
        startedAt: 4_000,
        resultDigest: "sha256:x"
      });

      expect(getWorkflowStep(db, "run-1", "step-impl")).toEqual({
        runId: "run-1",
        stepId: "step-impl",
        kind: "implementation",
        state: "running",
        startedAt: 4_000,
        finishedAt: null,
        errorCode: null,
        errorMessage: null,
        resultDigest: "sha256:x",
        operatorTransitionAt: null
      });
    } finally {
      db.close();
    }
  });
});

describe("workflow-step-transitions integration with deriveWorkflowRunState", () => {
  it("drives a single-step run pending-derivation through running then succeeded via durable transitions", () => {
    const { db } = openSeededDb();
    try {
      seedStep(db, "run-1", "step-impl", "approved", {
        kind: "implementation",
        order: 1,
        required: true
      });

      const toRecord = () => {
        const step = getWorkflowStep(db, "run-1", "step-impl");
        if (!step) throw new Error("step disappeared");
        return [
          {
            stepId: step.stepId,
            kind: step.kind,
            state: step.state,
            order: 1,
            required: true
          }
        ];
      };

      // approved -> running yields a running run state.
      const started = startWorkflowStep(db, {
        runId: "run-1",
        stepId: "step-impl",
        now: 5_000
      });
      expect(started.ok).toBe(true);
      expect(deriveWorkflowRunState(toRecord())).toBe("running");

      // running -> succeeded yields a succeeded run state (no outstanding leases).
      const finished = finishWorkflowStep(db, {
        runId: "run-1",
        stepId: "step-impl",
        state: "succeeded",
        resultDigest: "sha256:done",
        now: 8_000
      });
      expect(finished.ok).toBe(true);
      expect(deriveWorkflowRunState(toRecord())).toBe("succeeded");
    } finally {
      db.close();
    }
  });
});
