import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  WORKFLOW_EVIDENCE_FORMAT_VERSION,
  WORKFLOW_EVIDENCE_SOURCE,
  parseWorkflowArtifact
} from "../src/evidence-workflow.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-evidence-workflow-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function writeLedger(filePath: string, lines: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`
  );
}

function basePlan(runId: string): Record<string, unknown> {
  return {
    runId,
    schemaVersion: 1,
    mode: "execute-ready",
    profile: "momentum-m5",
    objective: "NGX-291 M5-04 workflow evidence ingestion",
    resolvedScope: { issues: ["NGX-291"], source: "explicit", status: "resolved" }
  };
}

describe("parseWorkflowArtifact", () => {
  it("normalizes a workflow directory into plan_created + ledger lifecycle records", () => {
    const root = makeTempDir();
    const runDir = path.join(root, "cwfp-abc123def456");
    const planPath = path.join(runDir, "plan.json");
    const ledgerPath = path.join(runDir, "ledger.jsonl");

    writeJsonFile(planPath, basePlan("cwfp-abc123def456"));
    writeLedger(ledgerPath, [
      {
        runId: "cwfp-abc123def456",
        step: "preflight",
        status: "complete",
        ts: "2026-05-17T10:00:00Z"
      },
      {
        runId: "cwfp-abc123def456",
        step: "implementation",
        status: "started",
        ts: "2026-05-17T10:01:00Z"
      },
      {
        runId: "cwfp-abc123def456",
        step: "implementation",
        status: "complete",
        ts: "2026-05-17T10:30:00Z",
        artifacts: [
          "/tmp/.gnhf/runs/work-through-the-fro-b5f255/notes.md"
        ]
      },
      {
        runId: "cwfp-abc123def456",
        step: "postflight:1",
        status: "failed",
        ts: "2026-05-17T10:34:00Z"
      },
      {
        runId: "cwfp-abc123def456",
        step: "postflight:1",
        status: "complete",
        ts: "2026-05-17T10:35:00Z"
      },
      {
        runId: "cwfp-abc123def456",
        step: "no-mistakes",
        status: "complete",
        ts: "2026-05-17T10:40:00Z",
        prUrl: "https://github.com/example/momentum/pull/98",
        toolRunId: "01KTEST",
        head: "abcdef0123456789",
        harness: "claude",
        model: "opus"
      },
      {
        runId: "cwfp-abc123def456",
        step: "merge-cleanup",
        status: "complete",
        ts: "2026-05-17T10:45:00Z",
        pr: "https://github.com/example/momentum/pull/99",
        mergeCommit: "0123456789abcdef0123456789abcdef01234567",
        branch: "gnhf/work-through-the-fro-b5f255",
        linearIssue: "NGX-291",
        linearState: "Done",
        verification: ["pnpm test", "pnpm typecheck"]
      }
    ]);

    const result = parseWorkflowArtifact(runDir);

    expect(result.diagnostics).toEqual([]);
    expect(result.records.map((r) => r.type)).toEqual([
      "plan_created",
      "preflight_complete",
      "implementation_started",
      "implementation_complete",
      "postflight_failed",
      "postflight_complete",
      "no_mistakes_complete",
      "merge_complete"
    ]);
    expect(new Set(result.records.map((r) => r.source))).toEqual(
      new Set([WORKFLOW_EVIDENCE_SOURCE])
    );
    expect(new Set(result.records.map((r) => r.formatVersion))).toEqual(
      new Set([WORKFLOW_EVIDENCE_FORMAT_VERSION])
    );
    expect(new Set(result.records.map((r) => r.externalId))).toEqual(
      new Set(["cwfp-abc123def456"])
    );
    expect(result.records.map((r) => r.ingestKey)).toEqual([
      "agent-workflow:cwfp-abc123def456:plan_created",
      "agent-workflow:cwfp-abc123def456:preflight:complete",
      "agent-workflow:cwfp-abc123def456:implementation:started",
      "agent-workflow:cwfp-abc123def456:implementation:complete",
      "agent-workflow:cwfp-abc123def456:postflight:1:failed",
      "agent-workflow:cwfp-abc123def456:postflight:1:complete",
      "agent-workflow:cwfp-abc123def456:no-mistakes:complete",
      "agent-workflow:cwfp-abc123def456:merge-cleanup:complete"
    ]);

    const planRecord = result.records[0]!;
    expect(planRecord.summary).toBe(
      "Plan created: NGX-291 M5-04 workflow evidence ingestion"
    );
    expect(planRecord.metadata).toMatchObject({
      runId: "cwfp-abc123def456",
      objective: "NGX-291 M5-04 workflow evidence ingestion",
      mode: "execute-ready",
      profile: "momentum-m5",
      issues: ["NGX-291"]
    });

    const noMistakes = result.records[6]!;
    expect(noMistakes.metadata).toMatchObject({
      step: "no-mistakes",
      status: "complete",
      prUrl: "https://github.com/example/momentum/pull/98",
      toolRunId: "01KTEST",
      head: "abcdef0123456789",
      harness: "claude",
      model: "opus"
    });
    expect(noMistakes.summary).toContain("No-mistakes complete");
    expect(noMistakes.summary).toContain(
      "pr=https://github.com/example/momentum/pull/98"
    );

    const merge = result.records[7]!;
    expect(merge.occurredAt).toBe(Date.parse("2026-05-17T10:45:00Z"));
    expect(merge.metadata).toMatchObject({
      step: "merge-cleanup",
      status: "complete",
      pr: "https://github.com/example/momentum/pull/99",
      mergeCommit: "0123456789abcdef0123456789abcdef01234567",
      branch: "gnhf/work-through-the-fro-b5f255",
      linearIssue: "NGX-291",
      linearState: "Done",
      verification: ["pnpm test", "pnpm typecheck"]
    });
    expect(merge.summary).toContain("Merge complete");
    expect(merge.summary).toContain("(NGX-291)");
    expect(merge.summary).toContain("pr=https://github.com/example/momentum/pull/99");
    expect(merge.summary).toContain("merge=0123456789ab");

    const implComplete = result.records[3]!;
    expect(implComplete.metadata).toMatchObject({
      step: "implementation",
      status: "complete",
      artifacts: ["/tmp/.gnhf/runs/work-through-the-fro-b5f255/notes.md"]
    });

    const kinds = new Set(result.sources.map((s) => s.kind));
    expect(kinds.has("directory")).toBe(true);
    expect(kinds.has("plan")).toBe(true);
    expect(kinds.has("ledger")).toBe(true);
  });

  it("emits evidence_format_unknown for unrecognized siblings and unknown step/status pairs", () => {
    const root = makeTempDir();
    const runDir = path.join(root, "cwfp-unknownsibling");
    const planPath = path.join(runDir, "plan.json");
    const ledgerPath = path.join(runDir, "ledger.jsonl");

    writeJsonFile(planPath, basePlan("cwfp-unknownsibling"));
    writeLedger(ledgerPath, [
      {
        runId: "cwfp-unknownsibling",
        step: "preflight",
        status: "complete",
        ts: "2026-05-17T11:00:00Z"
      },
      {
        runId: "cwfp-unknownsibling",
        step: "mystery-step",
        status: "complete",
        ts: "2026-05-17T11:05:00Z"
      },
      {
        runId: "cwfp-unknownsibling",
        step: "implementation",
        status: "weird-status",
        ts: "2026-05-17T11:06:00Z"
      }
    ]);
    fs.writeFileSync(path.join(runDir, "scratch.txt"), "manual notes");
    fs.mkdirSync(path.join(runDir, "locks"));

    const result = parseWorkflowArtifact(runDir);

    expect(result.records.map((r) => r.type)).toEqual([
      "plan_created",
      "preflight_complete"
    ]);
    const unknownReasons = result.diagnostics
      .filter((d) => d.code === "evidence_format_unknown")
      .map((d) => d.reason);
    expect(unknownReasons).toContain("unrecognized_filename");
    expect(unknownReasons).toContain("unsupported_subdirectory");
    expect(unknownReasons).toContain("unknown_step_or_status");
    expect(result.diagnostics.every((d) => d.code === "evidence_format_unknown")).toBe(
      true
    );
  });

  it("reports evidence_format_invalid for malformed plan JSON without crashing", () => {
    const root = makeTempDir();
    const runDir = path.join(root, "cwfp-badjson");
    fs.mkdirSync(runDir);
    fs.writeFileSync(path.join(runDir, "plan.json"), "{not valid json");

    const result = parseWorkflowArtifact(runDir);

    expect(result.records).toEqual([]);
    const invalid = result.diagnostics.filter(
      (d) => d.code === "evidence_format_invalid"
    );
    expect(invalid.length).toBeGreaterThanOrEqual(1);
    expect(invalid[0]!.reason).toBe("file_not_json");
  });

  it("reports evidence_format_invalid for ledger lines missing required fields or bad timestamps", () => {
    const root = makeTempDir();
    const runDir = path.join(root, "cwfp-badledger");
    const ledgerPath = path.join(runDir, "ledger.jsonl");
    writeLedger(ledgerPath, [
      { step: "preflight", status: "complete", ts: "2026-05-17T11:00:00Z" },
      {
        runId: "cwfp-badledger",
        step: "preflight",
        status: "complete",
        ts: "not-a-date"
      },
      {
        runId: "cwfp-badledger",
        step: "implementation",
        status: "complete",
        ts: "2026-05-17T11:01:00Z"
      }
    ]);
    fs.writeFileSync(`${ledgerPath}`, `${fs.readFileSync(ledgerPath, "utf8")}{ bad json line\n`);

    const result = parseWorkflowArtifact(ledgerPath);

    const invalidReasons = result.diagnostics
      .filter((d) => d.code === "evidence_format_invalid")
      .map((d) => d.reason);
    expect(invalidReasons).toEqual(
      expect.arrayContaining([
        "ledger_line_missing_required_fields",
        "ledger_line_invalid_timestamp",
        "ledger_line_not_json"
      ])
    );
    // The valid line is still ingested.
    expect(result.records.map((r) => r.type)).toEqual(["implementation_complete"]);
  });

  it("normalizes approval-*.json into a step_approved record", () => {
    const root = makeTempDir();
    const runDir = path.join(root, "cwfp-approval");
    const approvalPath = path.join(runDir, "approval-through-merge-cleanup.json");
    writeJsonFile(approvalPath, {
      runId: "cwfp-approval",
      schemaVersion: 1,
      boundary: "through-merge-cleanup",
      approvalContract: "approve plan <run-id> <boundary>",
      approvedAt: "2026-05-17T09:00:00Z",
      allowedSteps: ["preflight", "implementation", "no-mistakes", "merge-cleanup"]
    });

    const result = parseWorkflowArtifact(approvalPath);
    expect(result.diagnostics).toEqual([]);
    expect(result.records).toHaveLength(1);
    const record = result.records[0]!;
    expect(record.type).toBe("step_approved");
    expect(record.ingestKey).toBe(
      "agent-workflow:cwfp-approval:approval:through-merge-cleanup"
    );
    expect(record.occurredAt).toBe(Date.parse("2026-05-17T09:00:00Z"));
    expect(record.metadata).toMatchObject({
      runId: "cwfp-approval",
      boundary: "through-merge-cleanup",
      allowedSteps: [
        "preflight",
        "implementation",
        "no-mistakes",
        "merge-cleanup"
      ]
    });
    expect(record.summary).toBe(
      "Approval recorded: through-merge-cleanup (cwfp-approval)"
    );
  });

  it("reports evidence_format_invalid for invalid approval timestamps", () => {
    const root = makeTempDir();
    const runDir = path.join(root, "cwfp-approval-invalid-ts");
    const approvalPath = path.join(runDir, "approval-through-merge-cleanup.json");
    writeJsonFile(approvalPath, {
      runId: "cwfp-approval-invalid-ts",
      schemaVersion: 1,
      boundary: "through-merge-cleanup",
      approvedAt: "not-a-date"
    });

    const result = parseWorkflowArtifact(approvalPath);
    expect(result.records).toEqual([]);
    expect(result.diagnostics).toEqual([
      {
        code: "evidence_format_invalid",
        path: approvalPath,
        reason: "approval_invalid_timestamp",
        detail: "not-a-date"
      }
    ]);
  });

  it("propagates goalId and sourceItemId options onto every emitted record", () => {
    const root = makeTempDir();
    const runDir = path.join(root, "cwfp-link");
    writeJsonFile(path.join(runDir, "plan.json"), basePlan("cwfp-link"));
    writeLedger(path.join(runDir, "ledger.jsonl"), [
      {
        runId: "cwfp-link",
        step: "preflight",
        status: "complete",
        ts: "2026-05-17T11:00:00Z"
      }
    ]);

    const result = parseWorkflowArtifact(runDir, {
      goalId: "goal-xyz",
      sourceItemId: "source-item-abc"
    });

    expect(result.records).toHaveLength(2);
    for (const record of result.records) {
      expect(record.goalId).toBe("goal-xyz");
      expect(record.sourceItemId).toBe("source-item-abc");
    }
  });

  it("returns a single evidence_format_invalid diagnostic when the path does not exist", () => {
    const root = makeTempDir();
    const missing = path.join(root, "does-not-exist");

    const result = parseWorkflowArtifact(missing);

    expect(result.records).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.code).toBe("evidence_format_invalid");
    expect(result.diagnostics[0]!.reason).toBe("path_not_readable");
  });

  it("treats unrecognized standalone files as evidence_format_unknown", () => {
    const root = makeTempDir();
    const standalone = path.join(root, "random.md");
    fs.writeFileSync(standalone, "# scratch");

    const result = parseWorkflowArtifact(standalone);

    expect(result.records).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.code).toBe("evidence_format_unknown");
    expect(result.diagnostics[0]!.reason).toBe("unrecognized_filename");
  });

  it("yields stable ingest keys across repeated parses of the same workflow directory", () => {
    const root = makeTempDir();
    const runDir = path.join(root, "cwfp-idempotent");
    writeJsonFile(path.join(runDir, "plan.json"), basePlan("cwfp-idempotent"));
    writeLedger(path.join(runDir, "ledger.jsonl"), [
      {
        runId: "cwfp-idempotent",
        step: "preflight",
        status: "complete",
        ts: "2026-05-17T11:00:00Z"
      },
      {
        runId: "cwfp-idempotent",
        step: "implementation",
        status: "complete",
        ts: "2026-05-17T11:30:00Z"
      }
    ]);

    const first = parseWorkflowArtifact(runDir);
    const second = parseWorkflowArtifact(runDir);

    expect(first.records.map((r) => r.ingestKey)).toEqual(
      second.records.map((r) => r.ingestKey)
    );
    // External id and source stay identical across parses for the same artifact.
    expect(new Set(first.records.map((r) => r.externalId))).toEqual(
      new Set(["cwfp-idempotent"])
    );
  });
});
