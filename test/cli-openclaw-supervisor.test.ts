import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli.js";
import type { OpenClawSupervisorWatchEnvelope } from "../src/core/openclaw/supervisor.js";

type CliResult = {
  code: number;
  stdout: string;
  stderr: string;
};

const tempRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momentum-openclaw-cli-"));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function watch(
  input: Partial<OpenClawSupervisorWatchEnvelope>
): OpenClawSupervisorWatchEnvelope {
  return {
    ok: true,
    command: "workflow run watch",
    mode: "once",
    runId: input.runId ?? "cwfp-openclaw-cli",
    emit: input.emit ?? true,
    reason: input.reason ?? "in_progress",
    recommendedAction: input.recommendedAction ?? "poll",
    recommendedActionPolicy: input.recommendedActionPolicy ?? {
      action: "watch_recheck",
      authority: "auto_allowed",
      risk: "low",
      evidenceRequired: ["durable monitor/watch state"],
      rollback: "Stop polling; no external state was changed.",
      rationale: "Read-only supervisor polling is safe to repeat."
    },
    nextPollSeconds: input.nextPollSeconds ?? 15,
    humanAction: input.humanAction ?? null,
    cleanup: input.cleanup ?? "none",
    digest: input.digest ?? "sha256:cli",
    cursor: input.cursor ?? null,
    phase: input.phase ?? "advancing",
    stuckRisk: input.stuckRisk ?? "low",
    inspectionCommand: input.inspectionCommand ?? null
  };
}

function releaseMonitorPolicy() {
  return {
    action: "release_monitor",
    authority: "auto_allowed" as const,
    risk: "low" as const,
    evidenceRequired: ["terminal run state", "cleanup release signal"],
    rollback:
      "Re-register or resume the external monitor if more observation is needed.",
    rationale:
      "Releasing a supervisor monitor after terminal evidence only affects local/host polling registration."
  };
}

async function run(
  args: string[],
  watchPayload: OpenClawSupervisorWatchEnvelope,
  env: Record<string, string | undefined> = {}
): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(
    args,
    {
      stdout: { write: (chunk: string) => ((stdout += chunk), true) },
      stderr: { write: (chunk: string) => ((stderr += chunk), true) },
      env
    },
    {
      openClawWatchOnce: async () => watchPayload
    }
  );
  return { code, stdout, stderr };
}

