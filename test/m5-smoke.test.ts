import { afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { FAKE_RUNNER_GOAL_COMPLETE_ENV } from "../src/adapters/fake-runner.js";
import { DOCTOR_MILESTONE } from "../src/cli.js";

import {
  SMOKE_GOAL_SPEC,
  buildCli,
  cleanupTempRoots,
  initDisposableRepo,
  makeTempDir,
  runCliBinary,
  runCliBinaryAsync
} from "./helpers/smoke-harness.js";

beforeAll(buildCli, 60_000);

afterEach(cleanupTempRoots);

const M5_SMOKE_RUN_ID = "smoke-m5-workflow-run-1";

function writeM5WorkflowFixture(rootDir: string): string {
  const runDir = path.join(rootDir, ".agent-workflows", M5_SMOKE_RUN_ID);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "plan.json"),
    JSON.stringify(
      {
        runId: M5_SMOKE_RUN_ID,
        schemaVersion: 1,
        mode: "execute-ready",
        profile: "momentum-m5-smoke",
        objective: "NGX-294 smoke fixture for evidence ingestion",
        resolvedScope: {
          issues: ["NGX-294"],
          source: "explicit",
          status: "resolved"
        }
      },
      null,
      2
    )
  );
  const ledgerLines = [
    {
      runId: M5_SMOKE_RUN_ID,
      step: "preflight",
      status: "complete",
      ts: "2026-05-18T09:00:00Z"
    },
    {
      runId: M5_SMOKE_RUN_ID,
      step: "implementation",
      status: "started",
      ts: "2026-05-18T09:01:00Z"
    },
    {
      runId: M5_SMOKE_RUN_ID,
      step: "implementation",
      status: "complete",
      ts: "2026-05-18T09:30:00Z"
    }
  ];
  fs.writeFileSync(
    path.join(runDir, "ledger.jsonl"),
    `${ledgerLines.map((line) => JSON.stringify(line)).join("\n")}\n`
  );
  return runDir;
}

type LinearMockServer = {
  endpoint: string;
  bodies: Array<Record<string, unknown>>;
  close: () => Promise<void>;
};

async function startLinearMockServer(
  issues: Array<Record<string, unknown>>
): Promise<LinearMockServer> {
  const bodies: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      try {
        bodies.push(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        bodies.push({ rawBody: raw });
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          data: {
            issues: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: issues
            }
          }
        })
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const endpoint = `http://127.0.0.1:${address.port}/graphql`;
  return {
    endpoint,
    bodies,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      })
  };
}

