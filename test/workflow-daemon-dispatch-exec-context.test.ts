import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb, type MomentumDb } from "../src/adapters/db.js";
import { CODING_WORKFLOW_DEFINITION } from "../src/core/workflow/definition/definition.js";
import { persistWorkflowDefinition } from "../src/core/workflow/definition/persist.js";
import { persistWorkflowRunStart } from "../src/core/workflow/run/start-persist.js";
import { buildDispatchedStepExecutorInput } from "../src/core/workflow/dispatch/executor-context.js";
import { dispatchWorkflowStepExecutor } from "../src/core/workflow/step/executor.js";
import { buildRealWorkflowStepExecutorRegistry } from "../src/core/workflow/step/executor-real-adapters.js";
import {
  loadDispatchedStepRunProvenance,
  resolveDispatchedStepExecutorContext,
} from "../src/core/workflow/live-wrapper/daemon-exec-context.js";
import { loadWorkflowRunVerificationConfig } from "../src/core/daemon/workflow-dispatch.js";

/**
 * NGX-492 (RC-5b) — the daemon-lane exec-context deriver. The live-wrapper
 * dispatch wrapper (`live-wrapper-dispatch.ts`) takes a `deriveExec` by injection;
 * iterations 3 and 4 explicitly deferred the run-dir / repo-path layout decision to
 * this module. These tests pin that decision: a native run's bounded session runs
 * under `<repoPath>/.agent-workflows/<runId>/`, an imported run's under the run dir
 * derived from its source artifact, and a run with no `repo_path` is refused
 * honestly (no fabricated working directory) so the lane parks it for manual
 * recovery rather than running a live command in a guessed directory.
 */

const NOW = 1_700_000_000_000;
const RUN_ID = "run-execctx-001";
const REPO = "/repos/momentum";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-execctx-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

/** Open a migrated DB seeded exactly as the CLI `workflow run start` leaves it. */
function openSeededNativeRun(runId: string = RUN_ID): MomentumDb {
  const db = openDb(makeTempDir());
  persistWorkflowDefinition(db, CODING_WORKFLOW_DEFINITION, { now: NOW });
  persistWorkflowRunStart(db, {
    definition: CODING_WORKFLOW_DEFINITION,
    runId,
    repoPath: REPO,
    objective: "Dogfood NGX-492",
    now: NOW,
  });
  return db;
}

