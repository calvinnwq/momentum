import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { acquireRepoMutationFence } from "../src/adapters/repo-mutation-fence.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    fs.rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe("repository mutation fence", () => {
  it("serializes one repository without blocking another", () => {
    const firstRepo = initRepo();
    const secondRepo = initRepo();
    const first = acquireRepoMutationFence(firstRepo);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const sameRepo = acquireRepoMutationFence(firstRepo);
    expect(sameRepo.ok).toBe(false);
    const otherRepo = acquireRepoMutationFence(secondRepo);
    expect(otherRepo.ok).toBe(true);
    if (otherRepo.ok) otherRepo.release();

    first.release();
    const reacquired = acquireRepoMutationFence(firstRepo);
    expect(reacquired.ok).toBe(true);
    if (reacquired.ok) reacquired.release();
  });
});

function initRepo(): string {
  const repoPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "momentum-repo-mutation-fence-"),
  );
  tempRoots.push(repoPath);
  execFileSync("git", ["-C", repoPath, "init", "--quiet"]);
  return fs.realpathSync(repoPath);
}
