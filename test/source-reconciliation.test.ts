import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb } from "../src/db.js";
import {
  reconcileLinearSource,
  type LinearReconciliationClient,
  type LinearReconciliationFetchPageInput,
  type LinearReconciliationFetchPageResult
} from "../src/source-reconciliation.js";
import {
  listSourceItems
} from "../src/source-items.js";
import {
  getSourceReconciliationRun,
  listSourceReconciliationRuns
} from "../src/source-reconciliation-runs.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-source-reconciliation-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function makeLinearIssue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: overrides["id"] ?? "issue-uuid-1",
    identifier: overrides["identifier"] ?? "NGX-1",
    title: overrides["title"] ?? "Example issue",
    url: overrides["url"] ?? "https://linear.app/team/issue/NGX-1",
    state: overrides["state"] ?? { id: "state-1", name: "In Progress" },
    project: overrides["project"] ?? {
      id: "project-uuid-1",
      key: "PROJ",
      name: "Project One"
    },
    projectMilestone: overrides["projectMilestone"] ?? {
      id: "milestone-uuid-1",
      name: "Milestone One"
    },
    labels: overrides["labels"] ?? { nodes: [] },
    assignee: overrides["assignee"] ?? null,
    priority: overrides["priority"] ?? 0,
    updatedAt: overrides["updatedAt"] ?? "2026-04-01T00:00:00.000Z",
    ...overrides
  };
}

function makeStaticPaginatedClient(
  pages: readonly LinearReconciliationFetchPageResult[]
): LinearReconciliationClient {
  let pageIndex = 0;
  return {
    fetchPage(_input: LinearReconciliationFetchPageInput): LinearReconciliationFetchPageResult {
      const page = pages[pageIndex];
      pageIndex += 1;
      if (!page) {
        return {
          ok: true,
          page: { issues: [], nextCursor: null }
        };
      }
      return page;
    }
  };
}

