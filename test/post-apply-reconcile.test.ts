import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb } from "../src/adapters/db.js";
import {
  POST_APPLY_RECONCILE_OUTCOME_CODES,
  reconcileAfterExternalApply,
  type PostApplyReconcileClient
} from "../src/post-apply-reconcile.js";
import {
  getSourceItemByAdapterExternalId,
  listSourceSnapshotsForItem,
  upsertSourceItem
} from "../src/source-items.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-post-apply-reconcile-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function buildIssueRaw(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "linear-issue-1",
    identifier: "NGX-1",
    url: "https://linear.app/example/issue/NGX-1",
    title: "Example issue",
    updatedAt: "2025-06-01T12:00:00.000Z",
    state: { id: "state-done", name: "Done" },
    ...overrides
  };
}

type FakeClientCall = {
  target: { kind: string; value: string };
};

function buildFakeClient(
  responses: Array<Awaited<ReturnType<PostApplyReconcileClient["refresh"]>>>
): { client: PostApplyReconcileClient; calls: FakeClientCall[] } {
  const calls: FakeClientCall[] = [];
  let cursor = 0;
  const client: PostApplyReconcileClient = {
    async refresh(input) {
      calls.push({ target: { ...input.target } });
      const next = responses[cursor++];
      if (!next) {
        throw new Error(
          `fake refresh client ran out of responses on call #${calls.length}`
        );
      }
      return next;
    }
  };
  return { client, calls };
}

const MARKER = "momentum-intent:linear:intent-1:abcdef0123456789";

describe("POST_APPLY_RECONCILE_OUTCOME_CODES", () => {
  it("pins the stable outcome taxonomy for post-apply reconciliation", () => {
    expect(POST_APPLY_RECONCILE_OUTCOME_CODES).toEqual([
      "success",
      "stale_source",
      "mismatch_persists",
      "refresh_failed",
      "post_apply_reconcile_failed",
      "targeted_refresh_unsupported"
    ]);
  });
});

describe("reconcileAfterExternalApply — targeted single-issue scope", () => {
  it("calls refresh exactly once keyed by the external id", async () => {
    const db = openDb(makeTempDir());
    try {
      const { client, calls } = buildFakeClient([
        {
          ok: true,
          issue: buildIssueRaw(),
          comments: [{ id: "c-1", body: `Applied via ${MARKER}`, url: null }]
        }
      ]);
      const outcome = await reconcileAfterExternalApply({
        db,
        adapterKind: "linear",
        externalId: "linear-issue-1",
        idempotencyMarker: MARKER,
        client
      });
      expect(outcome.code).toBe("success");
      expect(calls).toEqual([
        { target: { kind: "id", value: "linear-issue-1" } }
      ]);
    } finally {
      db.close();
    }
  });
});

