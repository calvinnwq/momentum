import { describe, expect, it } from "vitest";

import {
  buildOpenClawWatchProcessCommand,
  OpenClawWatchRunnerError,
  parseOpenClawWatchFailureOutput,
  parseOpenClawWatchOutput
} from "../src/adapters/openclaw-watch-runner.js";

describe("buildOpenClawWatchProcessCommand", () => {
  it("preserves source-loader exec arguments for TypeScript entrypoint fallbacks", () => {
    const command = buildOpenClawWatchProcessCommand({
      runId: "cwfp-openclaw",
      dataDir: "/tmp/momentum-home",
      nodePath: "/usr/local/bin/node",
      nodeExecArgv: ["--import", "tsx"],
      distEntrypoint: "/repo/dist/index.js",
      distExists: false,
      argvEntrypoint: "/repo/src/index.ts",
      argvEntrypointExists: true
    });

    expect(command).toEqual({
      command: "/usr/local/bin/node",
      args: [
        "--import",
        "tsx",
        "/repo/src/index.ts",
        "workflow",
        "run",
        "watch",
        "cwfp-openclaw",
        "--once",
        "--data-dir",
        "/tmp/momentum-home",
        "--json"
      ]
    });
  });
});

describe("parseOpenClawWatchFailureOutput", () => {
  it("extracts workflow watch failure envelope codes from stderr", () => {
    const failure = parseOpenClawWatchFailureOutput(
      JSON.stringify({
        ok: false,
        command: "workflow run watch",
        code: "run_not_found",
        message: "Workflow run not found: cwfp-missing",
        runId: "cwfp-missing"
      })
    );

    expect(failure).toEqual({
      code: "run_not_found",
      message: "Workflow run not found: cwfp-missing"
    });
  });

  it("ignores non-envelope stderr diagnostics", () => {
    expect(parseOpenClawWatchFailureOutput("database locked\n")).toBeNull();
    expect(
      parseOpenClawWatchFailureOutput(
        JSON.stringify({
          ok: false,
          command: "workflow run watch",
          code: "",
          message: "missing code"
        })
      )
    ).toBeNull();
  });
});

describe("parseOpenClawWatchOutput", () => {
  it("fails closed when watch output omits action policy metadata", () => {
    const parsed = parseOpenClawWatchOutput(
      JSON.stringify({
        ok: true,
        command: "workflow run watch",
        mode: "once",
        runId: "cwfp-openclaw",
        emit: true,
        reason: "in_progress",
        recommendedAction: "poll",
        nextPollSeconds: 15,
        humanAction: null,
        cleanup: "none",
        digest: "sha256:progress",
        cursor: null,
        phase: "advancing",
        stuckRisk: "low",
        inspectionCommand: null
      }),
      "cwfp-openclaw"
    );

    expect(parsed.recommendedActionPolicy).toMatchObject({
      action: "poll",
      authority: "human_required",
      risk: "high"
    });
  });

  it("fails closed when watch output supplies invalid or unsafe policy metadata", () => {
    const parsed = parseOpenClawWatchOutput(
      JSON.stringify({
        ok: true,
        command: "workflow run watch",
        mode: "once",
        runId: "cwfp-openclaw",
        emit: true,
        reason: "awaiting_approval",
        recommendedAction: "approve",
        recommendedActionPolicy: {
          action: "approval_decision",
          authority: "auto_allowed",
          risk: "low",
          evidenceRequired: ["open approval gate"],
          rollback: "No rollback.",
          rationale: "Invalidly trusted approval."
        },
        nextPollSeconds: 30,
        humanAction: null,
        cleanup: "none",
        digest: "sha256:approval",
        cursor: null,
        phase: "awaiting_approval",
        stuckRisk: "medium",
        inspectionCommand: null
      }),
      "cwfp-openclaw"
    );

    expect(parsed.recommendedActionPolicy).toMatchObject({
      action: "approve",
      authority: "human_required",
      risk: "high"
    });
  });

  it("fails closed when watch output smuggles a different policy action", () => {
    const parsed = parseOpenClawWatchOutput(
      JSON.stringify({
        ok: true,
        command: "workflow run watch",
        mode: "once",
        runId: "cwfp-openclaw",
        emit: true,
        reason: "in_progress",
        recommendedAction: "poll",
        recommendedActionPolicy: {
          action: "stale_lease_auto_release",
          authority: "auto_allowed",
          risk: "low",
          evidenceRequired: ["stale lease"],
          rollback: "Recreate a lease.",
          rationale: "Incorrect action for a poll recommendation."
        },
        nextAction: {
          code: "resume_running",
          stepId: "implementation",
          leaseKind: "managed-step",
          detail: "Step is running."
        },
        nextPollSeconds: 15,
        humanAction: null,
        cleanup: "none",
        digest: "sha256:progress",
        cursor: null,
        phase: "advancing",
        stuckRisk: "low",
        inspectionCommand: null
      }),
      "cwfp-openclaw"
    );

    expect(parsed.recommendedActionPolicy).toMatchObject({
      action: "poll",
      authority: "human_required",
      risk: "high"
    });
  });

  it("preserves gate policy precedence for approved tail-step watch payloads", () => {
    const parsed = parseOpenClawWatchOutput(
      JSON.stringify({
        ok: true,
        command: "workflow run watch",
        mode: "once",
        runId: "cwfp-openclaw",
        emit: true,
        reason: "operator_decision",
        recommendedAction: "operator_decision",
        recommendedActionPolicy: {
          action: "operator_decision",
          authority: "human_required",
          risk: "medium",
          evidenceRequired: ["open operator-decision gate", "chosen allowed action"],
          rollback: "Record a new gate decision or recover the run with operator evidence.",
          rationale:
            "Operator decisions select a branch of execution and cannot be inferred by the supervisor."
        },
        nextAction: {
          code: "advance_to_step",
          stepId: "merge-cleanup",
          leaseKind: "managed-step",
          detail: "Step is approved."
        },
        activeStep: {
          stepId: "merge-cleanup",
          kind: "merge-cleanup",
          state: "approved",
          order: 4,
          required: true
        },
        nextPollSeconds: 15,
        humanAction: {
          code: "resolve_gate",
          command:
            "momentum workflow run decide gate-watch-tail-decision --action <action> --actor <name>",
          detail: "Merge cleanup needs operator direction before dispatch.",
          gateType: "operator_decision_required"
        },
        cleanup: "none",
        digest: "sha256:tail-gate",
        cursor: null,
        phase: "advancing",
        stuckRisk: "medium",
        inspectionCommand: null
      }),
      "cwfp-openclaw"
    );

    expect(parsed.recommendedActionPolicy).toMatchObject({
      action: "operator_decision",
      authority: "human_required",
      risk: "medium"
    });
  });

  it("preserves direct failure envelope codes", () => {
    let thrown: unknown;
    try {
      parseOpenClawWatchOutput(
        JSON.stringify({
          ok: false,
          command: "workflow run watch",
          code: "watch_unsupported_source",
          message: "`workflow run watch --once` is only supported here.",
          runId: "cwfp-openclaw"
        }),
        "cwfp-openclaw"
      )
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(OpenClawWatchRunnerError);
    expect((thrown as OpenClawWatchRunnerError).code).toBe(
      "watch_unsupported_source"
    );
    expect((thrown as Error).message).toBe(
      "`workflow run watch --once` is only supported here."
    );
  });
});
