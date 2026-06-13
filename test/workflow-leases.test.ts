import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import {
  acquireWorkflowLease,
  getWorkflowLease,
  heartbeatWorkflowLease,
  releaseWorkflowLease
} from "../src/workflow-leases.js";
import { classifyWorkflowLease } from "../src/workflow-run-reducer.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix = "momentum-workflow-leases-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function seedRun(db: MomentumDb, id: string): void {
  const at = 1_730_000_000_000;
  db.prepare(
    `INSERT INTO workflow_runs (id, source, created_at, updated_at)
     VALUES (?, ?, ?, ?)`
  ).run(id, "agent-workflow", at, at);
}

function openSeededDb(runId = "run-1"): { db: MomentumDb } {
  const db = openDb(makeTempDir());
  seedRun(db, runId);
  return { db };
}

type RawLeaseRow = {
  run_id: string;
  lease_kind: string;
  holder: string;
  acquired_at: number;
  expires_at: number;
  heartbeat_at: number;
  released_at: number | null;
  stale_policy: string;
  created_at: number;
  updated_at: number;
};

function readRawLease(
  db: MomentumDb,
  runId: string,
  leaseKind: string
): RawLeaseRow | undefined {
  return db
    .prepare(
      "SELECT * FROM workflow_leases WHERE run_id = ? AND lease_kind = ?"
    )
    .get(runId, leaseKind) as RawLeaseRow | undefined;
}