describe("reconcileAfterExternalApply — success path", () => {
  it("upserts the SourceItem, records a snapshot, and returns success", async () => {
    const db = openDb(makeTempDir());
    try {
      // Seed a stale source item with an old observedAt to verify the upsert
      // updates the row rather than creating a duplicate.
      upsertSourceItem(db, {
        adapterKind: "linear",
        externalId: "linear-issue-1",
        externalKey: "NGX-1",
        url: "https://linear.app/example/issue/NGX-1",
        title: "Old title",
        status: "Todo",
        metadata: {},
        observedAt: 1000
      });

      const { client } = buildFakeClient([
        {
          ok: true,
          issue: buildIssueRaw({ title: "Refreshed title" }),
          comments: [{ id: "c-1", body: `Done ${MARKER}`, url: null }]
        }
      ]);

      const outcome = await reconcileAfterExternalApply({
        db,
        adapterKind: "linear",
        externalId: "linear-issue-1",
        idempotencyMarker: MARKER,
        client
      });

      expect(outcome.code).toBe("success");
      expect(outcome.sourceItemId).toBeTruthy();
      expect(outcome.snapshotId).toBeTruthy();

      const refreshed = getSourceItemByAdapterExternalId(
        db,
        "linear",
        "linear-issue-1"
      );
      expect(refreshed?.title).toBe("Refreshed title");
      expect(refreshed?.status).toBe("Done");

      const snapshots = listSourceSnapshotsForItem(db, refreshed!.id);
      expect(snapshots.length).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  });
});

describe("reconcileAfterExternalApply — mismatch outcomes", () => {
  it("returns mismatch_persists when the marker is absent from the refreshed comments", async () => {
    const db = openDb(makeTempDir());
    try {
      const { client } = buildFakeClient([
        {
          ok: true,
          issue: buildIssueRaw(),
          comments: [{ id: "c-1", body: "unrelated comment", url: null }]
        }
      ]);
      const outcome = await reconcileAfterExternalApply({
        db,
        adapterKind: "linear",
        externalId: "linear-issue-1",
        idempotencyMarker: MARKER,
        client
      });
      expect(outcome.code).toBe("mismatch_persists");
    } finally {
      db.close();
    }
  });

  it("returns stale_source when refresh reports target_missing", async () => {
    const db = openDb(makeTempDir());
    try {
      const { client } = buildFakeClient([
        {
          ok: false,
          code: "target_missing",
          error: "Linear issue lookup returned no issue."
        }
      ]);
      const outcome = await reconcileAfterExternalApply({
        db,
        adapterKind: "linear",
        externalId: "linear-issue-1",
        idempotencyMarker: MARKER,
        client
      });
      expect(outcome.code).toBe("stale_source");
    } finally {
      db.close();
    }
  });

  it("returns refresh_failed when refresh reports transient failures", async () => {
    const db = openDb(makeTempDir());
    try {
      const { client } = buildFakeClient([
        {
          ok: false,
          code: "adapter_threw",
          error: "transient network error"
        }
      ]);
      const outcome = await reconcileAfterExternalApply({
        db,
        adapterKind: "linear",
        externalId: "linear-issue-1",
        idempotencyMarker: MARKER,
        client
      });
      expect(outcome.code).toBe("refresh_failed");
    } finally {
      db.close();
    }
  });

  it("returns refresh_failed when refresh reports auth_unavailable", async () => {
    const db = openDb(makeTempDir());
    try {
      const { client } = buildFakeClient([
        {
          ok: false,
          code: "auth_unavailable",
          error: "LINEAR_API_KEY rejected by Linear API."
        }
      ]);
      const outcome = await reconcileAfterExternalApply({
        db,
        adapterKind: "linear",
        externalId: "linear-issue-1",
        idempotencyMarker: MARKER,
        client
      });
      expect(outcome.code).toBe("refresh_failed");
    } finally {
      db.close();
    }
  });

  it("returns post_apply_reconcile_failed when the refreshed payload cannot be normalized", async () => {
    const db = openDb(makeTempDir());
    try {
      const { client } = buildFakeClient([
        {
          ok: true,
          // Missing id/title/url -> normalization fails.
          issue: { id: "" } as unknown,
          comments: [{ id: "c-1", body: `Done ${MARKER}`, url: null }]
        }
      ]);
      const outcome = await reconcileAfterExternalApply({
        db,
        adapterKind: "linear",
        externalId: "linear-issue-1",
        idempotencyMarker: MARKER,
        client
      });
      expect(outcome.code).toBe("post_apply_reconcile_failed");
    } finally {
      db.close();
    }
  });

  it("returns post_apply_reconcile_failed when refresh throws synchronously", async () => {
    const db = openDb(makeTempDir());
    try {
      const client: PostApplyReconcileClient = {
        async refresh() {
          throw new Error("boom");
        }
      };
      const outcome = await reconcileAfterExternalApply({
        db,
        adapterKind: "linear",
        externalId: "linear-issue-1",
        idempotencyMarker: MARKER,
        client
      });
      expect(outcome.code).toBe("post_apply_reconcile_failed");
      expect(outcome.detail).toContain("boom");
    } finally {
      db.close();
    }
  });
});

describe("reconcileAfterExternalApply — adapter support", () => {
  it("returns targeted_refresh_unsupported for unsupported adapter kinds", async () => {
    const db = openDb(makeTempDir());
    try {
      const { client, calls } = buildFakeClient([]);
      const outcome = await reconcileAfterExternalApply({
        db,
        adapterKind: "manual",
        externalId: "manual-1",
        idempotencyMarker: MARKER,
        client
      });
      expect(outcome.code).toBe("targeted_refresh_unsupported");
      expect(calls).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("returns targeted_refresh_unsupported when no client is wired", async () => {
    const db = openDb(makeTempDir());
    try {
      const outcome = await reconcileAfterExternalApply({
        db,
        adapterKind: "linear",
        externalId: "linear-issue-1",
        idempotencyMarker: MARKER,
        client: null
      });
      expect(outcome.code).toBe("targeted_refresh_unsupported");
    } finally {
      db.close();
    }
  });
});

describe("reconcileAfterExternalApply — idempotency", () => {
  it("a second reconcile call does not duplicate the SourceItem", async () => {
    const db = openDb(makeTempDir());
    try {
      const { client } = buildFakeClient([
        {
          ok: true,
          issue: buildIssueRaw(),
          comments: [{ id: "c-1", body: `Done ${MARKER}`, url: null }]
        },
        {
          ok: true,
          issue: buildIssueRaw(),
          comments: [{ id: "c-1", body: `Done ${MARKER}`, url: null }]
        }
      ]);
      const first = await reconcileAfterExternalApply({
        db,
        adapterKind: "linear",
        externalId: "linear-issue-1",
        idempotencyMarker: MARKER,
        client
      });
      const second = await reconcileAfterExternalApply({
        db,
        adapterKind: "linear",
        externalId: "linear-issue-1",
        idempotencyMarker: MARKER,
        client
      });
      expect(first.code).toBe("success");
      expect(second.code).toBe("success");
      expect(second.sourceItemId).toBe(first.sourceItemId);
    } finally {
      db.close();
    }
  });
});
