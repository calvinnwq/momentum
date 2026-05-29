import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/cli.js";
import { openDb } from "../src/db.js";
import { WORKFLOW_RECOVERY_ARTIFACT_FILENAME } from "../src/workflow-recovery-artifact.js";

type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix = "momentum-cli-import-recovery-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

async function run(argv: string[]): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    stdout: {
      write(chunk: string) {
        stdout += chunk;
        return true;
      }
    },
    stderr: {
      write(chunk: string) {
        stderr += chunk;
        return true;
      }
    },
    env: {}
  });
  return { code, stdout, stderr };
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function writeLedger(filePath: string, lines: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`
  );
}

function writePlan(runDir: string, runId: string): void {
  writeJsonFile(path.join(runDir, "plan.json"), {
    runId,
    schemaVersion: 1,
    mode: "execute-ready",
    profile: "momentum-m7",
    objective: "NGX-327 auto-set recovery on import",
    repo: "/Users/test/repos/momentum",
    resolvedScope: {
      issues: ["NGX-327"],
      source: "explicit",
      status: "resolved"
    },
    approvalsRequired: ["implementation"],
    taskFlow: {
      childTasks: [{ stepId: "preflight" }, { stepId: "implementation" }]
    }
  });
}

/** A run whose required implementation step failed -> failed_required_step. */
function buildFailedRequiredStepFixture(rootDir: string, runId: string): string {
  const runDir = path.join(rootDir, runId);
  writePlan(runDir, runId);
  writeLedger(path.join(runDir, "ledger.jsonl"), [
    { runId, step: "preflight", status: "complete", ts: "2026-05-17T10:00:00Z" },
    {
      runId,
      step: "implementation",
      status: "started",
      ts: "2026-05-17T10:01:00Z"
    },
    {
      runId,
      step: "implementation",
      status: "failed",
      ts: "2026-05-17T10:10:00Z"
    }
  ]);
  return runDir;
}

/** Same run, but the required step now succeeded -> no blocking condition. */
function rewriteAsResolvedFixture(runDir: string, runId: string): void {
  writeLedger(path.join(runDir, "ledger.jsonl"), [
    { runId, step: "preflight", status: "complete", ts: "2026-05-17T10:00:00Z" },
    {
      runId,
      step: "implementation",
      status: "started",
      ts: "2026-05-17T10:01:00Z"
    },
    {
      runId,
      step: "implementation",
      status: "complete",
      ts: "2026-05-17T10:30:00Z"
    }
  ]);
}

function buildCleanCompletedFixture(rootDir: string, runId: string): string {
  const runDir = path.join(rootDir, runId);
  writePlan(runDir, runId);
  writeLedger(path.join(runDir, "ledger.jsonl"), [
    { runId, step: "preflight", status: "complete", ts: "2026-05-17T10:00:00Z" },
    {
      runId,
      step: "implementation",
      status: "complete",
      ts: "2026-05-17T10:30:00Z"
    }
  ]);
  return runDir;
}

describe("momentum workflow import — run-scoped recovery auto-set (NGX-327)", () => {
  it("auto-sets the durable flag, renders recovery.md, and reports recovery in the envelope", async () => {
    const dataDir = makeTempDir();
    const workflowRoot = makeTempDir("momentum-cli-import-recovery-runs-");
    const runId = "cwfp-recov0001failed";
    const runDir = buildFailedRequiredStepFixture(workflowRoot, runId);

    const result = await run([
      "workflow",
      "import",
      "--path",
      runDir,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);

    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      state: string;
      needsManualRecovery: boolean;
      recovery: {
        code: string;
        stepId: string | null;
        reason: string;
        artifactPath: string;
      } | null;
    };
    expect(payload.ok).toBe(true);
    expect(payload.state).toBe("failed");
    expect(payload.needsManualRecovery).toBe(true);
    expect(payload.recovery).not.toBeNull();
    expect(payload.recovery?.code).toBe("failed_required_step");
    expect(payload.recovery?.stepId).toBe("implementation");
    expect(payload.recovery?.reason.length ?? 0).toBeGreaterThan(0);

    // recovery.md rendered into the run directory.
    const artifactPath = path.join(runDir, WORKFLOW_RECOVERY_ARTIFACT_FILENAME);
    expect(payload.recovery?.artifactPath).toBe(artifactPath);
    expect(fs.existsSync(artifactPath)).toBe(true);
    const body = fs.readFileSync(artifactPath, "utf8");
    expect(body).toContain(`Run ID: ${runId}`);
    expect(body).toContain("Step ID: implementation");
    expect(body).toContain("failed_required_step");

    // Durable flag persisted.
    const db = openDb(dataDir);
    try {
      const row = db
        .prepare(
          "SELECT needs_manual_recovery FROM workflow_runs WHERE id = ?"
        )
        .get(runId) as { needs_manual_recovery: number };
      expect(row.needs_manual_recovery).toBe(1);
    } finally {
      db.close();
    }
  });

  it("does not set the flag or render recovery.md for a clean run", async () => {
    const dataDir = makeTempDir();
    const workflowRoot = makeTempDir("momentum-cli-import-recovery-runs-");
    const runId = "cwfp-recov0002clean";
    const runDir = buildCleanCompletedFixture(workflowRoot, runId);

    const result = await run([
      "workflow",
      "import",
      "--path",
      runDir,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(result.code).toBe(0);

    const payload = JSON.parse(result.stdout) as {
      state: string;
      needsManualRecovery: boolean;
      recovery: unknown;
    };
    expect(payload.state).toBe("succeeded");
    expect(payload.needsManualRecovery).toBe(false);
    expect(payload.recovery).toBeNull();

    expect(
      fs.existsSync(path.join(runDir, WORKFLOW_RECOVERY_ARTIFACT_FILENAME))
    ).toBe(false);

    const db = openDb(dataDir);
    try {
      const row = db
        .prepare(
          "SELECT needs_manual_recovery FROM workflow_runs WHERE id = ?"
        )
        .get(runId) as { needs_manual_recovery: number };
      expect(row.needs_manual_recovery).toBe(0);
    } finally {
      db.close();
    }
  });

  it("blocks workflow run update-step after the import auto-set with manual_recovery_required", async () => {
    const dataDir = makeTempDir();
    const workflowRoot = makeTempDir("momentum-cli-import-recovery-runs-");
    const runId = "cwfp-recov0003blocked";
    const runDir = buildFailedRequiredStepFixture(workflowRoot, runId);

    const imported = await run([
      "workflow",
      "import",
      "--path",
      runDir,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(imported.code).toBe(0);

    const update = await run([
      "workflow",
      "run",
      "update-step",
      runId,
      "--step",
      "implementation",
      "--state",
      "succeeded",
      "--reason",
      "force past failure",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(update.code).toBe(1);
    const payload = JSON.parse(update.stderr) as { code: string };
    expect(payload.code).toBe("manual_recovery_required");
  });

  it("refuses clear-recovery with recovery_clear_refused while the blocking state persists", async () => {
    const dataDir = makeTempDir();
    const workflowRoot = makeTempDir("momentum-cli-import-recovery-runs-");
    const runId = "cwfp-recov0004refused";
    const runDir = buildFailedRequiredStepFixture(workflowRoot, runId);

    const imported = await run([
      "workflow",
      "import",
      "--path",
      runDir,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(imported.code).toBe(0);

    const clear = await run([
      "workflow",
      "run",
      "clear-recovery",
      runId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(clear.code).toBe(1);
    const payload = JSON.parse(clear.stderr) as {
      code: string;
      recoveryCode?: string;
    };
    expect(payload.code).toBe("recovery_clear_refused");
    expect(payload.recoveryCode).toBe("failed_required_step");
  });

  it("clears recovery once the underlying failure is resolved and re-imported", async () => {
    const dataDir = makeTempDir();
    const workflowRoot = makeTempDir("momentum-cli-import-recovery-runs-");
    const runId = "cwfp-recov0005cleared";
    const runDir = buildFailedRequiredStepFixture(workflowRoot, runId);

    // First import flags the run.
    const first = await run([
      "workflow",
      "import",
      "--path",
      runDir,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(first.code).toBe(0);
    expect(
      (JSON.parse(first.stdout) as { needsManualRecovery: boolean })
        .needsManualRecovery
    ).toBe(true);

    // Operator resolves the failure in the artifact tree and re-imports.
    rewriteAsResolvedFixture(runDir, runId);
    const second = await run([
      "workflow",
      "import",
      "--path",
      runDir,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(second.code).toBe(0);
    const secondPayload = JSON.parse(second.stdout) as {
      state: string;
      needsManualRecovery: boolean;
    };
    // Substrate is now clean, but reconcile is setter-only: the flag persists.
    expect(secondPayload.state).toBe("succeeded");
    expect(secondPayload.needsManualRecovery).toBe(true);

    // Explicit operator clear now succeeds because no blocking condition remains.
    const clear = await run([
      "workflow",
      "run",
      "clear-recovery",
      runId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(clear.code).toBe(0);
    const clearPayload = JSON.parse(clear.stdout) as { ok: boolean };
    expect(clearPayload.ok).toBe(true);

    const db = openDb(dataDir);
    try {
      const row = db
        .prepare(
          "SELECT needs_manual_recovery FROM workflow_runs WHERE id = ?"
        )
        .get(runId) as { needs_manual_recovery: number };
      expect(row.needs_manual_recovery).toBe(0);
    } finally {
      db.close();
    }
  });

  it("surfaces a recovery line in text-mode import output", async () => {
    const dataDir = makeTempDir();
    const workflowRoot = makeTempDir("momentum-cli-import-recovery-runs-");
    const runId = "cwfp-recov0006text";
    const runDir = buildFailedRequiredStepFixture(workflowRoot, runId);

    const result = await run([
      "workflow",
      "import",
      "--path",
      runDir,
      "--data-dir",
      dataDir
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Manual recovery: required");
    expect(result.stdout).toContain("failed_required_step");
  });
});
