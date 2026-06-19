import { expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  dispatchWorkflowStepExecutor,
  type WorkflowStepExecutorInput
} from "../../src/core/workflow/step-executor.js";
import type { WorkflowStepKind } from "../../src/core/workflow/run-reducer.js";

import {
  buildFakeWorkflowStepExecutorRegistry,
  type FakeWorkflowStepExecutorOutcome
} from "./fake-workflow-step-executor.js";
import { runCliBinary } from "./smoke-harness.js";

/**
 * The deterministic fake registry RC-5 (NGX-485) moved out of the production
 * default. The substrate smoke explicitly injects it into
 * `dispatchWorkflowStepExecutor`'s `registry` parameter so it keeps a
 * deterministic executor without depending on a shipped fake default.
 */
const FAKE_WORKFLOW_STEP_EXECUTOR_REGISTRY =
  buildFakeWorkflowStepExecutorRegistry();

/**
 * Shared workflow-run CLI helpers for the built-binary smoke suite.
 *
 * The M7 end-to-end (NGX-318), M8 operator-control (NGX-330), and M10
 * production-dispatch (NGX-367) smoke files all drive the same `workflow ...`
 * surfaces of the real `dist/index.js` CLI: importing a coding-workflow run,
 * driving its steps through the fake `WorkflowStepExecutor`, and asserting
 * against the `workflow status` / `handoff` / `run list` / `run monitor` JSON
 * envelopes. This module owns the fixture writer, the ledger-driving loop, and
 * the JSON-envelope readers those milestone smoke files share so each stays
 * focused on a single milestone's behavior.
 *
 * It is not a test file (no `*.test.ts` suffix, lives under `test/helpers/`),
 * so neither the fast lane nor the integration lane collects it directly.
 */

export type E2EStep = {
  stepId: string;
  kind: WorkflowStepKind;
};

export const E2E_STEPS: E2EStep[] = [
  { stepId: "preflight", kind: "preflight" },
  { stepId: "implementation", kind: "implementation" },
  { stepId: "postflight:1", kind: "postflight" },
  { stepId: "no-mistakes", kind: "no-mistakes" },
  { stepId: "merge-cleanup", kind: "merge-cleanup" }
];

