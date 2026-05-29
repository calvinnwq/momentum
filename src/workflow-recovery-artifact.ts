/**
 * Run-scoped recovery artifact renderer (NGX-327, M8-04).
 *
 * Renders the per-run `.agent-workflows/<runId>/recovery.md` artifact from the
 * M7 monitor reducer's recovery classification. The renderer is the run-scoped
 * sibling of the M3 goal-scoped `recovery-artifact.ts`: it owns artifact
 * *generation* only and never touches SQLite, executors, or the durable flag
 * (the durable `WorkflowRun.needs_manual_recovery` wiring and the explicit
 * clear path are layered on in follow-up M8-04 slices).
 *
 * The renderer is intentionally pure and accepts only structured, bounded
 * fields (run id, step id, classification, evidence pointers, recommended next
 * action, safe next steps, safety notes). There is no field through which raw
 * chat transcripts, runner stdout, or secrets can flow, which structurally
 * keeps the artifact free of secrets and private data per the NGX-327
 * acceptance criteria.
 */

import fs from "node:fs";
import path from "node:path";

import {
  WORKFLOW_MONITOR_RECOVERY_CODES,
  type WorkflowMonitorNextAction,
  type WorkflowMonitorRecovery,
  type WorkflowMonitorRecoveryCode
} from "./workflow-monitor-state.js";

/**
 * Filename for the run-scoped manual-recovery artifact. Co-located with the
 * skill-owned `plan.json` / `ledger.jsonl` inside `.agent-workflows/<runId>/`
 * so operators discover it through the same layout the rest of a run uses.
 */
export const WORKFLOW_RECOVERY_ARTIFACT_FILENAME = "recovery.md";

/**
 * Schema version of the rendered artifact. Bump when the section layout or
 * field semantics change so downstream tooling can branch deterministically.
 */
export const WORKFLOW_RECOVERY_ARTIFACT_SCHEMA_VERSION = 1;

export function isSafeWorkflowRunPathSegment(runId: string): boolean {
  return (
    runId.length > 0 &&
    runId !== "." &&
    runId !== ".." &&
    !runId.includes("/") &&
    !runId.includes("\\") &&
    !runId.includes("\0")
  );
}

/**
 * Shared safety / rollback guidance rendered for every recovery classification.
 * Encodes the NGX-327 safety contract: prefer blocking over guessing, never
 * auto-clear from elapsed time, no automatic repair or live process killing,
 * and the rollback is reverting the flag/artifact wiring without disturbing the
 * M7 monitor reducer classification.
 */
export const WORKFLOW_RECOVERY_SAFETY_NOTES: readonly string[] = [
  "Recovery never auto-clears from elapsed time alone; an operator must explicitly clear it once the blocking state is resolved.",
  "Momentum does not kill processes or perform automatic repair; resolve the underlying cause manually before clearing recovery.",
  "Rollback: revert the run-scoped recovery flag and artifact wiring. The M7 monitor reducer classification is unchanged by this artifact."
];

const SAFE_NEXT_STEPS: Record<
  WorkflowMonitorRecoveryCode,
  readonly string[]
> = {
  manual_recovery_lease: [
    "Inspect the outstanding manual-recovery-required lease with `momentum workflow status <run-id>`.",
    "Resolve or release the blocking lease before clearing recovery.",
    "Do not force a step transition or approval while the lease is unresolved."
  ],
  ghost_active_no_lease: [
    "Inspect the `.agent-workflows/<run-id>/` run directory; no dispatch lease was ever recorded for the running step.",
    "Confirm no managed child is still running before clearing recovery.",
    "Decide whether to re-dispatch the step or cancel the run."
  ],
  stale_running_step: [
    "Inspect the stale dispatch lease and the run directory for partial progress.",
    "Confirm the managed child has actually exited before clearing recovery.",
    "Decide whether to resume, re-dispatch, or cancel the running step."
  ],
  monitor_drift_stale: [
    "Re-import the run with `momentum workflow import` to refresh the monitor advisory snapshot.",
    "Treat the durable substrate state as authoritative; the monitor snapshot may be stale.",
    "Confirm no other recovery condition applies before clearing recovery."
  ],
  failed_required_step: [
    "Inspect the failed required step's executor log and artifact tree.",
    "Decide whether to retry the step or keep the run blocked for manual handling.",
    "Do not approve past the failed step until the failure is understood."
  ]
};

/**
 * Default classification-specific operator steps. Exported so the CLI clear
 * path and future surfaces can reuse the same guidance the artifact renders.
 */
export function workflowRecoverySafeNextSteps(
  code: WorkflowMonitorRecoveryCode
): readonly string[] {
  return SAFE_NEXT_STEPS[code] ?? [];
}

