import { describe, expect, it } from "vitest";

import {
  EXECUTOR_ARTIFACT_CLASSES,
  EXECUTOR_COMPLETION_CLASSIFICATIONS,
  EXECUTOR_HUMAN_GATE_TYPES,
  EXECUTOR_ATTEMPT_TERMINAL_STATES,
  EXECUTOR_ROUND_TERMINAL_STATES,
  transitionExecutorAttempt,
  transitionExecutorRound,
} from "../src/core/executors/loop/reducer.js";
import { expectSpecSection, readRepoFile } from "./helpers/repo-docs.js";

describe("executor loop contract", () => {
  const spec = readRepoFile("SPEC.md");

  it("keeps an executor layer anchor below workflow steps", () => {
    expectSpecSection(spec, "Runtime Model");
    expect(spec).toContain("ExecutorAttempt");
    expect(spec).toContain("ExecutorRound");
  });

  it("pins completion classifications and human gate types in runtime constants", () => {
    expect([...EXECUTOR_COMPLETION_CLASSIFICATIONS]).toEqual([
      "complete",
      "continue",
      "approval_required",
      "operator_decision_required",
      "manual_recovery_required",
      "blocked",
      "failed",
      "cancelled",
    ]);
    expect([...EXECUTOR_HUMAN_GATE_TYPES]).toContain(
      "destructive_action_requested",
    );
    expect([...EXECUTOR_HUMAN_GATE_TYPES]).toContain("credential_required");
  });

  it("keeps terminal state and artifact vocabularies executable", () => {
    expect([...EXECUTOR_ATTEMPT_TERMINAL_STATES]).toEqual([
      "manual_recovery_required",
      "blocked",
      "failed",
      "succeeded",
      "cancelled",
    ]);
    expect([...EXECUTOR_ROUND_TERMINAL_STATES]).toEqual([
      "manual_recovery_required",
      "blocked",
      "failed",
      "succeeded",
      "cancelled",
    ]);
    expect([...EXECUTOR_ARTIFACT_CLASSES]).toEqual([
      "result_document",
      "logs",
      "checkpoint_stream",
      "verification_output",
      "commit_or_reset_evidence",
      "recovery_note",
    ]);
  });

  it("enforces reducer transitions instead of relying on prose", () => {
    expect(transitionExecutorAttempt("pending", "preparing")).toEqual({
      ok: true,
      state: "preparing",
    });
    expect(transitionExecutorAttempt("succeeded", "running")).toMatchObject({
      ok: false,
      errorCode: "executor_attempt_terminal",
    });
    expect(transitionExecutorRound("running", "supervising_delegate")).toEqual({
      ok: true,
      state: "supervising_delegate",
    });
    expect(transitionExecutorRound("failed", "running")).toMatchObject({
      ok: false,
      errorCode: "executor_round_terminal",
    });
  });
});
