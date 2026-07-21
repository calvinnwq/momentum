import { afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  buildCli,
  cleanupTempRoots,
  makeTempDir,
  runCliBinary,
} from "./helpers/smoke-harness.js";
import {
  E2E_STEPS,
  appendLedgerEvent,
  driveStepWithFakeExecutor,
  importWorkflowRun,
  workflowRunListJson,
  workflowRunMonitorJson,
  workflowStatusJson,
  writeM7EndToEndFixture,
} from "./helpers/workflow-smoke-harness.js";

beforeAll(buildCli, 60_000);

afterEach(cleanupTempRoots);

describe("Milestone 8 operator-control end-to-end smoke (NGX-330)", () => {
  it("composes list / approve / monitor / typed evidence linkage through the built CLI", () => {
    const dataDir = makeTempDir("momentum-smoke-m8-ops-");
    const fixtureRoot = makeTempDir("momentum-smoke-m8-ops-fixture-");
    const runId = "cwfp-smoke8ops";
    const runDir = writeM7EndToEndFixture(fixtureRoot, runId);

    // Import plan + approval; the run is awaiting execution.
    const initialImport = importWorkflowRun(dataDir, runDir);
    expect(initialImport).toMatchObject({
      ok: true,
      runId,
      state: "approved",
      needsManualRecovery: false,
    });

    // workflow run list: the durable row is discoverable without an
    // `.agent-workflows/` directory scan, and the approved run is active.
    const listAll = workflowRunListJson(dataDir);
    expect(listAll["ok"]).toBe(true);
    const listedIds = (
      listAll["runs"] as Array<{ run: { runId: string } }>
    ).map((entry) => entry.run.runId);
    expect(listedIds).toContain(runId);

    const listActive = workflowRunListJson(dataDir, ["--filter", "active"]);
    expect(
      (listActive["runs"] as Array<{ run: { runId: string } }>).map(
        (entry) => entry.run.runId,
      ),
    ).toContain(runId);

    // workflow run approve: an explicit operator approval at a distinct
    // boundary persists a durable row alongside the imported approval.
    const approveResult = runCliBinary([
      "workflow",
      "run",
      "approve",
      runId,
      "--approval-boundary",
      "no-mistakes",
      "--phrase",
      "approve no-mistakes",
      "--actor",
      "smoke-operator",
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(
      approveResult.code,
      `workflow run approve stderr: ${approveResult.stderr}`,
    ).toBe(0);
    expect(JSON.parse(approveResult.stdout)).toMatchObject({
      ok: true,
      command: "workflow run approve",
      runId,
      boundary: "no-mistakes",
    });

    // Both the imported and operator-added approvals compose into status.
    const statusAfterApprove = workflowStatusJson(dataDir, [runId]);
    const approvalBoundaries = (
      statusAfterApprove["approvals"] as Array<Record<string, unknown>>
    ).map((approval) => approval["boundary"]);
    expect(approvalBoundaries).toContain("through-merge-cleanup");
    expect(approvalBoundaries).toContain("no-mistakes");

    // Drive every step through the fake executor to terminal success,
    // re-importing between iterations. The operator approval survives the
    // re-imports (upsert keyed on run/boundary, never delete).
    let cursor = Date.parse("2026-05-26T10:00:00Z");
    for (const step of E2E_STEPS) {
      const driveResult = driveStepWithFakeExecutor(
        runDir,
        runId,
        step,
        "success",
        new Date(cursor).toISOString(),
        new Date(cursor + 60_000).toISOString(),
      );
      expect(driveResult.ledgerStatus).toBe("complete");
      cursor += 120_000;
      importWorkflowRun(dataDir, runDir);
    }

    const finalImport = importWorkflowRun(dataDir, runDir);
    expect(finalImport).toMatchObject({
      ok: true,
      runId,
      state: "succeeded",
      needsManualRecovery: false,
    });

    // workflow run list: the run has moved into the completed bucket.
    const listCompleted = workflowRunListJson(dataDir, [
      "--filter",
      "completed",
    ]);
    expect(
      (
        listCompleted["runs"] as Array<{
          run: { runId: string; state: string };
        }>
      ).some(
        (entry) => entry.run.runId === runId && entry.run.state === "succeeded",
      ),
    ).toBe(true);

    // The operator approval still surfaces after the run finalized.
    const finalApprovalBoundaries = (
      workflowStatusJson(dataDir, [runId])["approvals"] as Array<
        Record<string, unknown>
      >
    ).map((approval) => approval["boundary"]);
    expect(finalApprovalBoundaries).toContain("no-mistakes");

    // workflow run monitor: a stable terminal report, no recovery, and no
    // evidence pointers before ingest.
    const monitor = workflowRunMonitorJson(dataDir, runId);
    expect(monitor).toMatchObject({
      ok: true,
      command: "workflow run monitor",
      schemaVersion: 2,
      runId,
      runState: "succeeded",
      terminal: true,
      needsManualRecovery: false,
      disposition: "report",
      reportable: true,
      reportReason: "terminal_succeeded",
      recovery: null,
    });
    expect((monitor["evidence"] as unknown[]).length).toBe(0);

    // Typed evidence linkage: ingest workflow artifacts, then assert every
    // record attaches the owning runId, plan evidence is run-scoped (null
    // stepId), and ledger step events carry the typed stepId.
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
    expect(
      (
        (JSON.parse(evidenceResult.stdout) as Record<string, unknown>)[
          "counts"
        ] as Record<string, number>
      )["created"],
    ).toBeGreaterThan(0);

    const monitorWithEvidence = workflowRunMonitorJson(dataDir, runId);
    const monitorEvidence = monitorWithEvidence["evidence"] as Array<
      Record<string, unknown>
    >;
    expect(monitorEvidence.length).toBeGreaterThan(0);
    expect(monitorEvidence.every((entry) => entry["runId"] === runId)).toBe(
      true,
    );

    const detail = workflowStatusJson(dataDir, [runId]);
    const detailEvidence = detail["evidence"] as Array<Record<string, unknown>>;
    expect(detailEvidence.length).toBeGreaterThan(0);
    expect(detailEvidence.every((entry) => entry["runId"] === runId)).toBe(
      true,
    );
    const planEvidence = detailEvidence.find(
      (entry) => entry["type"] === "plan_created",
    );
    expect(planEvidence).toBeDefined();
    expect(planEvidence?.["stepId"]).toBeNull();
    expect(
      detailEvidence.some(
        (entry) =>
          typeof entry["stepId"] === "string" &&
          (entry["stepId"] as string).length > 0,
      ),
    ).toBe(true);
  }, 120_000);

  it("recovers a ghost-active run: flag, monitor recover, clear-recovery refusal, update-step resolution, then a clean clear", () => {
    const dataDir = makeTempDir("momentum-smoke-m8-recover-");
    const fixtureRoot = makeTempDir("momentum-smoke-m8-recover-fixture-");
    const runId = "cwfp-smoke8recover";
    const runDir = writeM7EndToEndFixture(fixtureRoot, runId);

    // Drive preflight to a clean terminal success.
    let cursor = Date.parse("2026-05-26T11:00:00Z");
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

    // Simulate a managed child that died mid-implementation: a `started`
    // ledger event with no terminal event and no recorded lease. On import
    // the monitor reducer classifies this as ghost_active_no_lease.
    const implementationStep = E2E_STEPS[1]!;
    appendLedgerEvent(runDir, {
      runId,
      step: implementationStep.stepId,
      status: "started",
      ts: new Date(cursor).toISOString(),
    });

    const ghostImport = importWorkflowRun(dataDir, runDir);
    expect(ghostImport).toMatchObject({
      ok: true,
      runId,
      state: "running",
      needsManualRecovery: true,
    });
    const ghostRecovery = ghostImport["recovery"] as Record<string, unknown>;
    expect(ghostRecovery["code"]).toBe("ghost_active_no_lease");
    expect(ghostRecovery["stepId"]).toBe(implementationStep.stepId);

    // recovery.md is rendered into the run directory as operator audit
    // evidence (sibling to the M3 goal-scoped recovery artifact).
    const recoveryArtifact = path.join(runDir, "recovery.md");
    expect(fs.existsSync(recoveryArtifact)).toBe(true);
    const recoveryBody = fs.readFileSync(recoveryArtifact, "utf-8");
    expect(recoveryBody).toContain(`Run ID: ${runId}`);
    expect(recoveryBody).toContain(`Step ID: ${implementationStep.stepId}`);
    expect(recoveryBody).toContain("ghost_active_no_lease");

    // The flagged run stays in the active bucket (running) and is listable.
    const listActive = workflowRunListJson(dataDir, ["--filter", "active"]);
    expect(
      (listActive["runs"] as Array<{ run: { runId: string } }>).some(
        (entry) => entry.run.runId === runId,
      ),
    ).toBe(true);

    // workflow run monitor: an explicit operator-recovery ask.
    const monitorBlocked = workflowRunMonitorJson(dataDir, runId);
    expect(monitorBlocked).toMatchObject({
      ok: true,
      runId,
      needsManualRecovery: true,
      disposition: "recover",
      reportable: true,
      reportReason: "recovery_required",
    });
    expect(
      (monitorBlocked["recovery"] as Record<string, unknown>)["code"],
    ).toBe("ghost_active_no_lease");

    // workflow run clear-recovery: refuses while the blocking condition
    // persists, leaving the durable flag set.
    const clearRefused = runCliBinary([
      "workflow",
      "run",
      "clear-recovery",
      runId,
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(clearRefused.code).toBe(1);
    expect(JSON.parse(clearRefused.stderr)).toMatchObject({
      ok: false,
      command: "workflow run clear-recovery",
      code: "recovery_clear_refused",
      runId,
      recoveryCode: "ghost_active_no_lease",
    });

    // workflow run update-step: the operator finalizes the ghost step from a
    // durable record, without hand-editing ledger.jsonl. The flagged-run
    // guard permits the transition because it resolves the blocking state.
    const updateResult = runCliBinary([
      "workflow",
      "run",
      "update-step",
      runId,
      "--step",
      implementationStep.stepId,
      "--state",
      "succeeded",
      "--reason",
      "managed child finished the executor work but durable terminal evidence never landed",
      "--actor",
      "smoke-operator",
      "--evidence-pointer",
      `.agent-workflows/${runId}/ledger.jsonl#ghost-recovery`,
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(
      updateResult.code,
      `workflow run update-step stderr: ${updateResult.stderr}`,
    ).toBe(0);
    expect(JSON.parse(updateResult.stdout)).toMatchObject({
      ok: true,
      command: "workflow run update-step",
      runId,
      stepId: implementationStep.stepId,
      state: "succeeded",
      previousState: "running",
    });

    // The durable flag persists until an explicit clear: update-step only
    // unblocks the resolving transition, it does not auto-clear recovery.
    expect(workflowRunMonitorJson(dataDir, runId)["needsManualRecovery"]).toBe(
      true,
    );

    // workflow run clear-recovery: now succeeds because the blocking
    // condition is resolved.
    const clearOk = runCliBinary([
      "workflow",
      "run",
      "clear-recovery",
      runId,
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(
      clearOk.code,
      `workflow run clear-recovery stderr: ${clearOk.stderr}`,
    ).toBe(0);
    expect(JSON.parse(clearOk.stdout)).toMatchObject({
      ok: true,
      command: "workflow run clear-recovery",
      runId,
    });

    // workflow run monitor: clean again, flag cleared, no recovery. The
    // recovery.md artifact stays on disk as audit evidence after the clear.
    const monitorCleared = workflowRunMonitorJson(dataDir, runId);
    expect(monitorCleared).toMatchObject({
      ok: true,
      runId,
      needsManualRecovery: false,
      recovery: null,
    });
    expect(fs.existsSync(recoveryArtifact)).toBe(true);
  }, 120_000);
});
