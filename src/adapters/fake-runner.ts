import fs from "node:fs";
import path from "node:path";

import type { RunnerResult } from "../core/executors/types.js";

export const FAKE_RUNNER_FIXTURE_FILENAME = "momentum-fixture.txt";

// Test-only failure injection: when MOMENTUM_FAKE_RUNNER_FAIL is set to a
// non-empty value the fake runner still writes its artifacts but reports
// success=false, exercising the runner-failure reset path end-to-end.
export const FAKE_RUNNER_FAIL_ENV = "MOMENTUM_FAKE_RUNNER_FAIL";

// Test-only goal_complete injection: when MOMENTUM_FAKE_RUNNER_GOAL_COMPLETE is
// set to a non-empty value, a successful fake-runner result reports
// goal_complete=true so chaining/completion paths can be exercised without a
// trajectory. Ignored when the runner reports success=false.
export const FAKE_RUNNER_GOAL_COMPLETE_ENV =
  "MOMENTUM_FAKE_RUNNER_GOAL_COMPLETE";

// Test-only per-iteration trajectory: when MOMENTUM_FAKE_RUNNER_TRAJECTORY is
// set, each pipe-separated entry maps iteration N to one of `ok` (success),
// `complete` (success+goal_complete), or `fail` (runner failure). Iterations
// past the last entry reuse the last entry. Trajectory takes precedence over
// the legacy FAIL/GOAL_COMPLETE toggles when set.
export const FAKE_RUNNER_TRAJECTORY_ENV = "MOMENTUM_FAKE_RUNNER_TRAJECTORY";

export type FakeRunnerOutcome = "ok" | "complete" | "fail";

export type FakeRunnerInput = {
  repoPath: string;
  iterationDir: string;
  iteration: number;
  env?: NodeJS.ProcessEnv;
};

export type FakeRunnerOutput = {
  result: RunnerResult;
  fixturePath: string;
  runnerLogPath: string;
  resultJsonPath: string;
  fixtureExisted: boolean;
  outcome: FakeRunnerOutcome;
};

export function runFakeRunner(input: FakeRunnerInput): FakeRunnerOutput {
  const { repoPath, iterationDir, iteration } = input;
  const env = input.env ?? process.env;

  if (typeof repoPath !== "string" || repoPath.trim().length === 0) {
    throw new Error("fake runner: repoPath is required");
  }
  if (typeof iterationDir !== "string" || iterationDir.trim().length === 0) {
    throw new Error("fake runner: iterationDir is required");
  }
  if (!Number.isInteger(iteration) || iteration < 1) {
    throw new Error("fake runner: iteration must be a positive integer");
  }

  const repoStat = statOrThrow(repoPath, "repoPath");
  if (!repoStat.isDirectory()) {
    throw new Error(`fake runner: repoPath is not a directory: ${repoPath}`);
  }
  const iterationStat = statOrThrow(iterationDir, "iterationDir");
  if (!iterationStat.isDirectory()) {
    throw new Error(
      `fake runner: iterationDir is not a directory: ${iterationDir}`
    );
  }

  const fixturePath = path.join(repoPath, FAKE_RUNNER_FIXTURE_FILENAME);
  const fixtureExisted = fs.existsSync(fixturePath);
  const fixtureContent = `momentum fake runner fixture\niteration: ${iteration}\n`;
  fs.writeFileSync(fixturePath, fixtureContent, "utf-8");

  const outcome = resolveOutcome(env, iteration);
  const runnerLogPath = path.join(iterationDir, "runner.log");
  const action = fixtureExisted ? "modified" : "created";
  const logLines = [
    "[fake-runner] start",
    `[fake-runner] repo: ${repoPath}`,
    `[fake-runner] iteration: ${iteration}`,
    `[fake-runner] action: ${action} ${FAKE_RUNNER_FIXTURE_FILENAME}`,
    `[fake-runner] outcome: ${outcome}`,
    ...outcomeLogLines(outcome, env),
    "[fake-runner] result.json written",
    "[fake-runner] done"
  ];
  fs.writeFileSync(runnerLogPath, `${logLines.join("\n")}\n`, "utf-8");

  const result = buildRunnerResult(outcome);

  const resultJsonPath = path.join(iterationDir, "result.json");
  fs.writeFileSync(
    resultJsonPath,
    `${JSON.stringify(result, null, 2)}\n`,
    "utf-8"
  );

  return {
    result,
    fixturePath,
    runnerLogPath,
    resultJsonPath,
    fixtureExisted,
    outcome
  };
}

function buildRunnerResult(outcome: FakeRunnerOutcome): RunnerResult {
  const baseCommit = {
    type: "test" as const,
    scope: "milestone-1",
    subject: "prove foreground momentum iteration",
    body: "",
    breaking: false
  };
  if (outcome === "fail") {
    return {
      success: false,
      summary: `Simulated runner failure via ${FAKE_RUNNER_FAIL_ENV}.`,
      key_changes_made: [],
      key_learnings: [],
      remaining_work: ["Runner reported failure; iteration must reset."],
      goal_complete: false,
      commit: baseCommit
    };
  }
  return {
    success: true,
    summary: "Applied fake runner fixture.",
    key_changes_made: ["Created or modified fixture target file."],
    key_learnings: [],
    remaining_work: [],
    goal_complete: outcome === "complete",
    commit: baseCommit
  };
}

function outcomeLogLines(
  outcome: FakeRunnerOutcome,
  env: NodeJS.ProcessEnv
): string[] {
  if (outcome === "fail") {
    const source = readEnv(env, FAKE_RUNNER_TRAJECTORY_ENV)
      ? FAKE_RUNNER_TRAJECTORY_ENV
      : FAKE_RUNNER_FAIL_ENV;
    return [`[fake-runner] simulated failure via ${source}`];
  }
  if (outcome === "complete") {
    const source = readEnv(env, FAKE_RUNNER_TRAJECTORY_ENV)
      ? FAKE_RUNNER_TRAJECTORY_ENV
      : FAKE_RUNNER_GOAL_COMPLETE_ENV;
    return [`[fake-runner] goal_complete via ${source}`];
  }
  return [];
}

function statOrThrow(p: string, label: string): fs.Stats {
  try {
    return fs.statSync(p);
  } catch {
    throw new Error(`fake runner: ${label} does not exist: ${p}`);
  }
}

function resolveOutcome(
  env: NodeJS.ProcessEnv,
  iteration: number
): FakeRunnerOutcome {
  const trajectoryRaw = readEnv(env, FAKE_RUNNER_TRAJECTORY_ENV);
  if (trajectoryRaw !== undefined) {
    const entries = trajectoryRaw.split("|").map((entry) => entry.trim());
    const rawEntry = entries[Math.min(iteration - 1, entries.length - 1)] ?? "";
    const normalized = rawEntry.toLowerCase();
    if (normalized === "" || normalized === "ok") return "ok";
    if (normalized === "complete") return "complete";
    if (normalized === "fail") return "fail";
    throw new Error(
      `fake runner: ${FAKE_RUNNER_TRAJECTORY_ENV} entry ${JSON.stringify(rawEntry)} is not one of ok|complete|fail`
    );
  }

  if (readEnv(env, FAKE_RUNNER_FAIL_ENV) !== undefined) {
    return "fail";
  }
  if (readEnv(env, FAKE_RUNNER_GOAL_COMPLETE_ENV) !== undefined) {
    return "complete";
  }
  return "ok";
}

function readEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
