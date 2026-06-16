import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runForegroundIteration } from "../src/core/executors/foreground-iteration.js";
import { initGoalArtifacts } from "../src/core/evidence/artifacts.js";
import { parseRunnerResult } from "../src/core/executors/runner-result.js";
import type { GoalSpec } from "../src/core/goal/types.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix = "momentum-fg-ts-"): string {
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
  const dir = makeTempDir("momentum-fg-ts-repo-");
  runGit(dir, ["init", "--initial-branch=main", "--quiet"]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  runGit(dir, ["config", "user.name", "Test User"]);
  runGit(dir, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "README.md"), "init\n", "utf-8");
  runGit(dir, ["add", "README.md"]);
  runGit(dir, ["commit", "-m", "init", "--quiet"]);
  return dir;
}

const GOAL_ID = "9e3a0c7a-2222-3333-4444-555566667777";

function setupArtifacts() {
  const dataDir = makeTempDir("momentum-fg-ts-data-");
  return initGoalArtifacts(dataDir, GOAL_ID, "# trusted-shell smoke\n");
}

const RESULT_JSON_VALID = JSON.stringify({
  success: true,
  summary: "Trusted shell wrote fixture.txt.",
  key_changes_made: ["Wrote fixture.txt"],
  key_learnings: [],
  remaining_work: [],
  goal_complete: false,
  commit: {
    type: "test",
    scope: "milestone-4",
    subject: "trusted shell smoke",
    body: "",
    breaking: false
  }
});

const RESULT_JSON_FAILURE = JSON.stringify({
  success: false,
  summary: "Trusted shell reported failure.",
  key_changes_made: [],
  key_learnings: [],
  remaining_work: ["something"],
  goal_complete: false,
  commit: {
    type: "test",
    scope: "milestone-4",
    subject: "trusted shell smoke",
    body: "",
    breaking: false
  }
});

function makeSpec(
  repoPath: string,
  overrides: Partial<GoalSpec> = {}
): GoalSpec {
  return {
    title: "Trusted shell foreground probe",
    repo: repoPath,
    runner: "trusted-shell",
    branch: "momentum/trusted-shell-probe",
    max_iterations: 1,
    verification: ["true"],
    verification_timeout_sec: 900,
    body: "Apply the fixture via trusted-shell.",
    ...overrides
  };
}

