import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type RepoGuardErrorCode =
  | "missing"
  | "not_a_directory"
  | "not_a_git_repo"
  | "dirty_worktree"
  | "no_head"
  | "git_failed";

export type RepoGuardError = {
  ok: false;
  code: RepoGuardErrorCode;
  error: string;
};
export type RepoGuardSuccess = {
  ok: true;
  repoPath: string;
  head: string;
};
export type RepoGuardResult = RepoGuardError | RepoGuardSuccess;

export function inspectRepo(repoPath: string): RepoGuardResult {
  if (typeof repoPath !== "string" || repoPath.trim().length === 0) {
    return {
      ok: false,
      code: "missing",
      error: "Repo path is required."
    };
  }

  const absPath = path.resolve(repoPath);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return {
      ok: false,
      code: "missing",
      error: `Repo path does not exist: ${absPath}`
    };
  }

  if (!stat.isDirectory()) {
    return {
      ok: false,
      code: "not_a_directory",
      error: `Repo path is not a directory: ${absPath}`
    };
  }

  let topLevel: string;
  try {
    topLevel = runGit(absPath, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    return {
      ok: false,
      code: "not_a_git_repo",
      error: `Path is not inside a git repo: ${absPath}`
    };
  }

  const realAbs = fs.realpathSync(absPath);
  const realTop = fs.realpathSync(topLevel);
  if (realAbs !== realTop) {
    return {
      ok: false,
      code: "not_a_git_repo",
      error: `Repo path is not the git toplevel: ${absPath} (toplevel: ${topLevel})`
    };
  }

  let statusOutput: string;
  try {
    statusOutput = runGit(topLevel, ["status", "--porcelain"]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    return {
      ok: false,
      code: "git_failed",
      error: `git status failed: ${detail}`
    };
  }
  if (statusOutput.trim().length > 0) {
    return {
      ok: false,
      code: "dirty_worktree",
      error: `Repo has uncommitted changes: ${topLevel}`
    };
  }

  let head: string;
  try {
    head = runGit(topLevel, ["rev-parse", "HEAD"]).trim();
  } catch {
    return {
      ok: false,
      code: "no_head",
      error: `Repo has no HEAD commit: ${topLevel}`
    };
  }
  if (!/^[0-9a-f]{40}$/.test(head)) {
    return {
      ok: false,
      code: "no_head",
      error: `Unexpected HEAD format: ${head}`
    };
  }

  return { ok: true, repoPath: realTop, head };
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}
