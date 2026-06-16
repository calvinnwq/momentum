import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectRepo } from "../src/core/repo/guard.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix = "momentum-repo-guard-"): string {
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

describe("inspectRepo", () => {
  it("returns toplevel and HEAD when repo is clean with at least one commit", () => {
    const dir = initRepo();
    const head = commitInitial(dir);

    const result = inspectRepo(dir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.repoPath).toBe(fs.realpathSync(dir));
      expect(result.head).toBe(head);
      expect(result.head).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it("rejects a subdirectory that is not the repo toplevel", () => {
    const dir = initRepo();
    commitInitial(dir);
    const nested = path.join(dir, "pkg", "src");
    fs.mkdirSync(nested, { recursive: true });

    const result = inspectRepo(nested);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("not_a_git_repo");
      expect(result.error).toContain("toplevel");
    }
  });

  it("rejects an empty repo path with code missing", () => {
    const result = inspectRepo("");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("missing");
    }
  });

  it("rejects a non-existent path with code missing", () => {
    const dir = makeTempDir();
    const ghost = path.join(dir, "does-not-exist");

    const result = inspectRepo(ghost);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("missing");
      expect(result.error).toContain(ghost);
    }
  });

  it("rejects a file path with code not_a_directory", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "not-a-dir");
    fs.writeFileSync(file, "x", "utf-8");

    const result = inspectRepo(file);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("not_a_directory");
    }
  });

  it("rejects a directory that is not a git repo", () => {
    const dir = makeTempDir();

    const result = inspectRepo(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("not_a_git_repo");
    }
  });

  it("rejects a repo with uncommitted modifications", () => {
    const dir = initRepo();
    commitInitial(dir);
    fs.writeFileSync(path.join(dir, "README.md"), "modified\n", "utf-8");

    const result = inspectRepo(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("dirty_worktree");
    }
  });

  it("rejects a repo with untracked files", () => {
    const dir = initRepo();
    commitInitial(dir);
    fs.writeFileSync(path.join(dir, "stray.txt"), "stray\n", "utf-8");

    const result = inspectRepo(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("dirty_worktree");
    }
  });

  it("rejects a repo with staged but uncommitted changes", () => {
    const dir = initRepo();
    commitInitial(dir);
    fs.writeFileSync(path.join(dir, "staged.txt"), "staged\n", "utf-8");
    runGit(dir, ["add", "staged.txt"]);

    const result = inspectRepo(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("dirty_worktree");
    }
  });

  it("rejects a freshly initialized repo with no commits as no_head", () => {
    const dir = initRepo();

    const result = inspectRepo(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("no_head");
    }
  });
});
