import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb } from "../src/db.js";
import {
  DAEMON_CANCEL_OUTCOMES,
  DAEMON_RUN_STATES,
  finishDaemonRun,
  getActiveDaemonRun,
  getDaemonRun,
  getLatestDaemonRun,
  heartbeatDaemonRun,
  isActiveDaemonRunState,
  isTerminalDaemonRunState,
  listStaleDaemonRuns,
  recordDaemonRunReconciliation,
  requestDaemonRunImmediateStop,
  requestDaemonRunStop,
  setDaemonRunActiveJob,
  startDaemonRun
} from "../src/daemon-runs.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix = "momentum-daemon-runs-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

describe("DAEMON_RUN_STATES classification", () => {
  it("classifies active vs terminal states deterministically", () => {
    expect(new Set(DAEMON_RUN_STATES)).toEqual(
      new Set([
        "starting",
        "running",
        "stop_requested",
        "stopped",
        "canceled",
        "error"
      ])
    );
    for (const state of ["starting", "running", "stop_requested"] as const) {
      expect(isActiveDaemonRunState(state)).toBe(true);
      expect(isTerminalDaemonRunState(state)).toBe(false);
    }
    for (const state of ["stopped", "canceled", "error"] as const) {
      expect(isActiveDaemonRunState(state)).toBe(false);
      expect(isTerminalDaemonRunState(state)).toBe(true);
    }
  });
});

describe("startDaemonRun", () => {
  it("records pid, host, default 'running' state, and all timestamps", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { runId, run } = startDaemonRun(db, {
        pid: 42,
        host: "node-1",
        now: 1_000
      });

      expect(run.id).toBe(runId);
      expect(run.pid).toBe(42);
      expect(run.host).toBe("node-1");
      expect(run.state).toBe("running");
      expect(run.started_at).toBe(1_000);
      expect(run.heartbeat_at).toBe(1_000);
      expect(run.last_state_change_at).toBe(1_000);
      expect(run.finished_at).toBeNull();
      expect(run.active_job_id).toBeNull();
      expect(run.active_lock_id).toBeNull();
      expect(run.stop_requested_at).toBeNull();
      expect(run.stop_reason).toBeNull();
      expect(run.reconcile_count).toBe(0);
      expect(run.last_reconciled_at).toBeNull();
      expect(run.error).toBeNull();
      expect(run.error_at).toBeNull();
      expect(run.updated_at).toBe(1_000);
    } finally {
      db.close();
    }
  });

  it("enforces one active daemon run at the database layer", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      startDaemonRun(db, { now: 100 });
      expect(() => startDaemonRun(db, { now: 200 })).toThrow(
        /UNIQUE/
      );
    } finally {
      db.close();
    }
  });

  it("allows initial state 'starting' and rejects other initial states", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const out = startDaemonRun(db, { now: 100, state: "starting" });
      expect(out.run.state).toBe("starting");
      expect(() =>
        startDaemonRun(db, {
          now: 200,
          // @ts-expect-error invalid initial state for runtime test
          state: "stopped"
        })
      ).toThrow(/initial state/);
    } finally {
      db.close();
    }
  });

  it("validates pid and host inputs", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      expect(() => startDaemonRun(db, { pid: 0 })).toThrow(/pid/);
      expect(() => startDaemonRun(db, { pid: -1 })).toThrow(/pid/);
      expect(() => startDaemonRun(db, { host: "" })).toThrow(/host/);
    } finally {
      db.close();
    }
  });

  it("permits null pid and host", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { run } = startDaemonRun(db, { now: 5 });
      expect(run.pid).toBeNull();
      expect(run.host).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe("heartbeatDaemonRun", () => {
  it("refreshes heartbeat_at and updated_at on an active run", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { runId } = startDaemonRun(db, { now: 100 });
      const beat = heartbeatDaemonRun(db, { runId, now: 500 });
      expect(beat.ok).toBe(true);

      const refreshed = getDaemonRun(db, runId);
      expect(refreshed?.heartbeat_at).toBe(500);
      expect(refreshed?.updated_at).toBe(500);
      expect(refreshed?.state).toBe("running");
      expect(refreshed?.last_state_change_at).toBe(100);
    } finally {
      db.close();
    }
  });

  it("returns ok=false for unknown ids and terminal runs", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      expect(
        heartbeatDaemonRun(db, { runId: "missing", now: 500 }).ok
      ).toBe(false);

      const { runId } = startDaemonRun(db, { now: 100 });
      finishDaemonRun(db, { runId, terminalState: "stopped", now: 200 });
      expect(heartbeatDaemonRun(db, { runId, now: 500 }).ok).toBe(false);
    } finally {
      db.close();
    }
  });

  it("validates runId", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      expect(() =>
        heartbeatDaemonRun(db, { runId: "", now: 5 })
      ).toThrow(/runId/);
    } finally {
      db.close();
    }
  });
});

