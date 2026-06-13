import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb } from "../src/adapters/db.js";
import {
  acquireRepoLock,
  getActiveRepoLock,
  getRepoLock,
  listStaleRepoLocks,
  releaseRepoLock,
  updateRepoLockHeartbeat
} from "../src/repo-locks.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix = "momentum-repo-locks-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

const REPO_ROOT = "/tmp/momentum-test-repo";

describe("acquireRepoLock", () => {
  it("acquires an active lease and stores all lease metadata", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const out = acquireRepoLock(db, {
        repoRoot: REPO_ROOT,
        holder: "worker-a",
        goalId: "g1",
        iteration: 1,
        jobId: "j1",
        leaseExpiresAt: 1_000,
        now: 100
      });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.lock.repo_root).toBe(REPO_ROOT);
      expect(out.lock.holder).toBe("worker-a");
      expect(out.lock.goal_id).toBe("g1");
      expect(out.lock.iteration).toBe(1);
      expect(out.lock.job_id).toBe("j1");
      expect(out.lock.state).toBe("active");
      expect(out.lock.recovery_status).toBeNull();
      expect(out.lock.acquired_at).toBe(100);
      expect(out.lock.heartbeat_at).toBe(100);
      expect(out.lock.lease_expires_at).toBe(1_000);
      expect(out.lock.released_at).toBeNull();
      expect(out.lock.updated_at).toBe(100);

      const active = getActiveRepoLock(db, REPO_ROOT);
      expect(active?.id).toBe(out.lockId);
    } finally {
      db.close();
    }
  });

  it("rejects a second active acquire for the same repo and surfaces the existing lease", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const first = acquireRepoLock(db, {
        repoRoot: REPO_ROOT,
        holder: "worker-a",
        goalId: "g1",
        iteration: 1,
        jobId: "j1",
        leaseExpiresAt: 1_000,
        now: 100
      });
      expect(first.ok).toBe(true);

      const second = acquireRepoLock(db, {
        repoRoot: REPO_ROOT,
        holder: "worker-b",
        goalId: "g2",
        iteration: 1,
        jobId: "j2",
        leaseExpiresAt: 2_000,
        now: 150
      });
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.reason).toBe("already_locked");
      if (!first.ok) return;
      expect(second.existing.id).toBe(first.lockId);
      expect(second.existing.holder).toBe("worker-a");
    } finally {
      db.close();
    }
  });

  it("allows a new acquire after the previous lease is released", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const first = acquireRepoLock(db, {
        repoRoot: REPO_ROOT,
        holder: "worker-a",
        goalId: "g1",
        iteration: 1,
        jobId: "j1",
        leaseExpiresAt: 1_000,
        now: 100
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      const release = releaseRepoLock(db, {
        lockId: first.lockId,
        now: 200,
        recoveryStatus: "clean_exit"
      });
      expect(release.ok).toBe(true);

      const released = getRepoLock(db, first.lockId);
      expect(released?.state).toBe("released");
      expect(released?.released_at).toBe(200);
      expect(released?.recovery_status).toBe("clean_exit");
      expect(getActiveRepoLock(db, REPO_ROOT)).toBeUndefined();

      const second = acquireRepoLock(db, {
        repoRoot: REPO_ROOT,
        holder: "worker-b",
        goalId: "g2",
        iteration: 1,
        jobId: "j2",
        leaseExpiresAt: 3_000,
        now: 250
      });
      expect(second.ok).toBe(true);
    } finally {
      db.close();
    }
  });

  it("releaseRepoLock returns ok=false when the lease is not active", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const acquired = acquireRepoLock(db, {
        repoRoot: REPO_ROOT,
        holder: "worker-a",
        goalId: "g1",
        iteration: 1,
        jobId: "j1",
        leaseExpiresAt: 1_000,
        now: 100
      });
      expect(acquired.ok).toBe(true);
      if (!acquired.ok) return;

      expect(releaseRepoLock(db, { lockId: acquired.lockId, now: 200 }).ok).toBe(
        true
      );
      // Second release does not flip state again.
      expect(releaseRepoLock(db, { lockId: acquired.lockId, now: 300 }).ok).toBe(
        false
      );
      expect(releaseRepoLock(db, { lockId: "missing", now: 300 }).ok).toBe(false);
    } finally {
      db.close();
    }
  });

  it("updateRepoLockHeartbeat refreshes heartbeat_at, lease_expires_at, updated_at", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const acquired = acquireRepoLock(db, {
        repoRoot: REPO_ROOT,
        holder: "worker-a",
        goalId: "g1",
        iteration: 1,
        jobId: "j1",
        leaseExpiresAt: 1_000,
        now: 100
      });
      expect(acquired.ok).toBe(true);
      if (!acquired.ok) return;

      const beat = updateRepoLockHeartbeat(db, {
        lockId: acquired.lockId,
        heartbeatAt: 500,
        leaseExpiresAt: 1_500
      });
      expect(beat.ok).toBe(true);
      const after = getRepoLock(db, acquired.lockId);
      expect(after?.heartbeat_at).toBe(500);
      expect(after?.lease_expires_at).toBe(1_500);
      expect(after?.updated_at).toBe(500);
    } finally {
      db.close();
    }
  });

  it("updateRepoLockHeartbeat returns ok=false for released or unknown locks", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const acquired = acquireRepoLock(db, {
        repoRoot: REPO_ROOT,
        holder: "worker-a",
        goalId: "g1",
        iteration: 1,
        jobId: "j1",
        leaseExpiresAt: 1_000,
        now: 100
      });
      expect(acquired.ok).toBe(true);
      if (!acquired.ok) return;
      releaseRepoLock(db, { lockId: acquired.lockId, now: 200 });

      expect(
        updateRepoLockHeartbeat(db, {
          lockId: acquired.lockId,
          heartbeatAt: 300,
          leaseExpiresAt: 2_000
        }).ok
      ).toBe(false);

      expect(
        updateRepoLockHeartbeat(db, {
          lockId: "missing",
          heartbeatAt: 300,
          leaseExpiresAt: 2_000
        }).ok
      ).toBe(false);
    } finally {
      db.close();
    }
  });

  it("updateRepoLockHeartbeat does not revive expired active locks", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const acquired = acquireRepoLock(db, {
        repoRoot: REPO_ROOT,
        holder: "worker-a",
        goalId: "g1",
        iteration: 1,
        jobId: "j1",
        leaseExpiresAt: 1_000,
        now: 100
      });
      expect(acquired.ok).toBe(true);
      if (!acquired.ok) return;

      expect(
        updateRepoLockHeartbeat(db, {
          lockId: acquired.lockId,
          heartbeatAt: 1_001,
          leaseExpiresAt: 2_000
        }).ok
      ).toBe(false);

      const after = getRepoLock(db, acquired.lockId);
      expect(after?.heartbeat_at).toBe(100);
      expect(after?.lease_expires_at).toBe(1_000);
    } finally {
      db.close();
    }
  });

  it("validates required acquire input", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const base = {
        repoRoot: REPO_ROOT,
        holder: "h",
        goalId: "g",
        iteration: 1,
        jobId: "j",
        leaseExpiresAt: 1_000
      };
      expect(() => acquireRepoLock(db, { ...base, repoRoot: "" })).toThrow(
        /repoRoot/
      );
      expect(() => acquireRepoLock(db, { ...base, holder: "" })).toThrow(
        /holder/
      );
      expect(() => acquireRepoLock(db, { ...base, goalId: "" })).toThrow(
        /goalId/
      );
      expect(() => acquireRepoLock(db, { ...base, iteration: 0 })).toThrow(
        /iteration/
      );
      expect(() => acquireRepoLock(db, { ...base, jobId: "" })).toThrow(/jobId/);
      expect(() =>
        acquireRepoLock(db, { ...base, leaseExpiresAt: 0 })
      ).toThrow(/leaseExpiresAt/);
    } finally {
      db.close();
    }
  });
});

