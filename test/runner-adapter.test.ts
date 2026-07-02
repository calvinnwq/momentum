import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  dispatchRunnerAdapter,
  getRunnerAdapter,
  listExecutingRunnerAdapterKinds,
  listRunnerAdapterKinds,
  type RunnerAdapter,
  type RunnerAdapterInput
} from "../src/adapters/runner-adapter.js";
import {
  FAKE_RUNNER_FAIL_ENV,
  FAKE_RUNNER_FIXTURE_FILENAME,
  FAKE_RUNNER_GOAL_COMPLETE_ENV,
  FAKE_RUNNER_TRAJECTORY_ENV
} from "../src/adapters/fake-runner.js";
import { parseRunnerResult } from "../src/core/executors/runner/result.js";
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

function makeTempDir(prefix = "momentum-runner-adapter-"): string {
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
  const dir = makeTempDir("momentum-runner-adapter-repo-");
  runGit(dir, ["init", "--initial-branch=main", "--quiet"]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  runGit(dir, ["config", "user.name", "Test User"]);
  runGit(dir, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "README.md"), "init\n", "utf-8");
  runGit(dir, ["add", "README.md"]);
  runGit(dir, ["commit", "-m", "init", "--quiet"]);
  return dir;
}

function makeSpec(repoPath: string, runner = "fake"): GoalSpec {
  return {
    title: "Adapter probe",
    repo: repoPath,
    runner,
    branch: "momentum/adapter-probe",
    max_iterations: 1,
    verification: ["true"],
    verification_timeout_sec: 900,
    body: ""
  };
}

function makeInput(overrides: Partial<RunnerAdapterInput> = {}): RunnerAdapterInput {
  const repoPath = overrides.repoPath ?? initRepo();
  const iterationDir = overrides.iterationDir ?? makeTempDir("momentum-runner-adapter-iter-");
  return {
    goalId: "11111111-1111-2222-3333-444455556666",
    iteration: 1,
    repoPath,
    baseHead: "0123456789012345678901234567890123456789",
    branch: "momentum/adapter-probe",
    promptPath: path.join(iterationDir, "prompt.md"),
    iterationDir,
    resultJsonPath: path.join(iterationDir, "result.json"),
    runnerLogPath: path.join(iterationDir, "runner.log"),
    spec: makeSpec(repoPath),
    ...overrides
  };
}

describe("runner-adapter registry", () => {
  it("lists fake, trusted-shell, and acp as registered kinds", () => {
    expect(listRunnerAdapterKinds()).toEqual(["fake", "trusted-shell", "acp"]);
  });

  it("marks fake, trusted-shell, and acp as executing adapters after M4-04", () => {
    expect(listExecutingRunnerAdapterKinds()).toEqual([
      "fake",
      "trusted-shell",
      "acp"
    ]);
  });

  it("returns the fake adapter from getRunnerAdapter('fake') with executes=true", () => {
    const adapter = getRunnerAdapter("fake");
    expect(adapter).toBeDefined();
    expect(adapter?.kind).toBe("fake");
    expect(adapter?.executes).toBe(true);
  });

  it("returns the trusted-shell adapter with executes=true after M4-03", () => {
    const adapter = getRunnerAdapter("trusted-shell");
    expect(adapter).toBeDefined();
    expect(adapter?.kind).toBe("trusted-shell");
    expect(adapter?.executes).toBe(true);
  });

  it("returns the acp adapter with executes=true after M4-04", () => {
    const adapter = getRunnerAdapter("acp");
    expect(adapter).toBeDefined();
    expect(adapter?.kind).toBe("acp");
    expect(adapter?.executes).toBe(true);
  });

  it("returns undefined for unknown runner kinds", () => {
    expect(getRunnerAdapter("codex")).toBeUndefined();
    expect(getRunnerAdapter("")).toBeUndefined();
  });
});

