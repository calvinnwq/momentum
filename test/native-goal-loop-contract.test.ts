import { describe, expect, it } from "vitest";

import { WORKFLOW_EXECUTOR_FAMILIES } from "../src/core/workflow/definition/definition.js";
import {
  EXECUTOR_INVOCATION_STATES,
  EXECUTOR_ROUND_STATES
} from "../src/core/executors/loop/reducer.js";
import { readRepoFile } from "./helpers/repo-docs.js";

describe("native goal-loop contract docs", () => {
  const spec = readRepoFile("SPEC.md");
  const dataDirectory = readRepoFile("docs/data-directory.md");
  const workflowCommands = readRepoFile("docs/workflow-commands.md");

  it("defines invocation and round ownership below workflow steps", () => {
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

  it("pins the repo-native invocation and round state vocabulary", () => {
    expect([...EXECUTOR_INVOCATION_STATES]).toEqual([
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

  it("freezes the normalized round result JSON fixture", () => {
    const fixture = JSON.parse(
      readRepoFile("test/fixtures/native-goal-loop-result.json")
    ) as Record<string, unknown>;

    expect(Object.keys(fixture)).toEqual([
      "schema",
      "summary",
      "keyChanges",
      "learnings",
      "completionRecommendation",
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
      "Native goal-loop status and log readers treat Momentum executor rows and child evidence as the source of truth"
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
