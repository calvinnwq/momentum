/**
 * Run-scoped recovery artifact renderer.
 *
 * Renders the per-run `.agent-workflows/<runId>/recovery.md` artifact from
 * either the workflow-run monitor reducer's recovery classification, the live
 * run-level recovery classifications, or the executor-loop scheduler lane's stale
 * workflow-lease recovery classification. The renderer is the run-scoped
 * sibling of the goal-scoped `recovery-artifact.ts`: it owns artifact
 * *generation* only and never touches SQLite, executors, or the durable flag;
 * the durable `WorkflowRun.needs_manual_recovery` wiring and the explicit
 * clear path compose with this renderer through the recovery slice, live
 * live recovery seams, and executor-loop scheduler-lane recovery.
 *
 * The renderer is intentionally pure and accepts only structured, bounded
 * fields (run id, step id, classification, evidence pointers, recommended next
 * action, safe next steps, safety notes). There is no field through which raw
 * chat transcripts, runner stdout, or secrets can flow, which structurally
 * keeps the artifact free of secrets and private data per the recovery
 * safety contract.
 */

import fs from "node:fs";
import path from "node:path";

import {
  WORKFLOW_MONITOR_RECOVERY_CODES,
  type WorkflowMonitorNextAction,
  type WorkflowMonitorRecovery,
  type WorkflowMonitorRecoveryCode,
} from "../monitor/state.js";

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

/**
 * Live run-level recovery classifications that live-wrapper layers on top of the workflow-run
 * monitor recovery codes. These are NOT emitted by `deriveWorkflowMonitorState`
 * — they are raised by the live finalization transaction
 * (`head_mismatch`, `reset_failed`, `repo_lock_lost`, `git_failed`,
 * unsafe `commit_failed`, `invalid_input`), result-document checks during
 * finalization or process dispatch (`result_missing` / `result_invalid`), live
 * wrapper process dispatch failures (`unsupported_platform`,
 * `runtime_unavailable`, `auth_unavailable`,
 * `command_failed`, `command_timed_out`, `output_overflow`), trapped executor
 * throws (`executor_threw`), delegated handoff/state reconciliation failures,
 * and wrapper-reported `manual_recovery_required` outcomes
 * rendered into the same per-run `recovery.md`. Extending the recovery taxonomy
 * here is explicitly sanctioned by SPEC.md
 * ("live-wrapper can extend the operator-recovery taxonomy, but it cannot collapse distinct failure
 * causes into generic failure text"). The monitor reducer's emitted-code type
 * stays untouched so the substrate never claims to produce a code it cannot.
 */
export const WORKFLOW_LIVE_RUN_RECOVERY_CODES = [
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
] as const;
export type WorkflowLiveRunRecoveryCode =
  (typeof WORKFLOW_LIVE_RUN_RECOVERY_CODES)[number];

/**
 * Every classification `recovery.md` can render: the workflow-run monitor recovery codes
 * plus the live run-level recovery codes. This is the single source of truth
 * the renderer validates against. The executor-loop scheduler lane reuses the
 * monitor-owned `manual_recovery_lease` classification when a stale workflow
 * lease requires operator action, so it needs no separate live-only code here.
 */
export type WorkflowRecoveryClassification =
  WorkflowMonitorRecoveryCode | WorkflowLiveRunRecoveryCode;

export const WORKFLOW_RECOVERY_CLASSIFICATIONS: readonly WorkflowRecoveryClassification[] =
  [...WORKFLOW_MONITOR_RECOVERY_CODES, ...WORKFLOW_LIVE_RUN_RECOVERY_CODES];

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
 * Encodes the recovery safety contract: prefer blocking over guessing, never
 * auto-clear from elapsed time, no automatic repair or live process killing,
 * and the rollback is reverting the flag/artifact wiring without disturbing the
 * upstream monitor-derived, live-run, or scheduler-lane recovery source.
 */