describe("dispatchRunnerAdapter", () => {
  it("dispatches fake runner with repo, iteration, prompt path, iteration dir, result and log paths", () => {
    const repoPath = initRepo();
    const iterationDir = makeTempDir("momentum-runner-adapter-iter-");
    const input = makeInput({ repoPath, iterationDir });

    const out = dispatchRunnerAdapter("fake", input);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.runnerLogPath).toBe(path.join(iterationDir, "runner.log"));
    expect(out.resultJsonPath).toBe(path.join(iterationDir, "result.json"));
    expect(out.result.success).toBe(true);
    expect(out.result.goal_complete).toBe(false);
    expect(out.result.commit.type).toBe("test");
    expect(fs.existsSync(out.runnerLogPath)).toBe(true);
    expect(fs.existsSync(out.resultJsonPath)).toBe(true);
    expect(
      fs.existsSync(path.join(repoPath, FAKE_RUNNER_FIXTURE_FILENAME))
    ).toBe(true);
  });

  it("returns the same normalized RunnerResult as runFakeRunner produces", () => {
    const repoPath = initRepo();
    const iterationDir = makeTempDir("momentum-runner-adapter-iter-");
    const input = makeInput({ repoPath, iterationDir });

    const out = dispatchRunnerAdapter("fake", input);

    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const parsed = parseRunnerResult(
      fs.readFileSync(out.resultJsonPath, "utf-8")
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual(out.result);
    }
  });

  it("dispatches trusted-shell to its adapter and surfaces invalid_input when no trusted_shell block is configured", () => {
    const input = makeInput();
    const out = dispatchRunnerAdapter("trusted-shell", input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("invalid_input");
    expect(out.error).toContain("trusted_shell");
  });

  it("dispatches trusted-shell to its adapter and runs the configured shell command", () => {
    const repoPath = initRepo();
    const iterationDir = makeTempDir("momentum-runner-adapter-iter-");
    const resultPath = path.join(iterationDir, "result.json");
    const resultJson = JSON.stringify({
      success: true,
      summary: "Trusted shell smoke through dispatch.",
      key_changes_made: [],
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
    const script = [
      `cat <<'JSON' > "${resultPath}"`,
      resultJson,
      "JSON"
    ].join("\n");

    const baseSpec = makeSpec(repoPath, "trusted-shell");
    const input = makeInput({
      repoPath,
      iterationDir,
      spec: {
        ...baseSpec,
        trusted_shell: { command: "/bin/sh", args: ["-c", script] }
      } as unknown as GoalSpec
    });

    const out = dispatchRunnerAdapter("trusted-shell", input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.success).toBe(true);
    expect(out.result.summary).toBe("Trusted shell smoke through dispatch.");
    expect(out.runnerLogPath).toBe(input.runnerLogPath);
    expect(out.resultJsonPath).toBe(resultPath);
  });

  it("surfaces unsupported_runner for unregistered kinds", () => {
    const input = makeInput();
    const out = dispatchRunnerAdapter("codex", input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("unsupported_runner");
    expect(out.error).toContain("codex");
  });

  it("reports undefined log and result paths for unsupported_runner because no runner ran", () => {
    // Hermetic on purpose: an unknown kind fails closed after input validation
    // but before any adapter executes, so synthetic string paths suffice and no
    // real git repo / iteration dir is initialized (passing both overrides
    // short-circuits initRepo()/makeTempDir()).
    const input = makeInput({
      repoPath: "/synthetic/runner-adapter/repo",
      iterationDir: "/synthetic/runner-adapter/iter"
    });
    const out = dispatchRunnerAdapter("codex", input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("unsupported_runner");
    // Unlike runner_threw (which threads input.runnerLogPath/resultJsonPath so an
    // operator can inspect partial output), an unsupported kind never reached a
    // runner and therefore advertises no artifacts to read.
    expect(out.runnerLogPath).toBeUndefined();
    expect(out.resultJsonPath).toBeUndefined();
  });

  it("enumerates the executing runner kinds in the unsupported_runner error as operator guidance", () => {
    const input = makeInput({
      repoPath: "/synthetic/runner-adapter/repo",
      iterationDir: "/synthetic/runner-adapter/iter"
    });
    const out = dispatchRunnerAdapter("codex", input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("unsupported_runner");
    // The operator-visible reason lists exactly the executes===true adapters so an
    // operator can pick a runnable kind; this ties the fail-closed message to the
    // executing-runner filter rather than a hard-coded string.
    const executing = listExecutingRunnerAdapterKinds();
    expect(executing.length).toBeGreaterThan(0);
    expect(out.error).toContain(executing.join(", "));
  });

  it("maps a thrown adapter to runner_threw and includes the iteration log/result paths", () => {
    const repoPath = initRepo();
    const iterationDir = makeTempDir("momentum-runner-adapter-iter-");
    const input = makeInput({
      repoPath,
      iterationDir,
      env: { [FAKE_RUNNER_TRAJECTORY_ENV]: "bogus" }
    });

    const out = dispatchRunnerAdapter("fake", input);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("runner_threw");
    expect(out.error).toContain("not one of ok|complete|fail");
    expect(out.runnerLogPath).toBe(input.runnerLogPath);
    expect(out.resultJsonPath).toBe(input.resultJsonPath);
  });

  it("rejects invalid input before invoking the adapter", () => {
    const input = makeInput({ iteration: 0 });
    const out = dispatchRunnerAdapter("fake", input);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("invalid_input");
  });

  it("threads env through to the fake runner (failure injection)", () => {
    const repoPath = initRepo();
    const iterationDir = makeTempDir("momentum-runner-adapter-iter-");
    const input = makeInput({
      repoPath,
      iterationDir,
      env: { [FAKE_RUNNER_FAIL_ENV]: "1" }
    });

    const out = dispatchRunnerAdapter("fake", input);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.success).toBe(false);
    expect(out.result.goal_complete).toBe(false);
  });

  it("threads env through to the fake runner (goal_complete injection)", () => {
    const repoPath = initRepo();
    const iterationDir = makeTempDir("momentum-runner-adapter-iter-");
    const input = makeInput({
      repoPath,
      iterationDir,
      env: { [FAKE_RUNNER_GOAL_COMPLETE_ENV]: "1" }
    });

    const out = dispatchRunnerAdapter("fake", input);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.success).toBe(true);
    expect(out.result.goal_complete).toBe(true);
  });

  it("exposes fake adapter diagnostics for inspection without leaking into RunnerResult", () => {
    const repoPath = initRepo();
    const iterationDir = makeTempDir("momentum-runner-adapter-iter-");
    const input = makeInput({ repoPath, iterationDir });

    const out = dispatchRunnerAdapter("fake", input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.diagnostics?.outcome).toBe("ok");
    expect(out.diagnostics?.fixtureExisted).toBe(false);
    expect(out.diagnostics?.fixturePath).toBe(
      path.join(repoPath, FAKE_RUNNER_FIXTURE_FILENAME)
    );
  });
});

describe("runner-adapter contract", () => {
  it("requires repoPath, iterationDir, runnerLogPath, and resultJsonPath", () => {
    const base = makeInput();
    for (const field of [
      "repoPath",
      "iterationDir",
      "runnerLogPath",
      "resultJsonPath"
    ] as const) {
      const broken = { ...base, [field]: "" } as RunnerAdapterInput;
      const out = dispatchRunnerAdapter("fake", broken);
      expect(out.ok, `expected invalid_input when ${field} is empty`).toBe(
        false
      );
      if (out.ok) continue;
      expect(out.code).toBe("invalid_input");
      expect(out.error).toContain(field);
    }
  });

  it("adapter has a stable shape via getRunnerAdapter", () => {
    const adapter = getRunnerAdapter("fake") as RunnerAdapter;
    expect(typeof adapter.execute).toBe("function");
    expect(adapter.kind).toBe("fake");
    expect(adapter.executes).toBe(true);
  });
});