describe("resolveDispatchedStepExecutorContext", () => {
  it("derives a native run's session under <repoPath>/.agent-workflows/<runId>/", () => {
    const resolution = resolveDispatchedStepExecutorContext(RUN_ID, {
      repoPath: REPO,
      sourceArtifactPath: null,
    });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    const runDir = path.join(REPO, ".agent-workflows", RUN_ID);
    expect(resolution.exec).toEqual({
      repoPath: REPO,
      runDir,
      resultJsonPath: path.join(runDir, "result.json"),
      executorLogPath: path.join(runDir, "executor.log"),
    });
  });

  it("derives an imported run's session from its source artifact's run dir", () => {
    const sourceArtifactPath =
      "/imported/repo/.agent-workflows/run-imported-007/handoff.json";
    const resolution = resolveDispatchedStepExecutorContext(
      "run-imported-007",
      {
        repoPath: "/imported/repo",
        sourceArtifactPath,
      },
    );

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    const runDir = path.dirname(sourceArtifactPath);
    expect(resolution.exec.runDir).toBe(runDir);
    expect(resolution.exec.repoPath).toBe("/imported/repo");
    expect(resolution.exec.resultJsonPath).toBe(
      path.join(runDir, "result.json"),
    );
    expect(resolution.exec.executorLogPath).toBe(
      path.join(runDir, "executor.log"),
    );
  });

  it("refuses honestly when the run has no repo_path (no fabricated working dir)", () => {
    const resolution = resolveDispatchedStepExecutorContext(RUN_ID, {
      repoPath: null,
      sourceArtifactPath: null,
    });

    expect(resolution).toEqual({ ok: false, reason: "missing_repo_path" });
  });

  it("treats a blank repo_path as missing rather than deriving from it", () => {
    const resolution = resolveDispatchedStepExecutorContext(RUN_ID, {
      repoPath: "   ",
      sourceArtifactPath: null,
    });

    expect(resolution).toEqual({ ok: false, reason: "missing_repo_path" });
  });

  it("treats a blank source_artifact_path as absent and falls back to the native layout", () => {
    const resolution = resolveDispatchedStepExecutorContext(RUN_ID, {
      repoPath: REPO,
      sourceArtifactPath: "   ",
    });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.exec.runDir).toBe(
      path.join(REPO, ".agent-workflows", RUN_ID),
    );
  });

  it("produces a context that builds a VALID executor input (passes dispatch validation)", () => {
    const resolution = resolveDispatchedStepExecutorContext(RUN_ID, {
      repoPath: REPO,
      sourceArtifactPath: null,
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;

    const input = buildDispatchedStepExecutorInput(
      "implementation",
      RUN_ID,
      "step-impl",
      resolution.exec,
    );
    // The real registry with no profile resolves every kind to the honest
    // `runtime_unavailable` adapter. A `runtime_unavailable` (not `invalid_input`)
    // result proves the derived context produced a structurally valid input that
    // cleared dispatch validation and reached the adapter.
    const result = dispatchWorkflowStepExecutor(
      "implementation",
      input,
      buildRealWorkflowStepExecutorRegistry(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).not.toBe("invalid_input");
    expect(result.code).toBe("runtime_unavailable");
  });
});

describe("loadDispatchedStepRunProvenance", () => {
  it("loads repo_path (and null source_artifact_path) for a native run row", () => {
    const db = openSeededNativeRun();
    try {
      const provenance = loadDispatchedStepRunProvenance(db, RUN_ID);
      expect(provenance).toEqual({
        repoPath: REPO,
        sourceArtifactPath: null,
      });
    } finally {
      db.close();
    }
  });

  it("loads source_artifact_path when the run carries one", () => {
    const db = openSeededNativeRun();
    try {
      const sourceArtifactPath =
        "/imported/.agent-workflows/run-execctx-001/handoff.json";
      db.prepare(
        "UPDATE workflow_runs SET source_artifact_path = ? WHERE id = ?",
      ).run(sourceArtifactPath, RUN_ID);

      const provenance = loadDispatchedStepRunProvenance(db, RUN_ID);
      expect(provenance).toEqual({
        repoPath: REPO,
        sourceArtifactPath,
      });
    } finally {
      db.close();
    }
  });

  it("returns undefined for an unknown run", () => {
    const db = openSeededNativeRun();
    try {
      expect(
        loadDispatchedStepRunProvenance(db, "run-missing"),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("loaded provenance resolves end-to-end to the native session layout", () => {
    const db = openSeededNativeRun();
    try {
      const provenance = loadDispatchedStepRunProvenance(db, RUN_ID);
      expect(provenance).toBeDefined();
      if (!provenance) return;
      const resolution = resolveDispatchedStepExecutorContext(
        RUN_ID,
        provenance,
      );
      expect(resolution.ok).toBe(true);
      if (!resolution.ok) return;
      expect(resolution.exec.runDir).toBe(
        path.join(REPO, ".agent-workflows", RUN_ID),
      );
    } finally {
      db.close();
    }
  });
});

describe("loadWorkflowRunVerificationConfig", () => {
  function makeRepoDir(policy?: string): string {
    const repoDir = makeTempDir("momentum-execctx-repo-");
    if (policy !== undefined) {
      fs.writeFileSync(path.join(repoDir, "MOMENTUM.md"), policy, "utf-8");
    }
    return repoDir;
  }

  function attachGoal(
    db: MomentumDb,
    verification: string,
    timeoutSec: number,
  ): void {
    db.prepare(
      `INSERT INTO goals (id, title, branch, verification, verification_timeout_sec, artifact_dir, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "goal-1",
      "Goal",
      "main",
      verification,
      timeoutSec,
      "/tmp/goal-art",
      NOW,
      NOW,
    );
    db.prepare("UPDATE workflow_runs SET goal_id = ? WHERE id = ?").run(
      "goal-1",
      RUN_ID,
    );
  }

  it("falls back to the repo MOMENTUM.md verification for a native run with no goal", () => {
    const db = openSeededNativeRun();
    const repoDir = makeRepoDir(
      "---\nverification:\n  - pnpm test\n  - pnpm typecheck\nverification_timeout_sec: 120\n---\n",
    );
    try {
      const config = loadWorkflowRunVerificationConfig(db, RUN_ID, repoDir);
      expect(config).toEqual({
        ok: true,
        commands: ["pnpm test", "pnpm typecheck"],
        timeoutSec: 120,
      });
    } finally {
      db.close();
    }
  });

  it("resolves to no commands only when neither a goal nor MOMENTUM.md configures verification", () => {
    const db = openSeededNativeRun();
    const repoDir = makeRepoDir();
    try {
      const config = loadWorkflowRunVerificationConfig(db, RUN_ID, repoDir);
      expect(config).toEqual({ ok: true, commands: [], timeoutSec: 900 });
    } finally {
      db.close();
    }
  });

  it("fails closed on a present-but-malformed MOMENTUM.md instead of skipping verification", () => {
    const db = openSeededNativeRun();
    const repoDir = makeRepoDir("---\nrunner: 42\n---\n");
    try {
      const config = loadWorkflowRunVerificationConfig(db, RUN_ID, repoDir);
      expect(config.ok).toBe(false);
      if (config.ok) return;
      expect(config.reason).toContain("verification_policy_invalid");
    } finally {
      db.close();
    }
  });

  it("prefers goal-backed verification over the repo policy", () => {
    const db = openSeededNativeRun();
    const repoDir = makeRepoDir(
      "---\nverification:\n  - pnpm policy-test\nverification_timeout_sec: 120\n---\n",
    );
    try {
      attachGoal(db, JSON.stringify(["pnpm goal-test"]), 300);
      const config = loadWorkflowRunVerificationConfig(db, RUN_ID, repoDir);
      expect(config).toEqual({
        ok: true,
        commands: ["pnpm goal-test"],
        timeoutSec: 300,
      });
    } finally {
      db.close();
    }
  });

  it("fails closed when the run row is missing", () => {
    const db = openSeededNativeRun();
    try {
      const config = loadWorkflowRunVerificationConfig(
        db,
        "run-missing",
        makeRepoDir(),
      );
      expect(config.ok).toBe(false);
      if (config.ok) return;
      expect(config.reason).toContain("verification_config_unavailable");
    } finally {
      db.close();
    }
  });

  it("fails closed on a malformed goal verification column", () => {
    const db = openSeededNativeRun();
    try {
      attachGoal(db, "{not json", 300);
      const config = loadWorkflowRunVerificationConfig(
        db,
        RUN_ID,
        makeRepoDir(),
      );
      expect(config.ok).toBe(false);
      if (config.ok) return;
      expect(config.reason).toContain("verification_config_invalid");
    } finally {
      db.close();
    }
  });
});