describe("listStaleRepoLocks", () => {
  it("returns active locks whose lease has expired", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const acquired = acquireRepoLock(db, {
        repoRoot: REPO_ROOT,
        holder: "worker-a",
        goalId: "g1",
        iteration: 1,
        jobId: "j1",
        leaseExpiresAt: 1_000,
        now: 100
      });
      expect(acquired.ok).toBe(true);

      const stale = listStaleRepoLocks(db, { now: 2_000 });
      expect(stale.map((row) => row.repo_root)).toEqual([REPO_ROOT]);
      expect(stale[0]?.state).toBe("active");
    } finally {
      db.close();
    }
  });

  it("excludes active locks whose lease is still in the future", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      acquireRepoLock(db, {
        repoRoot: REPO_ROOT,
        holder: "worker-a",
        goalId: "g1",
        iteration: 1,
        jobId: "j1",
        leaseExpiresAt: 10_000,
        now: 100
      });
      expect(listStaleRepoLocks(db, { now: 5_000 })).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("excludes released locks even if the lease window is in the past", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const acquired = acquireRepoLock(db, {
        repoRoot: REPO_ROOT,
        holder: "worker-a",
        goalId: "g1",
        iteration: 1,
        jobId: "j1",
        leaseExpiresAt: 1_000,
        now: 100
      });
      expect(acquired.ok).toBe(true);
      if (!acquired.ok) return;
      releaseRepoLock(db, { lockId: acquired.lockId, now: 500 });

      expect(listStaleRepoLocks(db, { now: 9_000 })).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("orders multiple stale locks by lease_expires_at ascending", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      acquireRepoLock(db, {
        repoRoot: "/tmp/repo-a",
        holder: "worker-a",
        goalId: "g1",
        iteration: 1,
        jobId: "j1",
        leaseExpiresAt: 2_000,
        now: 100
      });
      acquireRepoLock(db, {
        repoRoot: "/tmp/repo-b",
        holder: "worker-b",
        goalId: "g2",
        iteration: 1,
        jobId: "j2",
        leaseExpiresAt: 1_000,
        now: 100
      });

      const stale = listStaleRepoLocks(db, { now: 5_000 });
      expect(stale.map((row) => row.repo_root)).toEqual([
        "/tmp/repo-b",
        "/tmp/repo-a"
      ]);
    } finally {
      db.close();
    }
  });

  it("supports an optional graceMs to tolerate small clock skew", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      acquireRepoLock(db, {
        repoRoot: REPO_ROOT,
        holder: "worker-a",
        goalId: "g1",
        iteration: 1,
        jobId: "j1",
        leaseExpiresAt: 1_000,
        now: 100
      });
      expect(
        listStaleRepoLocks(db, { now: 1_500, graceMs: 1_000 })
      ).toEqual([]);
      const stale = listStaleRepoLocks(db, {
        now: 3_000,
        graceMs: 1_000
      });
      expect(stale.map((row) => row.repo_root)).toEqual([REPO_ROOT]);
    } finally {
      db.close();
    }
  });

  it("validates now and graceMs inputs", () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      expect(() =>
        listStaleRepoLocks(db, { now: Number.NaN })
      ).toThrow(/now/);
      expect(() =>
        listStaleRepoLocks(db, { now: 100, graceMs: -1 })
      ).toThrow(/graceMs/);
      expect(() =>
        listStaleRepoLocks(db, { now: 100, graceMs: Number.NaN })
      ).toThrow(/graceMs/);
    } finally {
      db.close();
    }
  });
});
