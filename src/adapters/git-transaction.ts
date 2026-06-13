import { execFileSync, spawnSync } from "node:child_process";

import type { CommitIntent } from "../runner-result.js";

const SHA40_RE = /^[0-9a-f]{40}$/;

export type CommitErrorCode =
  | "invalid_input"
  | "head_mismatch"
  | "nothing_to_commit"
  | "git_failed";

export type CommitFailure = {
  ok: false;
  code: CommitErrorCode;
  error: string;
};

export type CommitSuccess = {
  ok: true;
  commitSha: string;
  parentSha: string;
  message: string;
};

export type CommitResult = CommitFailure | CommitSuccess;

export type CommitInput = {
  repoPath: string;
  baseHead: string;
  commit: CommitIntent;
};

export function commitVerifiedChanges(input: CommitInput): CommitResult {
  const validation = validateCommitInput(input);
  if (!validation.ok) return validation;

  const { repoPath, baseHead, commit } = input;

  let currentHead: string;
  try {
    currentHead = runGit(repoPath, ["rev-parse", "HEAD"]).trim();
  } catch (error) {
    return gitFailure("git rev-parse HEAD failed", error);
  }
  if (currentHead !== baseHead) {
    return {
      ok: false,
      code: "head_mismatch",
      error: `HEAD ${currentHead} does not match expected base ${baseHead}; runner must not commit.`
    };
  }

  try {
    runGit(repoPath, ["add", "-A"]);
  } catch (error) {
    return gitFailure("git add -A failed", error);
  }

  let staged: boolean;
  try {
    staged = hasStagedChanges(repoPath);
  } catch (error) {
    return gitFailure("git diff --cached failed", error);
  }
  if (!staged) {
    return {
      ok: false,
      code: "nothing_to_commit",
      error: "No staged changes after runner; nothing to commit."
    };
  }

  const message = formatCommitMessage(commit);

  try {
    runGit(repoPath, ["commit", "--quiet", "-m", message]);
  } catch (error) {
    return gitFailure("git commit failed", error);
  }

  let commitSha: string;
  try {
    commitSha = runGit(repoPath, ["rev-parse", "HEAD"]).trim();
  } catch (error) {
    return gitFailure("git rev-parse HEAD after commit failed", error);
  }
  if (!SHA40_RE.test(commitSha)) {
    return {
      ok: false,
      code: "git_failed",
      error: `Unexpected HEAD format after commit: ${commitSha}`
    };
  }
  if (commitSha === baseHead) {
    return {
      ok: false,
      code: "git_failed",
      error: `HEAD did not advance after commit: still at ${baseHead}.`
    };
  }

  return { ok: true, commitSha, parentSha: baseHead, message };
}

/**
 * List the repository-relative paths a commit changed relative to its parent —
 * the durable change set of a finalized round, derived from
 * `git diff --name-only <parentSha> <commitSha>`. Paths come back in git's
 * deterministic sorted order with blank lines dropped. Throws (like the rest of
 * this module's git calls) if git fails; callers that must stay total wrap it.
 */
