import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import {
  claimIntentApply,
  finalizeIntentApply,
  getLatestIntentApplyAudit,
  listIntentApplyAudits,
} from "../src/core/intent/apply-audits.js";
import {
  defaultBuildLinearClient,
  defaultBuildLinearRefreshClient,
  executeExternalApply,
  LINEAR_API_KEY_ENV_VAR,
  LINEAR_EXTERNAL_UPDATE_ENDPOINT_ENV_VAR,
  LINEAR_REFRESH_ENDPOINT_ENV_VAR,
} from "../src/core/intent/apply-execute.js";
import type {
  ExecuteExternalApplyDeps,
  ExecuteExternalApplyInput,
} from "../src/core/intent/apply-execute.js";
import {
  buildIdempotencyMarker,
  type ExternalUpdateAdapter,
} from "../src/adapters/external-update-adapter.js";
import type {
  LinearExternalUpdateClient,
  LinearExternalUpdateError,
  LinearExternalUpdateInput,
  LinearExternalUpdateResult,
  LinearExternalUpdateSuccess,
} from "../src/adapters/linear-external-update-client.js";
import type { LinearIssueRefreshClient } from "../src/adapters/linear-issue-refresh.js";
import { getUpdateIntentById } from "../src/core/intent/update-intents.js";

const tempRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-intent-apply-execute-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function makeRepo(policy: string | null): string {
  const repoPath = makeTempDir("momentum-intent-apply-execute-repo-");
  if (policy !== null) {
    fs.writeFileSync(path.join(repoPath, "MOMENTUM.md"), policy);
  }
  return repoPath;
}

function externalApplyAllowedPolicy(): string {
  return ["---", "intent_apply_policy: external_apply_allowed", "---", ""].join(
    "\n",
  );
}

function insertSourceItem(
  db: MomentumDb,
  args: {
    id: string;
    adapterKind: string;
    externalId: string;
    externalKey: string;
    url: string;
    title: string;
  },
): void {
  db.prepare(
    `INSERT INTO source_items
       (id, adapter_kind, external_id, external_key, url, title, status,
        metadata_json, last_observed_at, goal_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, '{}', 1, NULL, 1, 1)`,
  ).run(
    args.id,
    args.adapterKind,
    args.externalId,
    args.externalKey,
    args.url,
    args.title,
  );
}

function insertIntent(
  db: MomentumDb,
  args: {
    id: string;
    adapterKind?: string;
    intentType?: string;
    targetExternalId?: string | null;
    sourceItemId?: string | null;
    payload?: Record<string, unknown>;
    status?: "pending" | "applied" | "skipped" | "canceled";
  },
): void {
  const status = args.status ?? "pending";
  const appliedAt = status === "applied" ? 1 : null;
  const skippedAt = status === "skipped" ? 1 : null;
  const canceledAt = status === "canceled" ? 1 : null;
  const targetExternalId =
    args.targetExternalId === undefined
      ? "linear_issue_id_123"
      : args.targetExternalId;
  db.prepare(
    `INSERT INTO update_intents
       (id, adapter_kind, target_external_id, intent_type, payload_json,
        reason, source_item_id, status, idempotency_key, created_at, updated_at,
        applied_at, skipped_at, canceled_at, decision_reason)
     VALUES (?, ?, ?, ?, ?, 'evidence shows goal complete', ?, ?, ?, 1, 1,
             ?, ?, ?, ?)`,
  ).run(
    args.id,
    args.adapterKind ?? "linear",
    targetExternalId,
    args.intentType ?? "source_satisfied",
    JSON.stringify(args.payload ?? { kind: "comment" }),
    args.sourceItemId ?? null,
    status,
    `idemp:${args.id}`,
    appliedAt,
    skippedAt,
    canceledAt,
    status === "applied" ? "operator manual" : null,
  );
}

function seedHappyPath(db: MomentumDb): {
  intentId: string;
  sourceItemId: string;
  externalId: string;
} {
  const externalId = "linear_issue_id_happy";
  const sourceItemId = "source_item_happy";
  insertSourceItem(db, {
    id: sourceItemId,
    adapterKind: "linear",
    externalId,
    externalKey: "NGX-1001",
    url: "https://linear.app/example/issue/NGX-1001",
    title: "Happy issue",
  });
  const intentId = "intent_happy";
  insertIntent(db, {
    id: intentId,
    targetExternalId: externalId,
    sourceItemId,
  });
  return { intentId, sourceItemId, externalId };
}

type ApplySpy = {
  client: LinearExternalUpdateClient;
  calls: LinearExternalUpdateInput[];
};

function makeApplySpy(
  outcome:
    | LinearExternalUpdateResult
    | ((input: LinearExternalUpdateInput) => LinearExternalUpdateResult),
): ApplySpy {
  const calls: LinearExternalUpdateInput[] = [];
  return {
    calls,
    client: {
      async apply(input) {
        calls.push(input);
        return typeof outcome === "function" ? outcome(input) : outcome;
      },
    },
  };
}