describe("momentum openclaw supervise", () => {
  it("emits a sanitized once-mode JSON envelope and persists duplicate suppression", async () => {
    const dataDir = makeTempDir();
    const args = [
      "openclaw",
      "supervise",
      "cwfp-openclaw-cli",
      "--once",
      "--data-dir",
      dataDir,
      "--json"
    ];
    const payload = watch({ digest: "sha256:cli-progress" });

    const first = await run(args, payload);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stderr).toBe("");
    const firstJson = JSON.parse(first.stdout) as Record<string, unknown>;
    expect(firstJson).toMatchObject({
      ok: true,
      command: "openclaw supervise",
      mode: "once",
      runId: "cwfp-openclaw-cli",
      emit: true,
      eventType: "progress",
      reason: "in_progress",
      digest: "sha256:cli-progress",
      monitorEnabled: true,
      cleanupAction: null,
      debug: {
        watchEmit: true,
        suppressedReason: null,
        stateChanged: true
      },
      autoAction: {
        actionType: "watch_recheck",
        result: "success",
        statePersistence: "saved"
      }
    });
    expect(firstJson).toMatchObject({
      deliveryIntent: {
        kind: "progress",
        severity: "info",
        text: "cwfp-openclaw-cli is progressing. Next check in 15s.",
        action: null,
        wake: {
          target: "openclaw",
          intent: "message",
          reason: "progress"
        },
        message: {
          platform: "discord",
          format: "plain_text",
          allowedMentions: "none"
        },
        cleanup: null,
        failure: {
          retryable: true,
          logLevel: "warn",
          stateImpact: "none"
        }
      }
    });
    expect(JSON.stringify(firstJson)).not.toContain(dataDir);

    const second = await run(args, payload);
    expect(second.code, second.stderr).toBe(0);
    const secondJson = JSON.parse(second.stdout) as Record<string, unknown>;
    expect(secondJson).toMatchObject({
      ok: true,
      emit: false,
      eventType: null,
      deliveryIntent: null,
      debug: {
        watchEmit: true,
        suppressedReason: "duplicate_digest",
        stateChanged: true
      }
    });
    expect(JSON.stringify(secondJson)).not.toContain(dataDir);
  });

  it("sanitizes inspection commands in JSON and text output", async () => {
    const dataDir = makeTempDir();
    const payload = watch({
      reason: "stuck_risk",
      stuckRisk: "high",
      inspectionCommand: `momentum workflow run monitor 'cwfp-openclaw-cli' --data-dir '${dataDir}' --advance --json`,
      digest: "sha256:stuck-risk"
    });

    const jsonResult = await run(
      [
        "openclaw",
        "supervise",
        "cwfp-openclaw-cli",
        "--once",
        "--data-dir",
        dataDir,
        "--json"
      ],
      payload
    );

    expect(jsonResult.code, jsonResult.stderr).toBe(0);
    expect(jsonResult.stderr).toBe("");
    expect(jsonResult.stdout).not.toContain(dataDir);
    expect(JSON.parse(jsonResult.stdout)).toMatchObject({
      inspectionCommand:
        "momentum workflow run monitor 'cwfp-openclaw-cli' --data-dir <data-dir> --advance --json",
      deliveryIntent: {
        kind: "stuck-risk",
        text:
          "Stuck risk is high for cwfp-openclaw-cli. Inspect: momentum workflow run monitor 'cwfp-openclaw-cli' --data-dir <data-dir> --advance --json",
        action: {
          command:
            "momentum workflow run monitor 'cwfp-openclaw-cli' --data-dir <data-dir> --advance --json",
          evidence: "stuckRisk=high"
        }
      }
    });

    const textResult = await run(
      [
        "openclaw",
        "supervise",
        "cwfp-openclaw-cli-text",
        "--once",
        "--data-dir",
        dataDir
      ],
      watch({
        runId: "cwfp-openclaw-cli-text",
        reason: "stuck_risk",
        stuckRisk: "high",
        inspectionCommand: `momentum workflow run monitor cwfp-openclaw-cli-text --data-dir=${dataDir} --advance --json`,
        digest: "sha256:stuck-risk-text"
      })
    );

    expect(textResult.code, textResult.stderr).toBe(0);
    expect(textResult.stdout).not.toContain(dataDir);
    expect(textResult.stdout).toContain(
      "Inspection command: momentum workflow run monitor 'cwfp-openclaw-cli-text' --data-dir <data-dir> --advance --json"
    );
    expect(textResult.stdout).toContain("Delivery intent: stuck-risk (warning)");
    expect(textResult.stdout).toContain(
      "Delivery text: Stuck risk is high for cwfp-openclaw-cli-text. Inspect: momentum workflow run monitor 'cwfp-openclaw-cli-text' --data-dir <data-dir> --advance --json"
    );
  });

  it("sanitizes long delivery text before applying Discord truncation", async () => {
    const dataDir = `/tmp/${"private path with spaces ".repeat(160)}nested`;
    const payload = watch({
      reason: "stuck_risk",
      stuckRisk: "high",
      inspectionCommand: `momentum workflow run monitor cwfp-openclaw-cli --data-dir '${dataDir}' --advance --json`,
      digest: "sha256:stuck-risk-long"
    });

    const result = await run(
      [
        "openclaw",
        "supervise",
        "cwfp-openclaw-cli",
        "--once",
        "--data-dir",
        makeTempDir(),
        "--json"
      ],
      payload
    );

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).not.toContain(dataDir);
    expect(result.stdout).not.toContain("private path with spaces");
    const json = JSON.parse(result.stdout) as {
      deliveryIntent: {
        text: string;
        action: { command: string };
        message: { maxLength: number };
      };
    };
    expect(json.deliveryIntent.text.length).toBeLessThanOrEqual(
      json.deliveryIntent.message.maxLength
    );
    expect(json.deliveryIntent.text).toContain("--data-dir <data-dir>");
    expect(json.deliveryIntent.action.command).toBe(
      "momentum workflow run monitor 'cwfp-openclaw-cli' --data-dir <data-dir> --advance --json"
    );
  });

  it("requires cron-safe --once mode", async () => {
    const dataDir = makeTempDir();
    const result = await run(
      [
        "openclaw",
        "supervise",
        "cwfp-openclaw-cli",
        "--data-dir",
        dataDir,
        "--json"
      ],
      watch({})
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      command: "openclaw supervise",
      code: "once_required"
    });
  });

  it("sanitizes local audit and state persistence failure paths", async () => {
    const dataDir = makeTempDir();
    fs.writeFileSync(path.join(dataDir, "openclaw-supervisor"), "blocked");

    const jsonResult = await run(
      [
        "openclaw",
        "supervise",
        "cwfp-openclaw-cli",
        "--once",
        "--data-dir",
        dataDir,
        "--json"
      ],
      watch({ emit: false })
    );

    expect(jsonResult.code, jsonResult.stderr).toBe(1);
    expect(jsonResult.stdout).toBe("");
    expect(jsonResult.stderr).not.toContain(dataDir);
    expect(JSON.parse(jsonResult.stderr)).toMatchObject({
      ok: false,
      command: "openclaw supervise",
      code: "openclaw_auto_action_audit_failed",
      runId: "cwfp-openclaw-cli",
      emit: true,
      deliveryIntent: {
        severity: "action_required"
      },
      autoAction: {
        actionType: "watch_recheck",
        result: "failed",
        error: "Auto-action audit evidence could not be written.",
        escalation: "human_required"
      },
      state: {
        persisted: false
      },
      debug: {
        autoActionResult: "failed",
        autoActionEscalation: "human_required",
        statePersistence: "failed"
      }
    });

    const stuckRiskResult = await run(
      [
        "openclaw",
        "supervise",
        "cwfp-openclaw-stuck-risk",
        "--once",
        "--data-dir",
        dataDir,
        "--json"
      ],
      watch({
        runId: "cwfp-openclaw-stuck-risk",
        reason: "stuck_risk",
        stuckRisk: "high",
        inspectionCommand: `momentum workflow run monitor cwfp-openclaw-stuck-risk --data-dir '${dataDir}' --advance --json`,
        digest: "sha256:audit-failed-stuck-risk"
      })
    );

    expect(stuckRiskResult.code, stuckRiskResult.stderr).toBe(1);
    expect(stuckRiskResult.stdout).toBe("");
    expect(stuckRiskResult.stderr).not.toContain(dataDir);
    expect(JSON.parse(stuckRiskResult.stderr)).toMatchObject({
      ok: false,
      code: "openclaw_auto_action_audit_failed",
      eventType: "stuck-risk",
      deliveryIntent: {
        kind: "stuck-risk",
        severity: "action_required",
        text:
          "Human review required for cwfp-openclaw-stuck-risk: OpenClaw supervisor auto-action watch_recheck did not complete.",
        action: {
          command:
            "momentum workflow run monitor 'cwfp-openclaw-stuck-risk' --data-dir <data-dir> --advance --json"
        }
      },
      autoAction: {
        actionType: "watch_recheck",
        result: "failed",
        escalation: "human_required"
      }
    });

    const textResult = await run(
      [
        "openclaw",
        "supervise",
        "cwfp-openclaw-cli",
        "--once",
        "--data-dir",
        dataDir
      ],
      watch({ emit: false })
    );

    expect(textResult.code).toBe(1);
    expect(textResult.stdout).toBe("");
    expect(textResult.stderr).toContain(
      "Auto action: watch_recheck (failed)"
    );
    expect(textResult.stderr).not.toContain(dataDir);
  });

  it("preserves emitted advisories when local state persistence fails", async () => {
    const dataDir = makeTempDir();
    const statePath = path.join(
      dataDir,
      "openclaw-supervisor",
      `${encodeURIComponent("cwfp-openclaw-cli")}.json`
    );
    const originalWriteFileSync = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
      if (file === statePath) {
        throw new Error(`EACCES: permission denied, open '${statePath}'`);
      }
      return originalWriteFileSync(file, data, options);
    });

    const result = await run(
      [
        "openclaw",
        "supervise",
        "cwfp-openclaw-cli",
        "--once",
        "--data-dir",
        dataDir,
        "--json"
      ],
      watch({
        reason: "stuck_risk",
        stuckRisk: "high",
        inspectionCommand: `momentum workflow run monitor cwfp-openclaw-cli --data-dir '${dataDir}' --advance --json`,
        digest: "sha256:state-save-failed"
      })
    );

    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain(dataDir);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      emit: true,
      eventType: "stuck-risk",
      inspectionCommand:
        "momentum workflow run monitor 'cwfp-openclaw-cli' --data-dir <data-dir> --advance --json",
      state: {
        persisted: false
      },
      debug: {
        statePersistence: "failed"
      }
    });
  });

  it("fails silent non-auto-action ticks when local state persistence fails", async () => {
    const dataDir = makeTempDir();
    fs.writeFileSync(path.join(dataDir, "openclaw-supervisor"), "blocked");

    const result = await run(
      [
        "openclaw",
        "supervise",
        "cwfp-openclaw-cli",
        "--once",
        "--data-dir",
        dataDir,
        "--json"
      ],
      watch({
        emit: false,
        reason: "quiet_heartbeat",
        recommendedAction: "approve",
        recommendedActionPolicy: {
          action: "approval_decision",
          authority: "human_required",
          risk: "medium",
          evidenceRequired: ["open approval gate"],
          rollback: "Record a gate decision through the approval path.",
          rationale: "Approvals require an explicit operator decision."
        },
        digest: "sha256:silent-human-state-save-failed"
      })
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain(dataDir);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      command: "openclaw supervise",
      code: "openclaw_supervisor_failed",
      message: "OpenClaw supervisor failed while processing the run."
    });
  });

  it("repeats cleanup action after terminal state disables monitoring", async () => {
    const dataDir = makeTempDir();
    const args = [
      "openclaw",
      "supervise",
      "cwfp-openclaw-cli",
      "--once",
      "--data-dir",
      dataDir,
      "--json"
    ];

    const first = await run(
      args,
      watch({
        reason: "terminal_succeeded",
        recommendedAction: "release",
        recommendedActionPolicy: releaseMonitorPolicy(),
        cleanup: "release",
        digest: "sha256:terminal",
        nextPollSeconds: 0
      })
    );
    expect(first.code, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({
      emit: true,
      eventType: "terminal",
      monitorEnabled: false,
      cleanupAction: "remove_monitor",
      state: {
        disabled: true,
        persisted: true
      }
    });

    let watchCalls = 0;
    let stdout = "";
    let stderr = "";
    const secondCode = await runCli(
      args,
      {
        stdout: { write: (chunk: string) => ((stdout += chunk), true) },
        stderr: { write: (chunk: string) => ((stderr += chunk), true) },
        env: {}
      },
      {
        openClawWatchOnce: async () => {
          watchCalls += 1;
          return watch({});
        }
      }
    );

    expect(secondCode, stderr).toBe(0);
    expect(stderr).toBe("");
    expect(watchCalls).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      emit: false,
      eventType: null,
      monitorEnabled: false,
      cleanupAction: "remove_monitor",
      debug: {
        suppressedReason: "monitor_disabled"
      },
      state: {
        disabled: true,
        persisted: true
      }
    });
  });

  it("does not re-enable an already disabled monitor when auto-actions are disabled", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-openclaw-cli";
    const args = [
      "openclaw",
      "supervise",
      runId,
      "--once",
      "--data-dir",
      dataDir,
      "--json"
    ];

    const first = await run(
      args,
      watch({
        reason: "terminal_succeeded",
        recommendedAction: "release",
        recommendedActionPolicy: releaseMonitorPolicy(),
        cleanup: "release",
        digest: "sha256:terminal-disabled-env",
        nextPollSeconds: 0
      })
    );
    expect(first.code, first.stderr).toBe(0);

    let watchCalls = 0;
    let stdout = "";
    let stderr = "";
    const secondCode = await runCli(
      args,
      {
        stdout: { write: (chunk: string) => ((stdout += chunk), true) },
        stderr: { write: (chunk: string) => ((stderr += chunk), true) },
        env: {
          MOMENTUM_OPENCLAW_AUTO_ACTIONS: "0"
        }
      },
      {
        openClawWatchOnce: async () => {
          watchCalls += 1;
          return watch({});
        }
      }
    );

    expect(secondCode, stderr).toBe(0);
    expect(stderr).toBe("");
    expect(watchCalls).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      emit: true,
      eventType: "terminal",
      monitorEnabled: false,
      cleanupAction: "remove_monitor",
      deliveryIntent: {
        kind: "terminal",
        severity: "action_required",
        cleanup: {
          action: "remove_monitor"
        }
      },
      state: {
        disabled: true,
        persisted: true
      },
      autoAction: {
        actionType: "release_monitor",
        result: "skipped",
        escalation: "human_required"
      }
    });
  });

  it("reports skipped auto-action evidence when the config gate disables monitor release", async () => {
    const dataDir = makeTempDir();
    const result = await run(
      [
        "openclaw",
        "supervise",
        "cwfp-openclaw-cli",
        "--once",
        "--data-dir",
        dataDir,
        "--json"
      ],
      watch({
        reason: "terminal_succeeded",
        recommendedAction: "release",
        recommendedActionPolicy: releaseMonitorPolicy(),
        cleanup: "release",
        digest: "sha256:terminal-config-disabled",
        nextPollSeconds: 0
      }),
      {
        MOMENTUM_OPENCLAW_AUTO_ACTIONS: "0"
      }
    );

    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      monitorEnabled: true,
      cleanupAction: null,
      state: {
        disabled: false,
        persisted: true
      },
      autoAction: {
        actionType: "release_monitor",
        policyAction: "release_monitor",
        result: "skipped",
        escalation: "human_required"
      },
      debug: {
        autoActionResult: "skipped",
        autoActionEscalation: "human_required"
      }
    });
    expect(JSON.stringify(payload)).not.toContain(dataDir);
  });

  it("repeats disabled cleanup when timestamp persistence fails", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-openclaw-cli";
    const args = [
      "openclaw",
      "supervise",
      runId,
      "--once",
      "--data-dir",
      dataDir,
      "--json"
    ];

    const first = await run(
      args,
      watch({
        reason: "terminal_succeeded",
        recommendedAction: "release",
        recommendedActionPolicy: releaseMonitorPolicy(),
        cleanup: "release",
        digest: "sha256:terminal-readonly",
        nextPollSeconds: 0
      })
    );
    expect(first.code, first.stderr).toBe(0);

    const statePath = path.join(
      dataDir,
      "openclaw-supervisor",
      `${encodeURIComponent(runId)}.json`
    );
    const originalWriteFileSync = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
      if (file === statePath) {
        throw new Error(`EACCES: permission denied, open '${statePath}'`);
      }
      return originalWriteFileSync(file, data, options);
    });

    let watchCalls = 0;
    let stdout = "";
    let stderr = "";
    const secondCode = await runCli(
      args,
      {
        stdout: { write: (chunk: string) => ((stdout += chunk), true) },
        stderr: { write: (chunk: string) => ((stderr += chunk), true) },
        env: {}
      },
      {
        openClawWatchOnce: async () => {
          watchCalls += 1;
          return watch({});
        }
      }
    );

    expect(secondCode, stderr).toBe(0);
    expect(stderr).toBe("");
    expect(watchCalls).toBe(0);
    expect(stdout).not.toContain(dataDir);
    expect(JSON.parse(stdout)).toMatchObject({
      emit: false,
      eventType: null,
      monitorEnabled: false,
      cleanupAction: "remove_monitor",
      state: {
        disabled: true,
        persisted: false
      },
      debug: {
        suppressedReason: "monitor_disabled",
        statePersistence: "failed"
      }
    });
  });

  it("escalates terminal cleanup when audit and state persistence fail", async () => {
    const dataDir = makeTempDir();
    fs.writeFileSync(path.join(dataDir, "openclaw-supervisor"), "blocked");

    const result = await run(
      [
        "openclaw",
        "supervise",
        "cwfp-openclaw-cli",
        "--once",
        "--data-dir",
        dataDir,
        "--json"
      ],
      watch({
        emit: false,
        reason: "terminal_succeeded",
        recommendedAction: "release",
        recommendedActionPolicy: releaseMonitorPolicy(),
        cleanup: "release",
        digest: "sha256:terminal-silent",
        nextPollSeconds: 0
      })
    );

    expect(result.code, result.stderr).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain(dataDir);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      code: "openclaw_auto_action_audit_failed",
      emit: true,
      eventType: "terminal",
      monitorEnabled: true,
      cleanupAction: null,
      deliveryIntent: {
        kind: "terminal",
        severity: "action_required",
        text:
          "Human review required for cwfp-openclaw-cli: OpenClaw supervisor auto-action release_monitor did not complete."
      },
      autoAction: {
        actionType: "release_monitor",
        result: "failed",
        error: "Auto-action audit evidence could not be written.",
        escalation: "human_required"
      },
      state: {
        disabled: false,
        persisted: false
      },
      debug: {
        watchEmit: false,
        suppressedReason: "watch_silent",
        statePersistence: "failed",
        autoActionResult: "failed",
        autoActionEscalation: "human_required"
      }
    });
  });

  it("does not repeat-limit monitor release when state persistence never succeeds", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-openclaw-cli";
    const statePath = path.join(
      dataDir,
      "openclaw-supervisor",
      `${encodeURIComponent(runId)}.json`
    );
    const originalWriteFileSync = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
      if (file === statePath) {
        throw new Error(`EACCES: permission denied, open '${statePath}'`);
      }
      return originalWriteFileSync(file, data, options);
    });
    const args = [
      "openclaw",
      "supervise",
      runId,
      "--once",
      "--data-dir",
      dataDir,
      "--json"
    ];
    const payload = watch({
      runId,
      emit: false,
      reason: "terminal_succeeded",
      recommendedAction: "release",
      recommendedActionPolicy: releaseMonitorPolicy(),
      cleanup: "release",
      digest: "sha256:terminal-state-never-saved",
      nextPollSeconds: 0
    });

    for (let index = 0; index < 4; index += 1) {
      const result = await run(args, payload);
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        monitorEnabled: false,
        cleanupAction: "remove_monitor",
        autoAction: {
          actionType: "release_monitor",
          result: "success",
          statePersistence: "failed"
        },
        state: {
          disabled: true,
          persisted: false
        }
      });
    }
  });

  it("fails closed when final auto-action audit state persistence cannot be written", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-openclaw-final-audit";
    const auditPath = path.join(
      dataDir,
      "openclaw-supervisor",
      `${encodeURIComponent(runId)}.auto-actions.jsonl`
    );
    const statePath = path.join(
      dataDir,
      "openclaw-supervisor",
      `${encodeURIComponent(runId)}.json`
    );
    const originalAppendFileSync = fs.appendFileSync;
    let auditWriteCount = 0;
    vi.spyOn(fs, "appendFileSync").mockImplementation(
      (file, data, options) => {
        if (file === auditPath) {
          auditWriteCount += 1;
          if (auditWriteCount === 2) {
            throw new Error(`ENOSPC: no space left, open '${auditPath}'`);
          }
        }
        return originalAppendFileSync(file, data, options);
      }
    );

    const result = await run(
      [
        "openclaw",
        "supervise",
        runId,
        "--once",
        "--data-dir",
        dataDir,
        "--json"
      ],
      watch({
        runId,
        digest: "sha256:final-audit-status-failed"
      })
    );

    expect(result.code, result.stderr).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain(dataDir);
    expect(fs.existsSync(statePath)).toBe(true);
    expect(auditWriteCount).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      code: "openclaw_auto_action_audit_failed",
      emit: true,
      eventType: "progress",
      recommendedActionPolicy: {
        action: "watch_recheck",
        authority: "human_required",
        risk: "high"
      },
      deliveryIntent: {
        kind: "progress",
        severity: "action_required",
        text:
          "Human review required for cwfp-openclaw-final-audit: OpenClaw supervisor auto-action watch_recheck did not complete."
      },
      autoAction: {
        actionType: "watch_recheck",
        result: "failed",
        error: "Auto-action audit evidence could not be written.",
        escalation: "human_required"
      },
      state: {
        persisted: false
      },
      debug: {
        autoActionResult: "failed",
        autoActionEscalation: "human_required",
        statePersistence: "failed"
      }
    });
  });

  it("clears monitor cleanup when final release audit state persistence cannot be written", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-openclaw-release-final-audit";
    const auditPath = path.join(
      dataDir,
      "openclaw-supervisor",
      `${encodeURIComponent(runId)}.auto-actions.jsonl`
    );
    const statePath = path.join(
      dataDir,
      "openclaw-supervisor",
      `${encodeURIComponent(runId)}.json`
    );
    const originalAppendFileSync = fs.appendFileSync;
    let auditWriteCount = 0;
    vi.spyOn(fs, "appendFileSync").mockImplementation(
      (file, data, options) => {
        if (file === auditPath) {
          auditWriteCount += 1;
          if (auditWriteCount === 2) {
            throw new Error(`ENOSPC: no space left, open '${auditPath}'`);
          }
        }
        return originalAppendFileSync(file, data, options);
      }
    );

    const result = await run(
      [
        "openclaw",
        "supervise",
        runId,
        "--once",
        "--data-dir",
        dataDir,
        "--json"
      ],
      watch({
        runId,
        emit: false,
        reason: "terminal_succeeded",
        recommendedAction: "release",
        recommendedActionPolicy: releaseMonitorPolicy(),
        cleanup: "release",
        digest: "sha256:release-final-audit-status-failed",
        nextPollSeconds: 0
      })
    );

    expect(result.code, result.stderr).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain(dataDir);
    expect(fs.existsSync(statePath)).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>
    ).toMatchObject({
      disabled: false
    });
    expect(auditWriteCount).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      code: "openclaw_auto_action_audit_failed",
      emit: true,
      eventType: "terminal",
      monitorEnabled: true,
      cleanupAction: null,
      deliveryIntent: {
        kind: "terminal",
        severity: "action_required",
        cleanup: null,
        text:
          "Human review required for cwfp-openclaw-release-final-audit: OpenClaw supervisor auto-action release_monitor did not complete."
      },
      autoAction: {
        actionType: "release_monitor",
        result: "failed",
        escalation: "human_required",
        afterState: {
          disabled: false
        }
      },
      state: {
        disabled: false,
        persisted: false
      }
    });
  });

  it("clears disabled monitor cleanup when final audit state persistence cannot be written", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-openclaw-disabled-final-audit";
    const supervisorDir = path.join(dataDir, "openclaw-supervisor");
    fs.mkdirSync(supervisorDir, { recursive: true });
    fs.writeFileSync(
      path.join(supervisorDir, `${encodeURIComponent(runId)}.json`),
      `${JSON.stringify({
        version: 1,
        runId,
        lastCursor: "wfcur1.done",
        lastDigest: "sha256:disabled-final-audit",
        lastReason: "terminal_succeeded",
        lastHumanUpdateAt: 1_730_002_000_000,
        disabled: true,
        updatedAt: 1_730_002_000_000
      })}\n`
    );
    const auditPath = path.join(
      supervisorDir,
      `${encodeURIComponent(runId)}.auto-actions.jsonl`
    );
    const originalAppendFileSync = fs.appendFileSync;
    let auditWriteCount = 0;
    vi.spyOn(fs, "appendFileSync").mockImplementation(
      (file, data, options) => {
        if (file === auditPath) {
          auditWriteCount += 1;
          if (auditWriteCount === 2) {
            throw new Error(`ENOSPC: no space left, open '${auditPath}'`);
          }
        }
        return originalAppendFileSync(file, data, options);
      }
    );

    const result = await run(
      [
        "openclaw",
        "supervise",
        runId,
        "--once",
        "--data-dir",
        dataDir,
        "--json"
      ],
      watch({ runId })
    );

    expect(result.code, result.stderr).toBe(1);
    expect(result.stdout).toBe("");
    expect(auditWriteCount).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      code: "openclaw_auto_action_audit_failed",
      emit: true,
      eventType: "terminal",
      monitorEnabled: true,
      cleanupAction: null,
      deliveryIntent: {
        kind: "terminal",
        severity: "action_required",
        cleanup: null,
        text:
          "Human review required for cwfp-openclaw-disabled-final-audit: OpenClaw supervisor auto-action release_monitor did not complete."
      },
      autoAction: {
        actionType: "release_monitor",
        result: "failed",
        escalation: "human_required",
        afterState: {
          disabled: false
        }
      },
      state: {
        disabled: false,
        persisted: false
      }
    });
  });

  it("does not save supervisor state when required auto-action audit cannot be written", async () => {
    const dataDir = makeTempDir();
    const runId = "cwfp-openclaw-cli";
    const statePath = path.join(
      dataDir,
      "openclaw-supervisor",
      `${encodeURIComponent(runId)}.json`
    );
    fs.mkdirSync(
      path.join(
        dataDir,
        "openclaw-supervisor",
        `${encodeURIComponent(runId)}.auto-actions.jsonl`
      ),
      { recursive: true }
    );

    const result = await run(
      [
        "openclaw",
        "supervise",
        runId,
        "--once",
        "--data-dir",
        dataDir,
        "--json"
      ],
      watch({
        runId,
        emit: false,
        reason: "terminal_succeeded",
        recommendedAction: "release",
        recommendedActionPolicy: releaseMonitorPolicy(),
        cleanup: "release",
        digest: "sha256:audit-path-blocked",
        nextPollSeconds: 0
      })
    );

    expect(result.code, result.stderr).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      code: "openclaw_auto_action_audit_failed",
      emit: true,
      eventType: "terminal",
      deliveryIntent: {
        kind: "terminal",
        severity: "action_required"
      },
      autoAction: {
        actionType: "release_monitor",
        result: "failed",
        error: "Auto-action audit evidence could not be written.",
        escalation: "human_required"
      },
      state: {
        persisted: false
      },
      debug: {
        statePersistence: "failed",
        autoActionResult: "failed"
      }
    });
    expect(fs.existsSync(statePath)).toBe(false);
  });
});
