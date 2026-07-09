import type { MomentumDb } from "../../adapters/db.js";

/**
 * Durable goal row shape. Goals are compatibility data written by the retired
 * goal-first lane; nothing creates new rows, but recovery, daemon status, and
 * doctor surfaces keep reading the stored ones.
 */
export type GoalRow = {
  id: string;
  title: string;
  repo: string | null;
  runner: string;
  branch: string;
  max_iterations: number;
  verification: string;
  verification_timeout_sec: number;
  state: string;
  artifact_dir: string;
  current_iteration: number;
  completion_reason: string | null;
  needs_manual_recovery: number;
  manual_recovery_reason: string | null;
  manual_recovery_at: number | null;
  created_at: number;
  updated_at: number;
};

export function getGoal(db: MomentumDb, goalId: string): GoalRow | undefined {
  return db
    .prepare("SELECT * FROM goals WHERE id = ?")
    .get(goalId) as GoalRow | undefined;
}