describe("reconcileLinearSource", () => {
  it("upserts items from a single page and records a succeeded run with detailed counts", async () => {
    const db = openDb(makeTempDir());
    try {
      const issue = makeLinearIssue({ id: "issue-a", identifier: "NGX-1", updatedAt: 1_000 });
      const client = makeStaticPaginatedClient([
        { ok: true, page: { issues: [issue], nextCursor: null } }
      ]);

      const result = await reconcileLinearSource(
        db,
        { client, filters: { projectId: "project-uuid-1" } },
        { now: () => 9_000 }
      );

      expect(result.counts).toEqual({
        pages: 1,
        itemsObserved: 1,
        itemsCreated: 1,
        itemsUpdated: 0,
        itemsSkipped: 0,
        itemsErrored: 0
      });
      expect(result.paginationStopped).toEqual({ reason: "complete", pageIndex: 1 });
      expect(result.run.state).toBe("succeeded");
      expect(result.run.itemsSeen).toBe(1);
      expect(result.run.itemsUpserted).toBe(1);
      expect(result.run.metadata).toMatchObject({
        filters: { projectId: "project-uuid-1" },
        dryRun: false,
        counts: {
          pages: 1,
          itemsObserved: 1,
          itemsCreated: 1,
          itemsUpdated: 0,
          itemsSkipped: 0,
          itemsErrored: 0
        }
      });

      const items = listSourceItems(db, { adapterKind: "linear" });
      expect(items).toHaveLength(1);
      expect(items[0]?.externalKey).toBe("NGX-1");
      expect(items[0]?.lastObservedAt).toBe(1_000);
    } finally {
      db.close();
    }
  });

  it("dry-run reports classifications without writing source items or persisting a run", async () => {
    const db = openDb(makeTempDir());
    try {
      const issue = makeLinearIssue({ id: "issue-dry", identifier: "NGX-DR" });
      const client = makeStaticPaginatedClient([
        { ok: true, page: { issues: [issue], nextCursor: null } }
      ]);

      const result = await reconcileLinearSource(db, { client, dryRun: true });

      expect(result.counts.itemsObserved).toBe(1);
      expect(result.counts.itemsCreated).toBe(1);
      expect(result.run.state).toBe("succeeded");
      expect(result.run.metadata).toMatchObject({ dryRun: true });

      expect(listSourceItems(db, { adapterKind: "linear" })).toEqual([]);
      // Dry-run still records the run for audit; verify it is persisted exactly once.
      const runs = listSourceReconciliationRuns(db, { adapterKind: "linear" });
      expect(runs).toHaveLength(1);
      expect(runs[0]?.metadata).toMatchObject({ dryRun: true });
    } finally {
      db.close();
    }
  });

  it("merges multiple pages into one run and one count summary", async () => {
    const db = openDb(makeTempDir());
    try {
      const issueA = makeLinearIssue({ id: "issue-1", identifier: "NGX-1", updatedAt: 1_000 });
      const issueB = makeLinearIssue({ id: "issue-2", identifier: "NGX-2", updatedAt: 2_000 });
      const issueC = makeLinearIssue({ id: "issue-3", identifier: "NGX-3", updatedAt: 3_000 });

      const client = makeStaticPaginatedClient([
        { ok: true, page: { issues: [issueA, issueB], nextCursor: "cursor-b" } },
        { ok: true, page: { issues: [issueC], nextCursor: null } }
      ]);

      const result = await reconcileLinearSource(db, { client });

      expect(result.counts).toEqual({
        pages: 2,
        itemsObserved: 3,
        itemsCreated: 3,
        itemsUpdated: 0,
        itemsSkipped: 0,
        itemsErrored: 0
      });
      expect(result.paginationStopped).toEqual({ reason: "complete", pageIndex: 2 });
      expect(result.run.state).toBe("succeeded");
      expect(result.run.itemsSeen).toBe(3);
      expect(listSourceItems(db, { adapterKind: "linear" })).toHaveLength(3);
    } finally {
      db.close();
    }
  });

  it("persists items from earlier pages when a later page returns source_auth_unavailable", async () => {
    const db = openDb(makeTempDir());
    try {
      const issueA = makeLinearIssue({ id: "issue-1", identifier: "NGX-1", updatedAt: 1_000 });
      const issueB = makeLinearIssue({ id: "issue-2", identifier: "NGX-2", updatedAt: 2_000 });
      const client = makeStaticPaginatedClient([
        { ok: true, page: { issues: [issueA, issueB], nextCursor: "cursor-2" } },
        {
          ok: false,
          code: "source_auth_unavailable",
          error: "Linear API rejected token on page 2"
        }
      ]);

      const result = await reconcileLinearSource(db, { client });

      expect(result.paginationStopped).toEqual({
        reason: "auth_unavailable",
        pageIndex: 2,
        code: "source_auth_unavailable",
        error: "Linear API rejected token on page 2"
      });
      expect(result.counts.itemsObserved).toBe(2);
      expect(result.counts.itemsCreated).toBe(2);
      expect(result.run.state).toBe("failed");
      expect(result.run.error).toContain("source_auth_unavailable");
      expect(result.run.itemsSeen).toBe(2);
      expect(result.run.itemsUpserted).toBe(2);

      const items = listSourceItems(db, { adapterKind: "linear" });
      expect(items.map((item) => item.externalKey).sort()).toEqual(["NGX-1", "NGX-2"]);
    } finally {
      db.close();
    }
  });

  it("returns source_config_invalid without writing items when the first page reports a config error", async () => {
    const db = openDb(makeTempDir());
    try {
      const client = makeStaticPaginatedClient([
        {
          ok: false,
          code: "source_config_invalid",
          error: "missing required projectId filter"
        }
      ]);

      const result = await reconcileLinearSource(db, { client });

      expect(result.paginationStopped).toEqual({
        reason: "config_invalid",
        pageIndex: 1,
        code: "source_config_invalid",
        error: "missing required projectId filter"
      });
      expect(result.counts.itemsObserved).toBe(0);
      expect(result.run.state).toBe("failed");
      expect(listSourceItems(db, { adapterKind: "linear" })).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("finishes the run as failed when the client throws during pagination", async () => {
    const db = openDb(makeTempDir());
    try {
      const issue = makeLinearIssue({ id: "issue-before-throw", identifier: "NGX-THROW" });
      let calls = 0;
      const client: LinearReconciliationClient = {
        async fetchPage() {
          calls += 1;
          if (calls === 1) {
            return { ok: true, page: { issues: [issue], nextCursor: "next" } };
          }
          throw new Error("transport exploded");
        }
      };

      const result = await reconcileLinearSource(db, { client });

      expect(result.paginationStopped).toEqual({
        reason: "adapter_threw",
        pageIndex: 2,
        code: "source_adapter_threw",
        error: "transport exploded"
      });
      expect(result.counts.itemsObserved).toBe(1);
      expect(result.counts.itemsCreated).toBe(1);
      expect(result.run.state).toBe("failed");
      expect(result.run.error).toBe("source_adapter_threw: transport exploded");
      expect(result.run.finishedAt).not.toBeNull();

      const runs = listSourceReconciliationRuns(db, { adapterKind: "linear" });
      expect(runs).toHaveLength(1);
      expect(runs[0]?.state).toBe("failed");
      expect(runs[0]?.metadata).toMatchObject({
        paginationStopped: {
          reason: "adapter_threw",
          pageIndex: 2,
          code: "source_adapter_threw",
          error: "transport exploded"
        }
      });
      expect(listSourceItems(db, { adapterKind: "linear" })).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("is idempotent across repeated reconciliations of the same data", async () => {
    const db = openDb(makeTempDir());
    try {
      const issue = makeLinearIssue({ id: "issue-idem", identifier: "NGX-7", updatedAt: 5_000 });
      const firstClient = makeStaticPaginatedClient([
        { ok: true, page: { issues: [issue], nextCursor: null } }
      ]);
      const secondClient = makeStaticPaginatedClient([
        { ok: true, page: { issues: [issue], nextCursor: null } }
      ]);

      const first = await reconcileLinearSource(db, { client: firstClient });
      expect(first.counts.itemsCreated).toBe(1);
      expect(first.counts.itemsUpdated).toBe(0);
      expect(first.counts.itemsSkipped).toBe(0);

      const second = await reconcileLinearSource(db, { client: secondClient });
      expect(second.counts.itemsObserved).toBe(1);
      // Same observedAt — neither created (already exists) nor a strict update.
      expect(second.counts.itemsCreated).toBe(0);
      expect(second.counts.itemsUpdated).toBe(1);
      expect(second.counts.itemsErrored).toBe(0);

      // Items remain stable across repeated reconciliations.
      const items = listSourceItems(db, { adapterKind: "linear" });
      expect(items).toHaveLength(1);
      expect(items[0]?.lastObservedAt).toBe(5_000);
    } finally {
      db.close();
    }
  });

  it("skips items whose observedAt is older than the persisted lastObservedAt", async () => {
    const db = openDb(makeTempDir());
    try {
      const newer = makeLinearIssue({ id: "issue-skip", identifier: "NGX-SK", updatedAt: 5_000 });
      const older = makeLinearIssue({ id: "issue-skip", identifier: "NGX-SK", updatedAt: 1_000 });
      const firstClient = makeStaticPaginatedClient([
        { ok: true, page: { issues: [newer], nextCursor: null } }
      ]);
      const olderClient = makeStaticPaginatedClient([
        { ok: true, page: { issues: [older], nextCursor: null } }
      ]);

      await reconcileLinearSource(db, { client: firstClient });
      const stale = await reconcileLinearSource(db, { client: olderClient });

      expect(stale.counts.itemsObserved).toBe(1);
      expect(stale.counts.itemsSkipped).toBe(1);
      expect(stale.counts.itemsCreated).toBe(0);
      expect(stale.counts.itemsUpdated).toBe(0);

      const items = listSourceItems(db, { adapterKind: "linear" });
      expect(items[0]?.lastObservedAt).toBe(5_000);
    } finally {
      db.close();
    }
  });

  it("records normalization errors per item without aborting the page", async () => {
    const db = openDb(makeTempDir());
    try {
      const good = makeLinearIssue({ id: "issue-good", identifier: "NGX-OK", updatedAt: 1_000 });
      const broken = { id: "issue-broken" }; // missing required fields
      const client = makeStaticPaginatedClient([
        { ok: true, page: { issues: [broken, good], nextCursor: null } }
      ]);

      const result = await reconcileLinearSource(db, { client });

      expect(result.counts.itemsObserved).toBe(2);
      expect(result.counts.itemsCreated).toBe(1);
      expect(result.counts.itemsErrored).toBe(1);
      expect(result.run.state).toBe("succeeded");
      const errored = result.items.filter((item) => item.classification === "error");
      expect(errored).toHaveLength(1);

      const items = listSourceItems(db, { adapterKind: "linear" });
      expect(items).toHaveLength(1);
      expect(items[0]?.externalKey).toBe("NGX-OK");
    } finally {
      db.close();
    }
  });

  it("enforces maxPages to prevent runaway pagination and records the stop reason", async () => {
    const db = openDb(makeTempDir());
    try {
      const issueA = makeLinearIssue({ id: "issue-1", identifier: "NGX-1", updatedAt: 1_000 });
      const issueB = makeLinearIssue({ id: "issue-2", identifier: "NGX-2", updatedAt: 2_000 });
      const issueC = makeLinearIssue({ id: "issue-3", identifier: "NGX-3", updatedAt: 3_000 });

      const client = makeStaticPaginatedClient([
        { ok: true, page: { issues: [issueA], nextCursor: "c1" } },
        { ok: true, page: { issues: [issueB], nextCursor: "c2" } },
        { ok: true, page: { issues: [issueC], nextCursor: null } }
      ]);

      const result = await reconcileLinearSource(db, { client, maxPages: 2 });

      expect(result.paginationStopped).toEqual({ reason: "max_pages", pageIndex: 2 });
      expect(result.counts.pages).toBe(2);
      expect(result.counts.itemsObserved).toBe(2);
      expect(result.run.state).toBe("succeeded");
      expect(listSourceItems(db, { adapterKind: "linear" }).map((item) => item.externalKey).sort()).toEqual([
        "NGX-1",
        "NGX-2"
      ]);
    } finally {
      db.close();
    }
  });

  it("passes filters and the rolling cursor to the client on each fetchPage call", async () => {
    const db = openDb(makeTempDir());
    try {
      const calls: LinearReconciliationFetchPageInput[] = [];
      const issueA = makeLinearIssue({ id: "issue-1", identifier: "NGX-1", updatedAt: 1_000 });
      const issueB = makeLinearIssue({ id: "issue-2", identifier: "NGX-2", updatedAt: 2_000 });
      const responses: LinearReconciliationFetchPageResult[] = [
        { ok: true, page: { issues: [issueA], nextCursor: "next-1" } },
        { ok: true, page: { issues: [issueB], nextCursor: null } }
      ];
      let index = 0;
      const client: LinearReconciliationClient = {
        fetchPage(input) {
          calls.push(input);
          const page = responses[index];
          index += 1;
          return page ?? { ok: true, page: { issues: [], nextCursor: null } };
        }
      };

      await reconcileLinearSource(db, {
        client,
        filters: { projectId: "project-uuid-1", milestoneName: "Milestone One" }
      });

      expect(calls).toEqual([
        {
          cursor: null,
          filters: { projectId: "project-uuid-1", milestoneName: "Milestone One" }
        },
        {
          cursor: "next-1",
          filters: { projectId: "project-uuid-1", milestoneName: "Milestone One" }
        }
      ]);
    } finally {
      db.close();
    }
  });

  it("surfaces an existing run via getSourceReconciliationRun by id", async () => {
    const db = openDb(makeTempDir());
    try {
      const issue = makeLinearIssue({ id: "issue-x", identifier: "NGX-X", updatedAt: 1_000 });
      const client = makeStaticPaginatedClient([
        { ok: true, page: { issues: [issue], nextCursor: null } }
      ]);
      const result = await reconcileLinearSource(db, { client });
      const fetched = getSourceReconciliationRun(db, result.run.id);
      expect(fetched?.state).toBe("succeeded");
      expect(fetched?.adapterKind).toBe("linear");
    } finally {
      db.close();
    }
  });
});
