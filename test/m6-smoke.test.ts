import { afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { openDb } from "../src/adapters/db.js";

import {
  buildCli,
  cleanupTempRoots,
  initDisposableRepo,
  makeTempDir,
  runCliBinary,
  runCliBinaryAsync,
  runGit,
} from "./helpers/smoke-harness.js";

beforeAll(buildCli, 60_000);

afterEach(cleanupTempRoots);

/**
 * Seed a completed goal row directly in the SQLite store shared with the CLI
 * under test. The legacy goal-first lane (`goal start` + fake-runner daemon
 * drain) is retired, so the smoke fixtures insert the durable `goals` row the
 * kept surfaces actually read: source-satisfied intent generation requires
 * `state = 'completed'`, and the evidence/source/intent commands only check
 * that the goal row exists.
 */
function seedCompletedGoal(dataDir: string, goalId: string): void {
  const db = openDb(dataDir);
  try {
    const now = Date.now();
    db.prepare(
      `INSERT INTO goals
         (id, title, branch, state, artifact_dir, created_at, updated_at)
       VALUES (?, ?, ?, 'completed', ?, ?, ?)`,
    ).run(
      goalId,
      "M6 smoke completed goal",
      "momentum/smoke-m6",
      path.join(dataDir, "goals", goalId),
      now,
      now,
    );
  } finally {
    db.close();
  }
}

type LinearMockCommentCreateBehavior =
  { kind: "success" } | { kind: "graphql_error"; message: string };

type LinearMockIssueRefreshBehavior =
  { kind: "success" } | { kind: "graphql_error"; message: string };

type LinearExternalApplyMockServer = {
  endpoint: string;
  commentsCreated: Array<{ issueId: string; body: string }>;
  issueUpdates: Array<{ issueId: string; stateId: string }>;
  requestCounts: Record<string, number>;
  setIssueState: (issueId: string, state: { id: string; name: string }) => void;
  setCommentCreateBehavior: (behavior: LinearMockCommentCreateBehavior) => void;
  setIssueRefreshBehavior: (behavior: LinearMockIssueRefreshBehavior) => void;
  setCommentCreateDelayMs: (ms: number) => void;
  close: () => Promise<void>;
};

type LinearExternalApplyMockIssue = {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  url: string;
  updatedAt: string;
  priority?: number;
  state: { id: string; name: string };
  team?: { id: string };
  project?: { id: string; name: string; url: string };
  projectMilestone?: { id: string; name: string };
  labels?: { nodes: Array<{ id: string; name: string }> };
  assignee?: { id: string; name: string; email: string } | null;
  comments?: Array<{ id: string; body: string; url: string | null }>;
};

async function startLinearExternalApplyMockServer(
  issues: LinearExternalApplyMockIssue[],
): Promise<LinearExternalApplyMockServer> {
  type IssueRecord = LinearExternalApplyMockIssue & {
    comments: Array<{ id: string; body: string; url: string | null }>;
  };
  const issueById = new Map<string, IssueRecord>();
  for (const issue of issues) {
    issueById.set(issue.id, {
      ...issue,
      comments: [...(issue.comments ?? [])],
    });
  }
  const commentsCreated: Array<{ issueId: string; body: string }> = [];
  const issueUpdates: Array<{ issueId: string; stateId: string }> = [];
  const requestCounts: Record<string, number> = {};
  let commentCounter = 0;
  let commentCreateBehavior: LinearMockCommentCreateBehavior = {
    kind: "success",
  };
  let issueRefreshBehavior: LinearMockIssueRefreshBehavior = {
    kind: "success",
  };
  let commentCreateDelayMs = 0;

  function tallyOperation(query: string): void {
    const match = /(query|mutation)\s+(\w+)/.exec(query);
    const name = match ? match[2]! : "Unknown";
    requestCounts[name] = (requestCounts[name] ?? 0) + 1;
  }

  function serializeIssueForSourceListing(record: IssueRecord): unknown {
    return {
      id: record.id,
      identifier: record.identifier,
      title: record.title,
      description: record.description ?? null,
      url: record.url,
      updatedAt: record.updatedAt,
      priority: record.priority ?? 0,
      state: record.state,
      project: record.project ?? null,
      projectMilestone: record.projectMilestone ?? null,
      labels: record.labels ?? { nodes: [] },
      assignee: record.assignee ?? null,
    };
  }

  function serializeIssueWithComments(record: IssueRecord): unknown {
    return {
      id: record.id,
      identifier: record.identifier,
      title: record.title,
      description: record.description ?? null,
      url: record.url,
      updatedAt: record.updatedAt,
      priority: record.priority ?? 0,
      state: record.state,
      team: record.team ?? { id: `team-${record.id}` },
      project: record.project ?? null,
      projectMilestone: record.projectMilestone ?? null,
      labels: record.labels ?? { nodes: [] },
      assignee: record.assignee ?? null,
      comments: {
        nodes: record.comments,
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    };
  }

  function handle(body: {
    query?: string;
    variables?: Record<string, unknown>;
  }): { status: number; body: unknown } {
    const query = typeof body.query === "string" ? body.query : "";
    const variables = (body.variables ?? {}) as Record<string, unknown>;
    tallyOperation(query);

    if (query.includes("MomentumLinearIssues")) {
      const nodes = Array.from(issueById.values()).map(
        serializeIssueForSourceListing,
      );
      return {
        status: 200,
        body: {
          data: {
            issues: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes,
            },
          },
        },
      };
    }

    if (query.includes("MomentumIssueRefresh")) {
      if (issueRefreshBehavior.kind === "graphql_error") {
        return {
          status: 200,
          body: {
            errors: [{ message: issueRefreshBehavior.message }],
          },
        };
      }
      const id =
        typeof variables["id"] === "string" ? (variables["id"] as string) : "";
      const record = issueById.get(id);
      if (!record) {
        return { status: 200, body: { data: { issue: null } } };
      }
      return {
        status: 200,
        body: { data: { issue: serializeIssueWithComments(record) } },
      };
    }

    if (query.includes("MomentumExternalUpdateIssueLookup")) {
      const id =
        typeof variables["id"] === "string" ? (variables["id"] as string) : "";
      const record = issueById.get(id);
      if (!record) {
        return { status: 200, body: { data: { issue: null } } };
      }
      return {
        status: 200,
        body: { data: { issue: serializeIssueWithComments(record) } },
      };
    }

    if (
      query.includes("MomentumExternalUpdateIssueCommentsPage") ||
      query.includes("MomentumIssueRefreshCommentsPage")
    ) {
      return {
        status: 200,
        body: {
          data: {
            issue: {
              comments: {
                nodes: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      };
    }

    if (query.includes("MomentumExternalUpdateCommentCreate")) {
      const input = (variables["input"] ?? {}) as {
        issueId?: string;
        body?: string;
      };
      const issueId = input.issueId ?? "";
      const commentBody = input.body ?? "";
      const record = issueById.get(issueId);
      if (!record) {
        return {
          status: 200,
          body: { data: { commentCreate: { success: false, comment: null } } },
        };
      }
      if (commentCreateBehavior.kind === "graphql_error") {
        return {
          status: 200,
          body: {
            errors: [{ message: commentCreateBehavior.message }],
          },
        };
      }
      commentCounter += 1;
      const commentId = `mock-comment-${commentCounter}`;
      const commentUrl = `${record.url}#comment-${commentCounter}`;
      record.comments.push({
        id: commentId,
        body: commentBody,
        url: commentUrl,
      });
      commentsCreated.push({ issueId, body: commentBody });
      return {
        status: 200,
        body: {
          data: {
            commentCreate: {
              success: true,
              comment: { id: commentId, url: commentUrl },
            },
          },
        },
      };
    }

    if (query.includes("MomentumExternalUpdateIssueStateUpdate")) {
      const id =
        typeof variables["id"] === "string" ? (variables["id"] as string) : "";
      const input = (variables["input"] ?? {}) as { stateId?: string };
      const stateId = input.stateId ?? "";
      const record = issueById.get(id);
      if (!record) {
        return {
          status: 200,
          body: { data: { issueUpdate: { success: false, issue: null } } },
        };
      }
      record.state = { id: stateId, name: record.state.name };
      issueUpdates.push({ issueId: id, stateId });
      return {
        status: 200,
        body: {
          data: {
            issueUpdate: {
              success: true,
              issue: { id: record.id, state: record.state },
            },
          },
        },
      };
    }

    if (query.includes("MomentumExternalUpdateWorkflowStateLookup")) {
      return {
        status: 200,
        body: { data: { workflowStates: { nodes: [] } } },
      };
    }

    return {
      status: 200,
      body: { errors: [{ message: `unknown query: ${query.slice(0, 80)}` }] },
    };
  }

  const server = http.createServer((req, res) => {
    const hostHeader = req.headers["host"] ?? "";
    if (typeof hostHeader === "string" && /linear\.app/i.test(hostHeader)) {
      res.statusCode = 599;
      res.end(
        JSON.stringify({
          errors: [
            {
              message:
                "smoke mock refused: real Linear host detected in Host header",
            },
          ],
        }),
      );
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      let parsed: { query?: string; variables?: Record<string, unknown> };
      try {
        parsed = JSON.parse(raw) as {
          query?: string;
          variables?: Record<string, unknown>;
        };
      } catch {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ errors: [{ message: "invalid JSON body" }] }));
        return;
      }
      const result = handle(parsed);
      const isCommentCreate =
        typeof parsed.query === "string" &&
        parsed.query.includes("MomentumExternalUpdateCommentCreate");
      const writeResponse = (): void => {
        res.statusCode = result.status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result.body));
      };
      if (isCommentCreate && commentCreateDelayMs > 0) {
        setTimeout(writeResponse, commentCreateDelayMs);
        return;
      }
      writeResponse();
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
    commentsCreated,
    issueUpdates,
    requestCounts,
    setIssueState(issueId, state) {
      const record = issueById.get(issueId);
      if (record) record.state = state;
    },
    setCommentCreateBehavior(behavior) {
      commentCreateBehavior = behavior;
    },
    setIssueRefreshBehavior(behavior) {
      issueRefreshBehavior = behavior;
    },
    setCommentCreateDelayMs(ms) {
      commentCreateDelayMs = Math.max(0, ms);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe("Milestone 6 external apply end-to-end smoke (NGX-301)", () => {
  it("applies a pending source_satisfied intent through the mock Linear endpoint with deterministic idempotency and successful post-apply reconcile", async () => {
    const dataDir = makeTempDir("momentum-smoke-m6-apply-data-");
    const repo = initDisposableRepo();
    fs.writeFileSync(
      path.join(repo, "MOMENTUM.md"),
      [
        "---",
        "intent_apply_policy: external_apply_allowed",
        "---",
        "",
        "Smoke MOMENTUM.md for the M6 external apply path.",
        "",
      ].join("\n"),
      "utf-8",
    );
    runGit(repo, ["add", "MOMENTUM.md"]);
    runGit(repo, ["commit", "-m", "add MOMENTUM.md", "--quiet"]);

    const issue: LinearExternalApplyMockIssue = {
      id: "issue-smoke-ngx-301-apply",
      identifier: "NGX-301",
      title: "M6-06 External apply safety smoke and failure matrix",
      description: "Smoke fixture for the M6 external apply happy path.",
      url: "https://linear.app/ngxcalvin/issue/NGX-301",
      updatedAt: "2026-05-21T08:00:00.000Z",
      priority: 0,
      state: { id: "state-in-progress", name: "In Progress" },
      team: { id: "team-ngx" },
      project: {
        id: "project-momentum",
        name: "Momentum",
        url: "https://linear.app/ngxcalvin/project/momentum",
      },
      projectMilestone: {
        id: "milestone-m6",
        name: "Milestone 6: Policy-Gated External Apply",
      },
      labels: { nodes: [] },
      assignee: null,
      comments: [],
    };
    const mock = await startLinearExternalApplyMockServer([issue]);
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
          "--json",
        ],
        { env: { LINEAR_API_KEY: "lin_api_smoke_fixture_key" } },
      );
      expect(
        reconcile.code,
        `source reconcile linear stderr: ${reconcile.stderr}`,
      ).toBe(0);

      const sourceList = runCliBinary([
        "source",
        "list",
        "--data-dir",
        dataDir,
        "--json",
      ]);
      expect(sourceList.code, `source list stderr: ${sourceList.stderr}`).toBe(
        0,
      );
      const sourceItems = (
        JSON.parse(sourceList.stdout) as { items: Array<{ id: string }> }
      ).items;
      expect(sourceItems).toHaveLength(1);
      const sourceItemId = sourceItems[0]!.id;

      const goalId = "goal-smoke-m6-apply";
      seedCompletedGoal(dataDir, goalId);

      const fixtureRoot = makeTempDir("momentum-smoke-m6-apply-fixture-");
      const intentRunId = "smoke-m6-apply-run-1";
      const runDir = path.join(fixtureRoot, ".agent-workflows", intentRunId);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(
        path.join(runDir, "plan.json"),
        JSON.stringify(
          {
            runId: intentRunId,
            schemaVersion: 1,
            mode: "execute-ready",
            profile: "momentum-m6-smoke",
            objective: "NGX-301 smoke fixture for external apply",
            resolvedScope: {
              issues: ["NGX-301"],
              source: "explicit",
              status: "resolved",
            },
          },
          null,
          2,
        ),
      );
      const ledger = [
        {
          runId: intentRunId,
          step: "implementation",
          status: "complete",
          ts: "2026-05-21T08:20:00Z",
        },
        {
          runId: intentRunId,
          step: "no-mistakes",
          status: "complete",
          ts: "2026-05-21T08:25:00Z",
        },
      ];
      fs.writeFileSync(
        path.join(runDir, "ledger.jsonl"),
        `${ledger.map((line) => JSON.stringify(line)).join("\n")}\n`,
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
        "--json",
      ]);
      expect(ingest.code, `evidence ingest stderr: ${ingest.stderr}`).toBe(0);

      const link = runCliBinary([
        "source",
        "link",
        sourceItemId,
        "--goal",
        goalId,
        "--data-dir",
        dataDir,
        "--json",
      ]);
      expect(link.code, `source link stderr: ${link.stderr}`).toBe(0);
      const linkCounts = (
        JSON.parse(link.stdout) as {
          counts: { intentsCreated: number };
        }
      ).counts;
      expect(linkCounts.intentsCreated).toBe(1);

      const intentList = runCliBinary([
        "intent",
        "list",
        "--data-dir",
        dataDir,
        "--json",
      ]);
      expect(intentList.code).toBe(0);
      const intentListPayload = JSON.parse(intentList.stdout) as {
        intents: Array<{ id: string; status: string }>;
      };
      expect(intentListPayload.intents).toHaveLength(1);
      const intentId = intentListPayload.intents[0]!.id;
      expect(intentListPayload.intents[0]!.status).toBe("pending");

      const externalApply = await runCliBinaryAsync(
        [
          "intent",
          "apply",
          intentId,
          "--reason",
          "smoke happy-path external apply",
          "--external-apply",
          "--repo",
          repo,
          "--data-dir",
          dataDir,
          "--json",
        ],
        {
          env: {
            LINEAR_API_KEY: "lin_api_smoke_fixture_key",
            MOMENTUM_LINEAR_EXTERNAL_UPDATE_ENDPOINT: mock.endpoint,
            MOMENTUM_LINEAR_REFRESH_ENDPOINT: mock.endpoint,
          },
        },
      );
      expect(
        externalApply.code,
        `external apply stderr: ${externalApply.stderr}`,
      ).toBe(0);
      const externalApplyPayload = JSON.parse(externalApply.stdout) as {
        ok: boolean;
        intent: { id: string; status: string; decisionReason: string };
        applyPolicy: {
          effective: string;
          source: string;
          externalApplyRequested: boolean;
          externalApplyPerformed: boolean;
        };
        externalApply: {
          adapterKind: string;
          target: { externalId: string; externalKey: string };
          allowStatusMutation: boolean;
          auditId: string | null;
          mutationKind: string;
          external: {
            alreadyApplied: boolean;
            commentId: string;
            commentUrl: string;
            idempotencyMarker: string;
            statusTransitioned: boolean;
          };
          reconcile: { status: string; warning: string | null };
        };
      };
      expect(externalApplyPayload.ok).toBe(true);
      expect(externalApplyPayload.intent.status).toBe("applied");
      expect(externalApplyPayload.intent.decisionReason).toBe(
        "external_apply: smoke happy-path external apply",
      );
      expect(externalApplyPayload.applyPolicy).toMatchObject({
        effective: "external_apply_allowed",
        source: "momentum_policy",
        externalApplyRequested: true,
        externalApplyPerformed: true,
      });
      const externalSummary = externalApplyPayload.externalApply;
      expect(externalSummary.adapterKind).toBe("linear");
      expect(externalSummary.allowStatusMutation).toBe(false);
      expect(externalSummary.mutationKind).toBe("comment");
      expect(externalSummary.target.externalId).toBe(
        "issue-smoke-ngx-301-apply",
      );
      expect(externalSummary.target.externalKey).toBe("NGX-301");
      expect(typeof externalSummary.auditId).toBe("string");
      expect(externalSummary.external.alreadyApplied).toBe(false);
      expect(externalSummary.external.statusTransitioned).toBe(false);
      expect(externalSummary.external.commentId).toBe("mock-comment-1");
      const marker = externalSummary.external.idempotencyMarker;
      expect(marker).toMatch(
        new RegExp(`^momentum-intent:linear:${intentId}:[0-9a-f]{16}$`),
      );
      expect(externalSummary.reconcile.status).toBe("success");
      expect(externalSummary.reconcile.warning).toBeNull();

      // The mock recorded exactly one commentCreate and zero issueUpdate
      // calls (comment-only mode); request counts also include the
      // post-apply refresh fetch on the same endpoint.
      expect(mock.commentsCreated).toHaveLength(1);
      expect(mock.commentsCreated[0]!.issueId).toBe(
        "issue-smoke-ngx-301-apply",
      );
      expect(mock.commentsCreated[0]!.body).toContain(`idempotency: ${marker}`);
      expect(mock.issueUpdates).toHaveLength(0);
      expect(mock.requestCounts["MomentumExternalUpdateCommentCreate"]).toBe(1);
      expect(
        mock.requestCounts["MomentumExternalUpdateIssueStateUpdate"] ?? 0,
      ).toBe(0);
      expect(mock.requestCounts["MomentumIssueRefresh"]).toBe(1);

      // `intent get` surfaces the same audit summary with applyState=idle,
      // totalAttempts=1, succeeded=1, and the audit's idempotencyMarker
      // matches the value returned from the apply.
      const intentGet = runCliBinary([
        "intent",
        "get",
        intentId,
        "--data-dir",
        dataDir,
        "--json",
      ]);
      expect(intentGet.code).toBe(0);
      const intentGetPayload = JSON.parse(intentGet.stdout) as {
        intent: { status: string };
        externalApply: {
          applyState: string;
          totalAttempts: number;
          counts: {
            claimed: number;
            succeeded: number;
            failed: number;
            blocked: number;
            audit_incomplete: number;
          };
          latestAttempt: {
            lifecycleState: string;
            resultStatus: string;
            resultCode: string;
            idempotencyMarker: string;
            externalRefs: {
              commentId: string;
              commentUrl: string;
              stateTransitionId: string | null;
            };
            reconcile: { status: string; warning: string | null };
          } | null;
        };
      };
      expect(intentGetPayload.intent.status).toBe("applied");
      expect(intentGetPayload.externalApply.applyState).toBe("idle");
      expect(intentGetPayload.externalApply.totalAttempts).toBe(1);
      expect(intentGetPayload.externalApply.counts).toMatchObject({
        claimed: 0,
        succeeded: 1,
        failed: 0,
        blocked: 0,
        audit_incomplete: 0,
      });
      const latest = intentGetPayload.externalApply.latestAttempt;
      expect(latest).not.toBeNull();
      expect(latest!.lifecycleState).toBe("succeeded");
      expect(latest!.resultStatus).toBe("succeeded");
      expect(latest!.resultCode).toBe("applied");
      expect(latest!.idempotencyMarker).toBe(marker);
      expect(latest!.externalRefs.commentId).toBe("mock-comment-1");
      expect(latest!.externalRefs.stateTransitionId).toBeNull();
      expect(latest!.reconcile.status).toBe("success");
      expect(latest!.reconcile.warning).toBeNull();

      // Replaying `intent apply --external-apply` against a now-applied
      // intent refuses with intent_already_terminal and never opens a
      // new commentCreate against the mock.
      const replay = await runCliBinaryAsync(
        [
          "intent",
          "apply",
          intentId,
          "--reason",
          "smoke replay attempt",
          "--external-apply",
          "--repo",
          repo,
          "--data-dir",
          dataDir,
          "--json",
        ],
        {
          env: {
            LINEAR_API_KEY: "lin_api_smoke_fixture_key",
            MOMENTUM_LINEAR_EXTERNAL_UPDATE_ENDPOINT: mock.endpoint,
            MOMENTUM_LINEAR_REFRESH_ENDPOINT: mock.endpoint,
          },
        },
      );
      expect(replay.code).toBe(1);
      expect(replay.stdout).toBe("");
      const replayPayload = JSON.parse(replay.stderr) as {
        ok: boolean;
        code: string;
        currentStatus: string;
      };
      expect(replayPayload).toMatchObject({
        ok: false,
        code: "intent_already_terminal",
        currentStatus: "applied",
      });
      expect(mock.commentsCreated).toHaveLength(1);
    } finally {
      await mock.close();
    }
  }, 180_000);

  it("refuses with policy_denied when MOMENTUM.md does not opt into external apply and leaves the intent pending", async () => {
    const fixture = await establishM6ExternalApplyFixture({
      momentumPolicy: "create_intents_only",
    });
    const { repo, dataDir, intentId, mock } = fixture;
    try {
      const reconcileCallsBefore =
        mock.requestCounts["MomentumLinearIssues"] ?? 0;
      const externalApply = await runCliBinaryAsync(
        [
          "intent",
          "apply",
          intentId,
          "--reason",
          "smoke policy denied refusal",
          "--external-apply",
          "--repo",
          repo,
          "--data-dir",
          dataDir,
          "--json",
        ],
        {
          env: {
            LINEAR_API_KEY: "lin_api_smoke_fixture_key",
            MOMENTUM_LINEAR_EXTERNAL_UPDATE_ENDPOINT: mock.endpoint,
            MOMENTUM_LINEAR_REFRESH_ENDPOINT: mock.endpoint,
          },
        },
      );
      expect(externalApply.code).toBe(1);
      expect(externalApply.stdout).toBe("");
      const refusal = JSON.parse(externalApply.stderr) as {
        ok: boolean;
        command: string;
        code: string;
        intentId: string;
        applyPolicy: {
          effective: string;
          source: string;
          externalApplyRequested: boolean;
          externalApplyPerformed: boolean;
        };
      };
      expect(refusal).toMatchObject({
        ok: false,
        command: "intent apply",
        code: "policy_denied",
        intentId,
      });
      expect(refusal.applyPolicy).toMatchObject({
        effective: "create_intents_only",
        source: "momentum_policy",
        externalApplyRequested: true,
        externalApplyPerformed: false,
      });

      // No external write or post-apply refresh touches the mock.
      expect(mock.commentsCreated).toHaveLength(0);
      expect(mock.issueUpdates).toHaveLength(0);
      expect(
        mock.requestCounts["MomentumExternalUpdateCommentCreate"] ?? 0,
      ).toBe(0);
      expect(
        mock.requestCounts["MomentumExternalUpdateIssueStateUpdate"] ?? 0,
      ).toBe(0);
      expect(mock.requestCounts["MomentumExternalUpdateIssueLookup"] ?? 0).toBe(
        0,
      );
      expect(mock.requestCounts["MomentumIssueRefresh"] ?? 0).toBe(0);
      // Source reconcile counts are unchanged by the refused apply.
      expect(mock.requestCounts["MomentumLinearIssues"] ?? 0).toBe(
        reconcileCallsBefore,
      );

      const stillPending = runCliBinary([
        "intent",
        "get",
        intentId,
        "--data-dir",
        dataDir,
        "--json",
      ]);
      expect(stillPending.code).toBe(0);
      const stillPendingPayload = JSON.parse(stillPending.stdout) as {
        intent: { status: string };
        externalApply: {
          applyState: string;
          totalAttempts: number;
          latestAttempt: unknown;
        };
      };
      expect(stillPendingPayload.intent.status).toBe("pending");
      expect(stillPendingPayload.externalApply.applyState).toBe("idle");
      expect(stillPendingPayload.externalApply.totalAttempts).toBe(0);
      expect(stillPendingPayload.externalApply.latestAttempt).toBeNull();
    } finally {
      await fixture.close();
    }
  }, 180_000);

  it("refuses with auth_unavailable when LINEAR_API_KEY is missing and leaves the intent pending", async () => {
    const fixture = await establishM6ExternalApplyFixture({
      momentumPolicy: "external_apply_allowed",
    });
    const { repo, dataDir, intentId, mock } = fixture;
    try {
      const reconcileCallsBefore =
        mock.requestCounts["MomentumLinearIssues"] ?? 0;
      const externalApply = await runCliBinaryAsync(
        [
          "intent",
          "apply",
          intentId,
          "--reason",
          "smoke auth unavailable refusal",
          "--external-apply",
          "--repo",
          repo,
          "--data-dir",
          dataDir,
          "--json",
        ],
        {
          env: {
            LINEAR_API_KEY: "",
            MOMENTUM_LINEAR_EXTERNAL_UPDATE_ENDPOINT: mock.endpoint,
            MOMENTUM_LINEAR_REFRESH_ENDPOINT: mock.endpoint,
          },
        },
      );
      expect(externalApply.code).toBe(1);
      expect(externalApply.stdout).toBe("");
      const refusal = JSON.parse(externalApply.stderr) as {
        ok: boolean;
        command: string;
        code: string;
        intentId: string;
        message: string;
        applyPolicy: {
          effective: string;
          source: string;
          externalApplyRequested: boolean;
          externalApplyPerformed: boolean;
        };
      };
      expect(refusal).toMatchObject({
        ok: false,
        command: "intent apply",
        code: "auth_unavailable",
        intentId,
      });
      expect(refusal.message).toContain("LINEAR_API_KEY");
      expect(refusal.applyPolicy).toMatchObject({
        effective: "external_apply_allowed",
        source: "momentum_policy",
        externalApplyRequested: true,
        externalApplyPerformed: false,
      });

      // Policy resolved but auth failed before any adapter call.
      expect(mock.commentsCreated).toHaveLength(0);
      expect(mock.issueUpdates).toHaveLength(0);
      expect(
        mock.requestCounts["MomentumExternalUpdateCommentCreate"] ?? 0,
      ).toBe(0);
      expect(
        mock.requestCounts["MomentumExternalUpdateIssueStateUpdate"] ?? 0,
      ).toBe(0);
      expect(mock.requestCounts["MomentumExternalUpdateIssueLookup"] ?? 0).toBe(
        0,
      );
      expect(mock.requestCounts["MomentumIssueRefresh"] ?? 0).toBe(0);
      expect(mock.requestCounts["MomentumLinearIssues"] ?? 0).toBe(
        reconcileCallsBefore,
      );

      const stillPending = runCliBinary([
        "intent",
        "get",
        intentId,
        "--data-dir",
        dataDir,
        "--json",
      ]);
      expect(stillPending.code).toBe(0);
      const stillPendingPayload = JSON.parse(stillPending.stdout) as {
        intent: { status: string };
        externalApply: {
          applyState: string;
          totalAttempts: number;
          latestAttempt: unknown;
        };
      };
      expect(stillPendingPayload.intent.status).toBe("pending");
      expect(stillPendingPayload.externalApply.applyState).toBe("idle");
      expect(stillPendingPayload.externalApply.totalAttempts).toBe(0);
      expect(stillPendingPayload.externalApply.latestAttempt).toBeNull();
    } finally {
      await fixture.close();
    }
  }, 180_000);

  it("refuses with write_rejected when the external write fails, finalizes the audit as failed, and leaves the intent pending for retry", async () => {
    const fixture = await establishM6ExternalApplyFixture({
      momentumPolicy: "external_apply_allowed",
    });
    const { repo, dataDir, intentId, mock } = fixture;
    try {
      const reconcileCallsBefore =
        mock.requestCounts["MomentumLinearIssues"] ?? 0;
      mock.setCommentCreateBehavior({
        kind: "graphql_error",
        message: "smoke mock injected commentCreate failure",
      });

      const externalApply = await runCliBinaryAsync(
        [
          "intent",
          "apply",
          intentId,
          "--reason",
          "smoke adapter failure",
          "--external-apply",
          "--repo",
          repo,
          "--data-dir",
          dataDir,
          "--json",
        ],
        {
          env: {
            LINEAR_API_KEY: "lin_api_smoke_fixture_key",
            MOMENTUM_LINEAR_EXTERNAL_UPDATE_ENDPOINT: mock.endpoint,
            MOMENTUM_LINEAR_REFRESH_ENDPOINT: mock.endpoint,
          },
        },
      );
      expect(externalApply.code).toBe(1);
      expect(externalApply.stdout).toBe("");
      const refusal = JSON.parse(externalApply.stderr) as {
        ok: boolean;
        command: string;
        code: string;
        intentId: string;
        message: string;
        applyPolicy: {
          effective: string;
          source: string;
          externalApplyRequested: boolean;
          externalApplyPerformed: boolean;
        };
        externalApply: {
          adapterKind: string;
          allowStatusMutation: boolean;
          mutationKind: string | null;
          auditId: string | null;
          external: unknown;
          reconcile: { status: string | null; warning: string | null };
        };
      };
      expect(refusal).toMatchObject({
        ok: false,
        command: "intent apply",
        code: "write_rejected",
        intentId,
      });
      expect(refusal.message).toContain(
        "smoke mock injected commentCreate failure",
      );
      expect(refusal.applyPolicy).toMatchObject({
        effective: "external_apply_allowed",
        source: "momentum_policy",
        externalApplyRequested: true,
        externalApplyPerformed: false,
      });
      expect(refusal.externalApply.adapterKind).toBe("linear");
      expect(refusal.externalApply.mutationKind).toBe("comment");
      expect(refusal.externalApply.allowStatusMutation).toBe(false);
      expect(typeof refusal.externalApply.auditId).toBe("string");
      // No comment was successfully created by the mock — but the mutation
      // attempt itself must have reached the mock, proving the adapter
      // actually performed an external request before being rejected.
      expect(mock.commentsCreated).toHaveLength(0);
      expect(mock.issueUpdates).toHaveLength(0);
      expect(
        mock.requestCounts["MomentumExternalUpdateCommentCreate"] ?? 0,
      ).toBe(1);
      expect(
        mock.requestCounts["MomentumExternalUpdateIssueLookup"] ?? 0,
      ).toBeGreaterThanOrEqual(1);
      // No post-apply refresh because the apply failed before it.
      expect(mock.requestCounts["MomentumIssueRefresh"] ?? 0).toBe(0);
      // Source reconcile counts are unchanged by the refused apply.
      expect(mock.requestCounts["MomentumLinearIssues"] ?? 0).toBe(
        reconcileCallsBefore,
      );

      const intentGet = runCliBinary([
        "intent",
        "get",
        intentId,
        "--data-dir",
        dataDir,
        "--json",
      ]);
      expect(intentGet.code).toBe(0);
      const intentGetPayload = JSON.parse(intentGet.stdout) as {
        intent: { status: string };
        externalApply: {
          applyState: string;
          totalAttempts: number;
          counts: {
            claimed: number;
            succeeded: number;
            failed: number;
            blocked: number;
            audit_incomplete: number;
          };
          latestAttempt: {
            lifecycleState: string;
            resultStatus: string;
            resultCode: string;
            externalRefs: {
              commentId: string | null;
              commentUrl: string | null;
              stateTransitionId: string | null;
            };
          } | null;
        };
      };
      // Intent itself remains pending — only the audit attempt is marked
      // failed, leaving the intent eligible for a later retry against a
      // recovered Linear endpoint.
      expect(intentGetPayload.intent.status).toBe("pending");
      expect(intentGetPayload.externalApply.applyState).toBe("idle");
      expect(intentGetPayload.externalApply.totalAttempts).toBe(1);
      expect(intentGetPayload.externalApply.counts).toMatchObject({
        claimed: 0,
        succeeded: 0,
        failed: 1,
        blocked: 0,
        audit_incomplete: 0,
      });
      const latest = intentGetPayload.externalApply.latestAttempt;
      expect(latest).not.toBeNull();
      expect(latest!.lifecycleState).toBe("failed");
      expect(latest!.resultStatus).toBe("failed");
      expect(latest!.resultCode).toBe("write_rejected");
      expect(latest!.externalRefs.commentId).toBeNull();
      expect(latest!.externalRefs.stateTransitionId).toBeNull();
    } finally {
      await fixture.close();
    }
  }, 180_000);

  it("still marks the intent applied when post-apply refresh fails, with reconcile.status=refresh_failed and a warning recorded on the audit", async () => {
    const fixture = await establishM6ExternalApplyFixture({
      momentumPolicy: "external_apply_allowed",
    });
    const { repo, dataDir, intentId, mock } = fixture;
    try {
      const reconcileCallsBefore =
        mock.requestCounts["MomentumLinearIssues"] ?? 0;
      mock.setIssueRefreshBehavior({
        kind: "graphql_error",
        message: "smoke mock injected IssueRefresh failure",
      });

      const externalApply = await runCliBinaryAsync(
        [
          "intent",
          "apply",
          intentId,
          "--reason",
          "smoke reconcile refresh failed",
          "--external-apply",
          "--repo",
          repo,
          "--data-dir",
          dataDir,
          "--json",
        ],
        {
          env: {
            LINEAR_API_KEY: "lin_api_smoke_fixture_key",
            MOMENTUM_LINEAR_EXTERNAL_UPDATE_ENDPOINT: mock.endpoint,
            MOMENTUM_LINEAR_REFRESH_ENDPOINT: mock.endpoint,
          },
        },
      );
      expect(
        externalApply.code,
        `external apply stderr: ${externalApply.stderr}`,
      ).toBe(0);
      const payload = JSON.parse(externalApply.stdout) as {
        ok: boolean;
        intent: { id: string; status: string };
        applyPolicy: {
          effective: string;
          source: string;
          externalApplyRequested: boolean;
          externalApplyPerformed: boolean;
        };
        externalApply: {
          adapterKind: string;
          allowStatusMutation: boolean;
          mutationKind: string;
          auditId: string | null;
          external: {
            alreadyApplied: boolean;
            commentId: string;
            commentUrl: string;
            idempotencyMarker: string;
            statusTransitioned: boolean;
          };
          reconcile: { status: string; warning: string | null };
        };
      };
      expect(payload.ok).toBe(true);
      expect(payload.intent.status).toBe("applied");
      expect(payload.applyPolicy).toMatchObject({
        effective: "external_apply_allowed",
        source: "momentum_policy",
        externalApplyRequested: true,
        externalApplyPerformed: true,
      });
      // The external write itself succeeded — the audit captures a real
      // comment id even though the post-apply refresh failed.
      expect(payload.externalApply.adapterKind).toBe("linear");
      expect(payload.externalApply.mutationKind).toBe("comment");
      expect(payload.externalApply.external.alreadyApplied).toBe(false);
      expect(payload.externalApply.external.statusTransitioned).toBe(false);
      expect(payload.externalApply.external.commentId).toBe("mock-comment-1");
      const marker = payload.externalApply.external.idempotencyMarker;
      expect(marker).toMatch(
        new RegExp(`^momentum-intent:linear:${intentId}:[0-9a-f]{16}$`),
      );

      // Reconcile reports the failure code and a warning describing the
      // refresh error, but does NOT revert the apply.
      expect(payload.externalApply.reconcile.status).toBe("refresh_failed");
      expect(payload.externalApply.reconcile.warning).not.toBeNull();
      expect(payload.externalApply.reconcile.warning ?? "").toContain(
        "smoke mock injected IssueRefresh failure",
      );

      // Mock saw exactly one commentCreate and at least one IssueRefresh
      // attempt (the injected failure). Source reconcile traffic unchanged.
      expect(mock.commentsCreated).toHaveLength(1);
      expect(mock.commentsCreated[0]!.body).toContain(`idempotency: ${marker}`);
      expect(mock.issueUpdates).toHaveLength(0);
      expect(mock.requestCounts["MomentumExternalUpdateCommentCreate"]).toBe(1);
      expect(
        mock.requestCounts["MomentumExternalUpdateIssueStateUpdate"] ?? 0,
      ).toBe(0);
      expect(
        mock.requestCounts["MomentumIssueRefresh"] ?? 0,
      ).toBeGreaterThanOrEqual(1);
      expect(mock.requestCounts["MomentumLinearIssues"] ?? 0).toBe(
        reconcileCallsBefore,
      );

      // `intent get` rollup carries the same reconcile warning forward on
      // the latest audit attempt while still showing the audit as succeeded.
      const intentGet = runCliBinary([
        "intent",
        "get",
        intentId,
        "--data-dir",
        dataDir,
        "--json",
      ]);
      expect(intentGet.code).toBe(0);
      const intentGetPayload = JSON.parse(intentGet.stdout) as {
        intent: { status: string };
        externalApply: {
          applyState: string;
          totalAttempts: number;
          counts: {
            claimed: number;
            succeeded: number;
            failed: number;
            blocked: number;
            audit_incomplete: number;
          };
          latestAttempt: {
            lifecycleState: string;
            resultStatus: string;
            resultCode: string;
            idempotencyMarker: string;
            externalRefs: {
              commentId: string;
              commentUrl: string;
              stateTransitionId: string | null;
            };
            reconcile: { status: string; warning: string | null };
          } | null;
        };
      };
      expect(intentGetPayload.intent.status).toBe("applied");
      expect(intentGetPayload.externalApply.applyState).toBe("idle");
      expect(intentGetPayload.externalApply.totalAttempts).toBe(1);
      expect(intentGetPayload.externalApply.counts).toMatchObject({
        claimed: 0,
        succeeded: 1,
        failed: 0,
        blocked: 0,
        audit_incomplete: 0,
      });
      const latest = intentGetPayload.externalApply.latestAttempt;
      expect(latest).not.toBeNull();
      expect(latest!.lifecycleState).toBe("succeeded");
      expect(latest!.resultStatus).toBe("succeeded");
      expect(latest!.resultCode).toBe("applied");
      expect(latest!.idempotencyMarker).toBe(marker);
      expect(latest!.externalRefs.commentId).toBe("mock-comment-1");
      expect(latest!.externalRefs.stateTransitionId).toBeNull();
      expect(latest!.reconcile.status).toBe("refresh_failed");
      expect(latest!.reconcile.warning ?? "").toContain(
        "smoke mock injected IssueRefresh failure",
      );
    } finally {
      await fixture.close();
    }
  }, 180_000);

  it("rejects a concurrent intent apply --external-apply with intent_apply_in_progress and performs only one external mutation", async () => {
    const fixture = await establishM6ExternalApplyFixture({
      momentumPolicy: "external_apply_allowed",
    });
    const { repo, dataDir, intentId, mock } = fixture;
    try {
      const reconcileCallsBefore =
        mock.requestCounts["MomentumLinearIssues"] ?? 0;
      // Hold the mock's commentCreate response so the first CLI is still
      // in flight (apply_state='in_flight') when the second CLI attempts
      // to claim the same intent.
      mock.setCommentCreateDelayMs(2000);

      const baseArgs = [
        "intent",
        "apply",
        intentId,
        "--external-apply",
        "--repo",
        repo,
        "--data-dir",
        dataDir,
        "--json",
      ];
      const env = {
        LINEAR_API_KEY: "lin_api_smoke_fixture_key",
        MOMENTUM_LINEAR_EXTERNAL_UPDATE_ENDPOINT: mock.endpoint,
        MOMENTUM_LINEAR_REFRESH_ENDPOINT: mock.endpoint,
      };

      const firstPromise = runCliBinaryAsync(
        [...baseArgs, "--reason", "smoke concurrent A"],
        { env },
      );
      // Give the first CLI enough headroom to finish its claim
      // transaction (idle -> in_flight) before the second CLI's claim
      // attempt collides on the same intent row. The external write
      // itself is still pending against the delayed mock.
      await new Promise((resolve) => setTimeout(resolve, 750));
      const secondPromise = runCliBinaryAsync(
        [...baseArgs, "--reason", "smoke concurrent B"],
        { env },
      );

      const [first, second] = await Promise.all([firstPromise, secondPromise]);

      const results = [first, second];
      const successResult = results.find((r) => r.code === 0);
      const blockedResult = results.find((r) => r.code !== 0);
      expect(
        successResult,
        `expected one CLI to succeed but got codes a=${first.code} b=${second.code}`,
      ).toBeDefined();
      expect(
        blockedResult,
        `expected one CLI to fail with intent_apply_in_progress but got codes a=${first.code} b=${second.code}`,
      ).toBeDefined();

      const successPayload = JSON.parse(successResult!.stdout) as {
        ok: boolean;
        intent: { id: string; status: string };
        applyPolicy: {
          effective: string;
          source: string;
          externalApplyRequested: boolean;
          externalApplyPerformed: boolean;
        };
        externalApply: {
          adapterKind: string;
          mutationKind: string;
          external: {
            alreadyApplied: boolean;
            commentId: string;
            idempotencyMarker: string;
            statusTransitioned: boolean;
          };
          reconcile: { status: string; warning: string | null };
        };
      };
      expect(successPayload.ok).toBe(true);
      expect(successPayload.intent.id).toBe(intentId);
      expect(successPayload.intent.status).toBe("applied");
      expect(successPayload.applyPolicy).toMatchObject({
        effective: "external_apply_allowed",
        source: "momentum_policy",
        externalApplyRequested: true,
        externalApplyPerformed: true,
      });
      expect(successPayload.externalApply.adapterKind).toBe("linear");
      expect(successPayload.externalApply.mutationKind).toBe("comment");
      expect(successPayload.externalApply.external.alreadyApplied).toBe(false);
      expect(successPayload.externalApply.external.statusTransitioned).toBe(
        false,
      );
      expect(successPayload.externalApply.external.commentId).toBe(
        "mock-comment-1",
      );
      const marker = successPayload.externalApply.external.idempotencyMarker;
      expect(marker).toMatch(
        new RegExp(`^momentum-intent:linear:${intentId}:[0-9a-f]{16}$`),
      );
      expect(successPayload.externalApply.reconcile.status).toBe("success");

      const blockedPayload = JSON.parse(blockedResult!.stderr) as {
        ok: boolean;
        command: string;
        code: string;
        message: string;
        intentId: string;
        applyPolicy?: { effective: string; source: string };
        externalApply?: {
          adapterKind: string;
          mutationKind: string | null;
          allowStatusMutation: boolean;
          auditId: string | null;
        };
      };
      expect(blockedPayload.ok).toBe(false);
      expect(blockedPayload.command).toBe("intent apply");
      expect(blockedPayload.code).toBe("intent_apply_in_progress");
      expect(blockedPayload.intentId).toBe(intentId);
      // The refused claim must not have called the external adapter; the
      // failure envelope still reports the resolved policy so operators see
      // why the second invocation was refused.
      expect(blockedPayload.applyPolicy).toMatchObject({
        effective: "external_apply_allowed",
        source: "momentum_policy",
      });

      // Mock observed exactly one commentCreate request and zero status
      // mutations. The second CLI never reached the external write path.
      expect(mock.commentsCreated).toHaveLength(1);
      expect(mock.commentsCreated[0]!.body).toContain(`idempotency: ${marker}`);
      expect(mock.issueUpdates).toHaveLength(0);
      expect(mock.requestCounts["MomentumExternalUpdateCommentCreate"]).toBe(1);
      expect(
        mock.requestCounts["MomentumExternalUpdateIssueStateUpdate"] ?? 0,
      ).toBe(0);
      // Post-apply reconciliation ran exactly once for the winning CLI.
      expect(mock.requestCounts["MomentumIssueRefresh"]).toBe(1);
      // Source reconcile traffic from the fixture is unchanged.
      expect(mock.requestCounts["MomentumLinearIssues"] ?? 0).toBe(
        reconcileCallsBefore,
      );

      const intentGet = runCliBinary([
        "intent",
        "get",
        intentId,
        "--data-dir",
        dataDir,
        "--json",
      ]);
      expect(intentGet.code).toBe(0);
      const intentGetPayload = JSON.parse(intentGet.stdout) as {
        intent: { status: string };
        externalApply: {
          applyState: string;
          totalAttempts: number;
          counts: {
            claimed: number;
            succeeded: number;
            failed: number;
            blocked: number;
            audit_incomplete: number;
          };
          latestAttempt: {
            lifecycleState: string;
            resultStatus: string;
            resultCode: string;
            idempotencyMarker: string;
            externalRefs: {
              commentId: string;
              commentUrl: string;
              stateTransitionId: string | null;
            };
            reconcile: { status: string; warning: string | null };
          } | null;
        };
      };
      expect(intentGetPayload.intent.status).toBe("applied");
      expect(intentGetPayload.externalApply.applyState).toBe("idle");
      // Only the winning claimant's audit row exists; the refused CLI was
      // rejected at the CAS guard before any audit row was inserted.
      expect(intentGetPayload.externalApply.totalAttempts).toBe(1);
      expect(intentGetPayload.externalApply.counts).toMatchObject({
        claimed: 0,
        succeeded: 1,
        failed: 0,
        blocked: 0,
        audit_incomplete: 0,
      });
      const latest = intentGetPayload.externalApply.latestAttempt;
      expect(latest).not.toBeNull();
      expect(latest!.lifecycleState).toBe("succeeded");
      expect(latest!.resultStatus).toBe("succeeded");
      expect(latest!.resultCode).toBe("applied");
      expect(latest!.idempotencyMarker).toBe(marker);
      expect(latest!.externalRefs.commentId).toBe("mock-comment-1");
      expect(latest!.externalRefs.stateTransitionId).toBeNull();
      expect(latest!.reconcile.status).toBe("success");
    } finally {
      await fixture.close();
    }
  }, 180_000);

  it("surfaces the external apply audit through intent get, project status, and doctor after a write_rejected attempt leaves the intent pending", async () => {
    const fixture = await establishM6ExternalApplyFixture({
      momentumPolicy: "external_apply_allowed",
    });
    const { repo, dataDir, intentId, mock } = fixture;
    try {
      // Drive a write_rejected attempt so the intent stays pending — that
      // keeps the audit row visible through the pending-intent rollups used
      // by intent get and project status, while doctor surfaces the same
      // audit through its global listIntentApplyAudits view regardless of
      // intent state.
      mock.setCommentCreateBehavior({
        kind: "graphql_error",
        message: "smoke mock injected commentCreate failure",
      });

      const externalApply = await runCliBinaryAsync(
        [
          "intent",
          "apply",
          intentId,
          "--reason",
          "smoke audit visibility",
          "--external-apply",
          "--repo",
          repo,
          "--data-dir",
          dataDir,
          "--json",
        ],
        {
          env: {
            LINEAR_API_KEY: "lin_api_smoke_fixture_key",
            MOMENTUM_LINEAR_EXTERNAL_UPDATE_ENDPOINT: mock.endpoint,
            MOMENTUM_LINEAR_REFRESH_ENDPOINT: mock.endpoint,
          },
        },
      );
      expect(externalApply.code).toBe(1);
      const refusal = JSON.parse(externalApply.stderr) as {
        ok: boolean;
        code: string;
        intentId: string;
        externalApply: { auditId: string | null };
      };
      expect(refusal).toMatchObject({
        ok: false,
        code: "write_rejected",
        intentId,
      });
      const auditId = refusal.externalApply.auditId;
      expect(typeof auditId).toBe("string");

      // intent get --json shows the failed audit on the still-pending
      // intent so operators can inspect the latest attempt for a single
      // intent without a goal-scoped surface.
      const intentGet = runCliBinary([
        "intent",
        "get",
        intentId,
        "--data-dir",
        dataDir,
        "--json",
      ]);
      expect(intentGet.code, `intent get stderr: ${intentGet.stderr}`).toBe(0);
      const intentGetPayload = JSON.parse(intentGet.stdout) as {
        intent: { id: string; status: string };
        externalApply: {
          applyState: string;
          totalAttempts: number;
          counts: { failed: number; succeeded: number };
          latestAttempt: {
            id: string;
            lifecycleState: string;
            resultStatus: string;
            resultCode: string;
          } | null;
        };
      };
      expect(intentGetPayload.intent.id).toBe(intentId);
      expect(intentGetPayload.intent.status).toBe("pending");
      expect(intentGetPayload.externalApply.applyState).toBe("idle");
      expect(intentGetPayload.externalApply.totalAttempts).toBe(1);
      expect(intentGetPayload.externalApply.counts.failed).toBe(1);
      expect(intentGetPayload.externalApply.counts.succeeded).toBe(0);
      expect(intentGetPayload.externalApply.latestAttempt).not.toBeNull();
      expect(intentGetPayload.externalApply.latestAttempt!.id).toBe(auditId);
      expect(intentGetPayload.externalApply.latestAttempt!.lifecycleState).toBe(
        "failed",
      );
      expect(intentGetPayload.externalApply.latestAttempt!.resultStatus).toBe(
        "failed",
      );
      expect(intentGetPayload.externalApply.latestAttempt!.resultCode).toBe(
        "write_rejected",
      );

      // project status --json exposes the same audit via its pending-intent
      // rollup; this is the operator surface for cross-goal external apply
      // visibility.
      const projectStatus = runCliBinary([
        "project",
        "status",
        "--data-dir",
        dataDir,
        "--json",
      ]);
      expect(
        projectStatus.code,
        `project status stderr: ${projectStatus.stderr}`,
      ).toBe(0);
      const projectPayload = JSON.parse(projectStatus.stdout) as {
        externalApply: {
          pendingIntentApplyStateCounts: {
            idle: number;
            in_flight: number;
            blocked: number;
          };
          pendingAuditCounts: { failed: number; succeeded: number };
          totalAttempts: number;
          latestAttempt: {
            intentId: string;
            id: string;
            lifecycleState: string;
            resultCode: string;
          } | null;
        };
        pendingUpdateIntents: Array<{
          intentId: string;
          externalApply: {
            applyState: string;
            totalAttempts: number;
            latestAttempt: { id: string; lifecycleState: string } | null;
          };
        }>;
      };
      expect(projectPayload.pendingUpdateIntents).toHaveLength(1);
      const projectIntent = projectPayload.pendingUpdateIntents[0]!;
      expect(projectIntent.intentId).toBe(intentId);
      expect(projectIntent.externalApply.applyState).toBe("idle");
      expect(projectIntent.externalApply.totalAttempts).toBe(1);
      expect(projectIntent.externalApply.latestAttempt).not.toBeNull();
      expect(projectIntent.externalApply.latestAttempt!.id).toBe(auditId);
      expect(projectIntent.externalApply.latestAttempt!.lifecycleState).toBe(
        "failed",
      );
      expect(projectPayload.externalApply.totalAttempts).toBe(1);
      expect(projectPayload.externalApply.pendingAuditCounts.failed).toBe(1);
      expect(projectPayload.externalApply.pendingAuditCounts.succeeded).toBe(0);
      expect(
        projectPayload.externalApply.pendingIntentApplyStateCounts,
      ).toMatchObject({
        idle: 1,
        in_flight: 0,
        blocked: 0,
      });
      expect(projectPayload.externalApply.latestAttempt).not.toBeNull();
      expect(projectPayload.externalApply.latestAttempt!.intentId).toBe(
        intentId,
      );
      expect(projectPayload.externalApply.latestAttempt!.id).toBe(auditId);
      expect(projectPayload.externalApply.latestAttempt!.lifecycleState).toBe(
        "failed",
      );
      expect(projectPayload.externalApply.latestAttempt!.resultCode).toBe(
        "write_rejected",
      );

      // doctor --json reads from the global audit ledger, so its
      // externalApply.latestAttempt remains visible even once the intent
      // transitions to applied. Here it confirms the same failed audit.
      const doctor = runCliBinary(["doctor", "--data-dir", dataDir, "--json"]);
      expect(doctor.code, `doctor stderr: ${doctor.stderr}`).toBe(0);
      const doctorPayload = JSON.parse(doctor.stdout) as {
        externalApply: {
          ok: boolean;
          intentApplyStateCounts: {
            idle: number;
            in_flight: number;
            blocked: number;
          };
          auditCounts: { failed: number; succeeded: number };
          totalAttempts: number;
          latestAttempt: {
            intentId: string;
            id: string;
            lifecycleState: string;
            resultStatus: string;
            resultCode: string;
          } | null;
        };
      };
      expect(doctorPayload.externalApply.ok).toBe(true);
      expect(doctorPayload.externalApply.intentApplyStateCounts).toMatchObject({
        idle: 1,
        in_flight: 0,
        blocked: 0,
      });
      expect(doctorPayload.externalApply.auditCounts.failed).toBe(1);
      expect(doctorPayload.externalApply.auditCounts.succeeded).toBe(0);
      expect(doctorPayload.externalApply.totalAttempts).toBe(1);
      expect(doctorPayload.externalApply.latestAttempt).not.toBeNull();
      expect(doctorPayload.externalApply.latestAttempt!.intentId).toBe(
        intentId,
      );
      expect(doctorPayload.externalApply.latestAttempt!.id).toBe(auditId);
      expect(doctorPayload.externalApply.latestAttempt!.lifecycleState).toBe(
        "failed",
      );
      expect(doctorPayload.externalApply.latestAttempt!.resultStatus).toBe(
        "failed",
      );
      expect(doctorPayload.externalApply.latestAttempt!.resultCode).toBe(
        "write_rejected",
      );
    } finally {
      await fixture.close();
    }
  }, 180_000);

  it("blocks the intent and marks the audit incomplete when audit finalize fails after a successful external write, then refuses retries with intent_blocked without a second external mutation", async () => {
    const fixture = await establishM6ExternalApplyFixture({
      momentumPolicy: "external_apply_allowed",
    });
    const { repo, dataDir, intentId, mock } = fixture;
    try {
      const reconcileCallsBefore =
        mock.requestCounts["MomentumLinearIssues"] ?? 0;
      // Hold the mock's commentCreate response so the CLI is parked
      // mid-apply (audit row in 'claimed', external write in flight)
      // long enough for the test to tamper with the audit row and
      // force audit_already_finalized on the post-write finalize.
      mock.setCommentCreateDelayMs(2500);

      const baseArgs = [
        "intent",
        "apply",
        intentId,
        "--external-apply",
        "--reason",
        "smoke audit finalize failure",
        "--repo",
        repo,
        "--data-dir",
        dataDir,
        "--json",
      ];
      const env = {
        LINEAR_API_KEY: "lin_api_smoke_fixture_key",
        MOMENTUM_LINEAR_EXTERNAL_UPDATE_ENDPOINT: mock.endpoint,
        MOMENTUM_LINEAR_REFRESH_ENDPOINT: mock.endpoint,
      };

      const cliPromise = runCliBinaryAsync(baseArgs, { env });

      // Poll the audit ledger for the in-flight claim, then flip its
      // lifecycle_state out from under the CLI so finalizeIntentApply
      // returns audit_already_finalized after the external write returns.
      // The CLI is awaiting the delayed commentCreate fetch and not
      // holding the SQLite file lock during this window, so a separate
      // DatabaseSync connection can safely rewrite the row.
      const inspectionDb = new DatabaseSync(path.join(dataDir, "momentum.db"));
      inspectionDb.exec("PRAGMA busy_timeout = 5000");
      let tamperedAuditId: string | null = null;
      try {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const row = inspectionDb
            .prepare(
              `SELECT id FROM intent_apply_audits
                  WHERE intent_id = ? AND lifecycle_state = 'claimed'`,
            )
            .get(intentId) as { id: string } | undefined;
          if (row) {
            tamperedAuditId = row.id;
            inspectionDb
              .prepare(
                `UPDATE intent_apply_audits
                      SET lifecycle_state = 'failed',
                          result_status = 'failed',
                          result_code = 'smoke_tampered_for_finalize_failure'
                    WHERE id = ?`,
              )
              .run(tamperedAuditId);
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      } finally {
        inspectionDb.close();
      }
      expect(
        tamperedAuditId,
        "expected an in-flight 'claimed' audit row to appear before the CLI completed",
      ).not.toBeNull();

      const result = await cliPromise;
      expect(result.code, `cli stderr: ${result.stderr}`).toBe(1);
      const refusal = JSON.parse(result.stderr) as {
        ok: boolean;
        command: string;
        code: string;
        intentId: string;
        applyPolicy: {
          effective: string;
          source: string;
          externalApplyRequested: boolean;
          externalApplyPerformed: boolean;
        };
        externalApply: {
          adapterKind: string;
          mutationKind: string | null;
          allowStatusMutation: boolean;
          auditId: string | null;
          reconcile: { status: string | null; warning: string | null };
          external: {
            alreadyApplied: boolean;
            commentId: string | null;
            commentUrl: string | null;
            statusTransitioned: boolean;
            idempotencyMarker: string | null;
          } | null;
        };
      };
      expect(refusal.ok).toBe(false);
      expect(refusal.command).toBe("intent apply");
      expect(refusal.code).toBe("audit_incomplete");
      expect(refusal.intentId).toBe(intentId);
      // The external write reached the tracker before audit finalize
      // failed, so the policy summary reports externalApplyPerformed=true
      // even though the intent was never marked applied.
      expect(refusal.applyPolicy).toMatchObject({
        effective: "external_apply_allowed",
        source: "momentum_policy",
        externalApplyRequested: true,
        externalApplyPerformed: true,
      });
      expect(refusal.externalApply.adapterKind).toBe("linear");
      expect(refusal.externalApply.mutationKind).toBe("comment");
      expect(refusal.externalApply.allowStatusMutation).toBe(false);
      expect(refusal.externalApply.auditId).toBe(tamperedAuditId);
      expect(refusal.externalApply.reconcile).toEqual({
        status: "deferred",
        warning: "external write applied; audit finalize failed",
      });
      expect(refusal.externalApply.external).not.toBeNull();
      expect(refusal.externalApply.external!.alreadyApplied).toBe(false);
      expect(refusal.externalApply.external!.statusTransitioned).toBe(false);
      expect(refusal.externalApply.external!.commentId).toBe("mock-comment-1");
      const marker = refusal.externalApply.external!.idempotencyMarker;
      expect(typeof marker).toBe("string");
      expect(marker).toMatch(
        new RegExp(`^momentum-intent:linear:${intentId}:[0-9a-f]{16}$`),
      );

      // Exactly one external write made it through before audit finalize
      // failed; the post-apply reconcile path is skipped on the
      // audit_incomplete branch so no IssueRefresh was issued.
      expect(mock.commentsCreated).toHaveLength(1);
      expect(mock.commentsCreated[0]!.body).toContain(`idempotency: ${marker}`);
      expect(mock.issueUpdates).toHaveLength(0);
      expect(mock.requestCounts["MomentumExternalUpdateCommentCreate"]).toBe(1);
      expect(
        mock.requestCounts["MomentumExternalUpdateIssueStateUpdate"] ?? 0,
      ).toBe(0);
      expect(mock.requestCounts["MomentumIssueRefresh"] ?? 0).toBe(0);

      const intentGet = runCliBinary([
        "intent",
        "get",
        intentId,
        "--data-dir",
        dataDir,
        "--json",
      ]);
      expect(intentGet.code, `intent get stderr: ${intentGet.stderr}`).toBe(0);
      const intentGetPayload = JSON.parse(intentGet.stdout) as {
        intent: { status: string };
        externalApply: {
          applyState: string;
          totalAttempts: number;
          counts: {
            claimed: number;
            succeeded: number;
            failed: number;
            blocked: number;
            audit_incomplete: number;
          };
          latestAttempt: {
            id: string;
            lifecycleState: string;
            resultStatus: string;
            resultCode: string;
            externalRefs: {
              commentId: string | null;
              commentUrl: string | null;
              stateTransitionId: string | null;
            };
            reconcile: { status: string | null; warning: string | null };
          } | null;
        };
      };
      // Intent stays pending — markUpdateIntentApplied was never reached.
      expect(intentGetPayload.intent.status).toBe("pending");
      // ...but the CAS column is blocked so any retry must be refused
      // at the claim guard before the external write path runs again.
      expect(intentGetPayload.externalApply.applyState).toBe("blocked");
      expect(intentGetPayload.externalApply.totalAttempts).toBe(1);
      expect(intentGetPayload.externalApply.counts).toMatchObject({
        claimed: 0,
        succeeded: 0,
        failed: 0,
        blocked: 0,
        audit_incomplete: 1,
      });
      const latest = intentGetPayload.externalApply.latestAttempt;
      expect(latest).not.toBeNull();
      expect(latest!.id).toBe(tamperedAuditId);
      expect(latest!.lifecycleState).toBe("audit_incomplete");
      expect(latest!.resultStatus).toBe("audit_incomplete");
      expect(latest!.resultCode).toBe("audit_finalize_failed");
      // External write evidence is preserved on the audit row even after
      // the forced audit_incomplete transition, so operators can correlate
      // the surviving comment with the blocked intent.
      expect(latest!.externalRefs.commentId).toBe("mock-comment-1");
      expect(latest!.externalRefs.stateTransitionId).toBeNull();
      expect(latest!.reconcile).toEqual({
        status: "deferred",
        warning: "external write applied; audit finalize failed",
      });

      // Retrying the apply must be refused at the CAS guard with
      // intent_blocked and must not produce a second external write.
      mock.setCommentCreateDelayMs(0);
      const retry = await runCliBinaryAsync(baseArgs, { env });
      expect(retry.code, `retry stdout: ${retry.stdout}`).toBe(1);
      const retryRefusal = JSON.parse(retry.stderr) as {
        ok: boolean;
        command: string;
        code: string;
        intentId: string;
        applyPolicy: {
          effective: string;
          source: string;
          externalApplyRequested: boolean;
        };
      };
      expect(retryRefusal.ok).toBe(false);
      expect(retryRefusal.command).toBe("intent apply");
      expect(retryRefusal.code).toBe("intent_blocked");
      expect(retryRefusal.intentId).toBe(intentId);
      expect(retryRefusal.applyPolicy).toMatchObject({
        effective: "external_apply_allowed",
        source: "momentum_policy",
        externalApplyRequested: true,
      });

      // Mock state is unchanged after the retry refusal: no second comment,
      // no status mutation, no follow-up refresh.
      expect(mock.commentsCreated).toHaveLength(1);
      expect(mock.issueUpdates).toHaveLength(0);
      expect(mock.requestCounts["MomentumExternalUpdateCommentCreate"]).toBe(1);
      expect(
        mock.requestCounts["MomentumExternalUpdateIssueStateUpdate"] ?? 0,
      ).toBe(0);
      expect(mock.requestCounts["MomentumIssueRefresh"] ?? 0).toBe(0);
      // Source reconcile traffic from the fixture is unchanged.
      expect(mock.requestCounts["MomentumLinearIssues"] ?? 0).toBe(
        reconcileCallsBefore,
      );
    } finally {
      await fixture.close();
    }
  }, 180_000);
});

type M6ExternalApplyFixture = {
  repo: string;
  dataDir: string;
  sourceItemId: string;
  goalId: string;
  intentId: string;
  mock: LinearExternalApplyMockServer;
  close: () => Promise<void>;
};

async function establishM6ExternalApplyFixture(options: {
  momentumPolicy: "external_apply_allowed" | "create_intents_only";
}): Promise<M6ExternalApplyFixture> {
  const dataDir = makeTempDir("momentum-smoke-m6-failure-data-");
  const repo = initDisposableRepo();
  const momentumLines =
    options.momentumPolicy === "external_apply_allowed"
      ? [
          "---",
          "intent_apply_policy: external_apply_allowed",
          "---",
          "",
          "Smoke MOMENTUM.md for the M6 external apply failure matrix.",
          "",
        ]
      : [
          "---",
          "intent_apply_policy: create_intents_only",
          "---",
          "",
          "Smoke MOMENTUM.md for the M6 external apply failure matrix.",
          "",
        ];
  fs.writeFileSync(
    path.join(repo, "MOMENTUM.md"),
    momentumLines.join("\n"),
    "utf-8",
  );
  runGit(repo, ["add", "MOMENTUM.md"]);
  runGit(repo, ["commit", "-m", "add MOMENTUM.md", "--quiet"]);

  const issue: LinearExternalApplyMockIssue = {
    id: "issue-smoke-ngx-301-failure",
    identifier: "NGX-301",
    title: "M6-06 External apply safety smoke and failure matrix",
    description: "Smoke fixture for the M6 external apply failure matrix.",
    url: "https://linear.app/ngxcalvin/issue/NGX-301",
    updatedAt: "2026-05-21T08:00:00.000Z",
    priority: 0,
    state: { id: "state-in-progress", name: "In Progress" },
    team: { id: "team-ngx" },
    project: {
      id: "project-momentum",
      name: "Momentum",
      url: "https://linear.app/ngxcalvin/project/momentum",
    },
    projectMilestone: {
      id: "milestone-m6",
      name: "Milestone 6: Policy-Gated External Apply",
    },
    labels: { nodes: [] },
    assignee: null,
    comments: [],
  };
  const mock = await startLinearExternalApplyMockServer([issue]);

  const reconcile = await runCliBinaryAsync(
    [
      "source",
      "reconcile",
      "linear",
      "--linear-endpoint",
      mock.endpoint,
      "--data-dir",
      dataDir,
      "--json",
    ],
    { env: { LINEAR_API_KEY: "lin_api_smoke_fixture_key" } },
  );
  if (reconcile.code !== 0) {
    await mock.close();
    throw new Error(`source reconcile linear failed: ${reconcile.stderr}`);
  }

  const sourceList = runCliBinary([
    "source",
    "list",
    "--data-dir",
    dataDir,
    "--json",
  ]);
  const sourceItems = (
    JSON.parse(sourceList.stdout) as { items: Array<{ id: string }> }
  ).items;
  const sourceItemId = sourceItems[0]!.id;

  const goalId = "goal-smoke-m6-failure";
  seedCompletedGoal(dataDir, goalId);

  const fixtureRoot = makeTempDir("momentum-smoke-m6-failure-fixture-");
  const intentRunId = "smoke-m6-failure-run-1";
  const runDir = path.join(fixtureRoot, ".agent-workflows", intentRunId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "plan.json"),
    JSON.stringify(
      {
        runId: intentRunId,
        schemaVersion: 1,
        mode: "execute-ready",
        profile: "momentum-m6-smoke",
        objective: "NGX-301 smoke fixture for failure matrix",
        resolvedScope: {
          issues: ["NGX-301"],
          source: "explicit",
          status: "resolved",
        },
      },
      null,
      2,
    ),
  );
  const ledger = [
    {
      runId: intentRunId,
      step: "implementation",
      status: "complete",
      ts: "2026-05-21T08:20:00Z",
    },
    {
      runId: intentRunId,
      step: "no-mistakes",
      status: "complete",
      ts: "2026-05-21T08:25:00Z",
    },
  ];
  fs.writeFileSync(
    path.join(runDir, "ledger.jsonl"),
    `${ledger.map((line) => JSON.stringify(line)).join("\n")}\n`,
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
    "--json",
  ]);
  if (ingest.code !== 0) {
    await mock.close();
    throw new Error(`evidence ingest failed: ${ingest.stderr}`);
  }

  const link = runCliBinary([
    "source",
    "link",
    sourceItemId,
    "--goal",
    goalId,
    "--data-dir",
    dataDir,
    "--json",
  ]);
  if (link.code !== 0) {
    await mock.close();
    throw new Error(`source link failed: ${link.stderr}`);
  }

  const intentList = runCliBinary([
    "intent",
    "list",
    "--data-dir",
    dataDir,
    "--json",
  ]);
  const intentListPayload = JSON.parse(intentList.stdout) as {
    intents: Array<{ id: string; status: string }>;
  };
  const intentId = intentListPayload.intents[0]!.id;

  return {
    repo,
    dataDir,
    sourceItemId,
    goalId,
    intentId,
    mock,
    close: () => mock.close(),
  };
}
