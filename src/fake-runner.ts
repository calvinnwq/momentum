import fs from "node:fs";
import path from "node:path";

import type { RunnerResult } from "./runner-result.js";

export const FAKE_RUNNER_FIXTURE_FILENAME = "momentum-fixture.txt";

// Test-only failure injection: when MOMENTUM_FAKE_RUNNER_FAIL is set to a
// non-empty value the fake runner still writes its artifacts but reports
// success=false, exercising the runner-failure reset path end-to-end.
export const FAKE_RUNNER_FAIL_ENV = "MOMENTUM_FAKE_RUNNER_FAIL";

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

  const simulateFailure = isFailureRequested(env);
  const runnerLogPath = path.join(iterationDir, "runner.log");
  const action = fixtureExisted ? "modified" : "created";
  const logLines = [
    "[fake-runner] start",
    `[fake-runner] repo: ${repoPath}`,
    `[fake-runner] iteration: ${iteration}`,
    `[fake-runner] action: ${action} ${FAKE_RUNNER_FIXTURE_FILENAME}`,
    ...(simulateFailure
      ? [`[fake-runner] simulated failure via ${FAKE_RUNNER_FAIL_ENV}`]
      : []),
    "[fake-runner] result.json written",
    "[fake-runner] done"
  ];
  fs.writeFileSync(runnerLogPath, `${logLines.join("\n")}\n`, "utf-8");

  const result: RunnerResult = simulateFailure
    ? {
        success: false,
        summary: `Simulated runner failure via ${FAKE_RUNNER_FAIL_ENV}.`,
        key_changes_made: [],
        key_learnings: [],
        remaining_work: ["Runner reported failure; iteration must reset."],
        goal_complete: false,
        commit: {
          type: "test",
          scope: "milestone-1",
          subject: "prove foreground momentum iteration",
          body: "",
          breaking: false
        }
      }
    : {
        success: true,
        summary: "Applied fake runner fixture.",
        key_changes_made: ["Created or modified fixture target file."],
        key_learnings: [],
        remaining_work: [],
        goal_complete: false,
        commit: {
          type: "test",
          scope: "milestone-1",
          subject: "prove foreground momentum iteration",
          body: "",
          breaking: false
        }
      };

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
    fixtureExisted
  };
}

function statOrThrow(p: string, label: string): fs.Stats {
  try {
    return fs.statSync(p);
  } catch {
    throw new Error(`fake runner: ${label} does not exist: ${p}`);
  }
}

function isFailureRequested(env: NodeJS.ProcessEnv): boolean {
  const raw = env[FAKE_RUNNER_FAIL_ENV];
  return typeof raw === "string" && raw.trim().length > 0;
}