function makeSuccessOutcome(args: {
  alreadyApplied?: boolean;
  statusTransitioned?: boolean;
  issueId?: string;
  issueKey?: string | null;
  commentId?: string;
  commentUrl?: string | null;
  nextStateId?: string | null;
  nextStateName?: string | null;
  idempotencyMarker: string;
}): LinearExternalUpdateSuccess {
  const statusTransitioned = args.statusTransitioned ?? false;
  return {
    ok: true,
    alreadyApplied: args.alreadyApplied ?? false,
    issue: {
      id: args.issueId ?? "linear_issue_id_happy",
      key: args.issueKey ?? "NGX-1001",
      url: "https://linear.app/example/issue/NGX-1001",
    },
    comment: {
      id: args.commentId ?? "comment_1",
      url: args.commentUrl ?? "https://linear.app/example/comment/1",
    },
    status: {
      transitioned: statusTransitioned,
      previousStateId: "state_started",
      previousStateName: "In Progress",
      nextStateId: statusTransitioned
        ? (args.nextStateId ?? "state_done")
        : null,
      nextStateName: statusTransitioned ? (args.nextStateName ?? "Done") : null,
    },
    idempotencyMarker: args.idempotencyMarker,
  };
}

function makeErrorOutcome(
  code: LinearExternalUpdateError["code"],
  message: string,
): LinearExternalUpdateError {
  return { ok: false, code, error: message };
}

function makeRefreshClient(args: {
  marker: string;
  issueId?: string;
  issueKey?: string;
  status?: string;
  comments?: Array<{ id: string; body: string; url: string | null }>;
}): LinearIssueRefreshClient {
  return {
    async refresh() {
      return {
        ok: true,
        issue: {
          id: args.issueId ?? "linear_issue_id_happy",
          identifier: args.issueKey ?? "NGX-1001",
          title: "Happy issue",
          url: "https://linear.app/example/issue/NGX-1001",
          updatedAt: "2026-05-21T00:00:00.000Z",
          state: { id: "state-done", name: args.status ?? "Done" },
        },
        comments: args.comments ?? [
          {
            id: "comment_1",
            body: `Momentum applied ${args.marker}`,
            url: "https://linear.app/example/comment/1",
          },
        ],
      };
    },
  };
}

