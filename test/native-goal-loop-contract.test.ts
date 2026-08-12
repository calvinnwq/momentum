import { describe, expect, it } from "vitest";

import { parseAgentResult } from "../src/core/executors/agent-result/result.js";
import {
  AGENT_RESULT_SCHEMA,
  LEGACY_RUNNER_RESULT_SCHEMA,
} from "../src/core/executors/agent-result/types.js";
import { WORKFLOW_EXECUTORS } from "../src/core/workflow/definition/definition.js";
import type { FinalizeWorkflowStepFromResultFileResult } from "../src/core/executors/shared/step-finalize.js";
import {
  EXECUTOR_ATTEMPT_STATES,
  EXECUTOR_ROUND_STATES,
} from "../src/core/executors/loop/reducer.js";
import { readRepoFile } from "./helpers/repo-docs.js";

describe("agent-loop contract docs", () => {
  const spec = readRepoFile("SPEC.md");
  const dataDirectory = readRepoFile("docs/data-directory.md");
  const workflowCommands = readRepoFile("docs/workflow-commands.md");

  it("defines attempt and round ownership below workflow steps", () => {
    expect(spec).toContain("## Agent-Loop Contract");
    expect(spec).toContain(
      "`executor_attempt` is the whole autonomous agent-loop attempt for one workflow step",
    );
    expect(spec).toContain(
      "`executor_round` is one durable iteration beneath that attempt",
    );
    expect(spec).toContain(
      "A completed round is never replayed, renamed, or overwritten to continue the loop",
    );
  });

  it("pins the repo-native attempt and round state vocabulary", () => {
    expect([...EXECUTOR_ATTEMPT_STATES]).toEqual([
      "pending",
      "preparing",
      "running",
      "pausing",
      "waiting_operator",
      "manual_recovery_required",
      "blocked",
      "failed",
      "succeeded",
      "cancelled",
    ]);
    expect([...EXECUTOR_ROUND_STATES]).toEqual([
      "pending",
      "running",
      "capturing_result",
      "finalizing",
      "mirroring_external_state",
      "waiting_operator",
      "manual_recovery_required",
      "blocked",
      "failed",
      "succeeded",
      "cancelled",
    ]);
    expect(spec).toContain(
      "Agent-loop rounds reuse the repo-native executor state vocabulary rather than introducing a parallel pending/running/succeeded/failed/stale/recovered/canceled enum.",
    );
    expect(spec).toContain(
      "`manual_recovery_required` carries stale, recovered, invalid, and unsafe-resume cases through recovery codes and durable evidence",
    );
  });

  it("keeps the frozen legacy goal_complete result fixture readable through the version-aware legacy reader", () => {
    const raw = readRepoFile(
      "test/fixtures/native-goal-loop-runner-result.json",
    );
    // The fixture is immutable history: it must keep its raw `goal_complete`
    // field on disk and still normalize through the explicit legacy reader.
    expect(raw).toContain('"goal_complete": false');
    expect(raw).not.toContain("objective_complete");
    const parsed = parseAgentResult(raw);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.schema).toBe(LEGACY_RUNNER_RESULT_SCHEMA);
    expect(parsed.value).toMatchObject({
      success: true,
      key_changes_made: [
        "Added the native agent-loop runner result fixture.",
        "Recorded durable evidence pointers for the round.",
      ],
      objective_complete: false,
      commit: {
        type: "feat",
        scope: "agent-loop",
        subject: "document native goal loop contract",
      },
    });

    const withoutOptionalArrays = JSON.parse(raw) as Record<string, unknown>;
    delete withoutOptionalArrays.key_learnings;
    delete withoutOptionalArrays.remaining_work;
    const parsedWithoutOptionalArrays = parseAgentResult(
      JSON.stringify(withoutOptionalArrays),
    );

    expect(parsedWithoutOptionalArrays.ok).toBe(true);
    if (!parsedWithoutOptionalArrays.ok) return;
    expect(parsedWithoutOptionalArrays.value.key_learnings).toEqual([]);
    expect(parsedWithoutOptionalArrays.value.remaining_work).toEqual([]);
  });

  it("fails closed when a result document carries both completion fields", () => {
    const raw = readRepoFile(
      "test/fixtures/native-goal-loop-runner-result.json",
    );
    const mixed = JSON.parse(raw) as Record<string, unknown>;
    mixed.objective_complete = mixed.goal_complete;
    const parsed = parseAgentResult(JSON.stringify(mixed));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/ambiguous/i);
  });

  it("parses current agent result documents under the named current schema", () => {
    const raw = readRepoFile(
      "test/fixtures/native-goal-loop-runner-result.json",
    );
    const current = JSON.parse(raw) as Record<string, unknown>;
    current.objective_complete = current.goal_complete;
    delete current.goal_complete;
    const parsed = parseAgentResult(JSON.stringify(current));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.schema).toBe(AGENT_RESULT_SCHEMA);
    const legacy = parseAgentResult(raw);
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) return;
    // Legacy and current documents normalize to the same internal shape.
    expect(parsed.value).toEqual(legacy.value);
  });

  it("keeps agent failure as the current finalization vocabulary", () => {
    const resetFailure: FinalizeWorkflowStepFromResultFileResult = {
      outcome: "reset_failed",
      trigger: "agent_failure",
      verification: null,
      reset: { ok: false, code: "missing_base", error: "base is missing" },
    };

    expect(resetFailure.trigger).toBe("agent_failure");
  });

  it("freezes the post-finalization round evidence JSON fixture", () => {
    const fixture = JSON.parse(
      readRepoFile("test/fixtures/native-agent-loop-round-evidence.json"),
    ) as Record<string, unknown>;
    const legacyFixture = JSON.parse(
      readRepoFile("test/fixtures/native-goal-loop-round-evidence.json"),
    ) as Record<string, unknown>;

    expect(Object.keys(fixture)).toEqual([
      "schema",
      "summary",
      "keyChanges",
      "learnings",
      "completionRecommendation",
      "daemonClassification",
      "verificationResult",
      "artifacts",
      "checkpoints",
      "changedFiles",
      "commitSha",
      "recoveryReason",
      "remainingWork",
    ]);
    expect(fixture).toMatchObject({
      schema: "momentum.native-agent-loop.round-result.v1",
      completionRecommendation: "continue",
      daemonClassification: "continue",
      verificationResult: {
        status: "passed",
        commands: [
          {
            command: "pnpm test",
            exitCode: 0,
          },
        ],
      },
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      recoveryReason: null,
    });
    expect(legacyFixture.schema).toBe(
      "momentum.native-goal-loop.round-result.v1",
    );
    expect(spec).toContain(
      "The canonical `momentum.native-agent-loop.round-result.v1` fixture is a post-finalization evidence projection",
    );
    expect(spec).toContain(
      "The retained `momentum.native-goal-loop.round-result.v1` fixture remains readable only for frozen legacy artifacts",
    );
    expect(spec).toContain(
      "Its required JSON fields are `schema`, `summary`, `keyChanges`, `learnings`, `completionRecommendation`, `daemonClassification`, `verificationResult`, `artifacts`, `checkpoints`, `changedFiles`, `commitSha`, `recoveryReason`, and `remainingWork`.",
    );
    expect(spec).toContain(
      "`completionRecommendation` is the executor's recommendation only: `complete`, `continue`, `approval_required`, `operator_decision_required`, `manual_recovery_required`, `blocked`, `failed`, or `cancelled`.",
    );
  });

  it("documents commit/reset and resume semantics from Momentum-owned durable state", () => {
    for (const expected of [
      "Successful rounds commit exactly once after verification evidence is captured",
      "Failed, invalid, stale, unsafe, canceled, or no-op rounds do not create commits",
      "Momentum resumes from durable executor_attempts, executor_rounds, leases, checkpoints, artifacts, commits, recovery codes, and accumulated learnings",
      "Resume never depends on terminal scrollback",
      "no duplicate completed rounds",
      "no duplicate commits",
    ]) {
      expect(spec).toContain(expected);
    }

    expect(dataDirectory).toContain(
      "For native agent-loop, `executor_attempts` own the autonomous attempt and `executor_rounds` own each durable iteration",
    );
    expect(workflowCommands).toContain(
      "Agent-loop log readers treat Momentum executor rows and child evidence as the source of truth",
    );
    expect(workflowCommands).toContain(
      "Future status, handoff, monitor, and GUI readers must use the same projection once they are wired to executor round evidence.",
    );
  });

  it("preserves GNHF as source material or runner reference only", () => {
    expect([...WORKFLOW_EXECUTORS]).not.toContain("gnhf");
    expect(spec).toContain(
      "GNHF is source material, a compatibility reference, or an optional runner below the legacy `goal-loop` spelling for retained definitions",
    );
    expect(spec).toContain(
      "`.gnhf/runs` is not Momentum's durable source of truth",
    );
    expect(spec).toContain(
      "`gnhf` must not become a first-class executor merely to reuse behavior",
    );
  });
});
