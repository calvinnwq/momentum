import fs from "node:fs";
import path from "node:path";

export type GoalArtifactPaths = {
  goalDir: string;
  goalMd: string;
  ledgerMd: string;
  handoffMd: string;
  handoffJson: string;
  iteration: number;
  iterationDir: string;
  promptMd: string;
  runnerLog: string;
  verificationLog: string;
  resultJson: string;
};

export function initGoalArtifacts(
  dataDir: string,
  goalId: string,
  goalSpecContent: string
): GoalArtifactPaths {
  const paths = resolveGoalArtifactPaths(dataDir, goalId, 1);

  fs.mkdirSync(paths.iterationDir, { recursive: true });

  fs.writeFileSync(paths.goalMd, goalSpecContent, "utf-8");
  fs.writeFileSync(paths.ledgerMd, "", "utf-8");
  fs.writeFileSync(paths.handoffMd, "", "utf-8");
  fs.writeFileSync(paths.handoffJson, "{}\n", "utf-8");
  fs.writeFileSync(paths.promptMd, "", "utf-8");
  fs.writeFileSync(paths.runnerLog, "", "utf-8");
  fs.writeFileSync(paths.verificationLog, "", "utf-8");
  fs.writeFileSync(paths.resultJson, "{}\n", "utf-8");

  return paths;
}

export function resolveGoalArtifactPaths(
  dataDir: string,
  goalId: string,
  iteration: number = 1
): GoalArtifactPaths {
  if (!Number.isInteger(iteration) || iteration < 1) {
    throw new Error(
      `resolveGoalArtifactPaths: iteration must be a positive integer, got ${iteration}`
    );
  }
  const goalDir = path.join(dataDir, "goals", goalId);
  const iterationDir = path.join(goalDir, "iterations", String(iteration));

  return {
    goalDir,
    goalMd: path.join(goalDir, "goal.md"),
    ledgerMd: path.join(goalDir, "ledger.md"),
    handoffMd: path.join(goalDir, "handoff.md"),
    handoffJson: path.join(goalDir, "handoff.json"),
    iteration,
    iterationDir,
    promptMd: path.join(iterationDir, "prompt.md"),
    runnerLog: path.join(iterationDir, "runner.log"),
    verificationLog: path.join(iterationDir, "verification.log"),
    resultJson: path.join(iterationDir, "result.json")
  };
}

export function ensureIterationArtifactDir(
  dataDir: string,
  goalId: string,
  iteration: number
): GoalArtifactPaths {
  const paths = resolveGoalArtifactPaths(dataDir, goalId, iteration);
  fs.mkdirSync(paths.iterationDir, { recursive: true });
  return paths;
}