export type WorkflowRecoveryEvidencePointer = {
  label: string;
  ref: string;
};

/**
 * The recommended next action surfaced from the M7 monitor reducer's
 * `nextAction`. Only the stable code and operator-facing detail are carried;
 * lease internals stay in the substrate.
 */
export type WorkflowRecoveryNextAction = {
  code: string;
  detail: string;
  stepId?: string | null;
};

/**
 * Self-contained input for rendering / writing a run-scoped `recovery.md`.
 * Built from a monitor reducer classification (see
 * {@link buildWorkflowRecoveryArtifactInput}) so the renderer never needs a
 * live db handle or the file system to assemble its body.
 */
export type WorkflowRecoveryArtifactInput = {
  runId: string;
  stepId: string | null;
  classification: WorkflowMonitorRecoveryCode;
  reason: string;
  recommendedNextAction: WorkflowRecoveryNextAction;
  evidencePointers: readonly WorkflowRecoveryEvidencePointer[];
  repoPath?: string | null;
  safeNextSteps?: readonly string[];
  safetyNotes?: readonly string[];
  classifiedAt: number;
  schemaVersion?: number;
};

export type BuildWorkflowRecoveryArtifactInput = {
  runId: string;
  repoPath?: string | null;
  recovery: WorkflowMonitorRecovery;
  nextAction: WorkflowMonitorNextAction;
  evidencePointers?: readonly WorkflowRecoveryEvidencePointer[];
  classifiedAt: number;
  schemaVersion?: number;
};

/**
 * Bridge a monitor reducer recovery classification (`WorkflowMonitorState`'s
 * `recovery` + `nextAction`) into renderer input. Keeps callers from
 * re-deriving the artifact shape: the monitor reducer stays the single source
 * of truth for the recovery code, message, and recommended next action.
 */
export function buildWorkflowRecoveryArtifactInput(
  options: BuildWorkflowRecoveryArtifactInput
): WorkflowRecoveryArtifactInput {
  const input: WorkflowRecoveryArtifactInput = {
    runId: options.runId,
    stepId: options.recovery.stepId,
    classification: options.recovery.code,
    reason: options.recovery.message,
    recommendedNextAction: {
      code: options.nextAction.code,
      detail: options.nextAction.detail,
      stepId: options.nextAction.stepId
    },
    evidencePointers: options.evidencePointers ?? [],
    repoPath: options.repoPath ?? null,
    classifiedAt: options.classifiedAt
  };
  if (options.schemaVersion !== undefined) {
    input.schemaVersion = options.schemaVersion;
  }
  return input;
}

/**
 * Resolve the run-scoped path where a `recovery.md` artifact lives:
 * `<agentWorkflowsDir>/<runId>/recovery.md`. Mirrors the goal-scoped
 * `resolveRecoveryArtifactPath` but keyed by run id under the skill-owned
 * `.agent-workflows/` tree.
 */
export function resolveWorkflowRecoveryArtifactPath(
  agentWorkflowsDir: string,
  runId: string
): string {
  if (typeof agentWorkflowsDir !== "string" || agentWorkflowsDir.length === 0) {
    throw new Error(
      "resolveWorkflowRecoveryArtifactPath: agentWorkflowsDir is required"
    );
  }
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error("resolveWorkflowRecoveryArtifactPath: runId is required");
  }
  if (!isSafeWorkflowRunPathSegment(runId)) {
    throw new Error(
      "resolveWorkflowRecoveryArtifactPath: runId must be a safe path segment"
    );
  }
  return path.join(agentWorkflowsDir, runId, WORKFLOW_RECOVERY_ARTIFACT_FILENAME);
}

export function resolveWorkflowRecoveryArtifactPathInRunDir(
  runDir: string
): string {
  if (typeof runDir !== "string" || runDir.length === 0) {
    throw new Error(
      "resolveWorkflowRecoveryArtifactPathInRunDir: runDir is required"
    );
  }
  return path.join(runDir, WORKFLOW_RECOVERY_ARTIFACT_FILENAME);
}

