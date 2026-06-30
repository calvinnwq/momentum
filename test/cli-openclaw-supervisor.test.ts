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

async function run(
  args: string[],
  watchPayload: OpenClawSupervisorWatchEnvelope
): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(
    args,
    {
      stdout: { write: (chunk: string) => ((stdout += chunk), true) },
      stderr: { write: (chunk: string) => ((stderr += chunk), true) },
      env: {}
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

  it("sanitizes state persistence failure paths", async () => {
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

    expect(jsonResult.code).toBe(1);
    expect(jsonResult.stdout).toBe("");
    expect(jsonResult.stderr).not.toContain(dataDir);
    expect(JSON.parse(jsonResult.stderr)).toMatchObject({
      ok: false,
      command: "openclaw supervise",
      code: "openclaw_supervisor_failed",
      message: "OpenClaw supervisor failed while processing the run.",
      runId: "cwfp-openclaw-cli"
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
    expect(textResult.stderr).toBe(
      "OpenClaw supervisor failed while processing the run.\n"
    );
    expect(textResult.stderr).not.toContain(dataDir);
  });

  it("preserves emitted advisories when local state persistence fails", async () => {
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

  it("preserves terminal cleanup when watch is silent and state persistence fails", async () => {
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
        cleanup: "release",
        digest: "sha256:terminal-silent",
        nextPollSeconds: 0
      })
    );

    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain(dataDir);
    expect(JSON.parse(result.stdout)).toMatchObject({
      emit: false,
      eventType: null,
      monitorEnabled: false,
      cleanupAction: "remove_monitor",
      state: {
        disabled: true,
        persisted: false
      },
      debug: {
        watchEmit: false,
        suppressedReason: "watch_silent",
        statePersistence: "failed"
      }
    });
  });
});