describe("Milestone 5 evidence + intent + project status smoke (NGX-294)", () => {
  it(
    "doctor --json reports the M11 closeout milestone marker",
    () => {
      const result = runCliBinary(["doctor", "--json"]);
      expect(result.code, `doctor stderr: ${result.stderr}`).toBe(0);
      const payload = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(payload["milestone"]).toBe(DOCTOR_MILESTONE);
    },
    60_000
  );

  it(
    "ingests workflow fixtures and surfaces them through evidence list and doctor",
    () => {
      const dataDir = makeTempDir("momentum-smoke-m5-evidence-data-");
      const fixtureRoot = makeTempDir("momentum-smoke-m5-evidence-fixture-");
      const runDir = writeM5WorkflowFixture(fixtureRoot);

      const ingest = runCliBinary([
        "evidence",
        "ingest",
        "--path",
        runDir,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(ingest.code, `evidence ingest stderr: ${ingest.stderr}`).toBe(0);
      const ingestPayload = JSON.parse(ingest.stdout) as Record<string, unknown>;
      expect(ingestPayload).toMatchObject({
        ok: true,
        command: "evidence ingest",
        dataDir,
        path: runDir,
        goalId: null,
        sourceItemId: null
      });
      const ingestCounts = ingestPayload["counts"] as Record<string, number>;
      expect(ingestCounts.observed).toBe(4);
      expect(ingestCounts.created).toBe(4);
      expect(ingestCounts.skipped).toBe(0);
      expect(ingestCounts.errors).toBe(0);
      expect(ingestCounts.diagnostics).toBe(0);
      const createdTypes = (ingestPayload["created"] as Array<Record<string, unknown>>)
        .map((record) => record["type"])
        .sort();
      expect(createdTypes).toEqual([
        "implementation_complete",
        "implementation_started",
        "plan_created",
        "preflight_complete"
      ]);

      // Re-running ingestion is idempotent via stable ingest_key.
      const reIngest = runCliBinary([
        "evidence",
        "ingest",
        "--path",
        runDir,
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(
        reIngest.code,
        `re-ingest stderr: ${reIngest.stderr}`
      ).toBe(0);
      const reIngestPayload = JSON.parse(reIngest.stdout) as Record<
        string,
        unknown
      >;
      const reIngestCounts = reIngestPayload["counts"] as Record<string, number>;
      expect(reIngestCounts.observed).toBe(4);
      expect(reIngestCounts.created).toBe(0);
      expect(reIngestCounts.skipped).toBe(4);

      const list = runCliBinary([
        "evidence",
        "list",
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(list.code, `evidence list stderr: ${list.stderr}`).toBe(0);
      const listPayload = JSON.parse(list.stdout) as Record<string, unknown>;
      expect(listPayload).toMatchObject({
        ok: true,
        command: "evidence list",
        dataDir
      });
      expect(listPayload["count"]).toBe(4);
      const listedTypes = (listPayload["records"] as Array<Record<string, unknown>>)
        .map((record) => record["type"])
        .sort();
      expect(listedTypes).toEqual([
        "implementation_complete",
        "implementation_started",
        "plan_created",
        "preflight_complete"
      ]);
      const records = listPayload["records"] as Array<Record<string, unknown>>;
      for (const record of records) {
        expect(record["source"]).toBe("agent-workflow");
        expect(record["formatVersion"]).toBe(1);
        expect(typeof record["ingestKey"]).toBe("string");
        expect((record["ingestKey"] as string).startsWith("agent-workflow:")).toBe(
          true
        );
      }

      const filtered = runCliBinary([
        "evidence",
        "list",
        "--type",
        "plan_created",
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(filtered.code, `filtered evidence list stderr: ${filtered.stderr}`).toBe(
        0
      );
      const filteredPayload = JSON.parse(filtered.stdout) as Record<
        string,
        unknown
      >;
      expect(filteredPayload["count"]).toBe(1);
      expect(
        (filteredPayload["records"] as Array<Record<string, unknown>>)[0]?.["type"]
      ).toBe("plan_created");

      const doctor = runCliBinary([
        "doctor",
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(doctor.code, `doctor stderr: ${doctor.stderr}`).toBe(0);
      const doctorPayload = JSON.parse(doctor.stdout) as Record<string, unknown>;
      const evidencePayload = doctorPayload["evidence"] as Record<string, unknown>;
      expect(evidencePayload).toMatchObject({
        ok: true,
        totalRecords: 4,
        goalLinkedRecords: 0,
        sourceItemLinkedRecords: 0
      });
    },
    60_000
  );

  it(
    "reports an empty intent list cleanly when no update intents exist",
    () => {
      const dataDir = makeTempDir("momentum-smoke-m5-intent-data-");
      const result = runCliBinary([
        "intent",
        "list",
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(result.code, `intent list stderr: ${result.stderr}`).toBe(0);
      const payload = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: true,
        command: "intent list",
        dataDir,
        count: 0
      });
      expect(payload["intents"]).toEqual([]);
    },
    60_000
  );

  it(
    "reports a deterministic project status rollup when no source items exist",
    () => {
      const dataDir = makeTempDir("momentum-smoke-m5-project-data-");
      const result = runCliBinary([
        "project",
        "status",
        "--data-dir",
        dataDir,
        "--json"
      ]);
      expect(
        result.code,
        `project status stderr: ${result.stderr}`
      ).toBe(0);
      const payload = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: true,
        command: "project status",
        dataDir
      });
      const counts = payload["counts"] as Record<string, Record<string, unknown>>;
      expect(counts.sourceItems).toMatchObject({
        total: 0,
        linkedToGoal: 0,
        unlinked: 0
      });
      expect(counts.goals).toMatchObject({ total: 0, needingManualRecovery: 0 });
      expect(counts.evidence).toMatchObject({
        totalRecords: 0,
        goalsWithEvidence: 0,
        goalsWithoutEvidence: 0
      });
      expect(payload["sourceItems"]).toEqual([]);
      expect(payload["mismatches"]).toEqual([]);
      expect(payload["pendingUpdateIntents"]).toEqual([]);
      expect(payload["reconciliationWarnings"]).toEqual([]);
      const nextAction = payload["nextAction"] as Record<string, unknown>;
      expect(typeof nextAction["kind"]).toBe("string");
      expect(typeof nextAction["message"]).toBe("string");
    },
    60_000
  );

  it(
    "reconciles fixture Linear issues against a mock endpoint and surfaces them through source list and source get",
    async () => {
      const dataDir = makeTempDir("momentum-smoke-m5-reconcile-data-");
      const issue = {
        id: "issue-smoke-ngx-294",
        identifier: "NGX-294",
        title: "M5-07 M5 smoke, docs, and milestone closeout",
        description: "Smoke fixture for the M5 closeout reconciliation path.",
        url: "https://linear.app/ngxcalvin/issue/NGX-294",
        updatedAt: "2026-05-18T10:00:00.000Z",
        priority: 0,
        state: { id: "state-in-progress", name: "In Progress" },
        project: {
          id: "project-momentum",
          name: "Momentum",
          url: "https://linear.app/ngxcalvin/project/momentum"
        },
        projectMilestone: {
          id: "milestone-m5",
          name: "Milestone 5: Source Adapters And Evidence Sync"
        },
        labels: { nodes: [] },
        assignee: null
      };
      const mock = await startLinearMockServer([issue]);
      try {
        const reconcile = await runCliBinaryAsync(
          [
            "source",
            "reconcile",
            "linear",
            "--linear-endpoint",
            mock.endpoint,
            "--data-dir",
            dataDir,
            "--json"
          ],
          { env: { LINEAR_API_KEY: "lin_api_smoke_fixture_key" } }
        );
        expect(
          reconcile.code,
          `source reconcile linear stderr: ${reconcile.stderr}`
        ).toBe(0);
        const reconcilePayload = JSON.parse(reconcile.stdout) as Record<
          string,
          unknown
        >;
        expect(reconcilePayload).toMatchObject({
          ok: true,
          command: "source reconcile linear",
          dataDir,
          adapter: "linear",
          dryRun: false
        });
        const reconcileCounts = reconcilePayload["counts"] as Record<
          string,
          number
        >;
        expect(reconcileCounts).toMatchObject({
          pages: 1,
          itemsObserved: 1,
          itemsCreated: 1,
          itemsUpdated: 0,
          itemsSkipped: 0,
          itemsErrored: 0
        });
        const paginationStopped = reconcilePayload["paginationStopped"] as Record<
          string,
          unknown
        >;
        expect(paginationStopped["reason"]).toBe("complete");
        expect(paginationStopped["code"]).toBeNull();
        const itemsSampled = reconcilePayload["itemsSampled"] as Array<
          Record<string, unknown>
        >;
        expect(itemsSampled).toHaveLength(1);
        expect(itemsSampled[0]).toMatchObject({
          classification: "created",
          externalId: "issue-smoke-ngx-294",
          externalKey: "NGX-294"
        });
        const run = reconcilePayload["run"] as Record<string, unknown>;
        expect(run["state"]).toBe("succeeded");
        expect(run["adapterKind"]).toBe("linear");

        expect(mock.bodies).toHaveLength(1);
        const requestBody = mock.bodies[0];
        expect(typeof requestBody?.["query"]).toBe("string");
        const variables = requestBody?.["variables"] as Record<string, unknown>;
        expect(variables).toMatchObject({ first: 50, after: null });

        const list = runCliBinary([
          "source",
          "list",
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(list.code, `source list stderr: ${list.stderr}`).toBe(0);
        const listPayload = JSON.parse(list.stdout) as Record<string, unknown>;
        expect(listPayload).toMatchObject({
          ok: true,
          command: "source list",
          dataDir
        });
        const listedItems = listPayload["items"] as Array<Record<string, unknown>>;
        expect(listedItems).toHaveLength(1);
        const listedItem = listedItems[0]!;
        expect(listedItem).toMatchObject({
          adapterKind: "linear",
          externalId: "issue-smoke-ngx-294",
          externalKey: "NGX-294",
          title: "M5-07 M5 smoke, docs, and milestone closeout",
          status: "In Progress",
          url: "https://linear.app/ngxcalvin/issue/NGX-294",
          goalId: null
        });
        expect(typeof listedItem["id"]).toBe("string");

        const sourceItemId = listedItem["id"] as string;
        const get = runCliBinary([
          "source",
          "get",
          sourceItemId,
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(get.code, `source get stderr: ${get.stderr}`).toBe(0);
        const getPayload = JSON.parse(get.stdout) as Record<string, unknown>;
        expect(getPayload).toMatchObject({
          ok: true,
          command: "source get",
          dataDir
        });
        const fetchedItem = getPayload["item"] as Record<string, unknown>;
        expect(fetchedItem).toMatchObject({
          id: sourceItemId,
          adapterKind: "linear",
          externalId: "issue-smoke-ngx-294",
          externalKey: "NGX-294"
        });
        const metadata = fetchedItem["metadata"] as Record<string, unknown>;
        expect((metadata["project"] as Record<string, unknown>)?.["name"]).toBe(
          "Momentum"
        );
        expect(
          (metadata["milestone"] as Record<string, unknown>)?.["name"]
        ).toBe("Milestone 5: Source Adapters And Evidence Sync");

        const doctor = runCliBinary([
          "doctor",
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(doctor.code, `doctor stderr: ${doctor.stderr}`).toBe(0);
        const doctorPayload = JSON.parse(doctor.stdout) as Record<string, unknown>;
        const sourcesPayload = doctorPayload["sources"] as Record<string, unknown>;
        expect(sourcesPayload).toMatchObject({
          ok: true,
          totalSourceItems: 1,
          linkedSourceItems: 0,
          unlinkedSourceItems: 1
        });
        const lastReconciliation = sourcesPayload["lastReconciliation"] as Record<
          string,
          unknown
        >;
        expect(lastReconciliation).toMatchObject({
          adapterKind: "linear",
          state: "succeeded",
          itemsSeen: 1,
          itemsUpserted: 1
        });
      } finally {
        await mock.close();
      }
    },
    60_000
  );

  it(
    "links a reconciled SourceItem to a queued Goal and surfaces it through status and handoff",
    async () => {
      const dataDir = makeTempDir("momentum-smoke-m5-link-data-");
      const repo = initDisposableRepo();
      const goalFile = path.join(dataDir, "goal.md");
      fs.writeFileSync(goalFile, SMOKE_GOAL_SPEC, "utf-8");

      const issue = {
        id: "issue-smoke-ngx-294-link",
        identifier: "NGX-294",
        title: "M5-07 M5 smoke, docs, and milestone closeout",
        description: "Smoke fixture for the M5 Goal/SourceItem linkage path.",
        url: "https://linear.app/ngxcalvin/issue/NGX-294",
        updatedAt: "2026-05-18T10:30:00.000Z",
        priority: 0,
        state: { id: "state-in-progress", name: "In Progress" },
        project: {
          id: "project-momentum",
          name: "Momentum",
          url: "https://linear.app/ngxcalvin/project/momentum"
        },
        projectMilestone: {
          id: "milestone-m5",
          name: "Milestone 5: Source Adapters And Evidence Sync"
        },
        labels: { nodes: [] },
        assignee: null
      };
      const mock = await startLinearMockServer([issue]);
      try {
        const reconcile = await runCliBinaryAsync(
          [
            "source",
            "reconcile",
            "linear",
            "--linear-endpoint",
            mock.endpoint,
            "--data-dir",
            dataDir,
            "--json"
          ],
          { env: { LINEAR_API_KEY: "lin_api_smoke_fixture_key" } }
        );
        expect(
          reconcile.code,
          `source reconcile linear stderr: ${reconcile.stderr}`
        ).toBe(0);
        const reconcilePayload = JSON.parse(reconcile.stdout) as Record<
          string,
          unknown
        >;
        expect(reconcilePayload["ok"]).toBe(true);
        const reconciledSample = reconcilePayload["itemsSampled"] as Array<
          Record<string, unknown>
        >;
        expect(reconciledSample).toHaveLength(1);
        expect(reconciledSample[0]).toMatchObject({
          classification: "created",
          externalKey: "NGX-294"
        });

        // Resolve the new SourceItem id via source list (reconcile payload omits the local id).
        const initialList = runCliBinary([
          "source",
          "list",
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(
          initialList.code,
          `initial source list stderr: ${initialList.stderr}`
        ).toBe(0);
        const initialListPayload = JSON.parse(initialList.stdout) as Record<
          string,
          unknown
        >;
        const initialListedItems = initialListPayload["items"] as Array<
          Record<string, unknown>
        >;
        expect(initialListedItems).toHaveLength(1);
        const sourceItemId = initialListedItems[0]?.["id"] as string;
        expect(typeof sourceItemId).toBe("string");
        expect(sourceItemId.length).toBeGreaterThan(0);
        expect(initialListedItems[0]?.["goalId"]).toBeNull();

        const goalStart = runCliBinary([
          "goal",
          "start",
          goalFile,
          "--repo",
          repo,
          "--data-dir",
          dataDir,
          "--runner",
          "fake",
          "--json"
        ]);
        expect(goalStart.code, `goal start stderr: ${goalStart.stderr}`).toBe(0);
        const goalPayload = JSON.parse(goalStart.stdout) as Record<string, unknown>;
        const goalId = goalPayload["goalId"] as string;
        expect(typeof goalId).toBe("string");
        expect(goalId.length).toBeGreaterThan(0);
        expect(goalPayload["goalState"]).toBe("queued");

        const link = runCliBinary([
          "source",
          "link",
          sourceItemId,
          "--goal",
          goalId,
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(link.code, `source link stderr: ${link.stderr}`).toBe(0);
        const linkPayload = JSON.parse(link.stdout) as Record<string, unknown>;
        expect(linkPayload).toMatchObject({
          ok: true,
          command: "source link",
          dataDir,
          goalId,
          sourceItemId,
          changed: true,
          previousGoalId: null
        });
        const linkedItem = linkPayload["item"] as Record<string, unknown>;
        expect(linkedItem).toMatchObject({
          id: sourceItemId,
          adapterKind: "linear",
          externalKey: "NGX-294",
          goalId
        });

        // Linking the same item again is a no-op (changed=false, skippedReason=already_linked).
        const relink = runCliBinary([
          "source",
          "link",
          sourceItemId,
          "--goal",
          goalId,
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(relink.code, `source relink stderr: ${relink.stderr}`).toBe(0);
        const relinkPayload = JSON.parse(relink.stdout) as Record<string, unknown>;
        expect(relinkPayload).toMatchObject({
          ok: true,
          changed: false,
          skippedReason: "already_linked_to_target"
        });

        const status = runCliBinary([
          "status",
          goalId,
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(status.code, `status stderr: ${status.stderr}`).toBe(0);
        const statusPayload = JSON.parse(status.stdout) as Record<string, unknown>;
        expect(statusPayload).toMatchObject({
          ok: true,
          command: "status",
          goalId
        });
        const statusSourceItems = statusPayload["sourceItems"] as Array<
          Record<string, unknown>
        >;
        expect(Array.isArray(statusSourceItems)).toBe(true);
        expect(statusSourceItems).toHaveLength(1);
        expect(statusSourceItems[0]).toMatchObject({
          id: sourceItemId,
          adapterKind: "linear",
          externalId: "issue-smoke-ngx-294-link",
          externalKey: "NGX-294",
          title: "M5-07 M5 smoke, docs, and milestone closeout",
          status: "In Progress",
          url: "https://linear.app/ngxcalvin/issue/NGX-294"
        });
        expect(typeof statusSourceItems[0]?.["lastObservedAt"]).toBe("number");

        const handoff = runCliBinary([
          "handoff",
          goalId,
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(handoff.code, `handoff stderr: ${handoff.stderr}`).toBe(0);
        const handoffPayload = JSON.parse(handoff.stdout) as Record<string, unknown>;
        expect(handoffPayload).toMatchObject({
          ok: true,
          command: "handoff",
          goalId
        });
        const handoffSourceItems = handoffPayload["sourceItems"] as Array<
          Record<string, unknown>
        >;
        expect(Array.isArray(handoffSourceItems)).toBe(true);
        expect(handoffSourceItems).toHaveLength(1);
        expect(handoffSourceItems[0]).toMatchObject({
          id: sourceItemId,
          adapterKind: "linear",
          externalKey: "NGX-294",
          title: "M5-07 M5 smoke, docs, and milestone closeout"
        });

        // handoff.md on disk surfaces the linked source item as well.
        const handoffMdPath = handoffPayload["handoffMdPath"] as string;
        expect(typeof handoffMdPath).toBe("string");
        const handoffMd = fs.readFileSync(handoffMdPath, "utf-8");
        expect(handoffMd).toContain("## Source items");
        expect(handoffMd).toContain("linear/NGX-294");
        expect(handoffMd).toContain(
          "M5-07 M5 smoke, docs, and milestone closeout"
        );

        // doctor --json now reports the linked source item, not the unlinked one.
        const doctor = runCliBinary([
          "doctor",
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(doctor.code, `doctor stderr: ${doctor.stderr}`).toBe(0);
        const doctorPayload = JSON.parse(doctor.stdout) as Record<string, unknown>;
        const sourcesPayload = doctorPayload["sources"] as Record<string, unknown>;
        expect(sourcesPayload).toMatchObject({
          ok: true,
          totalSourceItems: 1,
          linkedSourceItems: 1,
          unlinkedSourceItems: 0
        });
      } finally {
        await mock.close();
      }
    },
    60_000
  );

  it(
    "generates a source_satisfied update intent through source link after a goal completes and refuses --external-apply",
    async () => {
      const dataDir = makeTempDir("momentum-smoke-m5-intent-gen-data-");
      const repo = initDisposableRepo();
      const goalFile = path.join(dataDir, "goal.md");
      fs.writeFileSync(goalFile, SMOKE_GOAL_SPEC, "utf-8");

      const issue = {
        id: "issue-smoke-ngx-294-intent",
        identifier: "NGX-294",
        title: "M5-07 M5 smoke, docs, and milestone closeout",
        description: "Smoke fixture for the M5 intent generation path.",
        url: "https://linear.app/ngxcalvin/issue/NGX-294",
        updatedAt: "2026-05-18T11:00:00.000Z",
        priority: 0,
        state: { id: "state-in-progress", name: "In Progress" },
        project: {
          id: "project-momentum",
          name: "Momentum",
          url: "https://linear.app/ngxcalvin/project/momentum"
        },
        projectMilestone: {
          id: "milestone-m5",
          name: "Milestone 5: Source Adapters And Evidence Sync"
        },
        labels: { nodes: [] },
        assignee: null
      };
      const mock = await startLinearMockServer([issue]);
      try {
        const reconcile = await runCliBinaryAsync(
          [
            "source",
            "reconcile",
            "linear",
            "--linear-endpoint",
            mock.endpoint,
            "--data-dir",
            dataDir,
            "--json"
          ],
          { env: { LINEAR_API_KEY: "lin_api_smoke_fixture_key" } }
        );
        expect(
          reconcile.code,
          `source reconcile linear stderr: ${reconcile.stderr}`
        ).toBe(0);

        const sourceList = runCliBinary([
          "source",
          "list",
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(sourceList.code, `source list stderr: ${sourceList.stderr}`).toBe(0);
        const sourceListPayload = JSON.parse(sourceList.stdout) as Record<
          string,
          unknown
        >;
        const sourceItems = sourceListPayload["items"] as Array<
          Record<string, unknown>
        >;
        expect(sourceItems).toHaveLength(1);
        const sourceItemId = sourceItems[0]?.["id"] as string;
        expect(typeof sourceItemId).toBe("string");
        expect(sourceItemId.length).toBeGreaterThan(0);

        const goalStart = runCliBinary([
          "goal",
          "start",
          goalFile,
          "--repo",
          repo,
          "--data-dir",
          dataDir,
          "--runner",
          "fake",
          "--json"
        ]);
        expect(goalStart.code, `goal start stderr: ${goalStart.stderr}`).toBe(0);
        const goalStartPayload = JSON.parse(goalStart.stdout) as Record<
          string,
          unknown
        >;
        const goalId = goalStartPayload["goalId"] as string;
        expect(typeof goalId).toBe("string");
        expect(goalStartPayload["goalState"]).toBe("queued");

        // Drain the queued goal to completion. FAKE_RUNNER_GOAL_COMPLETE makes
        // the single iteration mark goal_complete so the reducer transitions
        // the goal to the `completed` state — required by the intent generator.
        const drain = runCliBinary(
          [
            "daemon",
            "start",
            "--max-idle-cycles",
            "2",
            "--poll-interval-ms",
            "0",
            "--data-dir",
            dataDir,
            "--json"
          ],
          { env: { [FAKE_RUNNER_GOAL_COMPLETE_ENV]: "1" } }
        );
        expect(drain.code, `daemon start stderr: ${drain.stderr}`).toBe(0);
        const drainPayload = JSON.parse(drain.stdout) as Record<string, unknown>;
        const loop = drainPayload["loop"] as Record<string, unknown>;
        expect(loop).toMatchObject({
          workSucceeded: true,
          jobsRun: 1,
          jobsFailed: 0
        });

        const completedStatus = runCliBinary([
          "status",
          goalId,
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(completedStatus.code).toBe(0);
        expect(
          (JSON.parse(completedStatus.stdout) as Record<string, unknown>)[
            "state"
          ]
        ).toBe("completed");

        // Ingest a workflow evidence fixture with `no-mistakes complete` so
        // the intent generator finds an accepted verification evidence type.
        const fixtureRoot = makeTempDir("momentum-smoke-m5-intent-fixture-");
        const intentRunId = "smoke-m5-intent-run-1";
        const runDir = path.join(fixtureRoot, ".agent-workflows", intentRunId);
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(
          path.join(runDir, "plan.json"),
          JSON.stringify(
            {
              runId: intentRunId,
              schemaVersion: 1,
              mode: "execute-ready",
              profile: "momentum-m5-smoke",
              objective: "NGX-294 smoke fixture for intent generation",
              resolvedScope: {
                issues: ["NGX-294"],
                source: "explicit",
                status: "resolved"
              }
            },
            null,
            2
          )
        );
        const ledger = [
          {
            runId: intentRunId,
            step: "implementation",
            status: "complete",
            ts: "2026-05-18T11:20:00Z"
          },
          {
            runId: intentRunId,
            step: "no-mistakes",
            status: "complete",
            ts: "2026-05-18T11:25:00Z"
          }
        ];
        fs.writeFileSync(
          path.join(runDir, "ledger.jsonl"),
          `${ledger.map((line) => JSON.stringify(line)).join("\n")}\n`
        );

        const ingest = runCliBinary([
          "evidence",
          "ingest",
          "--path",
          runDir,
          "--goal",
          goalId,
          "--source-item",
          sourceItemId,
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(ingest.code, `evidence ingest stderr: ${ingest.stderr}`).toBe(0);
        const ingestPayload = JSON.parse(ingest.stdout) as Record<
          string,
          unknown
        >;
        const ingestCreated = ingestPayload["created"] as Array<
          Record<string, unknown>
        >;
        expect(
          ingestCreated.some(
            (record) => record["type"] === "no_mistakes_complete"
          ),
          `expected no_mistakes_complete in created evidence: ${JSON.stringify(
            ingestCreated
          )}`
        ).toBe(true);

        // Linking now triggers `evaluateGoalForSourceSatisfiedIntents` against
        // the completed goal + non-terminal source item + accepted evidence.
        const link = runCliBinary([
          "source",
          "link",
          sourceItemId,
          "--goal",
          goalId,
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(link.code, `source link stderr: ${link.stderr}`).toBe(0);
        const linkPayload = JSON.parse(link.stdout) as Record<string, unknown>;
        const linkCounts = linkPayload["counts"] as Record<string, number>;
        expect(linkCounts).toMatchObject({
          intentsCreated: 1,
          intentsReplayed: 0,
          intentWarnings: 0
        });

        const intentList = runCliBinary([
          "intent",
          "list",
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(intentList.code, `intent list stderr: ${intentList.stderr}`).toBe(
          0
        );
        const intentListPayload = JSON.parse(intentList.stdout) as Record<
          string,
          unknown
        >;
        expect(intentListPayload["count"]).toBe(1);
        const listedIntents = intentListPayload["intents"] as Array<
          Record<string, unknown>
        >;
        expect(listedIntents).toHaveLength(1);
        const intent = listedIntents[0]!;
        expect(intent).toMatchObject({
          adapterKind: "linear",
          intentType: "source_satisfied",
          status: "pending",
          goalId,
          sourceItemId,
          targetExternalId: "issue-smoke-ngx-294-intent"
        });
        const intentId = intent["id"] as string;
        expect(typeof intentId).toBe("string");
        expect(intentId.length).toBeGreaterThan(0);

        // Re-running the eval (e.g. relinking) replays the same intent rather
        // than creating a new one — proves idempotency through the built CLI.
        const relink = runCliBinary([
          "source",
          "link",
          sourceItemId,
          "--goal",
          goalId,
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(relink.code).toBe(0);
        const relinkPayload = JSON.parse(relink.stdout) as Record<string, unknown>;
        const relinkCounts = relinkPayload["counts"] as Record<string, number>;
        expect(relinkCounts).toMatchObject({
          intentsCreated: 0,
          intentsReplayed: 1
        });

        // `intent apply --external-apply` requires a repo context whose
        // MOMENTUM.md sets intent_apply_policy: external_apply_allowed.
        // Without --repo, the orchestrator refuses with policy_denied and
        // leaves the intent pending. No external write occurs.
        const externalApply = runCliBinary([
          "intent",
          "apply",
          intentId,
          "--reason",
          "smoke external apply attempt",
          "--external-apply",
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(externalApply.code).toBe(1);
        expect(externalApply.stdout).toBe("");
        const externalApplyPayload = JSON.parse(externalApply.stderr) as Record<
          string,
          unknown
        >;
        expect(externalApplyPayload).toMatchObject({
          ok: false,
          command: "intent apply",
          code: "policy_denied",
          intentId
        });
        const externalApplyPolicy = externalApplyPayload["applyPolicy"] as Record<
          string,
          unknown
        >;
        expect(externalApplyPolicy).toMatchObject({
          effective: "create_intents_only",
          source: "builtin_default",
          externalApplyRequested: true,
          externalApplyPerformed: false
        });

        const stillPending = runCliBinary([
          "intent",
          "get",
          intentId,
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(stillPending.code).toBe(0);
        const stillPendingPayload = JSON.parse(stillPending.stdout) as Record<
          string,
          unknown
        >;
        expect(
          (stillPendingPayload["intent"] as Record<string, unknown>)["status"]
        ).toBe("pending");

        // `intent apply` without --external-apply records the operator's
        // manual mark only; the intent moves to `applied` with no external
        // write attempted.
        const manualApply = runCliBinary([
          "intent",
          "apply",
          intentId,
          "--reason",
          "operator manual mark in smoke run",
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(
          manualApply.code,
          `manual apply stderr: ${manualApply.stderr}`
        ).toBe(0);
        const manualApplyPayload = JSON.parse(manualApply.stdout) as Record<
          string,
          unknown
        >;
        expect(manualApplyPayload["previousStatus"]).toBe("pending");
        const appliedIntent = manualApplyPayload["intent"] as Record<
          string,
          unknown
        >;
        expect(appliedIntent).toMatchObject({
          id: intentId,
          status: "applied",
          decisionReason: "operator manual mark in smoke run"
        });
        const manualApplyPolicy = manualApplyPayload["applyPolicy"] as Record<
          string,
          unknown
        >;
        expect(manualApplyPolicy).toMatchObject({
          effective: "create_intents_only",
          source: "builtin_default",
          externalApplyRequested: false,
          externalApplyPerformed: false
        });

        const pendingList = runCliBinary([
          "intent",
          "list",
          "--status",
          "pending",
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(pendingList.code).toBe(0);
        const pendingListPayload = JSON.parse(pendingList.stdout) as Record<
          string,
          unknown
        >;
        expect(pendingListPayload["count"]).toBe(0);

        const appliedList = runCliBinary([
          "intent",
          "list",
          "--status",
          "applied",
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(appliedList.code).toBe(0);
        const appliedListPayload = JSON.parse(appliedList.stdout) as Record<
          string,
          unknown
        >;
        expect(appliedListPayload["count"]).toBe(1);
        const appliedListedIntents = appliedListPayload["intents"] as Array<
          Record<string, unknown>
        >;
        expect(appliedListedIntents[0]).toMatchObject({
          id: intentId,
          status: "applied"
        });
      } finally {
        await mock.close();
      }
    },
    180_000
  );

  it(
    "computes a project rollup with mismatches and pending intents through the built CLI",
    async () => {
      const dataDir = makeTempDir("momentum-smoke-m5-rollup-data-");
      const repo = initDisposableRepo();
      const goalFile = path.join(dataDir, "goal.md");
      fs.writeFileSync(goalFile, SMOKE_GOAL_SPEC, "utf-8");

      // SourceItem stays in a non-terminal state ("In Progress") while the
      // Goal completes; that asymmetry is what produces the
      // `goal_done_source_not_done` mismatch the rollup must surface.
      const issue = {
        id: "issue-smoke-ngx-294-rollup",
        identifier: "NGX-294",
        title: "M5-07 M5 smoke, docs, and milestone closeout",
        description: "Smoke fixture for the M5 project rollup path.",
        url: "https://linear.app/ngxcalvin/issue/NGX-294",
        updatedAt: "2026-05-18T12:00:00.000Z",
        priority: 0,
        state: { id: "state-in-progress", name: "In Progress" },
        project: {
          id: "project-momentum",
          name: "Momentum",
          url: "https://linear.app/ngxcalvin/project/momentum"
        },
        projectMilestone: {
          id: "milestone-m5",
          name: "Milestone 5: Source Adapters And Evidence Sync"
        },
        labels: { nodes: [] },
        assignee: null
      };
      const mock = await startLinearMockServer([issue]);
      try {
        const reconcile = await runCliBinaryAsync(
          [
            "source",
            "reconcile",
            "linear",
            "--linear-endpoint",
            mock.endpoint,
            "--data-dir",
            dataDir,
            "--json"
          ],
          { env: { LINEAR_API_KEY: "lin_api_smoke_fixture_key" } }
        );
        expect(
          reconcile.code,
          `source reconcile linear stderr: ${reconcile.stderr}`
        ).toBe(0);

        const sourceList = runCliBinary([
          "source",
          "list",
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(sourceList.code, `source list stderr: ${sourceList.stderr}`).toBe(0);
        const sourceListPayload = JSON.parse(sourceList.stdout) as Record<
          string,
          unknown
        >;
        const sourceItems = sourceListPayload["items"] as Array<
          Record<string, unknown>
        >;
        expect(sourceItems).toHaveLength(1);
        const sourceItemId = sourceItems[0]?.["id"] as string;
        expect(typeof sourceItemId).toBe("string");

        const goalStart = runCliBinary([
          "goal",
          "start",
          goalFile,
          "--repo",
          repo,
          "--data-dir",
          dataDir,
          "--runner",
          "fake",
          "--json"
        ]);
        expect(goalStart.code, `goal start stderr: ${goalStart.stderr}`).toBe(0);
        const goalStartPayload = JSON.parse(goalStart.stdout) as Record<
          string,
          unknown
        >;
        const goalId = goalStartPayload["goalId"] as string;
        expect(typeof goalId).toBe("string");
        expect(goalStartPayload["goalState"]).toBe("queued");

        const drain = runCliBinary(
          [
            "daemon",
            "start",
            "--max-idle-cycles",
            "2",
            "--poll-interval-ms",
            "0",
            "--data-dir",
            dataDir,
            "--json"
          ],
          { env: { [FAKE_RUNNER_GOAL_COMPLETE_ENV]: "1" } }
        );
        expect(drain.code, `daemon start stderr: ${drain.stderr}`).toBe(0);
        const drainPayload = JSON.parse(drain.stdout) as Record<string, unknown>;
        const loop = drainPayload["loop"] as Record<string, unknown>;
        expect(loop).toMatchObject({
          workSucceeded: true,
          jobsRun: 1,
          jobsFailed: 0
        });

        // Ingest workflow evidence with a no-mistakes complete entry so the
        // intent generator finds an accepted verification evidence type.
        const fixtureRoot = makeTempDir("momentum-smoke-m5-rollup-fixture-");
        const runId = "smoke-m5-rollup-run-1";
        const runDir = path.join(fixtureRoot, ".agent-workflows", runId);
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(
          path.join(runDir, "plan.json"),
          JSON.stringify(
            {
              runId,
              schemaVersion: 1,
              mode: "execute-ready",
              profile: "momentum-m5-smoke",
              objective: "NGX-294 smoke fixture for project rollup",
              resolvedScope: {
                issues: ["NGX-294"],
                source: "explicit",
                status: "resolved"
              }
            },
            null,
            2
          )
        );
        const ledger = [
          {
            runId,
            step: "implementation",
            status: "complete",
            ts: "2026-05-18T12:20:00Z"
          },
          {
            runId,
            step: "no-mistakes",
            status: "complete",
            ts: "2026-05-18T12:25:00Z"
          }
        ];
        fs.writeFileSync(
          path.join(runDir, "ledger.jsonl"),
          `${ledger.map((line) => JSON.stringify(line)).join("\n")}\n`
        );

        const ingest = runCliBinary([
          "evidence",
          "ingest",
          "--path",
          runDir,
          "--goal",
          goalId,
          "--source-item",
          sourceItemId,
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(ingest.code, `evidence ingest stderr: ${ingest.stderr}`).toBe(0);

        // Link the SourceItem to the completed Goal — this triggers intent
        // creation (completed goal + non-terminal source + no_mistakes_complete).
        const link = runCliBinary([
          "source",
          "link",
          sourceItemId,
          "--goal",
          goalId,
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(link.code, `source link stderr: ${link.stderr}`).toBe(0);
        const linkPayload = JSON.parse(link.stdout) as Record<string, unknown>;
        const linkCounts = linkPayload["counts"] as Record<string, number>;
        expect(linkCounts).toMatchObject({
          intentsCreated: 1,
          intentsReplayed: 0,
          intentWarnings: 0
        });

        const project = runCliBinary([
          "project",
          "status",
          "--data-dir",
          dataDir,
          "--json"
        ]);
        expect(project.code, `project status stderr: ${project.stderr}`).toBe(0);
        const projectPayload = JSON.parse(project.stdout) as Record<
          string,
          unknown
        >;
        expect(projectPayload).toMatchObject({
          ok: true,
          command: "project status",
          dataDir
        });

        const counts = projectPayload["counts"] as Record<
          string,
          Record<string, unknown>
        >;
        expect(counts.sourceItems).toMatchObject({
          total: 1,
          linkedToGoal: 1,
          unlinked: 0
        });
        const sourceByStatus = counts.sourceItems?.["byStatus"] as Record<
          string,
          number
        >;
        expect(sourceByStatus["In Progress"]).toBe(1);
        expect(counts.goals).toMatchObject({
          total: 1,
          needingManualRecovery: 0
        });
        const goalByState = counts.goals?.["byState"] as Record<string, number>;
        expect(goalByState["completed"]).toBe(1);
        const evidenceCounts = counts.evidence as Record<string, number>;
        expect(evidenceCounts.totalRecords).toBeGreaterThanOrEqual(1);
        expect(evidenceCounts.goalsWithEvidence).toBe(1);
        expect(evidenceCounts.goalsWithoutEvidence).toBe(0);

        const mismatchCounts = counts.mismatches as Record<string, number>;
        expect(mismatchCounts.goal_done_source_not_done).toBe(1);
        expect(mismatchCounts.source_done_goal_not_terminal).toBe(0);
        expect(mismatchCounts.evidence_missing_after_completion).toBe(0);
        expect(mismatchCounts.manual_recovery_required).toBe(0);
        expect(counts["pendingUpdateIntents"]).toBe(1);
        expect(counts["staleUpdateIntents"]).toBe(0);

        // `project status` source-item summaries use `sourceItemId`, not the
        // bare `id` shape that `source list`/`source get` return — verify the
        // local id ties back to the SourceItem created by reconciliation.
        const rolledItems = projectPayload["sourceItems"] as Array<
          Record<string, unknown>
        >;
        expect(rolledItems).toHaveLength(1);
        expect(rolledItems[0]).toMatchObject({
          sourceItemId,
          adapterKind: "linear",
          externalKey: "NGX-294",
          status: "In Progress",
          goalId,
          goalState: "completed"
        });

        const mismatches = projectPayload["mismatches"] as Array<
          Record<string, unknown>
        >;
        expect(mismatches).toHaveLength(1);
        expect(mismatches[0]).toMatchObject({
          kind: "goal_done_source_not_done",
          sourceItemId,
          externalKey: "NGX-294",
          goalId,
          goalState: "completed",
          sourceStatus: "In Progress"
        });
        expect(projectPayload["totalMismatchCount"]).toBe(1);
        expect(projectPayload["truncatedMismatches"]).toBe(false);

        const pendingIntents = projectPayload["pendingUpdateIntents"] as Array<
          Record<string, unknown>
        >;
        expect(pendingIntents).toHaveLength(1);
        expect(pendingIntents[0]).toMatchObject({
          adapterKind: "linear",
          intentType: "source_satisfied",
          goalId,
          sourceItemId,
          targetExternalId: "issue-smoke-ngx-294-rollup",
          stale: false
        });
        expect(typeof pendingIntents[0]?.["intentId"]).toBe("string");
        expect(typeof pendingIntents[0]?.["ageMs"]).toBe("number");
        expect(projectPayload["totalPendingUpdateIntentCount"]).toBe(1);
        expect(projectPayload["truncatedPendingUpdateIntents"]).toBe(false);
        expect(projectPayload["reconciliationWarnings"]).toEqual([]);

        // `pickNextAction` prioritizes pending intents above the
        // `goal_done_source_not_done` mismatch, so the operator-facing
        // hint should steer to the intent review path here.
        const nextAction = projectPayload["nextAction"] as Record<
          string,
          unknown
        >;
        expect(nextAction["kind"]).toBe("review_pending_intents");
        expect(typeof nextAction["message"]).toBe("string");
        const nextActionDetail = nextAction["detail"] as Record<string, unknown>;
        expect(nextActionDetail["total"]).toBe(1);
        expect(nextActionDetail["stale"]).toBe(0);
        const intentIds = nextActionDetail["intentIds"] as string[];
        expect(Array.isArray(intentIds)).toBe(true);
        expect(intentIds).toHaveLength(1);
      } finally {
        await mock.close();
      }
    },
    180_000
  );
});