export function buildWorkflowRecoveryMarkdown(
  input: WorkflowRecoveryArtifactInput
): string {
  validateInput(input);

  const schemaVersion =
    input.schemaVersion ?? WORKFLOW_RECOVERY_ARTIFACT_SCHEMA_VERSION;
  const safeNextSteps =
    input.safeNextSteps ?? workflowRecoverySafeNextSteps(input.classification);
  const safetyNotes = input.safetyNotes ?? WORKFLOW_RECOVERY_SAFETY_NOTES;
  const lines: string[] = [];

  lines.push(`# Manual recovery required: workflow run ${input.runId}`);
  lines.push("");
  lines.push(`- Schema version: ${schemaVersion}`);
  lines.push(`- Run ID: ${input.runId}`);
  lines.push(`- Step ID: ${input.stepId ?? "(none)"}`);
  lines.push(`- Recovery classification: ${input.classification}`);
  lines.push(`- Repo path: ${input.repoPath ?? "(unset)"}`);
  lines.push(`- Classified at (epoch ms): ${input.classifiedAt}`);
  lines.push("");

  lines.push("## Reason");
  lines.push(input.reason);
  lines.push("");

  lines.push("## Recommended next action");
  lines.push(`- Code: ${input.recommendedNextAction.code}`);
  lines.push(`- Detail: ${input.recommendedNextAction.detail}`);
  lines.push("");

  lines.push("## Evidence pointers");
  if (input.evidencePointers.length === 0) {
    lines.push("- (none)");
  } else {
    for (const pointer of input.evidencePointers) {
      lines.push(`- ${pointer.label}: ${pointer.ref}`);
    }
  }
  lines.push("");

  lines.push("## Safe next steps");
  if (safeNextSteps.length === 0) {
    lines.push(
      "- No automatic next steps suggested. Inspect the run directory and decide manually."
    );
  } else {
    safeNextSteps.forEach((step, index) => {
      lines.push(`${index + 1}. ${step}`);
    });
  }
  lines.push("");

  lines.push("## Safety and rollback notes");
  for (const note of safetyNotes) {
    lines.push(`- ${note}`);
  }
  lines.push("");

  return lines.join("\n");
}

export type WriteWorkflowRecoveryArtifactInput = {
  agentWorkflowsDir: string;
  input: WorkflowRecoveryArtifactInput;
};

export type WriteWorkflowRecoveryArtifactInRunDirInput = {
  runDir: string;
  input: WorkflowRecoveryArtifactInput;
};

export type WriteWorkflowRecoveryArtifactResult = {
  path: string;
};

/**
 * Render and write a run-scoped `recovery.md` into the run directory, creating
 * it if absent. Overwriting an existing artifact is intentional: it reflects
 * the most recent manual-recovery classification, and stale text would mislead
 * operators.
 */
export function writeWorkflowRecoveryArtifact(
  options: WriteWorkflowRecoveryArtifactInput
): WriteWorkflowRecoveryArtifactResult {
  const body = buildWorkflowRecoveryMarkdown(options.input);
  const target = resolveWorkflowRecoveryArtifactPath(
    options.agentWorkflowsDir,
    options.input.runId
  );
  writeFileReplacingTarget(target, body);
  return { path: target };
}

export function writeWorkflowRecoveryArtifactInRunDir(
  options: WriteWorkflowRecoveryArtifactInRunDirInput
): WriteWorkflowRecoveryArtifactResult {
  const body = buildWorkflowRecoveryMarkdown(options.input);
  const target = resolveWorkflowRecoveryArtifactPathInRunDir(options.runDir);
  writeFileReplacingTarget(target, body);
  return { path: target };
}

function writeFileReplacingTarget(target: string, body: string): void {
  const targetDir = path.dirname(target);
  fs.mkdirSync(targetDir, { recursive: true });

  const temp = path.join(
    targetDir,
    `.${path.basename(target)}.${process.pid}.${Date.now()}.${Math.random()
      .toString(16)
      .slice(2)}.tmp`
  );
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      temp,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600
    );
    fs.writeFileSync(fd, body, "utf-8");
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, target);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
      }
    }
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

function validateInput(input: WorkflowRecoveryArtifactInput): void {
  if (typeof input.runId !== "string" || input.runId.length === 0) {
    throw new Error("buildWorkflowRecoveryMarkdown: runId is required");
  }
  if (
    !(WORKFLOW_MONITOR_RECOVERY_CODES as readonly string[]).includes(
      input.classification
    )
  ) {
    throw new Error(
      `buildWorkflowRecoveryMarkdown: unknown recovery classification ${String(
        input.classification
      )}`
    );
  }
  if (typeof input.reason !== "string" || input.reason.length === 0) {
    throw new Error("buildWorkflowRecoveryMarkdown: reason is required");
  }
  if (
    typeof input.recommendedNextAction.code !== "string" ||
    input.recommendedNextAction.code.length === 0
  ) {
    throw new Error(
      "buildWorkflowRecoveryMarkdown: recommendedNextAction.code is required"
    );
  }
  if (!Number.isFinite(input.classifiedAt)) {
    throw new Error(
      "buildWorkflowRecoveryMarkdown: classifiedAt must be a finite epoch millisecond"
    );
  }
}
