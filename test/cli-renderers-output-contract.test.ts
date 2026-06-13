import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { evidenceRecordToJsonShape } from "../src/renderers/evidence.js";
import {
  intentApplyAuditToJsonShape,
  updateIntentToJsonShape
} from "../src/renderers/intent.js";
import { sourceItemToJsonShape } from "../src/renderers/source.js";
import type { EvidenceRecord } from "../src/evidence-records.js";
import type { IntentApplyAudit } from "../src/intent-apply-audits.js";
import type { SourceItem } from "../src/source-items.js";
import type { UpdateIntent } from "../src/update-intents.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

type CliResult = { code: number; stdout: string; stderr: string };

async function run(args: string[]): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "momentum-renderer-home-"));
  const code = await runCli(args, {
    stdout: { write: (chunk: string) => ((stdout += chunk), true) },
    stderr: { write: (chunk: string) => ((stderr += chunk), true) },
    env: { ...process.env, HOME: home }
  });
  return { code, stdout, stderr };
}

function readFile(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), "utf8");
}

describe("shared renderer output contracts", () => {
  it("keeps reusable JSON-shape renderers out of sibling command families", () => {
    const commandModules = [
      "src/commands/evidence/index.ts",
      "src/commands/project/index.ts",
      "src/commands/source/index.ts",
      "src/commands/intent/index.ts"
    ];

    for (const modulePath of commandModules) {
      const source = readFile(modulePath);
      expect(
        source,
        `${modulePath} must import reusable render shapes from src/renderers instead of sibling command families`
      ).not.toMatch(/from "\.\.\/(?:evidence|intent|project|source|workflow|goal)\/index\.js"/);
    }

    for (const rendererPath of [
      "src/renderers/evidence.ts",
      "src/renderers/intent.ts",
      "src/renderers/source.ts"
    ]) {
      expect(
        fs.existsSync(path.join(repoRoot, rendererPath)),
        `${rendererPath} should own reusable JSON output shapes`
      ).toBe(true);
    }
  });

  it("keeps command-family renderer helpers in src/renderers modules", () => {
    const commandModules = [
      "src/commands/workflow/index.ts",
      "src/commands/project/index.ts",
      "src/commands/status.ts",
      "src/commands/intent/index.ts",
      "src/commands/goal/index.ts",
      "src/commands/source/index.ts",
      "src/commands/evidence/index.ts"
    ];

    for (const modulePath of commandModules) {
      const source = readFile(modulePath);
      expect(
        source,
        `${modulePath} should orchestrate commands and call src/renderers for text helpers`
      ).not.toMatch(/\bfunction\s+render[A-Z]/);
      expect(
        source,
        `${modulePath} should call src/renderers for JSON output shapes`
      ).not.toMatch(/\bfunction\s+\w+ToJsonShape\b/);
      expect(
        source,
        `${modulePath} should call src/renderers for command-family emit helpers`
      ).not.toMatch(/\bfunction\s+emit[A-Z]/);
      expect(
        source,
        `${modulePath} should route stdout/stderr writes through src/renderers`
      ).not.toMatch(/\bwrite(?:Json)?\(/);
    }

    for (const rendererPath of [
      "src/renderers/workflow.ts",
      "src/renderers/project.ts",
      "src/renderers/status.ts",
      "src/renderers/intent.ts",
      "src/renderers/goal.ts",
      "src/renderers/source.ts",
      "src/renderers/evidence.ts"
    ]) {
      expect(
        fs.existsSync(path.join(repoRoot, rendererPath)),
        `${rendererPath} should own command-family output contracts`
      ).toBe(true);
    }
  });

  it("preserves reusable JSON field contracts for source, evidence, intent, and apply audit shapes", () => {
    const sourceItem: SourceItem = {
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
      updatedAt: 12
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
      sourceItemId: "src-1",
      runId: "run-1",
      stepId: "step-1",
      ingestKey: "workflow:run-1:step-1",
      createdAt: 21,
      updatedAt: 22
    };
    const intent: UpdateIntent = {
      id: "intent-1",
      adapterKind: "linear",
      targetExternalId: "lin-1",
      intentType: "source_status",
      payload: { status: "Done" },
      reason: "Goal completed",
      goalId: "goal-1",
      sourceItemId: "src-1",
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
      canceledAt: null
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
        title: "Renderer shape"
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
        stateTransitionId: "transition-1"
      },
      reconcile: {
        status: "matched",
        warning: null
      },
      createdAt: 42,
      updatedAt: 43
    };

    expect(sourceItemToJsonShape(sourceItem)).toEqual({
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
      updatedAt: 12
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
      sourceItemId: "src-1",
      runId: "run-1",
      stepId: "step-1",
      ingestKey: "workflow:run-1:step-1",
      createdAt: 21,
      updatedAt: 22
    });
    expect(updateIntentToJsonShape(intent)).toEqual({
      id: "intent-1",
      adapterKind: "linear",
      targetExternalId: "lin-1",
      intentType: "source_status",
      payload: { status: "Done" },
      reason: "Goal completed",
      goalId: "goal-1",
      sourceItemId: "src-1",
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
      canceledAt: null
    });
    expect(intentApplyAuditToJsonShape(audit)).toEqual({
      id: "audit-1",
      adapterKind: "linear",
      provider: "linear",
      target: {
        externalId: "lin-1",
        externalKey: "NGX-1",
        url: "https://linear.example/NGX-1",
        title: "Renderer shape"
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
        stateTransitionId: "transition-1"
      },
      reconcile: { status: "matched", warning: null },
      createdAt: 42,
      updatedAt: 43
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
      message: "Missing required --action <action> for workflow run decide."
    });
  });

  it("preserves human usage rendering through the shared CLI output renderer", async () => {
    const result = await run(["source"]);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Missing required subcommand for source.");
    expect(result.stderr).toContain("Momentum\n\nUsage:\n");
    expect(result.stderr).toContain("  momentum source list");
  });

  it("does not add repo-local Codex skill files for renderer extraction", () => {
    expect(
      fs.existsSync(path.join(repoRoot, ".agents/skills/no-mistakes/SKILL.md"))
    ).toBe(false);
  });
});
