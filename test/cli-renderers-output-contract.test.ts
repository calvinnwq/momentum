import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { evidenceRecordToJsonShape } from "../src/renderers/evidence.js";
import {
  intentApplyAuditToJsonShape,
  updateIntentToJsonShape,
} from "../src/renderers/intent.js";
import { trackerItemToJsonShape } from "../src/renderers/tracker.js";
import type { EvidenceRecord } from "../src/core/evidence/records.js";
import type { IntentApplyAudit } from "../src/core/intent/apply-audits.js";
import type { TrackerItem } from "../src/core/tracker/items.js";
import type { UpdateIntent } from "../src/core/intent/update-intents.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

type CliResult = { code: number; stdout: string; stderr: string };

async function run(args: string[]): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const home = fs.mkdtempSync(
    path.join(os.tmpdir(), "momentum-renderer-home-"),
  );
  tempRoots.push(home);
  const code = await runCli(args, {
    stdout: { write: (chunk: string) => ((stdout += chunk), true) },
    stderr: { write: (chunk: string) => ((stderr += chunk), true) },
    env: { ...process.env, HOME: home },
  });
  return { code, stdout, stderr };
}

describe("shared renderer output contracts", () => {
  it("renders command families and compatibility surfaces through public CLI envelopes", async () => {
    const cases: Array<{
      args: string[];
      code: number;
      stream: "stdout" | "stderr";
      expected: Record<string, unknown>;
    }> = [
      {
        args: ["tracker", "list", "--json"],
        code: 0,
        stream: "stdout",
        expected: { ok: true, command: "tracker list", items: [], count: 0 },
      },
      {
        args: ["evidence", "list", "--json"],
        code: 0,
        stream: "stdout",
        expected: { ok: true, command: "evidence list", records: [], count: 0 },
      },
      {
        args: ["intent", "list", "--json"],
        code: 0,
        stream: "stdout",
        expected: { ok: true, command: "intent list", intents: [], count: 0 },
      },
      {
        args: ["daemon", "status", "--json"],
        code: 0,
        stream: "stdout",
        expected: { ok: true, command: "daemon status", hasRun: false },
      },
      {
        args: ["recovery", "clear", "missing-goal", "--json"],
        code: 1,
        stream: "stderr",
        expected: {
          ok: false,
          command: "recovery clear",
          code: "goal_not_found",
        },
      },
      {
        args: ["doctor", "--json"],
        code: 0,
        stream: "stdout",
        expected: { ok: true, command: "doctor" },
      },
    ];

    for (const spec of cases) {
      const result = await run(spec.args);
      expect(result.code, spec.args.join(" ")).toBe(spec.code);
      const selected =
        spec.stream === "stdout" ? result.stdout : result.stderr;
      const other = spec.stream === "stdout" ? result.stderr : result.stdout;
      expect(other, `${spec.args.join(" ")} other stream`).toBe("");
      expect(JSON.parse(selected), spec.args.join(" ")).toMatchObject(
        spec.expected,
      );
    }
  });

  it("preserves reusable JSON field contracts for source, evidence, intent, and apply audit shapes", () => {
    const trackerItem: TrackerItem = {
      id: "src-1",
      adapterKind: "linear",
      externalId: "lin-1",
      externalKey: "NGX-1",
      url: "https://linear.example/NGX-1",
      title: "Renderer shape",
      status: "Todo",
      metadata: { project: "Momentum" },
      lastObservedAt: 10,
      goalId: "goal-1",
      createdAt: 11,
      updatedAt: 12,
    };
    const evidence: EvidenceRecord = {
      id: "ev-1",
      source: "workflow",
      type: "ledger",
      formatVersion: 1,
      artifactPath: ".agent-workflows/run-1/ledger.jsonl",
      externalId: "ext-1",
      occurredAt: 20,
      summary: "Step succeeded",
      metadata: { runId: "run-1" },
      goalId: "goal-1",
      trackerItemId: "src-1",
      runId: "run-1",
      stepId: "step-1",
      ingestKey: "workflow:run-1:step-1",
      createdAt: 21,
      updatedAt: 22,
    };
    const intent: UpdateIntent = {
      id: "intent-1",
      adapterKind: "linear",
      targetExternalId: "lin-1",
      intentType: "source_status",
      payload: { status: "Done" },
      reason: "Goal completed",
      goalId: "goal-1",
      trackerItemId: "src-1",
      evidenceRecordId: "ev-1",
      status: "pending",
      idempotencyKey: "intent-key",
      decisionReason: null,
      errorCode: null,
      errorMessage: null,
      createdAt: 31,
      updatedAt: 32,
      appliedAt: null,
      skippedAt: null,
      canceledAt: null,
    };
    const audit: IntentApplyAudit = {
      id: "audit-1",
      intentId: "intent-1",
      adapterKind: "linear",
      provider: "linear",
      target: {
        externalId: "lin-1",
        externalKey: "NGX-1",
        url: "https://linear.example/NGX-1",
        title: "Renderer shape",
      },
      requestedAt: 40,
      finishedAt: 41,
      operatorReason: "Apply approved",
      operatorActor: "operator",
      intentApplyPolicy: "external_apply_allowed",
      allowStatusMutation: true,
      mutationKind: "status_transition",
      previewSummary: "Set status to Done",
      idempotencyMarker: "marker",
      lifecycleState: "succeeded",
      resultStatus: "applied",
      resultCode: "ok",
      resultMessage: "Applied",
      externalRefs: {
        commentId: "comment-1",
        commentUrl: "https://linear.example/comment-1",
        stateTransitionId: "transition-1",
      },
      reconcile: {
        status: "matched",
        warning: null,
      },
      createdAt: 42,
      updatedAt: 43,
    };

    expect(trackerItemToJsonShape(trackerItem)).toEqual({
      id: "src-1",
      adapterKind: "linear",
      externalId: "lin-1",
      externalKey: "NGX-1",
      url: "https://linear.example/NGX-1",
      title: "Renderer shape",
      status: "Todo",
      metadata: { project: "Momentum" },
      lastObservedAt: 10,
      goalId: "goal-1",
      createdAt: 11,
      updatedAt: 12,
    });
    expect(evidenceRecordToJsonShape(evidence)).toEqual({
      id: "ev-1",
      source: "workflow",
      type: "ledger",
      formatVersion: 1,
      artifactPath: ".agent-workflows/run-1/ledger.jsonl",
      externalId: "ext-1",
      occurredAt: 20,
      summary: "Step succeeded",
      metadata: { runId: "run-1" },
      goalId: "goal-1",
      trackerItemId: "src-1",
      runId: "run-1",
      stepId: "step-1",
      ingestKey: "workflow:run-1:step-1",
      createdAt: 21,
      updatedAt: 22,
    });
    expect(updateIntentToJsonShape(intent)).toEqual({
      id: "intent-1",
      adapterKind: "linear",
      targetExternalId: "lin-1",
      intentType: "source_status",
      payload: { status: "Done" },
      reason: "Goal completed",
      goalId: "goal-1",
      trackerItemId: "src-1",
      evidenceRecordId: "ev-1",
      status: "pending",
      idempotencyKey: "intent-key",
      decisionReason: null,
      errorCode: null,
      errorMessage: null,
      createdAt: 31,
      updatedAt: 32,
      appliedAt: null,
      skippedAt: null,
      canceledAt: null,
    });
    expect(intentApplyAuditToJsonShape(audit)).toEqual({
      id: "audit-1",
      adapterKind: "linear",
      provider: "linear",
      target: {
        externalId: "lin-1",
        externalKey: "NGX-1",
        url: "https://linear.example/NGX-1",
        title: "Renderer shape",
      },
      requestedAt: 40,
      finishedAt: 41,
      operatorReason: "Apply approved",
      operatorActor: "operator",
      intentApplyPolicy: "external_apply_allowed",
      allowStatusMutation: true,
      mutationKind: "status_transition",
      previewSummary: "Set status to Done",
      idempotencyMarker: "marker",
      lifecycleState: "succeeded",
      resultStatus: "applied",
      resultCode: "ok",
      resultMessage: "Applied",
      externalRefs: {
        commentId: "comment-1",
        commentUrl: "https://linear.example/comment-1",
        stateTransitionId: "transition-1",
      },
      reconcile: { status: "matched", warning: null },
      createdAt: 42,
      updatedAt: 43,
    });
  });

  it("preserves workflow agent validation envelopes on stderr", async () => {
    const result = await run(["workflow", "run", "decide", "gate-1", "--json"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      command: "workflow run decide",
      code: "action_required",
      gateId: "gate-1",
      message: "Missing required --action <action> for workflow run decide.",
    });
  });

  it("preserves human usage rendering through the shared CLI output renderer", async () => {
    const result = await run(["tracker"]);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Missing required subcommand for tracker.");
    expect(result.stderr).toContain("Momentum\n\nUsage:\n");
    expect(result.stderr).toContain("  momentum tracker list");
  });

  it("does not add repo-local Codex skill files for renderer extraction", () => {
    expect(
      fs.existsSync(path.join(repoRoot, ".agents/skills/no-mistakes/SKILL.md")),
    ).toBe(false);
  });
});