describe("acquireWorkflowLease", () => {
  it("acquires a fresh lease and stores all lease metadata", () => {
    const { db } = openSeededDb();
    try {
      const out = acquireWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "live-executor",
        expiresAt: 1_000,
        now: 100
      });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.lease).toEqual({
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "live-executor",
        acquiredAt: 100,
        expiresAt: 1_000,
        heartbeatAt: 100,
        releasedAt: null,
        stalePolicy: "auto-release"
      });

      const raw = readRawLease(db, "run-1", "managed-step");
      expect(raw?.created_at).toBe(100);
      expect(raw?.updated_at).toBe(100);
    } finally {
      db.close();
    }
  });

  it("honors an explicit manual-recovery-required stale policy", () => {
    const { db } = openSeededDb();
    try {
      const out = acquireWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "live-executor",
        expiresAt: 1_000,
        stalePolicy: "manual-recovery-required",
        now: 100
      });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.lease.stalePolicy).toBe("manual-recovery-required");
    } finally {
      db.close();
    }
  });

  it("refuses with already_held when an outstanding lease exists and does not overwrite it", () => {
    const { db } = openSeededDb();
    try {
      const first = acquireWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "holder-a",
        expiresAt: 1_000,
        now: 100
      });
      expect(first.ok).toBe(true);

      const second = acquireWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "holder-b",
        expiresAt: 5_000,
        now: 200
      });
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.reason).toBe("already_held");
      expect(second.existing.holder).toBe("holder-a");

      // The outstanding lease is untouched by the refused acquire.
      const raw = readRawLease(db, "run-1", "managed-step");
      expect(raw?.holder).toBe("holder-a");
      expect(raw?.expires_at).toBe(1_000);
      expect(raw?.updated_at).toBe(100);
    } finally {
      db.close();
    }
  });

  it("still refuses when an outstanding lease has expired (staleness is a recovery decision, not a silent takeover)", () => {
    const { db } = openSeededDb();
    try {
      acquireWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "holder-a",
        expiresAt: 1_000,
        now: 100
      });

      // now is well past expiresAt, but the row was never released.
      const second = acquireWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "holder-b",
        expiresAt: 9_000,
        now: 8_000
      });
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.reason).toBe("already_held");
      expect(second.existing.holder).toBe("holder-a");
    } finally {
      db.close();
    }
  });

  it("allows distinct lease kinds on the same run concurrently", () => {
    const { db } = openSeededDb();
    try {
      const managed = acquireWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "step-holder",
        expiresAt: 1_000,
        now: 100
      });
      const monitor = acquireWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "monitor",
        holder: "monitor-holder",
        expiresAt: 1_000,
        now: 100
      });
      expect(managed.ok).toBe(true);
      expect(monitor.ok).toBe(true);
    } finally {
      db.close();
    }
  });

  it("refuses a dispatch lease while a managed-step lease is outstanding", () => {
    const { db } = openSeededDb();
    try {
      const managed = acquireWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "step-holder",
        expiresAt: 1_000,
        now: 100
      });
      expect(managed.ok).toBe(true);

      const dispatch = acquireWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "dispatch",
        holder: "dispatch-holder",
        expiresAt: 2_000,
        now: 200
      });

      expect(dispatch.ok).toBe(false);
      if (dispatch.ok) return;
      expect(dispatch.reason).toBe("already_held");
      expect(dispatch.existing.leaseKind).toBe("managed-step");
      expect(getWorkflowLease(db, "run-1", "dispatch")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("refuses a managed-step lease while a dispatch lease is outstanding", () => {
    const { db } = openSeededDb();
    try {
      const dispatch = acquireWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "dispatch",
        holder: "dispatch-holder",
        expiresAt: 1_000,
        now: 100
      });
      expect(dispatch.ok).toBe(true);

      const managed = acquireWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "step-holder",
        expiresAt: 2_000,
        now: 200
      });

      expect(managed.ok).toBe(false);
      if (managed.ok) return;
      expect(managed.reason).toBe("already_held");
      expect(managed.existing.leaseKind).toBe("dispatch");
      expect(getWorkflowLease(db, "run-1", "managed-step")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("takes over a previously released lease row, preserving created_at", () => {
    const { db } = openSeededDb();
    try {
      acquireWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "holder-a",
        expiresAt: 1_000,
        now: 100
      });
      const released = releaseWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "holder-a",
        acquiredAt: 100,
        now: 300
      });
      expect(released.ok).toBe(true);

      const reacquired = acquireWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "holder-b",
        expiresAt: 9_000,
        now: 400
      });
      expect(reacquired.ok).toBe(true);
      if (!reacquired.ok) return;
      expect(reacquired.lease).toEqual({
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "holder-b",
        acquiredAt: 400,
        expiresAt: 9_000,
        heartbeatAt: 400,
        releasedAt: null,
        stalePolicy: "auto-release"
      });

      const raw = readRawLease(db, "run-1", "managed-step");
      // created_at is preserved from the original row; updated_at advances.
      expect(raw?.created_at).toBe(100);
      expect(raw?.updated_at).toBe(400);
    } finally {
      db.close();
    }
  });

  it("validates required inputs", () => {
    const { db } = openSeededDb();
    try {
      expect(() =>
        acquireWorkflowLease(db, {
          runId: "",
          leaseKind: "managed-step",
          holder: "h",
          expiresAt: 1_000
        })
      ).toThrow(/runId/);
      expect(() =>
        acquireWorkflowLease(db, {
          runId: "run-1",
          leaseKind: "managed-step",
          holder: "",
          expiresAt: 1_000
        })
      ).toThrow(/holder/);
      expect(() =>
        acquireWorkflowLease(db, {
          runId: "run-1",
          // @ts-expect-error intentionally invalid lease kind
          leaseKind: "not-a-kind",
          holder: "h",
          expiresAt: 1_000
        })
      ).toThrow(/leaseKind/);
      expect(() =>
        acquireWorkflowLease(db, {
          runId: "run-1",
          leaseKind: "managed-step",
          holder: "h",
          expiresAt: 0
        })
      ).toThrow(/expiresAt/);
    } finally {
      db.close();
    }
  });

  it("rejects acquisitions whose expiry is not after the acquisition time", () => {
    const { db } = openSeededDb();
    try {
      expect(() =>
        acquireWorkflowLease(db, {
          runId: "run-1",
          leaseKind: "managed-step",
          holder: "h",
          expiresAt: 1_000,
          now: 1_000
        })
      ).toThrow(/expiresAt/);

      expect(getWorkflowLease(db, "run-1", "managed-step")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("rejects released-row takeover when the monotonic acquisition time would already be expired", () => {
    const { db } = openSeededDb();
    try {
      const first = acquireWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "holder-a",
        expiresAt: 10_000,
        now: 500
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      expect(
        releaseWorkflowLease(db, {
          runId: "run-1",
          leaseKind: "managed-step",
          holder: "holder-a",
          acquiredAt: first.lease.acquiredAt,
          now: 600
        }).ok
      ).toBe(true);

      expect(() =>
        acquireWorkflowLease(db, {
          runId: "run-1",
          leaseKind: "managed-step",
          holder: "holder-b",
          expiresAt: first.lease.acquiredAt + 1,
          now: 400
        })
      ).toThrow(/expiresAt/);

      const lease = getWorkflowLease(db, "run-1", "managed-step");
      expect(lease?.holder).toBe("holder-a");
      expect(lease?.releasedAt).toBe(600);
    } finally {
      db.close();
    }
  });
});

describe("heartbeatWorkflowLease", () => {
  it("advances heartbeat and expiry on an outstanding lease without touching acquire metadata", () => {
    const { db } = openSeededDb();
    try {
      acquireWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "holder-a",
        expiresAt: 1_000,
        now: 100
      });

      const beat = heartbeatWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "holder-a",
        acquiredAt: 100,
        heartbeatAt: 500,
        expiresAt: 6_000
      });
      expect(beat.ok).toBe(true);

      const lease = getWorkflowLease(db, "run-1", "managed-step");
      expect(lease?.heartbeatAt).toBe(500);
      expect(lease?.expiresAt).toBe(6_000);
      expect(lease?.acquiredAt).toBe(100);
      expect(lease?.holder).toBe("holder-a");

      const raw = readRawLease(db, "run-1", "managed-step");
      expect(raw?.updated_at).toBe(500);
    } finally {
      db.close();
    }
  });

  it("returns ok:false for a released lease", () => {
    const { db } = openSeededDb();
    try {
      acquireWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "holder-a",
        expiresAt: 1_000,
        now: 100
      });
      releaseWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "holder-a",
        acquiredAt: 100,
        now: 200
      });

      const beat = heartbeatWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "holder-a",
        acquiredAt: 100,
        heartbeatAt: 500,
        expiresAt: 6_000
      });
      expect(beat.ok).toBe(false);
    } finally {
      db.close();
    }
  });

  it("returns ok:false for a lease that does not exist", () => {
    const { db } = openSeededDb();
    try {
      const beat = heartbeatWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "holder-a",
        acquiredAt: 100,
        heartbeatAt: 500,
        expiresAt: 6_000
      });
      expect(beat.ok).toBe(false);
    } finally {
      db.close();
    }
  });

  it("rejects heartbeats from a previous holder after lease reacquisition", () => {
    const { db } = openSeededDb();
    try {
      acquireWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "holder-a",
        expiresAt: 1_000,
        now: 100
      });
      releaseWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "holder-a",
        acquiredAt: 100,
        now: 200
      });
      acquireWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "holder-b",
        expiresAt: 9_000,
        now: 300
      });

      const beat = heartbeatWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "holder-a",
        acquiredAt: 100,
        heartbeatAt: 500,
        expiresAt: 6_000
      });

      expect(beat.ok).toBe(false);
      const lease = getWorkflowLease(db, "run-1", "managed-step");
      expect(lease?.holder).toBe("holder-b");
      expect(lease?.acquiredAt).toBe(300);
      expect(lease?.heartbeatAt).toBe(300);
      expect(lease?.expiresAt).toBe(9_000);
    } finally {
      db.close();
    }
  });

  it("rejects stale heartbeats when the same holder reacquires in the same millisecond", () => {
    const { db } = openSeededDb();
    try {
      const first = acquireWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "holder-a",
        expiresAt: 1_000,
        now: 100
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      expect(
        releaseWorkflowLease(db, {
          runId: "run-1",
          leaseKind: "managed-step",
          holder: "holder-a",
          acquiredAt: first.lease.acquiredAt,
          now: 100
        }).ok
      ).toBe(true);

      const reacquired = acquireWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "holder-a",
        expiresAt: 9_000,
        now: 100
      });
      expect(reacquired.ok).toBe(true);
      if (!reacquired.ok) return;
      expect(reacquired.lease.acquiredAt).toBeGreaterThan(
        first.lease.acquiredAt
      );

      const beat = heartbeatWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "holder-a",
        acquiredAt: first.lease.acquiredAt,
        heartbeatAt: 500,
        expiresAt: 6_000
      });

      expect(beat.ok).toBe(false);
      const lease = getWorkflowLease(db, "run-1", "managed-step");
      expect(lease?.holder).toBe("holder-a");
      expect(lease?.acquiredAt).toBe(reacquired.lease.acquiredAt);
      expect(lease?.heartbeatAt).toBe(reacquired.lease.heartbeatAt);
      expect(lease?.expiresAt).toBe(9_000);
    } finally {
      db.close();
    }
  });

  it("rejects heartbeats after the lease has already expired", () => {
    const { db } = openSeededDb();
    try {
      acquireWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "holder-a",
        expiresAt: 1_000,
        now: 100
      });

      const beat = heartbeatWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "holder-a",
        acquiredAt: 100,
        heartbeatAt: 1_001,
        expiresAt: 6_000
      });

      expect(beat.ok).toBe(false);
      const lease = getWorkflowLease(db, "run-1", "managed-step");
      expect(lease?.heartbeatAt).toBe(100);
      expect(lease?.expiresAt).toBe(1_000);
    } finally {
      db.close();
    }
  });
});

