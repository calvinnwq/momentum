import fs from "node:fs";
import path from "node:path";

import { parseAcpConfig } from "../../adapters/acp-config.js";
import { parseTrustedShellConfig } from "../../adapters/trusted-shell-config.js";
import type { GoalSpec } from "./types.js";

/**
 * Filename for the manual-recovery artifact stored at the goal artifact root.
 * Co-located with goal.md / handoff.md so operators discover it through the
 * same filesystem layout the rest of Momentum uses.
 */
export const RECOVERY_ARTIFACT_FILENAME = "recovery.md";

/**
 * Schema version of the rendered artifact. Bump when the section layout or
 * field semantics change so downstream tooling can branch deterministically.
 */
export const RECOVERY_ARTIFACT_SCHEMA_VERSION = 1;

export type RecoveryArtifactRunnerProfile = {
  runner: string;
  command?: string;
  args?: readonly string[];
  cwd?: "repo" | "iteration";
  timeoutSec?: number;
  resultFile?: string;
  note?: string;
};

/**
 * Renders the runner-profile summary recorded on recovery artifacts from a
 * stored goal spec. Retained from the retired goal-iteration mechanism so
 * stale-goal recovery keeps rendering the same profile detail for durable
 * specs written before the lane was removed.
 */
export function buildRunnerProfileSummary(
  spec: GoalSpec
): RecoveryArtifactRunnerProfile {
  if (spec.runner === "trusted-shell") {
    const parsed = parseTrustedShellConfig(spec.trusted_shell);
    if (!parsed.ok) {
      return {
        runner: spec.runner,
        note: `runner profile parse error: ${parsed.error}`
      };
    }
    return {
      runner: spec.runner,
      command: parsed.config.command,
      args: [...parsed.config.args],
      cwd: parsed.config.cwd,
      timeoutSec: parsed.config.timeoutSec,
      resultFile: parsed.config.resultFile
    };
  }

  if (spec.runner === "acp") {
    const parsed = parseAcpConfig(spec.acp);
    if (!parsed.ok) {
      return {
        runner: spec.runner,
        note: `runner profile parse error: ${parsed.error}`
      };
    }
    return {
      runner: spec.runner,
      command: parsed.config.command,
      args: [...parsed.config.args],
      cwd: parsed.config.cwd,
      timeoutSec: parsed.config.timeoutSec,
      resultFile: parsed.config.resultFile
    };
  }

  return {
    runner: spec.runner
  };
}

/**
 * Compact reason payload describing why a goal was routed to manual recovery.
 * `code` is the stable taxonomy string (e.g. `repo_dirty`, `repo_unknown_commit`,
 * `daemon_canceled_active_job`) and `message` is the operator-facing detail.
 */
export type RecoveryArtifactReason = {
  code: string;
  message: string;
};

/**
 * Pointers to per-iteration artifacts the operator should inspect while
 * resolving the recovery. Any field may be `null` when the underlying file was
 * never created (e.g. the runner never ran, or the verification stage was
 * skipped) so the rendered artifact can show a `(none)` placeholder rather
 * than promising a missing path.
 */
export type RecoveryArtifactPathBundle = {
  iterationDir: string;
  promptPath?: string | null;
  runnerLog: string | null;
  verificationLog: string | null;
  resultJson: string | null;
};

/**
 * Self-contained input for rendering / writing a `recovery.md`. Designed to be
 * built by callers that already have the goal/job context (daemon recovery and
 * stale-recovery skip paths) without needing to re-query the database from this
 * module. Keeping the artifact generator pure makes it cheap to test and to
 * reuse from CLI subcommands that may not have a live db handle.
 */
export type RecoveryArtifactInput = {
  goalId: string;
  goalTitle: string;
  iteration: number;
  jobId: string | null;
  daemonRunId: string | null;
  repoPath: string | null;
  expectedCommit: string | null;
  currentCommit: string | null;
  reason: RecoveryArtifactReason;
  runnerProfile?: RecoveryArtifactRunnerProfile;
  artifactPaths: RecoveryArtifactPathBundle;
  safeNextSteps: readonly string[];
  classifiedAt: number;
  schemaVersion?: number;
};

export type WriteRecoveryArtifactInput = {
  dataDir: string;
  input: RecoveryArtifactInput;
};

export type WriteRecoveryArtifactResult = {
  path: string;
};

/**
 * Resolve the goal-scoped path where a `recovery.md` artifact lives. Mirrors
 * `resolveGoalArtifactPaths` from `artifacts.ts` but is intentionally a pure
 * helper so callers without an `iteration` (e.g. the CLI ack/retry surface)
 * can locate the file without constructing a full `GoalArtifactPaths`.
 */
export function resolveRecoveryArtifactPath(
  dataDir: string,
  goalId: string
): string {
  if (typeof goalId !== "string" || goalId.length === 0) {
    throw new Error("resolveRecoveryArtifactPath: goalId is required");
  }
  return path.join(dataDir, "goals", goalId, RECOVERY_ARTIFACT_FILENAME);
}

