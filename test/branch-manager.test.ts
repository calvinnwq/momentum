import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureMomentumBranch } from "../src/core/repo/branch-manager.js";

const ZERO_SHA = "0".repeat(40);
const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix = "momentum-branch-manager-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function initRepo(): string {
  const dir = makeTempDir();
  runGit(dir, ["init", "--initial-branch=main", "--quiet"]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  runGit(dir, ["config", "user.name", "Test User"]);
  runGit(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

function commitInitial(dir: string): string {
  fs.writeFileSync(path.join(dir, "README.md"), "init\n", "utf-8");
  runGit(dir, ["add", "README.md"]);
  runGit(dir, ["commit", "-m", "init", "--quiet"]);
  return runGit(dir, ["rev-parse", "HEAD"]).trim();
}

function currentBranch(dir: string): string {
  return runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
}

describe("ensureMomentumBranch", () => {
  it("creates a new branch from baseHead and checks it out", () => {
    const dir = initRepo();
    const head = commitInitial(dir);

    const result = ensureMomentumBranch({
      repoPath: dir,
      branch: "momentum/test-goal",
      goalId: "goal-123",
      baseHead: head
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.created).toBe(true);
      expect(result.branch).toBe("momentum/test-goal");
      expect(result.head).toBe(head);
    }
    expect(currentBranch(dir)).toBe("momentum/test-goal");
  });

  it("writes the goal-id metadata under branch config on creation", () => {
    const dir = initRepo();
    const head = commitInitial(dir);

    ensureMomentumBranch({
      repoPath: dir,
      branch: "momentum/meta",
      goalId: "goal-meta",
      baseHead: head
    });

    const stored = runGit(dir, [
      "config",
      "--local",
      "--get",
      "branch.momentum/meta.momentum-goal-id"
    ]).trim();
    expect(stored).toBe("goal-meta");
  });

  it("returns created=false and reuses an existing matching branch", () => {
    const dir = initRepo();
    const head = commitInitial(dir);

    const first = ensureMomentumBranch({
      repoPath: dir,
      branch: "momentum/reuse",
      goalId: "goal-reuse",
      baseHead: head
    });
    expect(first.ok).toBe(true);

    runGit(dir, ["checkout", "--quiet", "main"]);

    const second = ensureMomentumBranch({
      repoPath: dir,
      branch: "momentum/reuse",
      goalId: "goal-reuse",
      baseHead: head
    });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.created).toBe(false);
      expect(second.branch).toBe("momentum/reuse");
      expect(second.head).toBe(head);
    }
    expect(currentBranch(dir)).toBe("momentum/reuse");
  });

  it("refuses with branch_collision when the branch exists without metadata", () => {
    const dir = initRepo();
    const head = commitInitial(dir);
    runGit(dir, ["branch", "feature/orphan", head]);

    const result = ensureMomentumBranch({
      repoPath: dir,
      branch: "feature/orphan",
      goalId: "goal-x",
      baseHead: head
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("branch_collision");
      expect(result.error).toContain("feature/orphan");
    }
    expect(currentBranch(dir)).toBe("main");
  });

  it("refuses with branch_collision when the branch belongs to a different goal", () => {
    const dir = initRepo();
    const head = commitInitial(dir);

    const first = ensureMomentumBranch({
      repoPath: dir,
      branch: "momentum/conflict",
      goalId: "goal-original",
      baseHead: head
    });
    expect(first.ok).toBe(true);
    runGit(dir, ["checkout", "--quiet", "main"]);

    const second = ensureMomentumBranch({
      repoPath: dir,
      branch: "momentum/conflict",
      goalId: "goal-other",
      baseHead: head
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe("branch_collision");
    }
    expect(currentBranch(dir)).toBe("main");
  });

  it("rejects an empty branch name with invalid_input", () => {
    const dir = initRepo();
    const head = commitInitial(dir);

    const result = ensureMomentumBranch({
      repoPath: dir,
      branch: "",
      goalId: "goal-1",
      baseHead: head
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_input");
  });

  it("rejects an unsupported branch name with invalid_input", () => {
    const dir = initRepo();
    const head = commitInitial(dir);

    const result = ensureMomentumBranch({
      repoPath: dir,
      branch: "bad branch",
      goalId: "goal-1",
      baseHead: head
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_input");
  });

  it("rejects a branch name starting with a hyphen with invalid_input", () => {
    const dir = initRepo();
    const head = commitInitial(dir);

    for (const branch of ["-evil", "--config"]) {
      const result = ensureMomentumBranch({
        repoPath: dir,
        branch,
        goalId: "goal-1",
        baseHead: head
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("invalid_input");
    }
  });

  it("rejects a non-40-char baseHead with invalid_input", () => {
    const dir = initRepo();
    commitInitial(dir);

    const result = ensureMomentumBranch({
      repoPath: dir,
      branch: "momentum/x",
      goalId: "goal-1",
      baseHead: "abc123"
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_input");
  });

  it("rejects an empty goalId with invalid_input", () => {
    const dir = initRepo();
    const head = commitInitial(dir);

    const result = ensureMomentumBranch({
      repoPath: dir,
      branch: "momentum/x",
      goalId: "",
      baseHead: head
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_input");
  });

  it("rejects an empty repoPath with invalid_input", () => {
    const result = ensureMomentumBranch({
      repoPath: "",
      branch: "momentum/x",
      goalId: "goal-1",
      baseHead: ZERO_SHA.replace("0", "a") + "0".repeat(39).slice(0, 39)
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_input");
  });

  it("returns missing_base_head when the SHA is well-formed but unknown", () => {
    const dir = initRepo();
    commitInitial(dir);

    const result = ensureMomentumBranch({
      repoPath: dir,
      branch: "momentum/missing-head",
      goalId: "goal-1",
      baseHead: ZERO_SHA
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("missing_base_head");
      expect(result.error).toContain(ZERO_SHA);
    }
  });

  it("returns post-checkout HEAD when reusing a branch that has advanced", () => {
    const dir = initRepo();
    const head = commitInitial(dir);

    const first = ensureMomentumBranch({
      repoPath: dir,
      branch: "momentum/advance",
      goalId: "goal-advance",
      baseHead: head
    });
    expect(first.ok).toBe(true);

    fs.writeFileSync(path.join(dir, "next.txt"), "next\n", "utf-8");
    runGit(dir, ["add", "next.txt"]);
    runGit(dir, ["commit", "-m", "advance", "--quiet"]);
    const advancedHead = runGit(dir, ["rev-parse", "HEAD"]).trim();
    expect(advancedHead).not.toBe(head);

    runGit(dir, ["checkout", "--quiet", "main"]);

    const second = ensureMomentumBranch({
      repoPath: dir,
      branch: "momentum/advance",
      goalId: "goal-advance",
      baseHead: head
    });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.created).toBe(false);
      expect(second.head).toBe(advancedHead);
    }
  });
});
