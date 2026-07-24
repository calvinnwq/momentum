import { afterEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  WORKFLOW_RUN_IMPORT_SOURCE,
  parseWorkflowRunImport,
} from "../src/core/workflow/run/import.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-workflow-import-"): string {
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
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
  );
}

function sha256OfFile(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function basePlan(
  runId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    runId,
    schemaVersion: 1,
    mode: "execute-ready",
    profile: "momentum-m7",
    objective: "NGX-314 import current agent-workflow plans",
    repo: "/Users/test/repos/momentum",
    resolvedScope: {
      issues: ["NGX-314"],
      source: "explicit",
      status: "resolved",
    },
    skillRevision: {
      contract: "coding-workflow-pipeline compact skill architecture",
      digest:
        "abc123def4560000000000000000000000000000000000000000000000000000",
      version: "2026.05.22.18",
      schemaVersion: 1,
    },
    approvalsRequired: [
      "implementation",
      "postflight:1",
      "validate",
      "merge-cleanup",
    ],
    taskFlow: {
      childTasks: [
        { stepId: "preflight" },
        { stepId: "implementation" },
        { stepId: "postflight:1" },
        { stepId: "validate" },
        { stepId: "merge-cleanup" },
      ],
    },
    ...overrides,
  };
}

describe("parseWorkflowRunImport", () => {
  it("normalizes a workflow run directory into run/steps/approvals/leases", () => {
    const root = makeTempDir();
    const runDir = path.join(root, "cwfp-abc123def456");
    const planPath = path.join(runDir, "plan.json");
    const ledgerPath = path.join(runDir, "ledger.jsonl");
    const approvalPath = path.join(
      runDir,
      "approval-through-merge-cleanup.json",
    );
    const monitorPath = path.join(runDir, "monitor.json");

    writeJsonFile(planPath, basePlan("cwfp-abc123def456"));
    writeLedger(ledgerPath, [
      {
        runId: "cwfp-abc123def456",
        step: "preflight",
        status: "complete",
        ts: "2026-05-17T10:00:00Z",
      },
      {
        runId: "cwfp-abc123def456",
        step: "implementation",
        status: "started",
        ts: "2026-05-17T10:01:00Z",
      },
      {
        runId: "cwfp-abc123def456",
        step: "implementation",
        status: "complete",
        ts: "2026-05-17T10:30:00Z",
      },
      {
        runId: "cwfp-abc123def456",
        step: "postflight:1",
        status: "failed",
        ts: "2026-05-17T10:34:00Z",
      },
      {
        runId: "cwfp-abc123def456",
        step: "postflight:1",
        status: "complete",
        ts: "2026-05-17T10:35:00Z",
      },
      {
        runId: "cwfp-abc123def456",
        step: "validate",
        status: "complete",
        ts: "2026-05-17T10:40:00Z",
      },
      {
        runId: "cwfp-abc123def456",
        step: "merge-cleanup",
        status: "complete",
        ts: "2026-05-17T10:45:00Z",
      },
    ]);
    writeJsonFile(approvalPath, {
      runId: "cwfp-abc123def456",
      schemaVersion: 1,
      boundary: "through-merge-cleanup",
      approvedAt: "2026-05-17T09:00:00Z",
      approvalContract: "approve plan <run-id> <boundary>",
      allowedSteps: [
        "preflight",
        "implementation",
        "postflight:1",
        "validate",
        "merge-cleanup",
      ],
    });
    writeJsonFile(monitorPath, {
      runId: "cwfp-abc123def456",
      schemaVersion: 1,
      active: false,
      terminal: true,
      lastSeenState: "complete",
      lastUpdateAt: 1779504220,
    });

    const result = parseWorkflowRunImport(runDir);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const { import: imp } = result;

    expect(imp.run.runId).toBe("cwfp-abc123def456");
    expect(imp.run.source).toBe(WORKFLOW_RUN_IMPORT_SOURCE);
    expect(imp.run.sourceArtifactPath).toBe(planPath);
    expect(imp.run.repoPath).toBe("/Users/test/repos/momentum");
    expect(imp.run.objective).toBe(
      "NGX-314 import current agent-workflow plans",
    );
    expect(imp.run.issueScope).toEqual({
      issues: ["NGX-314"],
      source: "explicit",
      status: "resolved",
    });
    expect(imp.run.skillRevision).toBe(
      "abc123def4560000000000000000000000000000000000000000000000000000",
    );
    expect(imp.run.approvalBoundary).toBe("through-merge-cleanup");
    expect(imp.run.planJson).toMatchObject({
      runId: "cwfp-abc123def456",
      objective: expect.any(String),
    });
    expect(imp.run.state).toBe("succeeded");

    expect(imp.steps.map((s) => s.stepId)).toEqual([
      "preflight",
      "implementation",
      "postflight:1",
      "validate",
      "merge-cleanup",
    ]);
    expect(imp.steps.map((s) => s.kind)).toEqual([
      "preflight",
      "implementation",
      "postflight",
      "validate",
      "merge-cleanup",
    ]);
    expect(imp.steps.map((s) => s.state)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(imp.steps.map((s) => s.order)).toEqual([0, 1, 2, 3, 4]);
    expect(imp.steps.map((s) => s.required)).toEqual([
      false,
      true,
      true,
      true,
      true,
    ]);

    const impl = imp.steps[1]!;
    expect(impl.startedAt).toBe(Date.parse("2026-05-17T10:01:00Z"));
    expect(impl.finishedAt).toBe(Date.parse("2026-05-17T10:30:00Z"));

    expect(imp.approvals).toHaveLength(1);
    const approval = imp.approvals[0]!;
    expect(approval.boundary).toBe("through-merge-cleanup");
    expect(approval.phrase).toBe("through-merge-cleanup");
    expect(approval.artifactPath).toBe(approvalPath);
    expect(approval.artifactDigest).toBe(sha256OfFile(approvalPath));
    expect(approval.recordedAt).toBe(Date.parse("2026-05-17T09:00:00Z"));

    expect(imp.monitor).not.toBeNull();
    expect(imp.monitor?.advisory).toBe(true);
    expect(imp.monitor?.terminal).toBe(true);
    expect(imp.monitor?.runState).toBe("complete");

    expect(imp.diagnostics).toEqual([]);
  });

  it("reads legacy step and approval vocabulary while projecting mutable boundaries", () => {
    const root = makeTempDir();
    const runId = "cwfp-legacy-vocabulary";
    const runDir = path.join(root, runId);
    writeJsonFile(
      path.join(runDir, "plan.json"),
      basePlan(runId, {
        approvalsRequired: ["no-mistakes"],
        taskFlow: {
          childTasks: [{ stepId: "no-mistakes" }, { stepId: "linear-refresh" }],
        },
      }),
    );
    writeLedger(path.join(runDir, "ledger.jsonl"), [
      {
        runId,
        step: "no-mistakes",
        status: "complete",
        ts: "2026-05-17T10:00:00Z",
      },
      {
        runId,
        step: "linear-refresh",
        status: "complete",
        ts: "2026-05-17T10:01:00Z",
      },
    ]);
    writeJsonFile(path.join(runDir, "approval-through-no-mistakes.json"), {
      runId,
      boundary: "through-no-mistakes",
      approvedAt: "2026-05-17T09:00:00Z",
    });

    const result = parseWorkflowRunImport(runDir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.import.diagnostics).toEqual([]);
    expect(result.import.steps.map((step) => [step.stepId, step.kind])).toEqual(
      [
        ["no-mistakes", "validate"],
        ["linear-refresh", "tracker-refresh"],
      ],
    );
    expect(result.import.approvals[0]?.boundary).toBe("through-no-mistakes");
    expect(result.import.run.approvalBoundary).toBe("through-validate");
  });

  it("joins a legacy ledger step to its canonical plan step", () => {
    const root = makeTempDir();
    const runId = "cwfp-canonical-plan-legacy-ledger";
    const runDir = path.join(root, runId);
    writeJsonFile(
      path.join(runDir, "plan.json"),
      basePlan(runId, {
        approvalsRequired: ["validate"],
        taskFlow: { childTasks: [{ stepId: "validate" }] },
      }),
    );
    writeLedger(path.join(runDir, "ledger.jsonl"), [
      {
        runId,
        step: "no-mistakes",
        status: "complete",
        ts: "2026-05-17T10:00:00Z",
      },
    ]);

    const result = parseWorkflowRunImport(runDir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.import.diagnostics).toEqual([]);
    expect(result.import.steps).toHaveLength(1);
    expect(result.import.steps[0]).toMatchObject({
      stepId: "validate",
      kind: "validate",
      state: "succeeded",
      required: true,
    });
  });

  it("matches legacy approval requirements to a canonical plan step", () => {
    const root = makeTempDir();
    const runId = "cwfp-legacy-approval-canonical-plan";
    const runDir = path.join(root, runId);
    writeJsonFile(
      path.join(runDir, "plan.json"),
      basePlan(runId, {
        approvalsRequired: ["no-mistakes"],
        taskFlow: { childTasks: [{ stepId: "validate" }] },
      }),
    );
    writeLedger(path.join(runDir, "ledger.jsonl"), [
      {
        runId,
        step: "validate",
        status: "complete",
        ts: "2026-05-17T10:00:00Z",
      },
    ]);

    const result = parseWorkflowRunImport(runDir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.import.diagnostics).toEqual([]);
    expect(result.import.steps).toHaveLength(1);
    expect(result.import.steps[0]).toMatchObject({
      stepId: "validate",
      kind: "validate",
      state: "succeeded",
      required: true,
    });
  });

  it("joins a canonical ledger step to its retained legacy plan step", () => {
    const root = makeTempDir();
    const runId = "cwfp-legacy-plan-canonical-ledger";
    const runDir = path.join(root, runId);
    writeJsonFile(
      path.join(runDir, "plan.json"),
      basePlan(runId, {
        approvalsRequired: ["no-mistakes"],
        taskFlow: { childTasks: [{ stepId: "no-mistakes" }] },
      }),
    );
    writeLedger(path.join(runDir, "ledger.jsonl"), [
      {
        runId,
        step: "validate",
        status: "complete",
        ts: "2026-05-17T10:00:00Z",
      },
    ]);

    const result = parseWorkflowRunImport(runDir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.import.diagnostics).toEqual([]);
    expect(result.import.steps).toHaveLength(1);
    expect(result.import.steps[0]).toMatchObject({
      stepId: "no-mistakes",
      kind: "validate",
      state: "succeeded",
      required: true,
    });
  });

  it("derives step state from the latest ledger event for each step (terminal evidence wins)", () => {
    const root = makeTempDir();
    const runDir = path.join(root, "cwfp-terminalwins");
    writeJsonFile(
      path.join(runDir, "plan.json"),
      basePlan("cwfp-terminalwins"),
    );
    writeLedger(path.join(runDir, "ledger.jsonl"), [
      {
        runId: "cwfp-terminalwins",
        step: "preflight",
        status: "complete",
        ts: "2026-05-17T10:00:00Z",
      },
      {
        runId: "cwfp-terminalwins",
        step: "implementation",
        status: "started",
        ts: "2026-05-17T10:01:00Z",
      },
      {
        runId: "cwfp-terminalwins",
        step: "implementation",
        status: "complete",
        ts: "2026-05-17T10:30:00Z",
      },
      {
        runId: "cwfp-terminalwins",
        step: "postflight:1",
        status: "started",
        ts: "2026-05-17T10:31:00Z",
      },
      {
        runId: "cwfp-terminalwins",
        step: "postflight:1",
        status: "failed",
        ts: "2026-05-17T10:32:00Z",
      },
    ]);

    const result = parseWorkflowRunImport(runDir);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    const state = Object.fromEntries(
      result.import.steps.map((s) => [s.stepId, s.state]),
    );
    expect(state).toMatchObject({
      preflight: "succeeded",
      implementation: "succeeded",
      "postflight:1": "failed",
      validate: "pending",
      "merge-cleanup": "pending",
    });
    expect(result.import.run.state).toBe("failed");
  });

  it("treats monitor.json as advisory: a stale monitor does not override completed ledger state", () => {
    const root = makeTempDir();
    const runDir = path.join(root, "cwfp-stalemonitor");
    writeJsonFile(
      path.join(runDir, "plan.json"),
      basePlan("cwfp-stalemonitor"),
    );
    writeLedger(path.join(runDir, "ledger.jsonl"), [
      {
        runId: "cwfp-stalemonitor",
        step: "preflight",
        status: "complete",
        ts: "2026-05-17T10:00:00Z",
      },
      {
        runId: "cwfp-stalemonitor",
        step: "implementation",
        status: "started",
        ts: "2026-05-17T10:01:00Z",
      },
      {
        runId: "cwfp-stalemonitor",
        step: "implementation",
        status: "complete",
        ts: "2026-05-17T10:30:00Z",
      },
      {
        runId: "cwfp-stalemonitor",
        step: "postflight:1",
        status: "complete",
        ts: "2026-05-17T10:31:00Z",
      },
      {
        runId: "cwfp-stalemonitor",
        step: "validate",
        status: "complete",
        ts: "2026-05-17T10:40:00Z",
      },
      {
        runId: "cwfp-stalemonitor",
        step: "merge-cleanup",
        status: "complete",
        ts: "2026-05-17T10:45:00Z",
      },
    ]);
    writeJsonFile(path.join(runDir, "monitor.json"), {
      runId: "cwfp-stalemonitor",
      active: true,
      terminal: false,
      lastSeenState: "running",
      step: "implementation",
    });

    const result = parseWorkflowRunImport(runDir);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    expect(result.import.run.state).toBe("succeeded");
    expect(
      result.import.steps.find((s) => s.stepId === "implementation")?.state,
    ).toBe("succeeded");
    expect(result.import.monitor?.advisory).toBe(true);
    expect(result.import.monitor?.runState).toBe("running");
  });

  it("ignores managed-*.pid / managed-*.log / lock siblings without diagnostics", () => {
    const root = makeTempDir();
    const runDir = path.join(root, "cwfp-lostmanaged");
    writeJsonFile(path.join(runDir, "plan.json"), basePlan("cwfp-lostmanaged"));
    writeLedger(path.join(runDir, "ledger.jsonl"), [
      {
        runId: "cwfp-lostmanaged",
        step: "preflight",
        status: "complete",
        ts: "2026-05-17T10:00:00Z",
      },
      {
        runId: "cwfp-lostmanaged",
        step: "implementation",
        status: "started",
        ts: "2026-05-17T10:01:00Z",
      },
      {
        runId: "cwfp-lostmanaged",
        step: "implementation",
        status: "complete",
        ts: "2026-05-17T10:30:00Z",
      },
    ]);
    fs.writeFileSync(
      path.join(runDir, "managed-gnhf_implementation.pid"),
      "99999\n",
    );
    fs.writeFileSync(
      path.join(runDir, "managed-gnhf_implementation.log"),
      "log content\n",
    );
    fs.mkdirSync(path.join(runDir, "locks"));
    fs.writeFileSync(
      path.join(runDir, "plan.json.backup-foo-20260522T0640Z"),
      "ignored",
    );

    const result = parseWorkflowRunImport(runDir);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    // Lost managed-task markers must coexist with completed ledger evidence
    // without forcing a failed step state.
    expect(
      result.import.steps.find((s) => s.stepId === "implementation")?.state,
    ).toBe("succeeded");
    expect(result.import.diagnostics).toEqual([]);
  });

  it("falls back to the directory basename when plan.json is missing", () => {
    const root = makeTempDir();
    const runDir = path.join(root, "cwfp-noplan0000");
    fs.mkdirSync(runDir, { recursive: true });
    writeLedger(path.join(runDir, "ledger.jsonl"), [
      {
        runId: "cwfp-noplan0000",
        step: "preflight",
        status: "complete",
        ts: "2026-05-17T10:00:00Z",
      },
    ]);

    const result = parseWorkflowRunImport(runDir);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    expect(result.import.run.runId).toBe("cwfp-noplan0000");
    expect(result.import.run.planJson).toBeNull();
    expect(result.import.run.sourceArtifactPath).toBeNull();
    // Without a plan, steps are inferred from ledger events.
    expect(result.import.steps.map((s) => s.stepId)).toEqual(["preflight"]);
    expect(result.import.steps[0]!.state).toBe("succeeded");
    expect(result.import.run.state).toBe("succeeded");
  });

  it("fails with import_run_id_missing when no plan and no runId in directory name", () => {
    const root = makeTempDir();
    const runDir = path.join(root, "not-a-run-dir");
    fs.mkdirSync(runDir, { recursive: true });

    const result = parseWorkflowRunImport(runDir);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.errorCode).toBe("import_run_id_missing");
  });

  it("emits evidence_format_unknown / evidence_format_invalid diagnostics without dropping valid records", () => {
    const root = makeTempDir();
    const runDir = path.join(root, "cwfp-mixedbad0");
    writeJsonFile(path.join(runDir, "plan.json"), basePlan("cwfp-mixedbad0"));
    writeLedger(path.join(runDir, "ledger.jsonl"), [
      {
        runId: "cwfp-mixedbad0",
        step: "preflight",
        status: "complete",
        ts: "2026-05-17T10:00:00Z",
      },
      {
        runId: "cwfp-mixedbad0",
        step: "mystery-step",
        status: "complete",
        ts: "2026-05-17T10:01:00Z",
      },
      {
        runId: "cwfp-mixedbad0",
        step: "implementation",
        status: "weird-status",
        ts: "2026-05-17T10:02:00Z",
      },
      { step: "preflight", status: "complete", ts: "2026-05-17T10:03:00Z" },
    ]);
    fs.writeFileSync(path.join(runDir, "scratch.txt"), "ad-hoc notes");

    const result = parseWorkflowRunImport(runDir);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    expect(
      result.import.steps.find((s) => s.stepId === "preflight")?.state,
    ).toBe("succeeded");
    expect(
      result.import.steps.find((s) => s.stepId === "implementation")?.state,
    ).toBe("pending");
    const reasons = result.import.diagnostics.map((d) => d.reason);
    expect(reasons).toContain("unrecognized_filename");
    expect(reasons).toContain("unknown_step_or_status");
    expect(reasons).toContain("ledger_line_missing_required_fields");
  });

  it("reports evidence_format_invalid for malformed plan JSON but still returns a result built from siblings", () => {
    const root = makeTempDir();
    const runDir = path.join(root, "cwfp-badplan000");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "plan.json"), "{not valid json");
    writeLedger(path.join(runDir, "ledger.jsonl"), [
      {
        runId: "cwfp-badplan000",
        step: "preflight",
        status: "complete",
        ts: "2026-05-17T10:00:00Z",
      },
    ]);

    const result = parseWorkflowRunImport(runDir);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.import.run.runId).toBe("cwfp-badplan000");
    expect(result.import.run.planJson).toBeNull();
    const reasons = result.import.diagnostics.map((d) => d.reason);
    expect(reasons).toContain("file_not_json");
    // The valid ledger event is still represented.
    expect(
      result.import.steps.find((s) => s.stepId === "preflight")?.state,
    ).toBe("succeeded");
  });

  it("skips approval records with malformed boundaries and reports diagnostics", () => {
    const root = makeTempDir();
    const runDir = path.join(root, "cwfp-badapproval");
    writeJsonFile(path.join(runDir, "plan.json"), basePlan("cwfp-badapproval"));
    writeJsonFile(path.join(runDir, "approval-bogus-boundary.json"), {
      runId: "cwfp-badapproval",
      boundary: "bogus-boundary",
      approvedAt: "2026-05-17T09:00:00Z",
    });
    writeJsonFile(path.join(runDir, "approval-through-implementation.json"), {
      runId: "cwfp-badapproval",
      boundary: "through-implementation",
      approvedAt: "2026-05-17T09:00:00Z",
    });

    const result = parseWorkflowRunImport(runDir);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    expect(result.import.approvals.map((a) => a.boundary)).toEqual([
      "through-implementation",
    ]);
    expect(
      result.import.diagnostics.some(
        (d) => d.reason === "approval_invalid_boundary",
      ),
    ).toBe(true);
  });

  it("derives run.approvalBoundary from the most recently recorded approval, not alphabetical order", () => {
    const root = makeTempDir();
    const runDir = path.join(root, "cwfp-multiapprov0");
    writeJsonFile(
      path.join(runDir, "plan.json"),
      basePlan("cwfp-multiapprov0"),
    );
    // through-merge-cleanup sorts alphabetically before through-validate,
    // but here it is recorded later, so it should win as the run-level boundary.
    writeJsonFile(path.join(runDir, "approval-through-validate.json"), {
      runId: "cwfp-multiapprov0",
      boundary: "through-validate",
      approvedAt: "2026-05-17T09:00:00Z",
    });
    writeJsonFile(path.join(runDir, "approval-through-merge-cleanup.json"), {
      runId: "cwfp-multiapprov0",
      boundary: "through-merge-cleanup",
      approvedAt: "2026-05-17T11:00:00Z",
    });

    const result = parseWorkflowRunImport(runDir);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    expect(result.import.approvals.map((a) => a.boundary)).toEqual([
      "through-validate",
      "through-merge-cleanup",
    ]);
    expect(result.import.run.approvalBoundary).toBe("through-merge-cleanup");
  });

  it("emits an unknown-step diagnostic when ledger references a step kind not in the vocabulary", () => {
    const root = makeTempDir();
    const runDir = path.join(root, "cwfp-unknownstp0");
    writeJsonFile(path.join(runDir, "plan.json"), basePlan("cwfp-unknownstp0"));
    writeLedger(path.join(runDir, "ledger.jsonl"), [
      {
        runId: "cwfp-unknownstp0",
        step: "preflight",
        status: "complete",
        ts: "2026-05-17T10:00:00Z",
      },
      {
        runId: "cwfp-unknownstp0",
        step: "mystery-step",
        status: "complete",
        ts: "2026-05-17T10:05:00Z",
      },
    ]);

    const result = parseWorkflowRunImport(runDir);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    expect(result.import.steps.some((s) => s.stepId === "mystery-step")).toBe(
      false,
    );
    const unknownDiagnostic = result.import.diagnostics.find(
      (d) =>
        d.code === "evidence_format_unknown" &&
        d.reason === "unknown_step_or_status" &&
        d.detail?.includes("step=mystery-step"),
    );
    expect(unknownDiagnostic).toBeDefined();
  });

  it("is deterministic: two calls on the same directory return equal records", () => {
    const root = makeTempDir();
    const runDir = path.join(root, "cwfp-deterministc");
    writeJsonFile(
      path.join(runDir, "plan.json"),
      basePlan("cwfp-deterministc"),
    );
    writeLedger(path.join(runDir, "ledger.jsonl"), [
      {
        runId: "cwfp-deterministc",
        step: "preflight",
        status: "complete",
        ts: "2026-05-17T10:00:00Z",
      },
      {
        runId: "cwfp-deterministc",
        step: "implementation",
        status: "complete",
        ts: "2026-05-17T10:30:00Z",
      },
    ]);
    writeJsonFile(path.join(runDir, "approval-through-implementation.json"), {
      runId: "cwfp-deterministc",
      boundary: "through-implementation",
      approvedAt: "2026-05-17T09:00:00Z",
    });

    const a = parseWorkflowRunImport(runDir);
    const b = parseWorkflowRunImport(runDir);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) throw new Error("expected ok");

    expect(a.import.run).toEqual(b.import.run);
    expect(a.import.steps).toEqual(b.import.steps);
    expect(a.import.approvals).toEqual(b.import.approvals);
    expect(a.import.diagnostics).toEqual(b.import.diagnostics);
  });

  it("returns import_path_unreadable when the path does not exist", () => {
    const root = makeTempDir();
    const result = parseWorkflowRunImport(path.join(root, "does-not-exist"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.errorCode).toBe("import_path_unreadable");
  });

  it("returns import_path_not_directory when given a file", () => {
    const root = makeTempDir();
    const filePath = path.join(root, "plan.json");
    writeJsonFile(filePath, basePlan("cwfp-fileonlypath"));
    const result = parseWorkflowRunImport(filePath);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.errorCode).toBe("import_path_not_directory");
  });
});