export function listCommittedChangedFiles(
  repoPath: string,
  parentSha: string,
  commitSha: string
): string[] {
  return runGit(repoPath, ["diff", "--name-only", parentSha, commitSha])
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function formatCommitMessage(intent: CommitIntent): string {
  const scopePart =
    intent.scope !== undefined && intent.scope.length > 0
      ? `(${intent.scope})`
      : "";
  const bangPart = intent.breaking ? "!" : "";
  const header = `${intent.type}${scopePart}${bangPart}: ${intent.subject}`;
  const body = intent.body.trim();
  if (body.length === 0) return header;
  return `${header}\n\n${body}`;
}

export type ResetErrorCode =
  | "invalid_input"
  | "missing_base"
  | "git_failed"
  | "head_mismatch";

export type ResetFailure = {
  ok: false;
  code: ResetErrorCode;
  error: string;
};

export type ResetSuccess = {
  ok: true;
  head: string;
};

export type ResetResult = ResetFailure | ResetSuccess;

export type ResetInput = {
  repoPath: string;
  baseHead: string;
};

export function resetToBase(input: ResetInput): ResetResult {
  const validation = validateResetInput(input);
  if (!validation.ok) return validation;

  const { repoPath, baseHead } = input;

  if (!commitExists(repoPath, baseHead)) {
    return {
      ok: false,
      code: "missing_base",
      error: `Base commit does not exist in repo: ${baseHead}`
    };
  }

  let currentHead: string;
  try {
    currentHead = runGit(repoPath, ["rev-parse", "HEAD"]).trim();
  } catch (error) {
    return gitFailure("git rev-parse HEAD failed", error);
  }
  if (currentHead !== baseHead) {
    return {
      ok: false,
      code: "head_mismatch",
      error: `HEAD ${currentHead} does not match expected base ${baseHead}; refusing to reset commits made outside Momentum.`
    };
  }

  try {
    runGit(repoPath, ["reset", "--hard", "--quiet", baseHead]);
  } catch (error) {
    return gitFailure("git reset --hard failed", error);
  }

  try {
    runGit(repoPath, ["clean", "-fd", "--quiet"]);
  } catch (error) {
    return gitFailure("git clean -fd failed", error);
  }

  let head: string;
  try {
    head = runGit(repoPath, ["rev-parse", "HEAD"]).trim();
  } catch (error) {
    return gitFailure("git rev-parse HEAD failed", error);
  }
  if (head !== baseHead) {
    return {
      ok: false,
      code: "head_mismatch",
      error: `HEAD ${head} does not match base ${baseHead} after reset.`
    };
  }

  return { ok: true, head };
}

function validateCommitInput(input: CommitInput): CommitFailure | { ok: true } {
  if (typeof input.repoPath !== "string" || input.repoPath.trim().length === 0) {
    return {
      ok: false,
      code: "invalid_input",
      error: "Repo path is required."
    };
  }
  if (typeof input.baseHead !== "string" || !SHA40_RE.test(input.baseHead)) {
    return {
      ok: false,
      code: "invalid_input",
      error: "Base HEAD must be a 40-character hex SHA."
    };
  }
  const commit = input.commit;
  if (commit === null || typeof commit !== "object") {
    return {
      ok: false,
      code: "invalid_input",
      error: "Commit intent is required."
    };
  }
  if (typeof commit.type !== "string" || commit.type.length === 0) {
    return {
      ok: false,
      code: "invalid_input",
      error: "Commit intent type is required."
    };
  }
  if (typeof commit.subject !== "string" || commit.subject.trim().length === 0) {
    return {
      ok: false,
      code: "invalid_input",
      error: "Commit intent subject is required."
    };
  }
  return { ok: true };
}

function validateResetInput(input: ResetInput): ResetFailure | { ok: true } {
  if (typeof input.repoPath !== "string" || input.repoPath.trim().length === 0) {
    return {
      ok: false,
      code: "invalid_input",
      error: "Repo path is required."
    };
  }
  if (typeof input.baseHead !== "string" || !SHA40_RE.test(input.baseHead)) {
    return {
      ok: false,
      code: "invalid_input",
      error: "Base HEAD must be a 40-character hex SHA."
    };
  }
  return { ok: true };
}

function hasStagedChanges(repoPath: string): boolean {
  const result = spawnSync(
    "git",
    ["-C", repoPath, "diff", "--cached", "--quiet"],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  if (result.error !== undefined) {
    throw result.error;
  }
  // exit 0 = no diff (clean), exit 1 = diff exists; anything else is a git error.
  if (result.status === 0) return false;
  if (result.status === 1) return true;
  const stderrRaw: unknown = result.stderr;
  const stderr =
    typeof stderrRaw === "string"
      ? stderrRaw.trim()
      : Buffer.isBuffer(stderrRaw)
        ? stderrRaw.toString("utf-8").trim()
        : "";
  const suffix = stderr.length > 0 ? `: ${stderr}` : "";
  throw new Error(
    `git diff --cached --quiet exited with status ${result.status ?? "null"}${suffix}`
  );
}

function commitExists(repoPath: string, sha: string): boolean {
  try {
    runGit(repoPath, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function gitFailure(prefix: string, error: unknown): CommitFailure & ResetFailure {
  const detail = error instanceof Error ? error.message : "unknown error";
  return {
    ok: false,
    code: "git_failed",
    error: `${prefix}: ${detail}`
  };
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}
