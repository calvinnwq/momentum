import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import type { OpenClawSupervisorWatchEnvelope } from "../src/core/openclaw/supervisor.js";

type CliResult = {
  code: number;
  stdout: string;
  stderr: string;
};

const tempRoots: string[] = [];

afterEach(() => {
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
    expect(JSON.stringify(firstJson)).not.toContain(dataDir);

    const second = await run(args, payload);
    expect(second.code, second.stderr).toBe(0);
    const secondJson = JSON.parse(second.stdout) as Record<string, unknown>;
    expect(secondJson).toMatchObject({
      ok: true,
      emit: false,
      eventType: null,
      debug: {
        watchEmit: true,
        suppressedReason: "duplicate_digest",
        stateChanged: true
      }
    });
    expect(JSON.stringify(secondJson)).not.toContain(dataDir);
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
});