export const WORKFLOW_RECOVERY_SAFETY_NOTES: readonly string[] = [
  "Recovery never auto-clears from elapsed time alone; an operator must explicitly clear it once the blocking state is resolved.",
  "Momentum does not kill processes or perform automatic repair; resolve the underlying cause manually before clearing recovery.",
  "Rollback: revert the run-scoped recovery flag and artifact wiring. The upstream monitor-derived, live-run, or scheduler-lane recovery source is unchanged by this artifact.",
];

const SAFE_NEXT_STEPS: Record<
  WorkflowRecoveryClassification,
  readonly string[]
> = {
  manual_recovery_lease: [
    "Inspect the outstanding manual-recovery-required lease with `momentum workflow status <run-id>`.",
    "Resolve or release the blocking lease before clearing recovery.",
    "Do not force a step transition or approval while the lease is unresolved.",
  ],
  ghost_active_no_lease: [
    "Inspect the `.agent-workflows/<run-id>/` run directory; no dispatch lease was ever recorded for the running step.",
    "Confirm no managed child is still running before clearing recovery.",
    "Decide whether to re-dispatch the step or cancel the run.",
  ],
  stale_running_step: [
    "Inspect the stale dispatch lease and the run directory for partial progress.",
    "Confirm the managed child has actually exited before clearing recovery.",
    "Decide whether to resume, re-dispatch, or cancel the running step.",
  ],
  monitor_drift_stale: [
    "Re-import the run with `momentum workflow import` to refresh the monitor advisory snapshot.",
    "Treat the durable substrate state as authoritative; the monitor snapshot may be stale.",
    "Confirm no other recovery condition applies before clearing recovery.",
  ],
  failed_required_step: [
    "Inspect the failed required step's executor log and artifact tree.",
    "Decide whether to retry the step or keep the run blocked for manual handling.",
    "Do not approve past the failed step until the failure is understood.",
  ],
  failed_external_side_effect_step: [
    "Verify the external side effects the tail step may have already landed: the pushed branch, the merged pull request, and the tracker / Linear intent state.",
    "Reconcile from that external success evidence rather than re-running the step; a blind re-run could double-merge the pull request or re-write the tracker.",
    "Clear recovery with `momentum workflow run clear-recovery <run-id> --evidence-pointer <ref>` only once the external state is confirmed consistent.",
  ],
  head_mismatch: [
    "Inspect the unexpected HEAD against the recorded base SHA with `git -C <repo> log`.",
    "Momentum refused a destructive reset: a non-Momentum commit on HEAD must be preserved, not discarded.",
    "Decide manually whether to keep, amend, or roll back the unexpected commit before clearing recovery.",
  ],
  result_missing: [
    "Inspect the live step's normalized result file path; the runner exited without writing it.",
    "Confirm the step's true outcome from its executor log before retrying — the result is unknown, so Momentum did not commit or reset.",
    "Re-dispatch the step or cancel the run once the missing result is understood.",
  ],
  result_invalid: [
    "Inspect the malformed live step result document; it is not a valid normalized runner result.",
    "Confirm the step's true outcome from its executor log before retrying — the result cannot be trusted, so Momentum did not commit or reset.",
    "Re-dispatch the step or cancel the run once the invalid result is understood.",
  ],
  reset_failed: [
    "Inspect the worktree and reset error before approving any later step.",
    "Confirm whether live-step edits are still present; Momentum could not restore the recorded base automatically.",
    "Clean up or preserve the worktree manually before clearing recovery.",
  ],
  repo_lock_lost: [
    "Inspect the active repo lock owner and the worktree before approving any later step.",
    "Confirm no other Momentum process is still mutating the repository.",
    "Re-establish repo ownership or clean up manually before clearing recovery.",
  ],
  git_failed: [
    "Inspect the git error and current worktree state before approving any later step.",
    "Confirm whether live-step edits are still present; Momentum could not prove the repository state.",
    "Restore or preserve the worktree manually before clearing recovery.",
  ],
  commit_failed: [
    "Inspect the commit failure and current worktree state before approving any later step.",
    "Confirm whether live-step edits are still staged or unstaged; Momentum did not prove cleanup.",
    "Commit, reset, or preserve the worktree manually before clearing recovery.",
  ],
  invalid_input: [
    "Inspect the live-step finalization inputs and run directory before approving any later step.",
    "Confirm whether live-step edits are present; Momentum refused to commit or reset with invalid inputs.",
    "Correct the invalid inputs and clean up or preserve the worktree manually before clearing recovery.",
  ],
  unsupported_platform: [
    "Move the workflow to a supported Linux or macOS host.",
    "Confirm that no process was launched and no worktree edits were made.",
    "Clear recovery on the supported host, then re-dispatch the prepared step.",
  ],
  runtime_unavailable: [
    "Inspect the live step executor log and runtime configuration.",
    "Confirm whether the wrapper made worktree edits before the runtime failure.",
    "Clean up or preserve any partial worktree changes before clearing recovery.",
  ],
  auth_unavailable: [
    "Inspect the live step executor log and authentication setup.",
    "Confirm whether the wrapper made worktree edits before authentication failed.",
    "Clean up or preserve any partial worktree changes before clearing recovery.",
  ],
  command_failed: [
    "Inspect the live step executor log for the failed command.",
    "Confirm whether partial worktree edits should be kept, reset, or retried.",
    "Resolve the worktree state manually before clearing recovery.",
  ],
  command_timed_out: [
    "Inspect the live step executor log and confirm the command is no longer running.",
    "Confirm whether the timeout left partial worktree edits behind.",
    "Clean up or preserve any partial worktree changes before clearing recovery.",
  ],
  output_overflow: [
    "Inspect the live step executor log size and truncation boundary.",
    "Confirm whether the wrapper left partial worktree edits before output capture stopped.",
    "Clean up or preserve any partial worktree changes before clearing recovery.",
  ],
  executor_threw: [
    "Inspect the executor error and run directory.",
    "Confirm whether the executor left partial worktree edits before throwing.",
    "Clean up or preserve any partial worktree changes before clearing recovery.",
  ],
  tool_adapter_unavailable: [
    "Inspect the delegated executor configuration and registered tool adapters.",
    "Confirm whether any external run was launched before the adapter became unavailable.",
    "Restore the configured adapter before clearing recovery and retrying the step.",
  ],
  delegate_handoff_failed: [
    "Inspect the delegated handoff receipt, executor log, and external tool state.",
    "Reconcile whether the external run was launched before the handoff failed.",
    "Preserve correlated external evidence before clearing recovery and retrying.",
  ],
  delegate_handoff_recovery_required: [
    "Inspect the prior handoff intent, receipt, and external tool run before retrying.",
    "Correlate the existing external run; do not launch a duplicate side effect.",
    "Restore recoverable handoff evidence before clearing recovery and retrying.",
  ],
  external_state_unreadable: [
    "Inspect the delegated external-state artifact and tool status output.",
    "Restore a readable, correlated state snapshot without launching a new external run.",
    "Clear recovery only after the supervisor can read the external state again.",
  ],
  external_state_inconsistent: [
    "Inspect the mirrored external identity, findings, decisions, and terminal evidence.",
    "Reconcile the external run until its durable state is internally consistent.",
    "Clear recovery only after the supervisor can safely resume classification.",
  ],
  manual_recovery_required: [
    "Inspect the live step executor log and run directory for the manual recovery request.",
    "Confirm whether partial worktree edits should be kept, reset, or retried.",
    "Resolve the worktree state manually before clearing recovery.",
  ],
};

