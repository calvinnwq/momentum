import { defineConfig } from "vitest/config";

const integrationTestFiles = [
  "test/*smoke.test.ts",
  "test/cli-workflow-run-approve.test.ts",
  "test/cli.test.ts",
  "test/daemon-loop.test.ts",
  "test/full-adapter-e2e.test.ts",
  "test/git-transaction.test.ts",
  "test/goal-loop-mechanism.test.ts",
  "test/goal-recovery.test.ts",
  "test/iteration-finalize.test.ts",
  "test/live-step-advance.test.ts",
  "test/live-step-finalize.test.ts",
  "test/live-step-orchestrator.test.ts",
  "test/live-step-wrapper.test.ts",
  "test/migrations.test.ts",
  "test/repo-guard.test.ts",
  "test/single-shot-mechanism.test.ts",
  "test/source-reconciliation-read-only.test.ts",
  "test/stale-recovery.test.ts",
  "test/verification.test.ts",
  "test/workflow-dispatch-execute.test.ts"
];

export default defineConfig({
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**", ...integrationTestFiles]
  }
});
