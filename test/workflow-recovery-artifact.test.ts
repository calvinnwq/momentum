import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  WORKFLOW_LIVE_RUN_RECOVERY_CODES,
  WORKFLOW_RECOVERY_ARTIFACT_FILENAME,
  WORKFLOW_RECOVERY_ARTIFACT_SCHEMA_VERSION,
  WORKFLOW_RECOVERY_CLASSIFICATIONS,
  WORKFLOW_RECOVERY_SAFETY_NOTES,
  buildWorkflowRecoveryArtifactInput,
  buildWorkflowRecoveryMarkdown,
  resolveWorkflowRecoveryArtifactPath,
  workflowRecoverySafeNextSteps,
  writeWorkflowRecoveryArtifact,
  type WorkflowRecoveryArtifactInput,
} from "../src/core/workflow/recovery/artifact.js";
import {
  WORKFLOW_MONITOR_RECOVERY_CODES,
  type WorkflowMonitorNextAction,
  type WorkflowMonitorRecovery,
} from "../src/core/workflow/monitor/state.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix = "momentum-workflow-recovery-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function makeFullInput(
  overrides: Partial<WorkflowRecoveryArtifactInput> = {},
): WorkflowRecoveryArtifactInput {
  return {
    runId: "run-abc",
    stepId: "no-mistakes",
    classification: "stale_running_step",
    reason:
      "Step is running but the dispatch lease is stale and no recent checkpoint has been observed.",
    recommendedNextAction: {
      code: "investigate_stale",
      detail:
        "Running step's dispatch lease is stale and no recent checkpoint has been observed. Inspect the run directory before forcing progress.",
    },
    evidencePointers: [
      { label: "Run directory", ref: ".agent-workflows/run-abc/" },
      { label: "Ledger", ref: ".agent-workflows/run-abc/ledger.jsonl" },
    ],
    repoPath: "/tmp/some-repo",
    classifiedAt: 1717000000000,
    schemaVersion: 1,
    ...overrides,
  };
}

describe("resolveWorkflowRecoveryArtifactPath", () => {
  it("locates recovery.md under the run directory in the agent-workflows tree", () => {
    const base = "/tmp/data/.agent-workflows";
    expect(resolveWorkflowRecoveryArtifactPath(base, "run-abc")).toBe(
      path.join(base, "run-abc", WORKFLOW_RECOVERY_ARTIFACT_FILENAME),
    );
  });

  it("rejects an empty run id", () => {
    expect(() => resolveWorkflowRecoveryArtifactPath("/tmp/x", "")).toThrow(
      /runId is required/,
    );
  });

  it("rejects run ids that are not safe path segments", () => {
    for (const runId of ["../escape", "nested/run", "nested\\run", "."]) {
      expect(() =>
        resolveWorkflowRecoveryArtifactPath("/tmp/x", runId),
      ).toThrow(/safe path segment/);
    }
  });
});

