import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  buildCli,
  cleanupTempRoots,
  makeTempDir,
  runCliBinary,
} from "./helpers/smoke-harness.js";
import {
  E2E_STEPS,
  driveStepWithFakeExecutor,
  importWorkflowRun,
  workflowHandoffJson,
  workflowStatusJson,
  writeM7EndToEndFixture,
} from "./helpers/workflow-smoke-harness.js";

beforeAll(buildCli, 60_000);

afterEach(cleanupTempRoots);

describe("Milestone 7 end-to-end coding workflow smoke (NGX-318)", () => {
  it("drives a full happy-path workflow through fake executors, import, status, and handoff", () => {
    const dataDir = makeTempDir("momentum-smoke-m7-e2e-ok-");
    const fixtureRoot = makeTempDir("momentum-smoke-m7-e2e-ok-fixture-");
    const runId = "cwfp-smoke7e2eok";
    const runDir = writeM7EndToEndFixture(fixtureRoot, runId);

    // Initial import: plan + approval only, no ledger events yet.
    const initialImport = importWorkflowRun(dataDir, runDir);
    expect(initialImport).toMatchObject({
      ok: true,
      runId,
      state: "approved",
      approvalBoundary: "through-merge-cleanup",
    });
    expect(
      (initialImport["counts"] as Record<string, number>)["approvals"],
    ).toBe(1);

    // Drive each step through the fake WorkflowStepExecutor and capture
    // ledger evidence between iterations.
    let cursor = Date.parse("2026-05-25T10:00:00Z");
    for (const step of E2E_STEPS) {
      const start = new Date(cursor).toISOString();
      const end = new Date(cursor + 60_000).toISOString();
      const driveResult = driveStepWithFakeExecutor(
        runDir,
        runId,
        step,
        "success",
        start,
        end,
      );
      expect(driveResult.ledgerStatus).toBe("complete");
      cursor += 120_000;

      const midImport = importWorkflowRun(dataDir, runDir);
      expect(midImport["runId"]).toBe(runId);
    }

    const finalImport = importWorkflowRun(dataDir, runDir);
    expect(finalImport).toMatchObject({
      ok: true,
      runId,
      state: "succeeded",
      approvalBoundary: "through-merge-cleanup",
    });
    expect((finalImport["counts"] as Record<string, number>)["steps"]).toBe(
      E2E_STEPS.length,
    );

    // No active or stale run remains.
    const activeRuns = workflowStatusJson(dataDir, ["--filter", "active"]);
    expect(activeRuns).toMatchObject({ ok: true, count: 0 });
    expect((activeRuns["runs"] as unknown[]).length).toBe(0);

    const blockedRuns = workflowStatusJson(dataDir, ["--filter", "blocked"]);
    expect(blockedRuns).toMatchObject({ ok: true, count: 0 });

    // Detail view: terminal succeeded run with all required steps green.
    const detail = workflowStatusJson(dataDir, [runId]);
    const detailRun = detail["run"] as Record<string, unknown>;
    expect(detailRun["state"]).toBe("succeeded");
    expect(detailRun["needsManualRecovery"]).toBe(false);
    const detailSteps = detail["steps"] as Array<Record<string, unknown>>;
    expect(detailSteps.map((s) => s["stepId"])).toEqual(
      E2E_STEPS.map((s) => s.stepId),
    );
    for (const step of detailSteps) {
      expect(step["state"]).toBe("succeeded");
    }
    expect((detail["leases"] as unknown[]).length).toBe(0);
    expect((detail["approvals"] as unknown[]).length).toBe(1);

    // Handoff envelope: terminal next action, no recovery.
    const handoff = workflowHandoffJson(dataDir, runId);
    expect(handoff).toMatchObject({
      ok: true,
      schemaVersion: 2,
    });
    expect((handoff["run"] as Record<string, unknown>)["state"]).toBe(
      "succeeded",
    );
    const nextAction = handoff["nextAction"] as Record<string, unknown>;
    expect(nextAction["code"]).toBe("no_action");
    const monitor = handoff["monitor"] as Record<string, unknown>;
    expect(monitor["recovery"]).toBeNull();
    expect((handoff["leases"] as unknown[]).length).toBe(0);
    expect((handoff["evidence"] as unknown[]).length).toBe(0);

    // Approval-gated step durably recorded.
    const approvals = handoff["approvals"] as Array<Record<string, unknown>>;
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      boundary: "through-merge-cleanup",
      actor: "smoke-tester",
      runId,
    });

    // Ingest evidence so the handoff envelope surfaces artifact pointers.
    const evidenceResult = runCliBinary([
      "evidence",
      "ingest",
      "--path",
      runDir,
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(
      evidenceResult.code,
      `evidence ingest stderr: ${evidenceResult.stderr}`,
    ).toBe(0);
    const evidencePayload = JSON.parse(evidenceResult.stdout) as Record<
      string,
      unknown
    >;
    const evidenceCounts = evidencePayload["counts"] as Record<string, number>;
    expect(evidenceCounts["created"]).toBeGreaterThan(0);

    const handoffAfterEvidence = workflowHandoffJson(dataDir, runId);
    const evidenceLinks = handoffAfterEvidence["evidence"] as Array<
      Record<string, unknown>
    >;
    expect(evidenceLinks.length).toBeGreaterThan(0);
    expect(evidenceLinks.some((e) => e["type"] === "plan_created")).toBe(true);
    expect(evidenceLinks.some((e) => e["type"] === "merge_complete")).toBe(
      true,
    );
  }, 120_000);

  it("leaves no ghost active run when a required step fails mid-workflow", () => {
    const dataDir = makeTempDir("momentum-smoke-m7-e2e-fail-");
    const fixtureRoot = makeTempDir("momentum-smoke-m7-e2e-fail-fixture-");
    const runId = "cwfp-smoke7e2efail";
    const runDir = writeM7EndToEndFixture(fixtureRoot, runId);

    let cursor = Date.parse("2026-05-25T11:00:00Z");

    const preflightStep = E2E_STEPS[0]!;
    const preflightResult = driveStepWithFakeExecutor(
      runDir,
      runId,
      preflightStep,
      "success",
      new Date(cursor).toISOString(),
      new Date(cursor + 60_000).toISOString(),
    );
    expect(preflightResult.ledgerStatus).toBe("complete");
    cursor += 120_000;

    const implementationStep = E2E_STEPS[1]!;
    const implementationResult = driveStepWithFakeExecutor(
      runDir,
      runId,
      implementationStep,
      "fail_retry",
      new Date(cursor).toISOString(),
      new Date(cursor + 60_000).toISOString(),
    );
    expect(implementationResult.ledgerStatus).toBe("failed");
    expect(implementationResult.errorCode).toBe("command_failed");

    const importPayload = importWorkflowRun(dataDir, runDir);
    expect(importPayload).toMatchObject({
      ok: true,
      runId,
      state: "failed",
    });

    // Failure leaves no ghost active or blocked run.
    const activeRuns = workflowStatusJson(dataDir, ["--filter", "active"]);
    expect(activeRuns).toMatchObject({ ok: true, count: 0 });
    const blockedRuns = workflowStatusJson(dataDir, ["--filter", "blocked"]);
    expect(blockedRuns).toMatchObject({ ok: true, count: 0 });

    const completedRuns = workflowStatusJson(dataDir, [
      "--filter",
      "completed",
    ]);
    const completedList = completedRuns["runs"] as Array<
      Record<string, unknown>
    >;
    expect(
      completedList.some(
        (entry) =>
          (entry["run"] as Record<string, unknown>)["runId"] === runId &&
          (entry["run"] as Record<string, unknown>)["state"] === "failed",
      ),
    ).toBe(true);

    // Detail view: failed required step, no leases.
    const detail = workflowStatusJson(dataDir, [runId]);
    const detailSteps = detail["steps"] as Array<Record<string, unknown>>;
    const preflightDetail = detailSteps.find(
      (s) => s["stepId"] === preflightStep.stepId,
    );
    expect(preflightDetail?.["state"]).toBe("succeeded");
    const implementationDetail = detailSteps.find(
      (s) => s["stepId"] === implementationStep.stepId,
    );
    expect(implementationDetail?.["state"]).toBe("failed");
    expect(implementationDetail?.["errorCode"]).toBe("command_failed");
    expect((detail["leases"] as unknown[]).length).toBe(0);

    // Handoff envelope surfaces the failed-required-step recovery.
    const handoff = workflowHandoffJson(dataDir, runId);
    const handoffRun = handoff["run"] as Record<string, unknown>;
    expect(handoffRun["state"]).toBe("failed");
    const handoffNext = handoff["nextAction"] as Record<string, unknown>;
    expect(handoffNext["code"]).toBe("rerun_failed_step");
    expect(handoffNext["stepId"]).toBe(implementationStep.stepId);
    const handoffMonitor = handoff["monitor"] as Record<string, unknown>;
    const recovery = handoffMonitor["recovery"] as Record<string, unknown>;
    expect(recovery).not.toBeNull();
    expect(recovery["code"]).toBe("failed_required_step");
    expect(recovery["stepId"]).toBe(implementationStep.stepId);
    expect((handoff["leases"] as unknown[]).length).toBe(0);
  }, 120_000);
});