describe("requestDaemonRunStop", () => {
  it("transitions an active run to stop_requested and records reason", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { runId } = startDaemonRun(db, { now: 100 });
      const stopped = requestDaemonRunStop(db, {
        runId,
        reason: "operator_request",
        now: 250
      });
      expect(stopped.ok).toBe(true);

      const after = getDaemonRun(db, runId);
      expect(after?.state).toBe("stop_requested");
      expect(after?.stop_requested_at).toBe(250);
      expect(after?.stop_reason).toBe("operator_request");
      expect(after?.last_state_change_at).toBe(250);
      expect(after?.updated_at).toBe(250);
    } finally {
      db.close();
    }
  });

  it("is idempotent on a run already in stop_requested without resetting state change timestamp", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { runId } = startDaemonRun(db, { now: 100 });
      requestDaemonRunStop(db, { runId, reason: "first", now: 200 });
      const out = requestDaemonRunStop(db, {
        runId,
        reason: "second",
        now: 400
      });
      expect(out.ok).toBe(true);

      const after = getDaemonRun(db, runId);
      expect(after?.state).toBe("stop_requested");
      // first request stamps the timestamp; later ones refresh reason only
      expect(after?.stop_requested_at).toBe(200);
      expect(after?.stop_reason).toBe("second");
      expect(after?.last_state_change_at).toBe(200);
      expect(after?.updated_at).toBe(400);
    } finally {
      db.close();
    }
  });

  it("refuses to mutate terminal runs", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { runId } = startDaemonRun(db, { now: 100 });
      finishDaemonRun(db, { runId, terminalState: "stopped", now: 150 });
      const out = requestDaemonRunStop(db, {
        runId,
        reason: "too_late",
        now: 200
      });
      expect(out.ok).toBe(false);
      expect(getDaemonRun(db, runId)?.state).toBe("stopped");
    } finally {
      db.close();
    }
  });

  it("validates inputs", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      expect(() =>
        requestDaemonRunStop(db, { runId: "", reason: "r" })
      ).toThrow(/runId/);
      expect(() =>
        requestDaemonRunStop(db, { runId: "a", reason: "" })
      ).toThrow(/reason/);
    } finally {
      db.close();
    }
  });
});