export function buildRecoveryMarkdown(input: RecoveryArtifactInput): string {
  validateInput(input);

  const schemaVersion =
    input.schemaVersion ?? RECOVERY_ARTIFACT_SCHEMA_VERSION;
  const lines: string[] = [];

  lines.push(`# Manual recovery required: ${input.goalTitle}`);
  lines.push("");
  lines.push(`- Schema version: ${schemaVersion}`);
  lines.push(`- Goal ID: ${input.goalId}`);
  lines.push(`- Job ID: ${input.jobId ?? "(none)"}`);
  lines.push(`- Iteration: ${input.iteration}`);
  lines.push(`- Daemon run ID: ${input.daemonRunId ?? "(none)"}`);
  lines.push(`- Repo path: ${input.repoPath ?? "(unset)"}`);
  lines.push(`- Classified at (epoch ms): ${input.classifiedAt}`);
  lines.push("");

  lines.push("## Reason");
  lines.push(`- Code: ${input.reason.code}`);
  lines.push(`- Message: ${input.reason.message}`);
  lines.push("");

  lines.push("## Runner/profile summary");
  const runnerProfile = input.runnerProfile ?? { runner: "unknown" };
  lines.push(`- Runner: ${runnerProfile.runner}`);
  if (runnerProfile.command !== undefined && runnerProfile.command.length > 0) {
    lines.push(`- Command: ${runnerProfile.command}`);
  }
  if (runnerProfile.args !== undefined && runnerProfile.args.length > 0) {
    lines.push(`- Args: ${runnerProfile.args.join(" ")}`);
  }
  if (runnerProfile.cwd !== undefined) {
    lines.push(`- CWD: ${runnerProfile.cwd}`);
  }
  if (runnerProfile.timeoutSec !== undefined) {
    lines.push(`- Timeout (sec): ${runnerProfile.timeoutSec}`);
  }
  if (runnerProfile.resultFile !== undefined && runnerProfile.resultFile.length > 0) {
    lines.push(`- Result file: ${runnerProfile.resultFile}`);
  }
  if (runnerProfile.note !== undefined && runnerProfile.note.length > 0) {
    lines.push(`- Note: ${runnerProfile.note}`);
  }
  lines.push("");

  lines.push("## Commit pointers");
  lines.push(
    `- Expected (pre-iteration) commit: ${input.expectedCommit ?? "(unknown)"}`
  );
  lines.push(`- Current commit: ${input.currentCommit ?? "(unknown)"}`);
  lines.push("");

  lines.push("## Relevant artifacts");
  lines.push(`- Iteration dir: ${input.artifactPaths.iterationDir}`);
  lines.push(`- Prompt: ${input.artifactPaths.promptPath ?? "(none)"}`);
  lines.push(`- Runner log: ${input.artifactPaths.runnerLog ?? "(none)"}`);
  lines.push(
    `- Verification log: ${input.artifactPaths.verificationLog ?? "(none)"}`
  );
  lines.push(`- Result JSON: ${input.artifactPaths.resultJson ?? "(none)"}`);
  lines.push("");

  lines.push("## Safe next steps");
  if (input.safeNextSteps.length === 0) {
    lines.push(
      "- No automatic next steps suggested. Inspect the artifacts above and decide manually."
    );
  } else {
    input.safeNextSteps.forEach((step, index) => {
      lines.push(`${index + 1}. ${step}`);
    });
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Render and atomically write a `recovery.md` to the goal's artifact dir,
 * creating the directory if it does not yet exist (e.g. for failure modes
 * classified before any iteration artifact has been laid down). Overwriting an
 * existing file is intentional: the artifact reflects the most recent manual-
 * recovery classification and stale text would mislead operators.
 */
export function writeRecoveryArtifact(
  options: WriteRecoveryArtifactInput
): WriteRecoveryArtifactResult {
  const body = buildRecoveryMarkdown(options.input);
  const target = resolveRecoveryArtifactPath(
    options.dataDir,
    options.input.goalId
  );
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body, "utf-8");
  return { path: target };
}

function validateInput(input: RecoveryArtifactInput): void {
  if (typeof input.goalId !== "string" || input.goalId.length === 0) {
    throw new Error("buildRecoveryMarkdown: goalId is required");
  }
  if (typeof input.goalTitle !== "string" || input.goalTitle.length === 0) {
    throw new Error("buildRecoveryMarkdown: goalTitle is required");
  }
  if (!Number.isInteger(input.iteration) || input.iteration < 1) {
    throw new Error(
      `buildRecoveryMarkdown: iteration must be a positive integer, got ${input.iteration}`
    );
  }
  if (
    typeof input.reason.code !== "string" ||
    input.reason.code.length === 0
  ) {
    throw new Error("buildRecoveryMarkdown: reason.code is required");
  }
  if (
    typeof input.reason.message !== "string" ||
    input.reason.message.length === 0
  ) {
    throw new Error("buildRecoveryMarkdown: reason.message is required");
  }
  if (!Number.isFinite(input.classifiedAt)) {
    throw new Error(
      "buildRecoveryMarkdown: classifiedAt must be a finite epoch millisecond"
    );
  }
  if (
    typeof input.artifactPaths.iterationDir !== "string" ||
    input.artifactPaths.iterationDir.length === 0
  ) {
    throw new Error(
      "buildRecoveryMarkdown: artifactPaths.iterationDir is required"
    );
  }
}
