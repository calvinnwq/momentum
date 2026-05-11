import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  commitVerifiedChanges,
  formatCommitMessage,
  resetToBase
} from "../src/git-transaction.js";
import type { CommitIntent } from "../src/runner-result.js";

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

function makeTempDir(prefix = "momentum-git-transaction-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
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

function baseIntent(overrides: Partial<CommitIntent> = {}): CommitIntent {
  return {
    type: "feat",
    scope: "milestone-1",
    subject: "prove foreground momentum iteration",
    body: "",
    breaking: false,
    ...overrides
  };
}

describe("formatCommitMessage", () => {
  it("includes scope when present", () => {
    const msg = formatCommitMessage(baseIntent({ scope: "ngx-238" }));
    expect(msg).toBe("feat(ngx-238): prove foreground momentum iteration");
  });

  it("omits scope when undefined", () => {
    const msg = formatCommitMessage(baseIntent({ scope: undefined }));
    expect(msg).toBe("feat: prove foreground momentum iteration");
  });

  it("adds a bang when breaking=true", () => {
    const msg = formatCommitMessage(
      baseIntent({ scope: "core", breaking: true })
    );
    expect(msg).toBe("feat(core)!: prove foreground momentum iteration");
  });

  it("appends body separated by a blank line", () => {
    const msg = formatCommitMessage(
      baseIntent({ scope: undefined, body: "explains why" })
    );
    expect(msg).toBe("feat: prove foreground momentum iteration\n\nexplains why");
  });

  it("trims a body that is whitespace only", () => {
    const msg = formatCommitMessage(baseIntent({ body: "   \n  " }));
    expect(msg).toBe("feat(milestone-1): prove foreground momentum iteration");
  });
});

describe("commitVerifiedChanges", () => {
  it("stages tracked and untracked changes and creates one commit", () => {
    const dir = initRepo();
    const baseHead = commitInitial(dir);

    fs.writeFileSync(path.join(dir, "README.md"), "init\nmore\n", "utf-8");
    fs.writeFileSync(path.join(dir, "new.txt"), "fresh\n", "utf-8");

    const result = commitVerifiedChanges({
      repoPath: dir,
      baseHead,
      commit: baseIntent()
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.parentSha).toBe(baseHead);
    expect(result.commitSha).not.toBe(baseHead);
    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.message).toBe(
      "feat(milestone-1): prove foreground momentum iteration"
    );

    const headAfter = runGit(dir, ["rev-parse", "HEAD"]).trim();
    expect(headAfter).toBe(result.commitSha);

    const status = runGit(dir, ["status", "--porcelain"]).trim();
    expect(status).toBe("");

    const log = runGit(dir, ["log", "--format=%H %s", `${baseHead}..HEAD`]).trim();
    expect(log.split("\n")).toHaveLength(1);
    expect(log).toContain("feat(milestone-1): prove foreground momentum iteration");
  });

  it("preserves multi-line body in the commit message", () => {
    const dir = initRepo();
    const baseHead = commitInitial(dir);
    fs.writeFileSync(path.join(dir, "new.txt"), "fresh\n", "utf-8");

    const result = commitVerifiedChanges({
      repoPath: dir,
      baseHead,
      commit: baseIntent({
        scope: undefined,
        body: "first line\nsecond line"
      })
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const fullMessage = runGit(dir, ["log", "-1", "--format=%B"]);
    expect(fullMessage).toContain("feat: prove foreground momentum iteration");
    expect(fullMessage).toContain("first line\nsecond line");
  });

  it("returns nothing_to_commit when the worktree is clean", () => {
    const dir = initRepo();
    const baseHead = commitInitial(dir);

    const result = commitVerifiedChanges({
      repoPath: dir,
      baseHead,
      commit: baseIntent()
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("nothing_to_commit");

    const headAfter = runGit(dir, ["rev-parse", "HEAD"]).trim();
    expect(headAfter).toBe(baseHead);
  });

  it("returns head_mismatch when HEAD advanced beyond baseHead", () => {
    const dir = initRepo();
    const baseHead = commitInitial(dir);
    fs.writeFileSync(path.join(dir, "other.txt"), "x\n", "utf-8");
    runGit(dir, ["add", "other.txt"]);
    runGit(dir, ["commit", "-m", "runner-commit", "--quiet"]);

    fs.writeFileSync(path.join(dir, "stray.txt"), "y\n", "utf-8");

    const result = commitVerifiedChanges({
      repoPath: dir,
      baseHead,
      commit: baseIntent()
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("head_mismatch");
    expect(result.error).toContain(baseHead);

    const status = runGit(dir, ["status", "--porcelain"]).trim();
    expect(status).toContain("stray.txt");
  });

  it("rejects an empty repoPath with invalid_input", () => {
    const result = commitVerifiedChanges({
      repoPath: "",
      baseHead: "a".repeat(40),
      commit: baseIntent()
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_input");
  });

  it("rejects a malformed baseHead with invalid_input", () => {
    const dir = initRepo();
    commitInitial(dir);

    const result = commitVerifiedChanges({
      repoPath: dir,
      baseHead: "deadbeef",
      commit: baseIntent()
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_input");
  });

  it("rejects a commit intent with an empty subject as invalid_input", () => {
    const dir = initRepo();
    const baseHead = commitInitial(dir);

    const result = commitVerifiedChanges({
      repoPath: dir,
      baseHead,
      commit: baseIntent({ subject: "   " })
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_input");
  });
});

describe("resetToBase", () => {
  it("discards tracked modifications and untracked files back to baseHead", () => {
    const dir = initRepo();
    const baseHead = commitInitial(dir);

    fs.writeFileSync(path.join(dir, "README.md"), "init\nlocal\n", "utf-8");
    fs.writeFileSync(path.join(dir, "scratch.txt"), "untracked\n", "utf-8");
    fs.mkdirSync(path.join(dir, "scratch-dir"));
    fs.writeFileSync(path.join(dir, "scratch-dir", "x.txt"), "nested\n", "utf-8");

    const result = resetToBase({ repoPath: dir, baseHead });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.head).toBe(baseHead);

    const status = runGit(dir, ["status", "--porcelain"]).trim();
    expect(status).toBe("");
    expect(fs.existsSync(path.join(dir, "scratch.txt"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "scratch-dir"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf-8")).toBe("init\n");
  });

  it("succeeds as a no-op when the worktree is already clean", () => {
    const dir = initRepo();
    const baseHead = commitInitial(dir);

    const result = resetToBase({ repoPath: dir, baseHead });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.head).toBe(baseHead);
  });

  it("returns missing_base when baseHead does not exist in the repo", () => {
    const dir = initRepo();
    commitInitial(dir);

    const result = resetToBase({ repoPath: dir, baseHead: ZERO_SHA });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("missing_base");
  });

  it("rejects an empty repoPath with invalid_input", () => {
    const result = resetToBase({ repoPath: "", baseHead: "a".repeat(40) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_input");
  });

  it("rejects a malformed baseHead with invalid_input", () => {
    const dir = initRepo();
    commitInitial(dir);

    const result = resetToBase({ repoPath: dir, baseHead: "abc" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_input");
  });
});