/**
 * Default classification-specific operator steps. Exported so the CLI clear
 * path and future surfaces can reuse the same guidance the artifact renders.
 */
export function workflowRecoverySafeNextSteps(
  code: WorkflowRecoveryClassification,
): readonly string[] {
  return SAFE_NEXT_STEPS[code] ?? [];
}

export type WorkflowRecoveryEvidencePointer = {
  label: string;
  ref: string;
};

/**
 * The recommended next action surfaced from the workflow-run monitor reducer's
 * `nextAction`, an live run-level recovery seam, or the executor-loop scheduler lane's
 * stale workflow-lease recovery. Monitor-derived inputs carry the reducer's
 * stable code/detail, live recovery inputs carry live-specific `investigate_*`
 * codes and operator-facing detail, and scheduler-lane lease recovery carries
 * the guarded `clear_recovery` action after the underlying lease condition is
 * resolved; lease internals stay in the substrate.
 */
export type WorkflowRecoveryNextAction = {
  code: string;
  detail: string;
  stepId?: string | null;
};

/**
 * Self-contained input for rendering / writing a run-scoped `recovery.md`.
 * Built from a monitor reducer classification (see
 * {@link buildWorkflowRecoveryArtifactInput}), a live run-level recovery seam,
 * or the scheduler lane's stale workflow-lease recovery path, so the renderer
 * never needs a live db handle or the file system to assemble its body.
 */
