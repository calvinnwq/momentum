import { describe, expect, it } from "vitest";

import { parseRunnerResult } from "../src/core/executors/runner/result.js";
import { WORKFLOW_EXECUTOR_FAMILIES } from "../src/core/workflow/definition/definition.js";
import {
  EXECUTOR_ATTEMPT_STATES,
  EXECUTOR_ROUND_STATES
} from "../src/core/executors/loop/reducer.js";
import { readRepoFile } from "./helpers/repo-docs.js";

describe("native goal-loop contract docs", () => {
  const spec = readRepoFile("SPEC.md");
  const dataDirectory = readRepoFile("docs/data-directory.md");
  const workflowCommands = readRepoFile("docs/workflow-commands.md");

  it("defines attempt and round ownership below workflow steps", () => {
    expect(spec).toContain("## Native Goal-Loop Contract");
    expect(spec).toContain(
      "`executor_invocation` is the whole autonomous goal-loop attempt for one workflow step"
    );
    expect(spec).toContain(
      "`executor_round` is one durable iteration beneath that invocation"
    );
    expect(spec).toContain(
      "A completed round is never replayed, renamed, or overwritten to continue the loop"
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
      "cancelled"
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
      "cancelled"
    ]);
    expect(spec).toContain(
      "Goal-loop rounds reuse the repo-native executor state vocabulary rather than introducing a parallel pending/running/succeeded/failed/stale/recovered/canceled enum."
    );
    expect(spec).toContain(
      "`manual_recovery_required` carries stale, recovered, invalid, and unsafe-resume cases through recovery codes and durable evidence"
    );
  });

  it("freezes the shipped runner result JSON fixture", () => {
    const raw = readRepoFile("test/fixtures/native-goal-loop-runner-result.json");
    const parsed = parseRunnerResult(raw);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({
      success: true,
      key_changes_made: [
        "Added the native goal-loop runner result fixture.",
        "Recorded durable evidence pointers for the round."
      ],
      goal_complete: false,
      commit: {
        type: "feat",
        scope: "goal-loop",
        subject: "document native goal loop contract"
      }
    });

    const withoutOptionalArrays = JSON.parse(raw) as Record<string, unknown>;
    delete withoutOptionalArrays.key_learnings;
    delete withoutOptionalArrays.remaining_work;
    const parsedWithoutOptionalArrays = parseRunnerResult(
      JSON.stringify(withoutOptionalArrays)
    );

    expect(parsedWithoutOptionalArrays.ok).toBe(true);
    if (!parsedWithoutOptionalArrays.ok) return;
    expect(parsedWithoutOptionalArrays.value.key_learnings).toEqual([]);
    expect(parsedWithoutOptionalArrays.value.remaining_work).toEqual([]);
    expect(spec).toContain(
      "The runner-authored result document consumed by the shipped goal-loop mechanism remains the normalized `RunnerResult` schema"
    );
    expect(spec).toContain(
      "`key_learnings` and `remaining_work` are optional runner-authored arrays that default to empty arrays when omitted."
    );
  });

  it("freezes the post-finalization round evidence JSON fixture", () => {
    const fixture = JSON.parse(
      readRepoFile("test/fixtures/native-goal-loop-round-evidence.json")
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
      "remainingWork"
    ]);
    expect(fixture).toMatchObject({
      schema: "momentum.native-goal-loop.round-result.v1",
      completionRecommendation: "continue",
      daemonClassification: "continue",
      verificationResult: {
        status: "passed",
        commands: [
          {
            command: "pnpm test",
            exitCode: 0
          }
        ]
      },
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      recoveryReason: null
    });
    expect(spec).toContain(
      "The `momentum.native-goal-loop.round-result.v1` fixture is a post-finalization evidence projection"
    );
    expect(spec).toContain(
      "Its required JSON fields are `schema`, `summary`, `keyChanges`, `learnings`, `completionRecommendation`, `daemonClassification`, `verificationResult`, `artifacts`, `checkpoints`, `changedFiles`, `commitSha`, `recoveryReason`, and `remainingWork`."
    );
    expect(spec).toContain(
      "`completionRecommendation` is the executor's recommendation only: `complete`, `continue`, `approval_required`, `operator_decision_required`, `manual_recovery_required`, `blocked`, `failed`, or `cancelled`."
    );
  });

  it("documents commit/reset and resume semantics from Momentum-owned durable state", () => {
    for (const expected of [
      "Successful rounds commit exactly once after verification evidence is captured",
      "Failed, invalid, stale, unsafe, canceled, or no-op rounds do not create commits",
      "Momentum resumes from durable executor_invocations, executor_rounds, leases, checkpoints, artifacts, commits, recovery codes, and accumulated learnings",
      "Resume never depends on terminal scrollback",
      "no duplicate completed rounds",
      "no duplicate commits"
    ]) {
      expect(spec).toContain(expected);
    }

    expect(dataDirectory).toContain(
      "For native goal-loop, `executor_invocations` own the autonomous attempt and `executor_rounds` own each durable iteration"
    );
    expect(workflowCommands).toContain(
      "Native goal-loop log readers treat Momentum executor rows and child evidence as the source of truth"
    );
    expect(workflowCommands).toContain(
      "Future status, handoff, monitor, and GUI readers must use the same projection once they are wired to executor round evidence."
    );
  });

  it("preserves GNHF as source material or runner reference only", () => {
    expect([...WORKFLOW_EXECUTOR_FAMILIES]).not.toContain("gnhf");
    expect(spec).toContain(
      "GNHF is source material, a compatibility reference, or an optional runner below `goal-loop`"
    );
    expect(spec).toContain(
      "`.gnhf/runs` is not Momentum's durable source of truth"
    );
    expect(spec).toContain(
      "`gnhf` must not become a first-class executor family merely to reuse behavior"
    );
  });
});