describe("releaseWorkflowLease", () => {
  it("releases an outstanding lease and is not re-releasable", () => {
    const { db } = openSeededDb();
    try {
      acquireWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "holder-a",
        expiresAt: 1_000,
        now: 100
      });

      const first = releaseWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "holder-a",
        acquiredAt: 100,
        now: 300
      });
      expect(first.ok).toBe(true);

      const lease = getWorkflowLease(db, "run-1", "managed-step");
      expect(lease?.releasedAt).toBe(300);

      const second = releaseWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "holder-a",
        acquiredAt: 100,
        now: 400
      });
      expect(second.ok).toBe(false);
    } finally {
      db.close();
    }
  });

  it("returns ok:false for a lease that does not exist", () => {
    const { db } = openSeededDb();
    try {
      const out = releaseWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "holder-a",
        acquiredAt: 100,
        now: 300
      });
      expect(out.ok).toBe(false);
    } finally {
      db.close();
    }
  });

  it("rejects release from a previous holder after lease reacquisition", () => {
    const { db } = openSeededDb();
    try {
      acquireWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "holder-a",
        expiresAt: 1_000,
        now: 100
      });
      releaseWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "holder-a",
        acquiredAt: 100,
        now: 200
      });
      acquireWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "holder-b",
        expiresAt: 9_000,
        now: 300
      });

      const released = releaseWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "holder-a",
        acquiredAt: 100,
        now: 500
      });

      expect(released.ok).toBe(false);
      const lease = getWorkflowLease(db, "run-1", "managed-step");
      expect(lease?.holder).toBe("holder-b");
      expect(lease?.releasedAt).toBeNull();
    } finally {
      db.close();
    }
  });

  it("rejects stale release when the same holder reacquires in the same millisecond", () => {
    const { db } = openSeededDb();
    try {
      const first = acquireWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "holder-a",
        expiresAt: 1_000,
        now: 100
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      expect(
        releaseWorkflowLease(db, {
          runId: "run-1",
          leaseKind: "managed-step",
          holder: "holder-a",
          acquiredAt: first.lease.acquiredAt,
          now: 100
        }).ok
      ).toBe(true);

      const reacquired = acquireWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "holder-a",
        expiresAt: 9_000,
        now: 100
      });
      expect(reacquired.ok).toBe(true);
      if (!reacquired.ok) return;

      const released = releaseWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "holder-a",
        acquiredAt: first.lease.acquiredAt,
        now: 500
      });

      expect(released.ok).toBe(false);
      const lease = getWorkflowLease(db, "run-1", "managed-step");
      expect(lease?.acquiredAt).toBe(reacquired.lease.acquiredAt);
      expect(lease?.releasedAt).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe("getWorkflowLease", () => {
  it("returns undefined when absent and the mapped record when present", () => {
    const { db } = openSeededDb();
    try {
      expect(getWorkflowLease(db, "run-1", "managed-step")).toBeUndefined();

      acquireWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "holder-a",
        expiresAt: 1_000,
        now: 100
      });

      expect(getWorkflowLease(db, "run-1", "managed-step")).toEqual({
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "holder-a",
        acquiredAt: 100,
        expiresAt: 1_000,
        heartbeatAt: 100,
        releasedAt: null,
        stalePolicy: "auto-release"
      });
    } finally {
      db.close();
    }
  });
});

describe("workflow-leases integration with classifyWorkflowLease", () => {
  it("produces records the reducer classifies across fresh, stale, and released states", () => {
    const { db } = openSeededDb();
    try {
      const acquired = acquireWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "holder-a",
        expiresAt: 1_000,
        stalePolicy: "manual-recovery-required",
        now: 100
      });
      expect(acquired.ok).toBe(true);
      if (!acquired.ok) return;

      // Fresh: now is before expiry.
      expect(classifyWorkflowLease(acquired.lease, { now: 500 })).toBe("fresh");
      // Stale with a manual-recovery policy: now is past expiry.
      expect(classifyWorkflowLease(acquired.lease, { now: 2_000 })).toBe(
        "stale-manual-recovery-required"
      );

      releaseWorkflowLease(db, {
        runId: "run-1",
        leaseKind: "managed-step",
        holder: "holder-a",
        acquiredAt: 100,
        now: 600
      });
      const released = getWorkflowLease(db, "run-1", "managed-step");
      expect(released).toBeDefined();
      if (!released) return;
      expect(classifyWorkflowLease(released, { now: 2_000 })).toBe("released");
    } finally {
      db.close();
    }
  });
});