describe("requestDaemonRunImmediateStop", () => {
  it("stamps stop_now_requested_at alongside graceful stop columns on an active run", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { runId } = startDaemonRun(db, { now: 100 });
      const out = requestDaemonRunImmediateStop(db, {
        runId,
        reason: "operator-now",
        now: 250
      });
      expect(out.ok).toBe(true);

      const after = getDaemonRun(db, runId);
      expect(after?.state).toBe("stop_requested");
      expect(after?.stop_requested_at).toBe(250);
      expect(after?.stop_now_requested_at).toBe(250);
      expect(after?.stop_reason).toBe("operator-now");
      expect(after?.last_state_change_at).toBe(250);
    } finally {
      db.close();
    }
  });

  it("preserves earliest stop_requested_at when upgrading from graceful to stop_now", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { runId } = startDaemonRun(db, { now: 100 });
      requestDaemonRunStop(db, { runId, reason: "graceful", now: 200 });
      const out = requestDaemonRunImmediateStop(db, {
        runId,
        reason: "now-please",
        now: 400
      });
      expect(out.ok).toBe(true);

      const after = getDaemonRun(db, runId);
      expect(after?.stop_requested_at).toBe(200);
      expect(after?.stop_now_requested_at).toBe(400);
      expect(after?.stop_reason).toBe("now-please");
      // last_state_change_at stays at 200 because we were already stop_requested.
      expect(after?.last_state_change_at).toBe(200);
    } finally {
      db.close();
    }
  });

  it("is idempotent for repeat stop-now calls without resetting stop_now_requested_at", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { runId } = startDaemonRun(db, { now: 100 });
      requestDaemonRunImmediateStop(db, {
        runId,
        reason: "first",
        now: 200
      });
      const out = requestDaemonRunImmediateStop(db, {
        runId,
        reason: "second",
        now: 350
      });
      expect(out.ok).toBe(true);

      const after = getDaemonRun(db, runId);
      expect(after?.stop_now_requested_at).toBe(200);
      expect(after?.stop_requested_at).toBe(200);
      expect(after?.stop_reason).toBe("first");
    } finally {
      db.close();
    }
  });

  it("preserves stop-now reason when a later graceful stop is requested", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { runId } = startDaemonRun(db, { now: 100 });
      requestDaemonRunImmediateStop(db, {
        runId,
        reason: "now-reason",
        now: 200
      });
      const out = requestDaemonRunStop(db, {
        runId,
        reason: "later-graceful",
        now: 350
      });
      expect(out.ok).toBe(true);

      const after = getDaemonRun(db, runId);
      expect(after?.stop_now_requested_at).toBe(200);
      expect(after?.stop_requested_at).toBe(200);
      expect(after?.stop_reason).toBe("now-reason");
      expect(after?.updated_at).toBe(350);
    } finally {
      db.close();
    }
  });

  it("refuses to mutate terminal runs", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { runId } = startDaemonRun(db, { now: 100 });
      finishDaemonRun(db, { runId, terminalState: "stopped", now: 150 });
      const out = requestDaemonRunImmediateStop(db, {
        runId,
        reason: "nope",
        now: 200
      });
      expect(out.ok).toBe(false);

      const after = getDaemonRun(db, runId);
      expect(after?.state).toBe("stopped");
      expect(after?.stop_now_requested_at).toBeNull();
    } finally {
      db.close();
    }
  });

  it("validates inputs", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      expect(() =>
        requestDaemonRunImmediateStop(db, { runId: "", reason: "r" })
      ).toThrow(/runId/);
      expect(() =>
        requestDaemonRunImmediateStop(db, { runId: "a", reason: "" })
      ).toThrow(/reason/);
    } finally {
      db.close();
    }
  });
});

describe("finishDaemonRun", () => {
  it("stops a running daemon and clears active job/lock linkage", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { runId } = startDaemonRun(db, { now: 100 });
      setDaemonRunActiveJob(db, {
        runId,
        jobId: "job-1",
        lockId: "lock-1",
        now: 150
      });
      const out = finishDaemonRun(db, {
        runId,
        terminalState: "stopped",
        now: 300
      });
      expect(out.ok).toBe(true);

      const after = getDaemonRun(db, runId);
      expect(after?.state).toBe("stopped");
      expect(after?.finished_at).toBe(300);
      expect(after?.last_state_change_at).toBe(300);
      expect(after?.active_job_id).toBeNull();
      expect(after?.active_lock_id).toBeNull();
      expect(after?.error).toBeNull();
      expect(after?.error_at).toBeNull();
    } finally {
      db.close();
    }
  });

  it("records error message and error_at when terminalState is 'error'", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { runId } = startDaemonRun(db, { now: 100 });
      const out = finishDaemonRun(db, {
        runId,
        terminalState: "error",
        now: 400,
        error: "panic in worker loop"
      });
      expect(out.ok).toBe(true);

      const after = getDaemonRun(db, runId);
      expect(after?.state).toBe("error");
      expect(after?.error).toBe("panic in worker loop");
      expect(after?.error_at).toBe(400);
      expect(after?.finished_at).toBe(400);
    } finally {
      db.close();
    }
  });

  it("requires an error message for terminalState 'error'", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { runId } = startDaemonRun(db, { now: 100 });
      expect(() =>
        finishDaemonRun(db, { runId, terminalState: "error", now: 200 })
      ).toThrow(/error message/);
    } finally {
      db.close();
    }
  });

  it("refuses to mutate a record that is already terminal", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { runId } = startDaemonRun(db, { now: 100 });
      finishDaemonRun(db, { runId, terminalState: "stopped", now: 200 });
      const out = finishDaemonRun(db, {
        runId,
        terminalState: "error",
        now: 300,
        error: "race"
      });
      expect(out.ok).toBe(false);
      const after = getDaemonRun(db, runId);
      expect(after?.state).toBe("stopped");
      expect(after?.error).toBeNull();
    } finally {
      db.close();
    }
  });

  it("records cancel_outcome and finalizes when terminalState is 'canceled'", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { runId } = startDaemonRun(db, { now: 100 });
      requestDaemonRunImmediateStop(db, {
        runId,
        reason: "operator-now",
        now: 150
      });
      const out = finishDaemonRun(db, {
        runId,
        terminalState: "canceled",
        cancelOutcome: "idle",
        now: 250
      });
      expect(out.ok).toBe(true);

      const after = getDaemonRun(db, runId);
      expect(after?.state).toBe("canceled");
      expect(after?.cancel_outcome).toBe("idle");
      expect(after?.finished_at).toBe(250);
      expect(after?.error).toBeNull();
      expect(after?.error_at).toBeNull();
      expect(after?.active_job_id).toBeNull();
    } finally {
      db.close();
    }
  });

  it("requires cancel_outcome when terminalState is 'canceled'", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { runId } = startDaemonRun(db, { now: 100 });
      expect(() =>
        finishDaemonRun(db, {
          runId,
          terminalState: "canceled",
          now: 200
        })
      ).toThrow(/cancelOutcome/);
    } finally {
      db.close();
    }
  });

  it("rejects unknown cancel outcomes", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { runId } = startDaemonRun(db, { now: 100 });
      expect(() =>
        finishDaemonRun(db, {
          runId,
          terminalState: "canceled",
          // @ts-expect-error invalid outcome for runtime test
          cancelOutcome: "not-a-real-outcome",
          now: 200
        })
      ).toThrow(/cancelOutcome/);
    } finally {
      db.close();
    }
  });

  it("exposes DAEMON_CANCEL_OUTCOMES as a stable list", () => {
    expect(new Set(DAEMON_CANCEL_OUTCOMES)).toEqual(
      new Set(["idle", "active_job_completed", "active_job_abandoned"])
    );
  });

  it("rejects invalid terminal states", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { runId } = startDaemonRun(db, { now: 100 });
      expect(() =>
        finishDaemonRun(db, {
          runId,
          // @ts-expect-error invalid terminal state for runtime test
          terminalState: "running",
          now: 200
        })
      ).toThrow(/terminalState/);
    } finally {
      db.close();
    }
  });
});