describe("runForegroundIteration with trusted-shell", () => {
  it("runs the configured shell, writes a fixture file, passes verification, and commits", () => {
    const repo = initRepo();
    const artifactPaths = setupArtifacts();
    const fixturePath = path.join(repo, "fixture.txt");
    const resultPath = artifactPaths.resultJson;
    const script = [
      `printf 'hello trusted-shell\\n' > "${fixturePath}"`,
      `cat <<'JSON' > "${resultPath}"`,
      RESULT_JSON_VALID,
      "JSON",
      "echo wrote-fixture",
      "echo wrote-stderr >&2"
    ].join("\n");
    const spec = makeSpec(repo, {
      trusted_shell: { command: "/bin/sh", args: ["-c", script] }
    } as unknown as Partial<GoalSpec>);

    const out = runForegroundIteration({
      goalId: GOAL_ID,
      spec,
      iteration: 1,
      artifactPaths
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.success).toBe(true);
    expect(out.result.summary).toBe("Trusted shell wrote fixture.txt.");
    expect(out.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(out.commitSha).not.toBe(out.baseHead);
    expect(out.commitMessage).toContain("test(milestone-4):");
    expect(out.finalize.outcome).toBe("committed");

    expect(fs.existsSync(fixturePath)).toBe(true);
    expect(fs.readFileSync(fixturePath, "utf-8")).toContain("hello trusted-shell");

    const log = fs.readFileSync(out.runnerLogPath, "utf-8");
    expect(log).toContain("[trusted-shell] start");
    expect(log).toContain("wrote-fixture");
    expect(log).toContain("wrote-stderr");
    expect(log).toContain("[trusted-shell] runner_success: true");

    const parsed = parseRunnerResult(
      fs.readFileSync(out.resultJsonPath, "utf-8")
    );
    expect(parsed.ok).toBe(true);
  });

  it("surfaces command_failed and resets when the shell exits non-zero after dirtying the repo", () => {
    const repo = initRepo();
    const artifactPaths = setupArtifacts();
    const dirtyPath = path.join(repo, "half-done.txt");
    const script = [
      `printf 'partial\\n' > "${dirtyPath}"`,
      "echo failed-stderr >&2",
      "exit 17"
    ].join("\n");
    const spec = makeSpec(repo, {
      trusted_shell: { command: "/bin/sh", args: ["-c", script] }
    } as unknown as Partial<GoalSpec>);

    const baseHead = runGit(repo, ["rev-parse", "HEAD"]).trim();

    const out = runForegroundIteration({
      goalId: GOAL_ID,
      spec,
      iteration: 1,
      artifactPaths
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("command_failed");
    expect(out.error).toContain("17");

    const head = runGit(repo, ["rev-parse", "HEAD"]).trim();
    expect(head).toBe(baseHead);
    expect(runGit(repo, ["status", "--porcelain"]).trim()).toBe("");
    expect(fs.existsSync(dirtyPath)).toBe(false);

    const log = fs.readFileSync(artifactPaths.runnerLog, "utf-8");
    expect(log).toContain("[trusted-shell] exit_code: 17");
    expect(log).toContain("failed-stderr");
    expect(log).toContain("nonzero_exit");
  });

  it("leaves a runner-created commit in place when execution fails after moving HEAD", () => {
    const repo = initRepo();
    const artifactPaths = setupArtifacts();
    const committedPath = path.join(repo, "committed-before-failure.txt");
    const script = [
      `printf 'committed before failure\n' > "${committedPath}"`,
      `git -C "${repo}" add committed-before-failure.txt`,
      `git -C "${repo}" commit -m 'runner commit before failure' --quiet`,
      "exit 17"
    ].join("\n");
    const spec = makeSpec(repo, {
      trusted_shell: { command: "/bin/sh", args: ["-c", script] }
    } as unknown as Partial<GoalSpec>);

    const baseHead = runGit(repo, ["rev-parse", "HEAD"]).trim();

    const out = runForegroundIteration({
      goalId: GOAL_ID,
      spec,
      iteration: 1,
      artifactPaths
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("runner_changed_head");
    expect(out.error).toContain("manual recovery");

    const head = runGit(repo, ["rev-parse", "HEAD"]).trim();
    expect(head).not.toBe(baseHead);
    expect(runGit(repo, ["log", "-1", "--pretty=%s"]).trim()).toBe(
      "runner commit before failure"
    );
    expect(runGit(repo, ["status", "--porcelain"]).trim()).toBe("");
    expect(fs.existsSync(committedPath)).toBe(true);
  });

  it("leaves a runner-created commit in place when execution succeeds after moving HEAD", () => {
    const repo = initRepo();
    const artifactPaths = setupArtifacts();
    const committedPath = path.join(repo, "committed-before-success.txt");
    const script = [
      `printf 'committed before success\n' > "${committedPath}"`,
      `git -C "${repo}" add committed-before-success.txt`,
      `git -C "${repo}" commit -m 'runner commit before success' --quiet`,
      `cat <<'JSON' > "$MOMENTUM_RESULT_PATH"`,
      RESULT_JSON_VALID,
      "JSON"
    ].join("\n");
    const spec = makeSpec(repo, {
      trusted_shell: { command: "/bin/sh", args: ["-c", script] }
    } as unknown as Partial<GoalSpec>);

    const baseHead = runGit(repo, ["rev-parse", "HEAD"]).trim();

    const out = runForegroundIteration({
      goalId: GOAL_ID,
      spec,
      iteration: 1,
      artifactPaths
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("runner_changed_head");
    expect(out.error).toContain("manual recovery");

    const head = runGit(repo, ["rev-parse", "HEAD"]).trim();
    expect(head).not.toBe(baseHead);
    expect(runGit(repo, ["log", "-1", "--pretty=%s"]).trim()).toBe(
      "runner commit before success"
    );
    expect(runGit(repo, ["status", "--porcelain"]).trim()).toBe("");
    expect(fs.existsSync(committedPath)).toBe(true);
    if (fs.existsSync(artifactPaths.verificationLog)) {
      expect(fs.readFileSync(artifactPaths.verificationLog, "utf-8")).not.toContain(
        "[verify]"
      );
    }
  });

  it("surfaces command_timed_out and resets when the shell times out", () => {
    const repo = initRepo();
    const artifactPaths = setupArtifacts();
    const dirtyPath = path.join(repo, "before-timeout.txt");
    const script = [
      `printf 'partial\\n' > "${dirtyPath}"`,
      "sleep 5"
    ].join("\n");
    const spec = makeSpec(repo, {
      trusted_shell: {
        command: "/bin/sh",
        args: ["-c", script],
        timeout_sec: 1
      }
    } as unknown as Partial<GoalSpec>);

    const baseHead = runGit(repo, ["rev-parse", "HEAD"]).trim();

    const out = runForegroundIteration({
      goalId: GOAL_ID,
      spec,
      iteration: 1,
      artifactPaths
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("command_timed_out");
    expect(out.error).toContain("timed out");

    const head = runGit(repo, ["rev-parse", "HEAD"]).trim();
    expect(head).toBe(baseHead);
    expect(runGit(repo, ["status", "--porcelain"]).trim()).toBe("");
    expect(fs.existsSync(dirtyPath)).toBe(false);

    const log = fs.readFileSync(artifactPaths.runnerLog, "utf-8");
    expect(log).toContain("[trusted-shell] result: timed_out");
  });

  it("surfaces result_missing and resets when the shell exits 0 but never writes result.json", () => {
    const repo = initRepo();
    const artifactPaths = setupArtifacts();
    fs.rmSync(artifactPaths.resultJson, { force: true });
    const dirtyPath = path.join(repo, "no-result.txt");
    const script = [
      `printf 'partial\\n' > "${dirtyPath}"`,
      "echo done"
    ].join("\n");
    const spec = makeSpec(repo, {
      trusted_shell: { command: "/bin/sh", args: ["-c", script] }
    } as unknown as Partial<GoalSpec>);

    const baseHead = runGit(repo, ["rev-parse", "HEAD"]).trim();

    const out = runForegroundIteration({
      goalId: GOAL_ID,
      spec,
      iteration: 1,
      artifactPaths
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("result_missing");
    expect(out.error).toContain("result file");

    const head = runGit(repo, ["rev-parse", "HEAD"]).trim();
    expect(head).toBe(baseHead);
    expect(fs.existsSync(dirtyPath)).toBe(false);

    const log = fs.readFileSync(artifactPaths.runnerLog, "utf-8");
    expect(log).toContain("[trusted-shell] result_missing:");
  });

  it("surfaces result_invalid and resets when the result file is malformed JSON", () => {
    const repo = initRepo();
    const artifactPaths = setupArtifacts();
    const resultPath = artifactPaths.resultJson;
    const dirtyPath = path.join(repo, "malformed.txt");
    const script = [
      `printf 'partial\\n' > "${dirtyPath}"`,
      `printf 'not json' > "${resultPath}"`
    ].join("\n");
    const spec = makeSpec(repo, {
      trusted_shell: { command: "/bin/sh", args: ["-c", script] }
    } as unknown as Partial<GoalSpec>);

    const baseHead = runGit(repo, ["rev-parse", "HEAD"]).trim();

    const out = runForegroundIteration({
      goalId: GOAL_ID,
      spec,
      iteration: 1,
      artifactPaths
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("result_invalid");
    expect(out.error).toContain("invalid");

    const head = runGit(repo, ["rev-parse", "HEAD"]).trim();
    expect(head).toBe(baseHead);
    expect(fs.existsSync(dirtyPath)).toBe(false);
  });

  it("treats runner-reported success=false as a runner failure, resets, and skips verification", () => {
    const repo = initRepo();
    const artifactPaths = setupArtifacts();
    const dirtyPath = path.join(repo, "should-be-reset.txt");
    const script = [
      `printf 'partial\\n' > "${dirtyPath}"`,
      `cat <<'JSON' > "${artifactPaths.resultJson}"`,
      RESULT_JSON_FAILURE,
      "JSON"
    ].join("\n");
    const spec = makeSpec(repo, {
      trusted_shell: { command: "/bin/sh", args: ["-c", script] }
    } as unknown as Partial<GoalSpec>);

    const baseHead = runGit(repo, ["rev-parse", "HEAD"]).trim();

    const out = runForegroundIteration({
      goalId: GOAL_ID,
      spec,
      iteration: 1,
      artifactPaths
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("runner_reported_failure");
    expect(out.finalize?.outcome).toBe("reset_runner_failure");

    const head = runGit(repo, ["rev-parse", "HEAD"]).trim();
    expect(head).toBe(baseHead);
    expect(fs.existsSync(dirtyPath)).toBe(false);

    const verificationLog = fs.readFileSync(
      artifactPaths.verificationLog,
      "utf-8"
    );
    expect(verificationLog).toContain(
      "[verify] skipped: runner reported failure"
    );
  });
});