function makeIssueRefreshPayload(args: {
  id: string;
  identifier: string;
  marker: string;
}): unknown {
  return {
    data: {
      issue: {
        id: args.id,
        identifier: args.identifier,
        title: "Happy issue",
        url: `https://linear.app/example/issue/${args.identifier}`,
        updatedAt: "2026-05-21T00:00:00.000Z",
        state: { id: "state-done", name: "Done" },
        comments: {
          nodes: [
            {
              id: "comment_1",
              body: `Momentum applied ${args.marker}`,
              url: "https://linear.app/example/comment/1",
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  };
}

function expectedIdempotencyMarker(
  intentId: string,
  payload: Record<string, unknown>,
): string {
  return buildIdempotencyMarker({
    adapterKind: "linear",
    intentId,
    payload,
  });
}

function baseInput(
  db: MomentumDb,
  overrides: Partial<ExecuteExternalApplyInput> & { intentId: string },
): ExecuteExternalApplyInput {
  const deps = overrides.deps ?? {};
  return {
    db,
    intentId: overrides.intentId,
    operatorReason: overrides.operatorReason ?? "verified evidence",
    operatorActor: overrides.operatorActor ?? "operator@example.com",
    repoPath: overrides.repoPath ?? null,
    env: overrides.env ?? { [LINEAR_API_KEY_ENV_VAR]: "test-key" },
    statusMutation: overrides.statusMutation ?? null,
    deps: {
      ...deps,
      buildLinearRefreshClient:
        deps.buildLinearRefreshClient ??
        (() =>
          makeRefreshClient({
            marker: expectedIdempotencyMarker(overrides.intentId, {
              kind: "comment",
            }),
          })),
    },
  };
}

describe("executeExternalApply policy & input gates", () => {
  it("refuses with intent_not_found for an unknown intent id", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const result = await executeExternalApply(
        baseInput(db, { intentId: "missing_intent" }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected refusal");
      expect(result.code).toBe("intent_not_found");
      expect(result.audit).toBeNull();
      expect(result.context.intentId).toBe("missing_intent");
    } finally {
      db.close();
    }
  });

  it("refuses with intent_already_terminal for an applied intent (terminal idempotency)", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      insertIntent(db, { id: "intent_done", status: "applied" });
      const spy = makeApplySpy(
        makeErrorOutcome("validation_failed", "should not be called"),
      );
      const result = await executeExternalApply(
        baseInput(db, {
          intentId: "intent_done",
          repoPath: makeRepo(externalApplyAllowedPolicy()),
          deps: { buildLinearClient: () => spy.client },
        }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected refusal");
      expect(result.code).toBe("intent_already_terminal");
      expect(spy.calls).toHaveLength(0);
      expect(
        listIntentApplyAudits(db, { intentId: "intent_done" }),
      ).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("refuses with policy_denied when no repo context is provided", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedHappyPath(db);
      const spy = makeApplySpy(
        makeErrorOutcome("validation_failed", "must not call"),
      );
      const result = await executeExternalApply(
        baseInput(db, {
          intentId: "intent_happy",
          repoPath: null,
          deps: { buildLinearClient: () => spy.client },
        }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected refusal");
      expect(result.code).toBe("policy_denied");
      expect(result.context.applyPolicy.source).toBe("missing_repo");
      expect(spy.calls).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("refuses with policy_denied when the repo policy is create_intents_only", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedHappyPath(db);
      const repoPath = makeRepo(
        ["---", "intent_apply_policy: create_intents_only", "---", ""].join(
          "\n",
        ),
      );
      const spy = makeApplySpy(
        makeErrorOutcome("validation_failed", "must not call"),
      );
      const result = await executeExternalApply(
        baseInput(db, {
          intentId: "intent_happy",
          repoPath,
          deps: { buildLinearClient: () => spy.client },
        }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected refusal");
      expect(result.code).toBe("policy_denied");
      expect(result.context.applyPolicy.value).toBe("create_intents_only");
      expect(result.context.applyPolicy.source).toBe("momentum_policy");
      expect(spy.calls).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("refuses with policy_load_failed when MOMENTUM.md is malformed", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedHappyPath(db);
      const repoPath = makeRepo(
        ["---", "intent_apply_policy: bogus_value", "---", ""].join("\n"),
      );
      const result = await executeExternalApply(
        baseInput(db, { intentId: "intent_happy", repoPath }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected refusal");
      expect(result.code).toBe("policy_load_failed");
    } finally {
      db.close();
    }
  });

  it("refuses with auth_unavailable when LINEAR_API_KEY is missing", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedHappyPath(db);
      const repoPath = makeRepo(externalApplyAllowedPolicy());
      const result = await executeExternalApply(
        baseInput(db, {
          intentId: "intent_happy",
          repoPath,
          env: {},
        }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected refusal");
      expect(result.code).toBe("auth_unavailable");
      expect(
        listIntentApplyAudits(db, { intentId: "intent_happy" }),
      ).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("refuses with unsupported_adapter for an unknown adapter kind", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      insertIntent(db, {
        id: "intent_unknown_adapter",
        adapterKind: "github",
        targetExternalId: "gh_issue_1",
      });
      const repoPath = makeRepo(externalApplyAllowedPolicy());
      const result = await executeExternalApply(
        baseInput(db, { intentId: "intent_unknown_adapter", repoPath }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected refusal");
      expect(result.code).toBe("unsupported_adapter");
    } finally {
      db.close();
    }
  });

  it("refuses with unsupported_intent_type when adapter does not support the intent type", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      insertIntent(db, {
        id: "intent_unknown_type",
        adapterKind: "linear",
        intentType: "experimental_unrelated",
        targetExternalId: "linear_issue_id_x",
      });
      const repoPath = makeRepo(externalApplyAllowedPolicy());
      const result = await executeExternalApply(
        baseInput(db, { intentId: "intent_unknown_type", repoPath }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected refusal");
      expect(result.code).toBe("unsupported_intent_type");
    } finally {
      db.close();
    }
  });

  it("refuses with target_missing when the intent has no external target id", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      insertIntent(db, {
        id: "intent_no_target",
        targetExternalId: null,
      });
      const repoPath = makeRepo(externalApplyAllowedPolicy());
      const result = await executeExternalApply(
        baseInput(db, { intentId: "intent_no_target", repoPath }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected refusal");
      expect(result.code).toBe("target_missing");
    } finally {
      db.close();
    }
  });
});

describe("executeExternalApply two-phase happy path", () => {
  it("claims, writes through the adapter, finalizes the audit, and marks the intent applied", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { intentId } = seedHappyPath(db);
      const repoPath = makeRepo(externalApplyAllowedPolicy());
      const intent = getUpdateIntentById(db, intentId);
      if (!intent) throw new Error("intent missing");
      const idempotencyMarker = expectedIdempotencyMarker(
        intentId,
        intent.payload,
      );
      const spy = makeApplySpy(makeSuccessOutcome({ idempotencyMarker }));

      const result = await executeExternalApply(
        baseInput(db, {
          intentId,
          repoPath,
          deps: {
            buildLinearClient: () => spy.client,
            now: () => 1000,
          },
        }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
      expect(result.resultCode).toBe("applied");
      expect(result.context.applyPolicy.value).toBe("external_apply_allowed");
      expect(result.context.applyPolicy.source).toBe("momentum_policy");
      expect(result.context.adapterKind).toBe("linear");
      expect(result.context.target.externalId).toBe("linear_issue_id_happy");
      expect(result.context.target.externalKey).toBe("NGX-1001");
      expect(result.context.auditId).toBe(result.audit.id);
      expect(result.context.reconcile.status).toBe("success");
      expect(result.external.alreadyApplied).toBe(false);
      expect(result.external.commentId).toBe("comment_1");
      expect(result.external.idempotencyMarker).toBe(idempotencyMarker);

      expect(spy.calls).toHaveLength(1);
      const sent = spy.calls[0]!;
      expect(sent.preview.target.externalId).toBe("linear_issue_id_happy");
      expect(sent.preview.idempotencyMarker).toBe(idempotencyMarker);
      expect(sent.statusMutation).toBeNull();

      expect(result.intent.status).toBe("applied");
      expect(result.intent.decisionReason).toContain("external_apply:");
      expect(result.audit.lifecycleState).toBe("succeeded");
      expect(result.audit.resultCode).toBe("applied");
      expect(result.audit.externalRefs.commentId).toBe("comment_1");
      expect(result.audit.reconcile.status).toBe("success");
      expect(result.audit.reconcile.warning).toBeNull();

      const applyState = db
        .prepare("SELECT apply_state FROM update_intents WHERE id = ?")
        .get(intentId) as { apply_state: string };
      expect(applyState.apply_state).toBe("idle");
    } finally {
      db.close();
    }
  });

  it("infers a Linear status transition from a status_update intent payload", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const externalId = "linear_issue_id_status";
      const sourceItemId = "source_item_status";
      insertSourceItem(db, {
        id: sourceItemId,
        adapterKind: "linear",
        externalId,
        externalKey: "NGX-522",
        url: "https://linear.app/example/issue/NGX-522",
        title: "Status issue",
      });
      const payload = {
        state: "Done",
        comment: "Native workflow finished and should close the tracker.",
      };
      insertIntent(db, {
        id: "intent_status_update",
        intentType: "status_update",
        targetExternalId: externalId,
        sourceItemId,
        payload,
      });
      const repoPath = makeRepo(externalApplyAllowedPolicy());
      const idempotencyMarker = expectedIdempotencyMarker(
        "intent_status_update",
        payload,
      );
      const spy = makeApplySpy((input) => ({
        ok: true,
        alreadyApplied: false,
        issue: {
          id: externalId,
          key: "NGX-522",
          url: "https://linear.app/example/issue/NGX-522",
        },
        comment: {
          id: "comment_status_update",
          url: "https://linear.app/example/comment/status",
        },
        status: {
          transitioned: true,
          previousStateId: "state-started",
          previousStateName: "In Review",
          nextStateId: "state-done",
          nextStateName:
            input.statusMutation?.kind === "by_name"
              ? input.statusMutation.stateName
              : null,
        },
        idempotencyMarker,
      }));

      const result = await executeExternalApply(
        baseInput(db, {
          intentId: "intent_status_update",
          repoPath,
          deps: {
            buildLinearClient: () => spy.client,
            buildLinearRefreshClient: () =>
              makeRefreshClient({
                marker: idempotencyMarker,
                issueId: externalId,
                issueKey: "NGX-522",
                status: "Done",
                comments: [
                  {
                    id: "comment_status_update",
                    body: `Momentum applied ${idempotencyMarker}`,
                    url: "https://linear.app/example/comment/status",
                  },
                ],
              }),
            now: () => 1000,
          },
        }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
      expect(result.context.intentType).toBe("status_update");
      expect(result.context.allowStatusMutation).toBe(true);
      expect(result.context.mutationKind).toBe("status_transition");
      expect(result.external.statusTransitioned).toBe(true);
      expect(result.external.nextStateName).toBe("Done");
      expect(getUpdateIntentById(db, "intent_status_update")?.status).toBe(
        "applied",
      );

      expect(spy.calls).toHaveLength(1);
      const sent = spy.calls[0]!;
      expect(sent.statusMutation).toEqual({
        kind: "by_name",
        stateName: "Done",
      });
      expect(sent.preview.commentBody).toContain(
        "Native workflow finished and should close the tracker.",
      );
      expect(sent.preview.idempotencyMarker).toBe(idempotencyMarker);
    } finally {
      db.close();
    }
  });

  it("refuses malformed status_update payloads before claiming an audit", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      insertIntent(db, {
        id: "intent_status_update_bad",
        intentType: "status_update",
        targetExternalId: "linear_issue_id_status",
        payload: { comment: "missing state" },
      });
      const repoPath = makeRepo(externalApplyAllowedPolicy());
      const spy = makeApplySpy(
        makeErrorOutcome("validation_failed", "must not call"),
      );

      const result = await executeExternalApply(
        baseInput(db, {
          intentId: "intent_status_update_bad",
          repoPath,
          deps: { buildLinearClient: () => spy.client },
        }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected refusal");
      expect(result.code).toBe("validation_failed");
      expect(result.message).toContain('"state" or "stateId"');
      expect(spy.calls).toHaveLength(0);
      expect(
        listIntentApplyAudits(db, { intentId: "intent_status_update_bad" }),
      ).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("treats alreadyApplied replay as success without creating a duplicate Linear mutation", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { intentId } = seedHappyPath(db);
      const repoPath = makeRepo(externalApplyAllowedPolicy());
      const intent = getUpdateIntentById(db, intentId);
      if (!intent) throw new Error("intent missing");
      const idempotencyMarker = expectedIdempotencyMarker(
        intentId,
        intent.payload,
      );
      const spy = makeApplySpy(
        makeSuccessOutcome({
          alreadyApplied: true,
          commentId: "comment_existing",
          commentUrl: "https://linear.app/example/comment/existing",
          idempotencyMarker,
        }),
      );

      const result = await executeExternalApply(
        baseInput(db, {
          intentId,
          repoPath,
          deps: { buildLinearClient: () => spy.client, now: () => 2000 },
        }),
      );
      if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
      expect(result.resultCode).toBe("already_applied");
      expect(result.external.alreadyApplied).toBe(true);
      expect(result.external.commentId).toBe("comment_existing");
      expect(result.audit.resultCode).toBe("already_applied");
      expect(result.intent.status).toBe("applied");
      expect(spy.calls).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("reports alreadyApplied replay with a status transition as applied", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { intentId } = seedHappyPath(db);
      const repoPath = makeRepo(externalApplyAllowedPolicy());
      const intent = getUpdateIntentById(db, intentId);
      if (!intent) throw new Error("intent missing");
      const idempotencyMarker = expectedIdempotencyMarker(
        intentId,
        intent.payload,
      );
      const spy = makeApplySpy(
        makeSuccessOutcome({
          alreadyApplied: true,
          statusTransitioned: true,
          commentId: "comment_existing",
          commentUrl: "https://linear.app/example/comment/existing",
          nextStateId: "state_done",
          nextStateName: "Done",
          idempotencyMarker,
        }),
      );

      const result = await executeExternalApply(
        baseInput(db, {
          intentId,
          repoPath,
          deps: { buildLinearClient: () => spy.client, now: () => 2050 },
        }),
      );
      if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
      expect(result.resultCode).toBe("applied");
      expect(result.external.alreadyApplied).toBe(true);
      expect(result.external.statusTransitioned).toBe(true);
      expect(result.external.nextStateId).toBe("state_done");
      expect(result.external.commentId).toBe("comment_existing");
      expect(result.audit.resultCode).toBe("applied");
      expect(result.audit.externalRefs.stateTransitionId).toBe("state_done");
      expect(result.intent.status).toBe("applied");
      expect(spy.calls).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("surfaces and persists a stable warning when targeted post-apply reconcile still mismatches", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { intentId } = seedHappyPath(db);
      const repoPath = makeRepo(externalApplyAllowedPolicy());
      const intent = getUpdateIntentById(db, intentId);
      if (!intent) throw new Error("intent missing");
      const idempotencyMarker = expectedIdempotencyMarker(
        intentId,
        intent.payload,
      );
      const spy = makeApplySpy(makeSuccessOutcome({ idempotencyMarker }));

      const result = await executeExternalApply(
        baseInput(db, {
          intentId,
          repoPath,
          deps: {
            buildLinearClient: () => spy.client,
            buildLinearRefreshClient: () =>
              makeRefreshClient({
                marker: idempotencyMarker,
                comments: [
                  { id: "comment_other", body: "unrelated", url: null },
                ],
              }),
            now: () => 2100,
          },
        }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
      expect(result.context.reconcile.status).toBe("mismatch_persists");
      expect(result.context.reconcile.warning).toContain(
        "did not surface idempotency marker",
      );
      expect(result.audit.lifecycleState).toBe("succeeded");
      expect(result.audit.reconcile.status).toBe("mismatch_persists");
      expect(result.intent.status).toBe("applied");
    } finally {
      db.close();
    }
  });

  it("uses the default Linear refresh client when no refresh builder is injected", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { intentId } = seedHappyPath(db);
      const repoPath = makeRepo(externalApplyAllowedPolicy());
      const intent = getUpdateIntentById(db, intentId);
      if (!intent) throw new Error("intent missing");
      const idempotencyMarker = expectedIdempotencyMarker(
        intentId,
        intent.payload,
      );
      const spy = makeApplySpy(makeSuccessOutcome({ idempotencyMarker }));
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify(
            makeIssueRefreshPayload({
              id: "linear_issue_id_happy",
              identifier: "NGX-1001",
              marker: idempotencyMarker,
            }),
          ),
          { status: 200 },
        ),
      );

      const result = await executeExternalApply({
        db,
        intentId,
        operatorReason: "verified evidence",
        operatorActor: "operator@example.com",
        repoPath,
        env: { [LINEAR_API_KEY_ENV_VAR]: "test-key" },
        statusMutation: null,
        deps: {
          buildLinearClient: () => spy.client,
          now: () => 2150,
        },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
      expect(result.context.reconcile.status).toBe("success");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });

  it("keeps external apply successful when reconcile audit update throws", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { intentId } = seedHappyPath(db);
      const repoPath = makeRepo(externalApplyAllowedPolicy());
      const intent = getUpdateIntentById(db, intentId);
      if (!intent) throw new Error("intent missing");
      const idempotencyMarker = expectedIdempotencyMarker(
        intentId,
        intent.payload,
      );
      const spy = makeApplySpy(makeSuccessOutcome({ idempotencyMarker }));

      const result = await executeExternalApply(
        baseInput(db, {
          intentId,
          repoPath,
          deps: {
            buildLinearClient: () => spy.client,
            updateIntentApplyAuditReconcile: () => {
              throw new Error("simulated reconcile update failure");
            },
            now: () => 2200,
          },
        }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
      expect(result.context.reconcile.status).toBe(
        "post_apply_reconcile_failed",
      );
      expect(result.context.reconcile.warning).toContain(
        "audit reconcile update threw",
      );
      expect(result.audit.lifecycleState).toBe("succeeded");
      expect(result.audit.reconcile.status).toBe("pending");
      expect(result.intent.status).toBe("applied");
    } finally {
      db.close();
    }
  });
});

describe("executeExternalApply concurrency and write failures", () => {
  it("returns intent_apply_in_progress when another claim already holds the CAS guard and makes zero adapter calls", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { intentId, externalId } = seedHappyPath(db);
      const repoPath = makeRepo(externalApplyAllowedPolicy());

      // Pre-claim the intent so the orchestrator's claim refuses.
      const preClaim = claimIntentApply(db, {
        intentId,
        adapterKind: "linear",
        provider: "linear",
        target: {
          externalId,
          externalKey: "NGX-1001",
          url: "https://linear.app/example/issue/NGX-1001",
          title: "Happy issue",
        },
        operatorReason: "first claim",
        operatorActor: "other@operator",
        intentApplyPolicy: "external_apply_allowed",
        allowStatusMutation: false,
        mutationKind: "comment",
        previewSummary: "Linear comment on NGX-1001: source_satisfied",
        idempotencyMarker:
          "momentum-intent:linear:intent_happy:abcdef0123456789",
        now: 500,
      });
      if (!preClaim.ok) throw new Error("pre-claim must succeed");

      const spy = makeApplySpy(
        makeErrorOutcome("validation_failed", "must not call"),
      );
      const result = await executeExternalApply(
        baseInput(db, {
          intentId,
          repoPath,
          deps: { buildLinearClient: () => spy.client, now: () => 600 },
        }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected refusal");
      expect(result.code).toBe("intent_apply_in_progress");
      expect(spy.calls).toHaveLength(0);

      const audits = listIntentApplyAudits(db, { intentId });
      expect(audits).toHaveLength(1);
      expect(audits[0]!.id).toBe(preClaim.audit.id);
    } finally {
      db.close();
    }
  });

  it("refuses to claim an intent already in the blocked state and surfaces intent_blocked", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { intentId, externalId } = seedHappyPath(db);
      const repoPath = makeRepo(externalApplyAllowedPolicy());
      const claim = claimIntentApply(db, {
        intentId,
        adapterKind: "linear",
        target: {
          externalId,
          externalKey: "NGX-1001",
          url: null,
          title: null,
        },
        operatorReason: "first attempt",
        intentApplyPolicy: "external_apply_allowed",
        allowStatusMutation: false,
        mutationKind: "comment",
        previewSummary: "preview",
        idempotencyMarker:
          "momentum-intent:linear:intent_happy:bbbbbbbbbbbbbbbb",
        now: 100,
      });
      if (!claim.ok) throw new Error("claim must succeed");
      const finalize = finalizeIntentApply(db, {
        auditId: claim.audit.id,
        lifecycleState: "audit_incomplete",
        resultCode: "audit_finalize_failed",
        resultMessage: "simulated",
        now: 110,
      });
      if (!finalize.ok) throw new Error("finalize must succeed");

      const spy = makeApplySpy(
        makeErrorOutcome("validation_failed", "must not call"),
      );
      const result = await executeExternalApply(
        baseInput(db, {
          intentId,
          repoPath,
          deps: { buildLinearClient: () => spy.client, now: () => 200 },
        }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected refusal");
      expect(result.code).toBe("intent_blocked");
      expect(spy.calls).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("finalizes audit as failed and releases the intent when the external write rejects", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { intentId } = seedHappyPath(db);
      const repoPath = makeRepo(externalApplyAllowedPolicy());
      const spy = makeApplySpy(
        makeErrorOutcome("write_rejected", "Linear rejected the mutation"),
      );
      const result = await executeExternalApply(
        baseInput(db, {
          intentId,
          repoPath,
          deps: { buildLinearClient: () => spy.client, now: () => 700 },
        }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected refusal");
      expect(result.code).toBe("write_rejected");
      expect(result.audit?.lifecycleState).toBe("failed");
      expect(result.audit?.resultCode).toBe("write_rejected");

      const intent = getUpdateIntentById(db, intentId);
      expect(intent?.status).toBe("pending");
      const applyState = db
        .prepare("SELECT apply_state FROM update_intents WHERE id = ?")
        .get(intentId) as { apply_state: string };
      expect(applyState.apply_state).toBe("idle");
    } finally {
      db.close();
    }
  });

  it("blocks the intent when external write rejection cannot finalize the audit as failed", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { intentId } = seedHappyPath(db);
      const repoPath = makeRepo(externalApplyAllowedPolicy());
      const spy = makeApplySpy(
        makeErrorOutcome("write_rejected", "Linear rejected the mutation"),
      );

      let finalizeCalls = 0;
      const result = await executeExternalApply(
        baseInput(db, {
          intentId,
          repoPath,
          deps: {
            buildLinearClient: () => spy.client,
            now: () => 750,
            finalizeIntentApply: (db, input) => {
              finalizeCalls += 1;
              if (finalizeCalls === 1 && input.lifecycleState === "failed") {
                return {
                  ok: false,
                  code: "audit_already_finalized",
                  message: "simulated finalize failure",
                };
              }
              return finalizeIntentApply(db, input);
            },
          },
        }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected refusal");
      expect(result.code).toBe("audit_incomplete");
      expect(result.audit?.lifecycleState).toBe("audit_incomplete");
      expect(result.audit?.resultCode).toBe("failed_finalize_failed");

      const applyState = db
        .prepare("SELECT apply_state FROM update_intents WHERE id = ?")
        .get(intentId) as { apply_state: string };
      expect(applyState.apply_state).toBe("blocked");
    } finally {
      db.close();
    }
  });

  it("transitions the intent to blocked when the audit finalize fails after a successful external write", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { intentId } = seedHappyPath(db);
      const repoPath = makeRepo(externalApplyAllowedPolicy());
      const intent = getUpdateIntentById(db, intentId);
      if (!intent) throw new Error("intent missing");
      const idempotencyMarker = expectedIdempotencyMarker(
        intentId,
        intent.payload,
      );

      const spy = makeApplySpy(makeSuccessOutcome({ idempotencyMarker }));

      // The initial success finalize fails; recovery must force
      // audit_incomplete and block replay without relying on another normal
      // finalize call.
      let finalizeCalls = 0;
      const deps: ExecuteExternalApplyDeps = {
        buildLinearClient: () => spy.client,
        now: () => 800,
        finalizeIntentApply: (db, input) => {
          finalizeCalls += 1;
          if (finalizeCalls === 1 && input.lifecycleState === "succeeded") {
            return {
              ok: false,
              code: "audit_already_finalized",
              message: "simulated finalize failure",
            };
          }
          return finalizeIntentApply(db, input);
        },
      };
      const result = await executeExternalApply(
        baseInput(db, { intentId, repoPath, deps }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected refusal");
      expect(result.code).toBe("audit_incomplete");
      expect(result.audit?.lifecycleState).toBe("audit_incomplete");
      expect(result.audit?.resultCode).toBe("audit_finalize_failed");
      expect(result.context.reconcile.status).toBe("deferred");

      const applyState = db
        .prepare("SELECT apply_state FROM update_intents WHERE id = ?")
        .get(intentId) as { apply_state: string };
      expect(applyState.apply_state).toBe("blocked");

      const intentAfter = getUpdateIntentById(db, intentId);
      expect(intentAfter?.status).toBe("pending");

      const latest = getLatestIntentApplyAudit(db, intentId);
      expect(latest?.lifecycleState).toBe("audit_incomplete");
      expect(latest?.externalRefs.commentId).toBe("comment_1");
      expect(latest?.reconcile.status).toBe("deferred");
    } finally {
      db.close();
    }
  });

  it("transitions the intent to blocked when mark-applied fails after a successful external write", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { intentId } = seedHappyPath(db);
      const repoPath = makeRepo(externalApplyAllowedPolicy());
      const intent = getUpdateIntentById(db, intentId);
      if (!intent) throw new Error("intent missing");
      const idempotencyMarker = expectedIdempotencyMarker(
        intentId,
        intent.payload,
      );
      const spy = makeApplySpy(makeSuccessOutcome({ idempotencyMarker }));

      const result = await executeExternalApply(
        baseInput(db, {
          intentId,
          repoPath,
          deps: {
            buildLinearClient: () => spy.client,
            now: () => 850,
            markUpdateIntentApplied: () => ({
              ok: false,
              code: "intent_already_terminal",
              message: "simulated mark-applied failure",
            }),
          },
        }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected refusal");
      expect(result.code).toBe("audit_incomplete");
      expect(result.audit?.lifecycleState).toBe("audit_incomplete");
      expect(result.audit?.resultCode).toBe("mark_applied_failed");
      expect(result.context.reconcile).toEqual({
        status: "deferred",
        warning: "external write applied; intent transition failed",
      });

      const applyState = db
        .prepare("SELECT apply_state FROM update_intents WHERE id = ?")
        .get(intentId) as { apply_state: string };
      expect(applyState.apply_state).toBe("blocked");

      const intentAfter = getUpdateIntentById(db, intentId);
      expect(intentAfter?.status).toBe("pending");

      const latest = getLatestIntentApplyAudit(db, intentId);
      expect(latest?.lifecycleState).toBe("audit_incomplete");
      expect(latest?.externalRefs.commentId).toBe("comment_1");
      expect(latest?.reconcile.status).toBe("deferred");
    } finally {
      db.close();
    }
  });

  it("treats concurrent already-applied intent transition as success without blocking replay", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { intentId } = seedHappyPath(db);
      const repoPath = makeRepo(externalApplyAllowedPolicy());
      const intent = getUpdateIntentById(db, intentId);
      if (!intent) throw new Error("intent missing");
      const idempotencyMarker = expectedIdempotencyMarker(
        intentId,
        intent.payload,
      );
      const spy = makeApplySpy(makeSuccessOutcome({ idempotencyMarker }));

      const result = await executeExternalApply(
        baseInput(db, {
          intentId,
          repoPath,
          deps: {
            buildLinearClient: () => spy.client,
            now: () => 875,
            markUpdateIntentApplied: (db, input) => {
              db.prepare(
                `UPDATE update_intents
                    SET status = 'applied',
                        decision_reason = 'external_apply: concurrent operator',
                        applied_at = ?,
                        updated_at = ?
                  WHERE id = ?`,
              ).run(input.now ?? 875, input.now ?? 875, input.intentId);
              return {
                ok: false,
                code: "intent_already_terminal",
                message: "simulated concurrent apply",
                currentStatus: "applied",
              };
            },
          },
        }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
      expect(result.intent.status).toBe("applied");
      expect(result.audit.lifecycleState).toBe("succeeded");
      expect(result.audit.resultCode).toBe("applied");

      const applyState = db
        .prepare("SELECT apply_state FROM update_intents WHERE id = ?")
        .get(intentId) as { apply_state: string };
      expect(applyState.apply_state).toBe("idle");
    } finally {
      db.close();
    }
  });

  it("maps a thrown adapter exception to adapter_threw and finalizes the audit as failed", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { intentId } = seedHappyPath(db);
      const repoPath = makeRepo(externalApplyAllowedPolicy());
      const client: LinearExternalUpdateClient = {
        async apply() {
          throw new Error("network kaboom");
        },
      };
      const result = await executeExternalApply(
        baseInput(db, {
          intentId,
          repoPath,
          deps: { buildLinearClient: () => client, now: () => 900 },
        }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected refusal");
      expect(result.code).toBe("adapter_threw");
      expect(result.message).toContain("network kaboom");
      expect(result.audit?.lifecycleState).toBe("failed");
    } finally {
      db.close();
    }
  });

  it("blocks the intent when adapter exception cannot finalize the audit as failed", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      const { intentId } = seedHappyPath(db);
      const repoPath = makeRepo(externalApplyAllowedPolicy());
      const client: LinearExternalUpdateClient = {
        async apply() {
          throw new Error("network kaboom");
        },
      };

      let finalizeCalls = 0;
      const result = await executeExternalApply(
        baseInput(db, {
          intentId,
          repoPath,
          deps: {
            buildLinearClient: () => client,
            now: () => 950,
            finalizeIntentApply: (db, input) => {
              finalizeCalls += 1;
              if (finalizeCalls === 1 && input.lifecycleState === "failed") {
                return {
                  ok: false,
                  code: "audit_already_finalized",
                  message: "simulated finalize failure",
                };
              }
              return finalizeIntentApply(db, input);
            },
          },
        }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected refusal");
      expect(result.code).toBe("audit_incomplete");
      expect(result.audit?.lifecycleState).toBe("audit_incomplete");
      expect(result.audit?.resultCode).toBe("failed_finalize_failed");

      const applyState = db
        .prepare("SELECT apply_state FROM update_intents WHERE id = ?")
        .get(intentId) as { apply_state: string };
      expect(applyState.apply_state).toBe("blocked");
    } finally {
      db.close();
    }
  });
});

describe("default Linear client factories honor endpoint env var overrides", () => {
  it("defaultBuildLinearClient points at MOMENTUM_LINEAR_EXTERNAL_UPDATE_ENDPOINT when set", async () => {
    const overrideEndpoint = "http://127.0.0.1:65535/momentum-mock/graphql";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { issue: null } }), {
        status: 200,
      }),
    );
    const client = defaultBuildLinearClient({
      [LINEAR_API_KEY_ENV_VAR]: "test-key",
      [LINEAR_EXTERNAL_UPDATE_ENDPOINT_ENV_VAR]: overrideEndpoint,
    });
    await client.apply({
      preview: {
        adapterKind: "linear",
        intentId: "intent_override",
        intentType: "source_satisfied",
        target: {
          adapterKind: "linear",
          externalId: "linear_issue_id_override",
          externalKey: null,
          url: null,
          title: null,
        },
        mutationKind: "comment",
        summary: "preview summary",
        commentBody:
          "marker line\nmomentum-intent:linear:override:0000000000000000",
        idempotencyMarker: "momentum-intent:linear:override:0000000000000000",
      },
    });
    expect(fetchSpy).toHaveBeenCalled();
    const firstCall = fetchSpy.mock.calls[0];
    if (!firstCall) throw new Error("expected fetch attempt");
    expect(firstCall[0]).toBe(overrideEndpoint);
  });

  it("defaultBuildLinearRefreshClient points at MOMENTUM_LINEAR_REFRESH_ENDPOINT when set", async () => {
    const overrideEndpoint = "http://127.0.0.1:65535/momentum-mock/graphql";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { issue: null } }), {
        status: 200,
      }),
    );
    const client = defaultBuildLinearRefreshClient({
      [LINEAR_API_KEY_ENV_VAR]: "test-key",
      [LINEAR_REFRESH_ENDPOINT_ENV_VAR]: overrideEndpoint,
    });
    await client.refresh({
      target: { kind: "id", value: "linear_issue_id_override" },
    });
    expect(fetchSpy).toHaveBeenCalled();
    const firstCall = fetchSpy.mock.calls[0];
    if (!firstCall) throw new Error("expected fetch attempt");
    expect(firstCall[0]).toBe(overrideEndpoint);
  });

  it("defaultBuildLinearClient falls back to the production endpoint when the override env var is unset or empty", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { issue: null } }), {
        status: 200,
      }),
    );
    const client = defaultBuildLinearClient({
      [LINEAR_API_KEY_ENV_VAR]: "test-key",
      [LINEAR_EXTERNAL_UPDATE_ENDPOINT_ENV_VAR]: "   ",
    });
    await client.apply({
      preview: {
        adapterKind: "linear",
        intentId: "intent_fallback",
        intentType: "source_satisfied",
        target: {
          adapterKind: "linear",
          externalId: "linear_issue_id_fallback",
          externalKey: null,
          url: null,
          title: null,
        },
        mutationKind: "comment",
        summary: "preview summary",
        commentBody:
          "marker line\nmomentum-intent:linear:fallback:0000000000000000",
        idempotencyMarker: "momentum-intent:linear:fallback:0000000000000000",
      },
    });
    expect(fetchSpy).toHaveBeenCalled();
    const firstCall = fetchSpy.mock.calls[0];
    if (!firstCall) throw new Error("expected fetch attempt");
    expect(firstCall[0]).toBe("https://api.linear.app/graphql");
  });
});

describe("executeExternalApply adapter registry override", () => {
  it("respects an injected adapter registry that omits the linear adapter", async () => {
    const dataDir = makeTempDir();
    const db = openDb(dataDir);
    try {
      seedHappyPath(db);
      const repoPath = makeRepo(externalApplyAllowedPolicy());
      const emptyAdapters = new Map<string, ExternalUpdateAdapter>();
      const spy = makeApplySpy(
        makeErrorOutcome("validation_failed", "must not call"),
      );
      const result = await executeExternalApply(
        baseInput(db, {
          intentId: "intent_happy",
          repoPath,
          deps: {
            adapters: emptyAdapters,
            buildLinearClient: () => spy.client,
          },
        }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected refusal");
      expect(result.code).toBe("unsupported_adapter");
      expect(spy.calls).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