describe("setDaemonRunActiveJob", () => {
  it("attaches and clears active job/lock linkage on active runs", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { runId } = startDaemonRun(db, { now: 100 });

      const attached = setDaemonRunActiveJob(db, {
        runId,
        jobId: "j1",
        lockId: "l1",
        now: 200
      });
      expect(attached.ok).toBe(true);
      const after = getDaemonRun(db, runId);
      expect(after?.active_job_id).toBe("j1");
      expect(after?.active_lock_id).toBe("l1");
      expect(after?.updated_at).toBe(200);

      const cleared = setDaemonRunActiveJob(db, {
        runId,
        jobId: null,
        lockId: null,
        now: 300
      });
      expect(cleared.ok).toBe(true);
      const cleared_after = getDaemonRun(db, runId);
      expect(cleared_after?.active_job_id).toBeNull();
      expect(cleared_after?.active_lock_id).toBeNull();
    } finally {
      db.close();
    }
  });

  it("refuses to mutate terminal runs", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { runId } = startDaemonRun(db, { now: 100 });
      finishDaemonRun(db, { runId, terminalState: "stopped", now: 150 });
      const out = setDaemonRunActiveJob(db, {
        runId,
        jobId: "j1",
        now: 200
      });
      expect(out.ok).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe("recordDaemonRunReconciliation", () => {
  it("bumps reconcile_count and stamps last_reconciled_at", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { runId } = startDaemonRun(db, { now: 100 });
      expect(
        recordDaemonRunReconciliation(db, { runId, now: 200 }).ok
      ).toBe(true);
      expect(
        recordDaemonRunReconciliation(db, { runId, now: 250 }).ok
      ).toBe(true);
      const after = getDaemonRun(db, runId);
      expect(after?.reconcile_count).toBe(2);
      expect(after?.last_reconciled_at).toBe(250);
      expect(after?.updated_at).toBe(250);
    } finally {
      db.close();
    }
  });

  it("refuses to bump terminal runs", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { runId } = startDaemonRun(db, { now: 100 });
      finishDaemonRun(db, { runId, terminalState: "stopped", now: 200 });
      expect(
        recordDaemonRunReconciliation(db, { runId, now: 300 }).ok
      ).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe("getActiveDaemonRun and getLatestDaemonRun", () => {
  it("returns undefined when no daemon record exists", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      expect(getActiveDaemonRun(db)).toBeUndefined();
      expect(getLatestDaemonRun(db)).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("getActiveDaemonRun ignores terminal runs and returns the most recently started active one", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const older = startDaemonRun(db, { now: 100, pid: 1 });
      finishDaemonRun(db, {
        runId: older.runId,
        terminalState: "stopped",
        now: 150
      });
      const middle = startDaemonRun(db, { now: 200, pid: 2 });
      finishDaemonRun(db, {
        runId: middle.runId,
        terminalState: "stopped",
        now: 250
      });
      const newest = startDaemonRun(db, { now: 300, pid: 3 });

      const active = getActiveDaemonRun(db);
      expect(active?.id).toBe(newest.runId);

      // and the latest record (regardless of state) is also the newest start
      expect(getLatestDaemonRun(db)?.id).toBe(newest.runId);

      // unused but ensures the middle row is preserved
      expect(getDaemonRun(db, middle.runId)?.state).toBe("stopped");
    } finally {
      db.close();
    }
  });

  it("getLatestDaemonRun returns the most recently started record even if terminal", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const first = startDaemonRun(db, { now: 100 });
      finishDaemonRun(db, {
        runId: first.runId,
        terminalState: "stopped",
        now: 150
      });
      const second = startDaemonRun(db, { now: 200 });
      finishDaemonRun(db, {
        runId: second.runId,
        terminalState: "stopped",
        now: 250
      });
      const latest = getLatestDaemonRun(db);
      expect(latest?.id).toBe(second.runId);
      expect(latest?.state).toBe("stopped");
      expect(getActiveDaemonRun(db)).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe("listStaleDaemonRuns", () => {
  it("returns active runs whose heartbeat is older than now - staleAfterMs", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const stale = startDaemonRun(db, { now: 1_000 });

      const out = listStaleDaemonRuns(db, {
        now: 10_000,
        staleAfterMs: 5_000
      });
      expect(out.map((row) => row.id)).toEqual([stale.runId]);
    } finally {
      db.close();
    }
  });

  it("excludes active runs whose heartbeat is still fresh", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const fresh = startDaemonRun(db, { now: 1_000 });
      heartbeatDaemonRun(db, { runId: fresh.runId, now: 9_000 });

      const out = listStaleDaemonRuns(db, {
        now: 10_000,
        staleAfterMs: 5_000
      });
      expect(out).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("uses the longer stale cutoff for runs with an active job", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const activeWork = startDaemonRun(db, { now: 1_000 });
      setDaemonRunActiveJob(db, {
        runId: activeWork.runId,
        jobId: "job-1",
        lockId: "lock-1",
        now: 1_000
      });

      const notYetStale = listStaleDaemonRuns(db, {
        now: 100_000,
        staleAfterMs: 5_000,
        activeJobStaleAfterMs: 120_000
      });
      expect(notYetStale).toEqual([]);

      const stale = listStaleDaemonRuns(db, {
        now: 130_000,
        staleAfterMs: 5_000,
        activeJobStaleAfterMs: 120_000
      });
      expect(stale.map((row) => row.id)).toEqual([activeWork.runId]);

      const shorterActiveJobCutoff = listStaleDaemonRuns(db, {
        now: 11_000,
        staleAfterMs: 120_000,
        activeJobStaleAfterMs: 5_000
      });
      expect(shorterActiveJobCutoff.map((row) => row.id)).toEqual([
        activeWork.runId
      ]);
    } finally {
      db.close();
    }
  });

  it("excludes terminal runs even when their heartbeat is ancient", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const old = startDaemonRun(db, { now: 1_000 });
      finishDaemonRun(db, {
        runId: old.runId,
        terminalState: "stopped",
        now: 1_500
      });
      const out = listStaleDaemonRuns(db, {
        now: 10_000,
        staleAfterMs: 1_000
      });
      expect(out).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("validates staleAfterMs", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      expect(() =>
        listStaleDaemonRuns(db, { now: 100, staleAfterMs: 0 })
      ).toThrow(/staleAfterMs/);
      expect(() =>
        listStaleDaemonRuns(db, { now: 100, staleAfterMs: -5 })
      ).toThrow(/staleAfterMs/);
      expect(() =>
        listStaleDaemonRuns(db, { now: Number.NaN, staleAfterMs: 1 })
      ).toThrow(/now/);
    } finally {
      db.close();
    }
  });
});