export type WorkflowRecoveryArtifactInput = {
  runId: string;
  stepId: string | null;
  classification: WorkflowRecoveryClassification;
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
  options: BuildWorkflowRecoveryArtifactInput,
): WorkflowRecoveryArtifactInput {
  const input: WorkflowRecoveryArtifactInput = {
    runId: options.runId,
    stepId: options.recovery.stepId,
    classification: options.recovery.code,
    reason: options.recovery.message,
    recommendedNextAction: {
      code: options.nextAction.code,
      detail: options.nextAction.detail,
      stepId: options.nextAction.stepId,
    },
    evidencePointers: options.evidencePointers ?? [],
    repoPath: options.repoPath ?? null,
    classifiedAt: options.classifiedAt,
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
  runId: string,
): string {
  if (typeof agentWorkflowsDir !== "string" || agentWorkflowsDir.length === 0) {
    throw new Error(
      "resolveWorkflowRecoveryArtifactPath: agentWorkflowsDir is required",
    );
  }
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error("resolveWorkflowRecoveryArtifactPath: runId is required");
  }
  if (!isSafeWorkflowRunPathSegment(runId)) {
    throw new Error(
      "resolveWorkflowRecoveryArtifactPath: runId must be a safe path segment",
    );
  }
  return path.join(
    agentWorkflowsDir,
    runId,
    WORKFLOW_RECOVERY_ARTIFACT_FILENAME,
  );
}

export function resolveWorkflowRecoveryArtifactPathInRunDir(
  runDir: string,
): string {
  if (typeof runDir !== "string" || runDir.length === 0) {
    throw new Error(
      "resolveWorkflowRecoveryArtifactPathInRunDir: runDir is required",
    );
  }
  return path.join(runDir, WORKFLOW_RECOVERY_ARTIFACT_FILENAME);
}

export function buildWorkflowRecoveryMarkdown(
  input: WorkflowRecoveryArtifactInput,
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
      "- No automatic next steps suggested. Inspect the run directory and decide manually.",
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
  options: WriteWorkflowRecoveryArtifactInput,
): WriteWorkflowRecoveryArtifactResult {
  const body = buildWorkflowRecoveryMarkdown(options.input);
  const target = resolveWorkflowRecoveryArtifactPath(
    options.agentWorkflowsDir,
    options.input.runId,
  );
  writeFileReplacingTarget(target, body);
  return { path: target };
}

export function writeWorkflowRecoveryArtifactInRunDir(
  options: WriteWorkflowRecoveryArtifactInRunDirInput,
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
      .slice(2)}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      temp,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600,
    );
    fs.writeFileSync(fd, body, "utf-8");
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, target);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
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
    !(WORKFLOW_RECOVERY_CLASSIFICATIONS as readonly string[]).includes(
      input.classification,
    )
  ) {
    throw new Error(
      `buildWorkflowRecoveryMarkdown: unknown recovery classification ${String(
        input.classification,
      )}`,
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
      "buildWorkflowRecoveryMarkdown: recommendedNextAction.code is required",
    );
  }
  if (!Number.isFinite(input.classifiedAt)) {
    throw new Error(
      "buildWorkflowRecoveryMarkdown: classifiedAt must be a finite epoch millisecond",
    );
  }
}
