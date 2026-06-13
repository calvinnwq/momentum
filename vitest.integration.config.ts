import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: [
      "test/*smoke.test.ts",
      "test/acp-runner.test.ts",
      "test/branch-manager.test.ts",
      "test/cli-readonly-status-family.test.ts",
      "test/cli-workflow-run-approve.test.ts",
      "test/cli.test.ts",
      "test/daemon-loop.test.ts",
      "test/full-adapter-e2e.test.ts",
      "test/fake-runner.test.ts",
      "test/foreground-iteration-trusted-shell.test.ts",
      "test/foreground-iteration.test.ts",
      "test/git-transaction.test.ts",
      "test/goal-logs.test.ts",
      "test/goal-loop-mechanism.test.ts",
      "test/goal-recovery.test.ts",
      "test/goal-status.test.ts",
      "test/handoff.test.ts",
      "test/iteration-finalize.test.ts",
      "test/iteration-job.test.ts",
      "test/live-step-advance.test.ts",
      "test/live-step-finalize.test.ts",
      "test/live-step-orchestrator.test.ts",
      "test/live-step-wrapper.test.ts",
      "test/migrations.test.ts",
      "test/repo-guard.test.ts",
      "test/runner-adapter.test.ts",
      "test/single-shot-mechanism.test.ts",
      "test/source-reconciliation-read-only.test.ts",
      "test/stale-recovery.test.ts",
      "test/trusted-shell-runner.test.ts",
      "test/verification.test.ts",
      "test/worker-run.test.ts",
      "test/workflow-dispatch-execute.test.ts"
    ],
    fileParallelism: false,
    testTimeout: 30_000
  }
});
