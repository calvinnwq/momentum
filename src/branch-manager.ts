import { execFileSync } from "node:child_process";

const SHA40_RE = /^[0-9a-f]{40}$/;
const BRANCH_NAME_RE = /^[A-Za-z0-9._/-]+$/;
const GOAL_ID_CONFIG_KEY_SUFFIX = "momentum-goal-id";

export type BranchManagerErrorCode =
  | "invalid_input"
  | "missing_base_head"
  | "branch_collision"
  | "git_failed";

export type BranchManagerError = {
  ok: false;
  code: BranchManagerErrorCode;
  error: string;
};

export type BranchManagerSuccess = {
  ok: true;
  branch: string;
  created: boolean;
  head: string;
};

export type BranchManagerResult = BranchManagerError | BranchManagerSuccess;

export type BranchManagerInput = {
  repoPath: string;
  branch: string;
  goalId: string;
  baseHead: string;
};

export function ensureMomentumBranch(
  input: BranchManagerInput
): BranchManagerResult {
  const validation = validateInput(input);
  if (!validation.ok) return validation;

  const { repoPath, branch, goalId, baseHead } = input;

  if (!commitExists(repoPath, baseHead)) {
    return {
      ok: false,
      code: "missing_base_head",
      error: `Base HEAD does not exist in repo: ${baseHead}`
    };
  }

  const branchExists = verifyBranchExists(repoPath, branch);

  if (branchExists) {
    const existingGoalId = readBranchGoalId(repoPath, branch);
    if (existingGoalId === undefined) {
      return {
        ok: false,
        code: "branch_collision",
        error: `Branch ${branch} exists without Momentum metadata.`
      };
    }
    if (existingGoalId !== goalId) {
      return {
        ok: false,
        code: "branch_collision",
        error: `Branch ${branch} is owned by a different Momentum goal.`
      };
    }

    try {
      runGit(repoPath, ["checkout", "--quiet", branch]);
    } catch (error) {
      return gitFailure("git checkout failed", error);
    }

    let head: string;
    try {
      head = runGit(repoPath, ["rev-parse", "HEAD"]).trim();
    } catch (error) {
      return gitFailure("git rev-parse HEAD failed", error);
    }
    if (!SHA40_RE.test(head)) {
      return {
        ok: false,
        code: "git_failed",
        error: `Unexpected HEAD format after checkout: ${head}`
      };
    }

    return { ok: true, branch, created: false, head };
  }

  try {
    runGit(repoPath, ["checkout", "--quiet", "-b", branch, baseHead]);
  } catch (error) {
    return gitFailure(`git checkout -b ${branch} failed`, error);
  }

  try {
    runGit(repoPath, [
      "config",
      "--local",
      branchConfigKey(branch),
      goalId
    ]);
  } catch (error) {
    return gitFailure("git config write failed", error);
  }

  return { ok: true, branch, created: true, head: baseHead };
}

function validateInput(input: BranchManagerInput): BranchManagerError | { ok: true } {
  if (typeof input.repoPath !== "string" || input.repoPath.trim().length === 0) {
    return {
      ok: false,
      code: "invalid_input",
      error: "Repo path is required."
    };
  }
  if (typeof input.branch !== "string" || input.branch.trim().length === 0) {
    return {
      ok: false,
      code: "invalid_input",
      error: "Branch name is required."
    };
  }
  if (!BRANCH_NAME_RE.test(input.branch)) {
    return {
      ok: false,
      code: "invalid_input",
      error: `Branch name has unsupported characters: ${input.branch}`
    };
  }
  if (typeof input.goalId !== "string" || input.goalId.trim().length === 0) {
    return {
      ok: false,
      code: "invalid_input",
      error: "Goal id is required."
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

function verifyBranchExists(repoPath: string, branch: string): boolean {
  try {
    runGit(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

function commitExists(repoPath: string, sha: string): boolean {
  try {
    runGit(repoPath, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function readBranchGoalId(repoPath: string, branch: string): string | undefined {
  try {
    const value = runGit(repoPath, [
      "config",
      "--local",
      "--get",
      branchConfigKey(branch)
    ]).trim();
    return value.length === 0 ? undefined : value;
  } catch {
    return undefined;
  }
}

function branchConfigKey(branch: string): string {
  return `branch.${branch}.${GOAL_ID_CONFIG_KEY_SUFFIX}`;
}

function gitFailure(prefix: string, error: unknown): BranchManagerError {
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
