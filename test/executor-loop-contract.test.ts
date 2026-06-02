import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readDoc(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), "utf8");
}

describe("executor loop planning contract", () => {
  const contractPath = "internal/contracts/executor-loop.md";

  it("pins daemon-owned orchestration and executor-owned bounded work", () => {
    const contract = readDoc(contractPath);

    expect(contract).toMatch(/daemon owns orchestration/i);
    expect(contract).toMatch(/Executors own bounded work/i);
    expect(contract).toMatch(/Executors may recommend progress\. The daemon decides progress\./);
  });

  it("keeps executor-loop state below StepRun instead of flattening rounds into workflow steps", () => {
    const contract = readDoc(contractPath);

    for (const record of [
      "executor_definitions",
      "executor_invocations",
      "executor_rounds",
      "executor_artifacts",
      "executor_findings",
      "executor_decisions",
      "executor_checkpoints",
    ]) {
      expect(contract, `contract should name ${record}`).toContain(record);
    }

    expect(contract).toMatch(/nested below step state/i);
    expect(contract).toMatch(/StepRun: implementation \/ running/);
  });

  it("defines invocation states, round states, and durable human pauses", () => {
    const contract = readDoc(contractPath);

    for (const state of [
      "pending",
      "preparing",
      "running",
      "waiting_operator",
      "manual_recovery_required",
      "blocked",
      "failed",
      "succeeded",
      "cancelled",
    ]) {
      expect(contract, `contract should name ${state}`).toContain(state);
    }

    expect(contract).toMatch(/`waiting_operator` is not terminal/i);
  });

  it("requires a normalized result or mirrored external state before classification", () => {
    const contract = readDoc(contractPath);

    expect(contract).toMatch(/Require a normalized result document or mirrored external state snapshot/i);
    expect(contract).toMatch(/cannot silently skip the normalized result step/i);
    expect(contract).toMatch(/classifies the round as failed or manual recovery/i);
  });

  it("pins the common round schema used by status, handoff, monitor, and recovery surfaces", () => {
    const contract = readDoc(contractPath);

    for (const field of [
      "round_id",
      "workflow_run_id",
      "step_run_id",
      "executor_family",
      "round_index",
      "agent_provider",
      "model",
      "input_digest",
      "result_digest",
      "verification_status",
      "commit_sha",
      "recovery_code",
      "human_gate",
    ]) {
      expect(contract, `contract should name ${field}`).toContain(field);
    }

    expect(contract).toMatch(/workflow status, handoff, monitor, and recovery surfaces/i);
  });

  it("pins completion classification and human-gate taxonomy", () => {
    const contract = readDoc(contractPath);

    for (const decision of [
      "complete",
      "continue",
      "approval_required",
      "operator_decision_required",
      "manual_recovery_required",
      "blocked",
      "failed",
      "cancelled",
    ]) {
      expect(contract, `contract should name ${decision}`).toContain(decision);
    }

    for (const gate of [
      "policy_boundary_exceeded",
      "quota_exhausted",
      "scope_boundary_exceeded",
      "credential_required",
      "external_state_required",
      "destructive_action_requested",
    ]) {
      expect(contract, `contract should name ${gate}`).toContain(gate);
    }
  });

  it("sets deterministic agent and model selection precedence", () => {
    const contract = readDoc(contractPath);

    expect(contract).toMatch(/StepDefinition executor config[\s\S]*WorkflowDefinition defaults[\s\S]*Repository policy[\s\S]*Executor family default[\s\S]*Momentum global default/);
    expect(contract).toMatch(/copied into the `executor_rounds` record before the round starts/i);
  });

  it("makes durable reattach and external executor mirroring authoritative", () => {
    const contract = readDoc(contractPath);

    expect(contract).toMatch(/reattach using durable state alone/i);
    expect(contract).toMatch(/Process handles, sockets, hook events, and file watchers are fast-path hints/i);
    expect(contract).toMatch(/External state strings are never enough on their own/i);
    expect(contract).toMatch(/Momentum reconciles external state with artifacts, logs, repo state/i);
  });

  it("links from the workflow-first pivot, roadmap, and exclusions", () => {
    const pivot = readDoc("internal/contracts/workflow-first-runtime.md");
    const roadmap = readDoc("internal/roadmap.md");
    const exclusions = readDoc("internal/exclusions.md");

    expect(pivot).toContain("internal/contracts/executor-loop.md");
    expect(roadmap).toContain("internal/contracts/executor-loop.md");
    expect(exclusions).toContain("internal/contracts/executor-loop.md");
  });
});
