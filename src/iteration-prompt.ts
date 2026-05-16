import type { GoalSpec } from "./goal-spec.js";

export type IterationPromptContext = {
  spec: GoalSpec;
  goalId: string;
  iteration: number;
  repoPath: string;
  baseHead: string;
};

export function renderIterationPrompt(ctx: IterationPromptContext): string {
  const { spec, goalId, iteration, repoPath, baseHead } = ctx;

  if (!Number.isInteger(iteration) || iteration < 1) {
    throw new Error("iteration must be a positive integer");
  }
  if (iteration > spec.max_iterations) {
    throw new Error(
      `iteration ${iteration} exceeds max_iterations ${spec.max_iterations}`
    );
  }
  if (!/^[0-9a-f]{40}$/.test(baseHead)) {
    throw new Error(`baseHead must be a 40-char git SHA, got: ${baseHead}`);
  }

  const lines: string[] = [];

  lines.push("# Momentum iteration prompt");
  lines.push("");
  lines.push("## Goal");
  lines.push(`- goal_id: ${goalId}`);
  lines.push(`- title: ${spec.title}`);
  lines.push(`- iteration: ${iteration} of ${spec.max_iterations}`);
  lines.push(`- branch: ${spec.branch}`);
  lines.push(`- runner: ${spec.runner}`);
  lines.push("");

  lines.push("## Repo context");
  lines.push(`- path: ${repoPath}`);
  lines.push(`- pre_iteration_head: ${baseHead}`);
  lines.push("");

  lines.push("## Goal body");
  const body = spec.body.trim();
  if (body.length > 0) {
    lines.push(body);
  } else {
    lines.push("(no goal body provided)");
  }
  lines.push("");

  lines.push("## Verification commands");
  if (spec.verification.length === 0) {
    lines.push("(none configured)");
  } else {
    for (const cmd of spec.verification) {
      lines.push(`- ${cmd}`);
    }
  }
  lines.push(`- timeout_sec: ${spec.verification_timeout_sec}`);
  lines.push("");

  lines.push("## Output contract");
  lines.push(
    "Write a single JSON object to the configured result path with this exact shape (trusted-shell runners must use $MOMENTUM_RESULT_PATH; result.json is the default):"
  );
  lines.push("");
  lines.push("```json");
  lines.push("{");
  lines.push('  "success": boolean,');
  lines.push('  "summary": string,');
  lines.push('  "key_changes_made": string[],');
  lines.push('  "key_learnings": string[],');
  lines.push('  "remaining_work": string[],');
  lines.push('  "goal_complete": boolean,');
  lines.push('  "commit": {');
  lines.push(
    '    "type": "build" | "ci" | "docs" | "feat" | "fix" | "perf" | "refactor" | "test" | "chore",'
  );
  lines.push('    "scope": string,');
  lines.push('    "subject": string,');
  lines.push('    "body": string,');
  lines.push('    "breaking": boolean');
  lines.push("  }");
  lines.push("}");
  lines.push("```");
  lines.push("");

  lines.push("## Rules");
  lines.push(
    "- Do not create git commits. Momentum will commit on success or reset on failure."
  );
  lines.push(
    "- Do not push or fetch. Operate only on the working tree at the path above."
  );
  lines.push(
    "- Stage no changes. Leave modifications in the worktree for Momentum to inspect."
  );

  return `${lines.join("\n")}\n`;
}