export function writeM7EndToEndFixture(rootDir: string, runId: string): string {
  const runDir = path.join(rootDir, ".agent-workflows", runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "plan.json"),
    JSON.stringify(
      {
        runId,
        schemaVersion: 1,
        mode: "execute-ready",
        profile: "momentum-m7-e2e-smoke",
        objective: "NGX-318 end-to-end smoke for a coding workflow",
        repo: "/Users/test/repos/momentum",
        resolvedScope: {
          issues: ["NGX-318"],
          source: "explicit",
          status: "resolved"
        },
        skillRevision: {
          contract: "coding-workflow-pipeline compact skill architecture",
          digest:
            "e2e0000000000000000000000000000000000000000000000000000000000000",
          version: "2026.05.25.01",
          schemaVersion: 1
        },
        approvalsRequired: [
          "implementation",
          "postflight:1",
          "no-mistakes",
          "merge-cleanup"
        ],
        taskFlow: {
          childTasks: E2E_STEPS.map((s) => ({ stepId: s.stepId }))
        }
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(runDir, "approval-through-merge-cleanup.json"),
    JSON.stringify(
      {
        runId,
        schemaVersion: 1,
        boundary: "through-merge-cleanup",
        actor: "smoke-tester",
        phrase: "through-merge-cleanup",
        approvedAt: "2026-05-25T09:00:00Z",
        approvalContract: "approve plan <run-id> <boundary>",
        allowedSteps: E2E_STEPS.map((s) => s.stepId)
      },
      null,
      2
    )
  );
  fs.writeFileSync(path.join(runDir, "ledger.jsonl"), "");
  return runDir;
}

function safeStepBaseName(stepId: string): string {
  return stepId.replace(/[^A-Za-z0-9._-]+/g, "_");
}

export function appendLedgerEvent(
  runDir: string,
  event: Record<string, unknown>
): void {
  fs.appendFileSync(
    path.join(runDir, "ledger.jsonl"),
    `${JSON.stringify(event)}\n`
  );
}

export type DriveStepResult = {
  executorOk: boolean;
  ledgerStatus: "complete" | "failed";
  errorCode: string | null;
};

export function driveStepWithFakeExecutor(
  runDir: string,
  runId: string,
  step: E2EStep,
  outcome: FakeWorkflowStepExecutorOutcome,
  startTs: string,
  endTs: string,
  attempt = 1
): DriveStepResult {
  const baseName = safeStepBaseName(step.stepId);
  const resultJsonPath = path.join(runDir, `step-${baseName}.result.json`);
  const executorLogPath = path.join(runDir, `step-${baseName}.log`);
  fs.writeFileSync(
    executorLogPath,
    `executor=${step.kind} step=${step.stepId} attempt=${attempt} outcome=${outcome}\n`
  );

  const input: WorkflowStepExecutorInput = {
    runId,
    stepId: step.stepId,
    kind: step.kind,
    attempt,
    repoPath: runDir,
    runDir,
    resultJsonPath,
    executorLogPath,
    config: { outcome }
  };

  const dispatch = dispatchWorkflowStepExecutor(
    step.kind,
    input,
    FAKE_WORKFLOW_STEP_EXECUTOR_REGISTRY
  );

  appendLedgerEvent(runDir, {
    runId,
    step: step.stepId,
    status: "started",
    ts: startTs
  });

  if (!dispatch.ok) {
    fs.writeFileSync(
      resultJsonPath,
      JSON.stringify(
        { ok: false, code: dispatch.code, error: dispatch.error },
        null,
        2
      )
    );
    appendLedgerEvent(runDir, {
      runId,
      step: step.stepId,
      status: "failed",
      ts: endTs,
      errorCode: dispatch.code,
      errorMessage: dispatch.error
    });
    return {
      executorOk: false,
      ledgerStatus: "failed",
      errorCode: dispatch.code
    };
  }

  fs.writeFileSync(resultJsonPath, JSON.stringify(dispatch.result, null, 2));

  if (
    dispatch.result.state === "succeeded" ||
    dispatch.result.state === "skipped"
  ) {
    appendLedgerEvent(runDir, {
      runId,
      step: step.stepId,
      status: "complete",
      ts: endTs
    });
    return { executorOk: true, ledgerStatus: "complete", errorCode: null };
  }

  appendLedgerEvent(runDir, {
    runId,
    step: step.stepId,
    status: "failed",
    ts: endTs,
    errorCode: dispatch.result.errorCode ?? "command_failed",
    errorMessage: dispatch.result.errorMessage ?? `fake ${step.kind} failed`
  });
  return {
    executorOk: true,
    ledgerStatus: "failed",
    errorCode: dispatch.result.errorCode
  };
}

export function importWorkflowRun(
  dataDir: string,
  runDir: string
): Record<string, unknown> {
  const result = runCliBinary([
    "workflow",
    "import",
    "--path",
    runDir,
    "--data-dir",
    dataDir,
    "--json"
  ]);
  expect(result.code, `workflow import stderr: ${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

export function workflowStatusJson(
  dataDir: string,
  args: string[] = []
): Record<string, unknown> {
  const result = runCliBinary([
    "workflow",
    "status",
    ...args,
    "--data-dir",
    dataDir,
    "--json"
  ]);
  expect(result.code, `workflow status stderr: ${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

export function workflowHandoffJson(
  dataDir: string,
  runId: string
): Record<string, unknown> {
  const result = runCliBinary([
    "workflow",
    "handoff",
    runId,
    "--data-dir",
    dataDir,
    "--json"
  ]);
  expect(result.code, `workflow handoff stderr: ${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

export function workflowRunListJson(
  dataDir: string,
  args: string[] = []
): Record<string, unknown> {
  const result = runCliBinary([
    "workflow",
    "run",
    "list",
    ...args,
    "--data-dir",
    dataDir,
    "--json"
  ]);
  expect(result.code, `workflow run list stderr: ${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

export function workflowRunMonitorJson(
  dataDir: string,
  runId: string
): Record<string, unknown> {
  const result = runCliBinary([
    "workflow",
    "run",
    "monitor",
    runId,
    "--data-dir",
    dataDir,
    "--json"
  ]);
  expect(result.code, `workflow run monitor stderr: ${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}