describe("buildWorkflowRecoveryMarkdown", () => {
  it("renders run id, step id, classification, reason, and schema version", () => {
    const body = buildWorkflowRecoveryMarkdown(makeFullInput());
    expect(body).toContain("# Manual recovery required: workflow run run-abc");
    expect(body).toContain(
      `- Schema version: ${WORKFLOW_RECOVERY_ARTIFACT_SCHEMA_VERSION}`,
    );
    expect(body).toContain("- Run ID: run-abc");
    expect(body).toContain("- Step ID: no-mistakes");
    expect(body).toContain("- Recovery classification: stale_running_step");
    expect(body).toContain("- Repo path: /tmp/some-repo");
    expect(body).toContain("- Classified at (epoch ms): 1717000000000");
    expect(body).toContain(
      "Step is running but the dispatch lease is stale and no recent checkpoint has been observed.",
    );
  });

  it("renders the recommended next action from the monitor reducer", () => {
    const body = buildWorkflowRecoveryMarkdown(makeFullInput());
    expect(body).toContain("## Recommended next action");
    expect(body).toContain("- Code: investigate_stale");
    expect(body).toContain(
      "Inspect the run directory before forcing progress.",
    );
  });

  it("renders evidence pointers as label/ref pairs", () => {
    const body = buildWorkflowRecoveryMarkdown(makeFullInput());
    expect(body).toContain("## Evidence pointers");
    expect(body).toContain("- Run directory: .agent-workflows/run-abc/");
    expect(body).toContain("- Ledger: .agent-workflows/run-abc/ledger.jsonl");
  });

  it("renders a placeholder when no evidence pointers are present", () => {
    const body = buildWorkflowRecoveryMarkdown(
      makeFullInput({ evidencePointers: [] }),
    );
    expect(body).toContain("## Evidence pointers");
    expect(body).toMatch(/## Evidence pointers\n- \(none\)/);
  });

  it("renders (none) for a null step id and (unset) for a null repo path", () => {
    const body = buildWorkflowRecoveryMarkdown(
      makeFullInput({ stepId: null, repoPath: null }),
    );
    expect(body).toContain("- Step ID: (none)");
    expect(body).toContain("- Repo path: (unset)");
  });

  it("renders classification-specific safe next steps for every recovery code", () => {
    for (const code of WORKFLOW_MONITOR_RECOVERY_CODES) {
      const body = buildWorkflowRecoveryMarkdown(
        makeFullInput({ classification: code }),
      );
      expect(body).toContain("## Safe next steps");
      const steps = workflowRecoverySafeNextSteps(code);
      expect(steps.length).toBeGreaterThan(0);
      for (const step of steps) {
        expect(body).toContain(step);
      }
    }
  });

  it("renders the evidence-backed clear command for failed external side effect steps", () => {
    const body = buildWorkflowRecoveryMarkdown(
      makeFullInput({ classification: "failed_external_side_effect_step" }),
    );
    expect(body).toContain(
      "momentum workflow run clear-recovery <run-id> --evidence-pointer <ref>",
    );
  });

  it("renders the shared safety and rollback notes", () => {
    const body = buildWorkflowRecoveryMarkdown(makeFullInput());
    expect(body).toContain("## Safety and rollback notes");
    for (const note of WORKFLOW_RECOVERY_SAFETY_NOTES) {
      expect(body).toContain(note);
    }
  });

  it("allows callers to override safe next steps and safety notes", () => {
    const body = buildWorkflowRecoveryMarkdown(
      makeFullInput({
        safeNextSteps: ["Custom operator step."],
        safetyNotes: ["Custom safety note."],
      }),
    );
    expect(body).toContain("1. Custom operator step.");
    expect(body).toContain("- Custom safety note.");
  });

  it("does not leak raw token or transcript content (structural guard)", () => {
    // The renderer only accepts structured, bounded fields. There is no field
    // through which raw chat transcripts or secrets can flow, so a typical
    // input produces output containing only the structured pointers we passed.
    const body = buildWorkflowRecoveryMarkdown(makeFullInput());
    expect(body).not.toContain("BEGIN PRIVATE KEY");
    expect(body).not.toContain("ghp_");
    expect(body).not.toMatch(/\bsk-[A-Za-z0-9]{8,}\b/);
  });

  it("requires a run id", () => {
    expect(() =>
      buildWorkflowRecoveryMarkdown(makeFullInput({ runId: "" })),
    ).toThrow(/runId is required/);
  });

  it("requires a finite classifiedAt", () => {
    expect(() =>
      buildWorkflowRecoveryMarkdown(
        makeFullInput({ classifiedAt: Number.NaN }),
      ),
    ).toThrow(/classifiedAt/);
  });

  it("rejects an unknown recovery classification", () => {
    expect(() =>
      buildWorkflowRecoveryMarkdown(
        makeFullInput({
          classification: "not_a_real_code" as never,
        }),
      ),
    ).toThrow(/classification/);
  });
});

describe("live run-level recovery classifications (M9)", () => {
  it("layers the live run-level recovery codes on top of the monitor taxonomy", () => {
    expect([...WORKFLOW_LIVE_RUN_RECOVERY_CODES]).toEqual([
      "head_mismatch",
      "result_missing",
      "result_invalid",
      "reset_failed",
      "repo_lock_lost",
      "git_failed",
      "commit_failed",
      "invalid_input",
      "unsupported_platform",
      "runtime_unavailable",
      "auth_unavailable",
      "command_failed",
      "command_timed_out",
      "output_overflow",
      "executor_threw",
      "tool_adapter_unavailable",
      "delegate_handoff_failed",
      "delegate_handoff_recovery_required",
      "external_state_unreadable",
      "external_state_inconsistent",
      "manual_recovery_required",
    ]);
    // The full recovery.md render vocabulary is the M7 monitor codes plus the
    // M9 live run-level codes; neither set drops out.
    for (const code of WORKFLOW_MONITOR_RECOVERY_CODES) {
      expect(WORKFLOW_RECOVERY_CLASSIFICATIONS).toContain(code);
    }
    for (const code of WORKFLOW_LIVE_RUN_RECOVERY_CODES) {
      expect(WORKFLOW_RECOVERY_CLASSIFICATIONS).toContain(code);
    }
  });

  it("renders recovery.md for each live run-level code with classification-specific safe next steps", () => {
    for (const code of WORKFLOW_LIVE_RUN_RECOVERY_CODES) {
      const body = buildWorkflowRecoveryMarkdown(
        makeFullInput({ classification: code }),
      );
      expect(body).toContain(`- Recovery classification: ${code}`);
      const steps = workflowRecoverySafeNextSteps(code);
      expect(steps.length).toBeGreaterThan(0);
      for (const step of steps) {
        expect(body).toContain(step);
      }
    }
  });

  it("orders unsupported-platform recovery clearing before re-dispatch", () => {
    expect(workflowRecoverySafeNextSteps("unsupported_platform")).toEqual([
      "Move the workflow to a supported Linux or macOS host.",
      "Confirm that no process was launched and no worktree edits were made.",
      "Clear recovery on the supported host, then re-dispatch the prepared step.",
    ]);
  });

  it("still rejects a classification outside the monitor + live taxonomy", () => {
    expect(() =>
      buildWorkflowRecoveryMarkdown(
        makeFullInput({ classification: "totally_made_up" as never }),
      ),
    ).toThrow(/classification/);
  });
});

describe("buildWorkflowRecoveryArtifactInput", () => {
  it("maps a monitor recovery and next action into renderer input", () => {
    const recovery: WorkflowMonitorRecovery = {
      code: "failed_required_step",
      message: "A required step finalized in failed state.",
      stepId: "implementation",
    };
    const nextAction: WorkflowMonitorNextAction = {
      code: "rerun_failed_step",
      stepId: "implementation",
      leaseKind: "managed-step",
      detail: "A required step failed. Decide whether to retry the step.",
    };
    const input = buildWorkflowRecoveryArtifactInput({
      runId: "run-xyz",
      repoPath: "/tmp/repo",
      recovery,
      nextAction,
      evidencePointers: [{ label: "Ledger", ref: "ledger.jsonl" }],
      classifiedAt: 1717000000111,
    });
    expect(input.runId).toBe("run-xyz");
    expect(input.stepId).toBe("implementation");
    expect(input.classification).toBe("failed_required_step");
    expect(input.reason).toBe("A required step finalized in failed state.");
    expect(input.recommendedNextAction.code).toBe("rerun_failed_step");
    expect(input.recommendedNextAction.detail).toContain("retry the step");
    expect(input.repoPath).toBe("/tmp/repo");
    expect(input.classifiedAt).toBe(1717000000111);
  });

  it("renders end-to-end from a monitor recovery classification", () => {
    const recovery: WorkflowMonitorRecovery = {
      code: "manual_recovery_lease",
      message: "An outstanding manual-recovery-required lease is blocking.",
      stepId: "no-mistakes",
    };
    const nextAction: WorkflowMonitorNextAction = {
      code: "clear_recovery",
      stepId: "no-mistakes",
      leaseKind: null,
      detail: "Run is blocked. Clear the manual recovery once resolved.",
    };
    const input = buildWorkflowRecoveryArtifactInput({
      runId: "run-block",
      repoPath: null,
      recovery,
      nextAction,
      evidencePointers: [],
      classifiedAt: 1717000000222,
    });
    const body = buildWorkflowRecoveryMarkdown(input);
    expect(body).toContain("- Recovery classification: manual_recovery_lease");
    expect(body).toContain("- Code: clear_recovery");
    for (const step of workflowRecoverySafeNextSteps("manual_recovery_lease")) {
      expect(body).toContain(step);
    }
  });
});

describe("writeWorkflowRecoveryArtifact", () => {
  it("writes recovery.md under the run directory, creating it if absent", () => {
    const base = makeTempDir();
    const result = writeWorkflowRecoveryArtifact({
      agentWorkflowsDir: base,
      input: makeFullInput({ runId: "run-write" }),
    });
    expect(result.path).toBe(
      path.join(base, "run-write", WORKFLOW_RECOVERY_ARTIFACT_FILENAME),
    );
    const onDisk = fs.readFileSync(result.path, "utf-8");
    expect(onDisk).toContain(
      "# Manual recovery required: workflow run run-write",
    );
    expect(onDisk).toContain("## Safe next steps");
  });

  it("overwrites a stale recovery.md so the artifact reflects the latest classification", () => {
    const base = makeTempDir();
    writeWorkflowRecoveryArtifact({
      agentWorkflowsDir: base,
      input: makeFullInput({
        runId: "run-rewrite",
        classification: "stale_running_step",
      }),
    });
    const second = writeWorkflowRecoveryArtifact({
      agentWorkflowsDir: base,
      input: makeFullInput({
        runId: "run-rewrite",
        classification: "failed_required_step",
      }),
    });
    const onDisk = fs.readFileSync(second.path, "utf-8");
    expect(onDisk).toContain("- Recovery classification: failed_required_step");
    expect(onDisk).not.toContain(
      "- Recovery classification: stale_running_step",
    );
  });

  it("replaces a recovery.md symlink without writing through it", () => {
    const base = makeTempDir();
    const outside = path.join(makeTempDir(), "outside.md");
    fs.writeFileSync(outside, "outside must remain unchanged", "utf8");

    const runDir = path.join(base, "run-symlink");
    fs.mkdirSync(runDir, { recursive: true });
    const symlinkPath = path.join(runDir, WORKFLOW_RECOVERY_ARTIFACT_FILENAME);
    fs.symlinkSync(outside, symlinkPath);

    const result = writeWorkflowRecoveryArtifact({
      agentWorkflowsDir: base,
      input: makeFullInput({ runId: "run-symlink" }),
    });

    expect(result.path).toBe(symlinkPath);
    expect(fs.readFileSync(outside, "utf8")).toBe(
      "outside must remain unchanged",
    );
    expect(fs.lstatSync(symlinkPath).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(symlinkPath, "utf8")).toContain(
      "# Manual recovery required: workflow run run-symlink",
    );
  });
});
