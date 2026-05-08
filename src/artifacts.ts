import fs from "node:fs";
import path from "node:path";

export type GoalArtifactPaths = {
  goalDir: string;
  goalMd: string;
  ledgerMd: string;
  handoffMd: string;
  handoffJson: string;
  iteration1Dir: string;
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
  const paths = resolveGoalArtifactPaths(dataDir, goalId);

  fs.mkdirSync(paths.iteration1Dir, { recursive: true });

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
  goalId: string
): GoalArtifactPaths {
  const goalDir = path.join(dataDir, "goals", goalId);
  const iteration1Dir = path.join(goalDir, "iterations", "1");

  return {
    goalDir,
    goalMd: path.join(goalDir, "goal.md"),
    ledgerMd: path.join(goalDir, "ledger.md"),
    handoffMd: path.join(goalDir, "handoff.md"),
    handoffJson: path.join(goalDir, "handoff.json"),
    iteration1Dir,
    promptMd: path.join(iteration1Dir, "prompt.md"),
    runnerLog: path.join(iteration1Dir, "runner.log"),
    verificationLog: path.join(iteration1Dir, "verification.log"),
    resultJson: path.join(iteration1Dir, "result.json")
  };
}
