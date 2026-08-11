import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { openDb } from "../src/adapters/db.js";
import { runCli } from "../src/cli.js";
import { resolveDaemonWorkflowStepDispatch } from "../src/core/daemon/workflow-dispatch.js";
import {
  DAEMON_HOST_BINDINGS_FILE_ENV_VAR,
  RETIRED_LIVE_WRAPPER_PROFILE_ENV_VAR,
} from "../src/core/workflow/live-wrapper/daemon-host-bindings.js";
import { persistWorkflowDefinition } from "../src/core/workflow/definition/persist.js";
import type { WorkflowDefinition } from "../src/core/workflow/definition/definition.js";
import { executeWorkflowStepDispatch } from "../src/core/workflow/dispatch/execute.js";
import { claimRunnableWorkflowStep } from "../src/core/workflow/dispatch/scheduler.js";
import { persistWorkflowRunStart } from "../src/core/workflow/run/start-persist.js";

/**
 * NGX-668 (NAM-03E) north-star authority regression.
 *
 * Proves the host-binding cutover is an authority change, not a cosmetic
 * rename, through the real production daemon dispatch seam:
 *
 *   - `MOMENTUM_HOST_BINDINGS_FILE` selects command A and executes it;
 *   - a divergent legacy live-wrapper profile file pointing the same
 *     capability at command B is neither read (it is unreadable on disk, so
 *     any fallback read would fail the dispatch loudly) nor executed;
 *   - the retired `MOMENTUM_LIVE_WRAPPER_PROFILE` selector refuses with a
 *     precise migration diagnostic before any process launch or workflow
 *     mutation; and
 *   - durable reattachment state records only the opaque resolved-binding
 *     digest: no path, command, environment value, profile name, or binding
 *     name.
 */

const NOW = 1_700_000_000_000;
const tempDirs: string[] = [];

const COMMAND_A_SCRIPT = `printf 'command A\\n' > "$MOMENTUM_REPO_PATH/command-a.txt"
cat > "$MOMENTUM_RESULT_PATH" <<'JSON'
{"success":true,"summary":"command A completed","key_changes_made":["command-a.txt"],"key_learnings":[],"remaining_work":[],"goal_complete":true,"commit":{"type":"test","subject":"complete command A","body":"","breaking":false}}
JSON`;

const COMMAND_B_SCRIPT = `printf 'command B\\n' > "$MOMENTUM_REPO_PATH/command-b.txt"
cat > "$MOMENTUM_RESULT_PATH" <<'JSON'
{"success":true,"summary":"command B completed","key_changes_made":["command-b.txt"],"key_learnings":[],"remaining_work":[],"goal_complete":true,"commit":{"type":"test","subject":"complete command B","body":"","breaking":false}}
JSON`;

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.chmodSync(path.join(dir, "legacy-profile.json"), 0o600);
    } catch {
      // Not every temp dir holds the unreadable legacy fixture.
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const value = fs.mkdtempSync(
    path.join(os.tmpdir(), "momentum-host-bindings-authority-"),
  );
  tempDirs.push(value);
  return value;
}

function initRepo(): string {
  const repoPath = tempDir();
  execFileSync("git", ["-C", repoPath, "init", "--quiet"]);
  execFileSync("git", ["-C", repoPath, "config", "user.name", "Momentum Test"]);
  execFileSync("git", [
    "-C",
    repoPath,
    "config",
    "user.email",
    "momentum@example.test",
  ]);
  fs.writeFileSync(path.join(repoPath, ".gitignore"), ".agent-workflows/\n");
  fs.writeFileSync(path.join(repoPath, "README.md"), "fixture\n");
  execFileSync("git", ["-C", repoPath, "add", ".gitignore", "README.md"]);
  execFileSync("git", [
    "-C",
    repoPath,
    "commit",
    "--quiet",
    "-m",
    "test: initialize fixture",
  ]);
  return repoPath;
}

function writeHostBindingsFile(dir: string): string {
  const bindingsPath = path.join(dir, "host-bindings.json");
  fs.writeFileSync(
    bindingsPath,
    JSON.stringify({
      bindings: {
        preflight: {
          command: "/bin/sh",
          args: ["-c", COMMAND_A_SCRIPT],
          cwd: "repo",
          timeout_sec: 5,
          env_allow: [],
          result_file: "result.json",
        },
      },
    }),
  );
  return bindingsPath;
}

/**
 * A divergent legacy live-wrapper profile pointing the same capability at
 * command B. It is made unreadable after writing, so any code path that still
 * consulted it as a fallback source would fail the dispatch loudly instead of
 * silently selecting command B.
 */
function writeUnreadableLegacyProfile(dir: string): string {
  const legacyPath = path.join(dir, "legacy-profile.json");
  fs.writeFileSync(
    legacyPath,
    JSON.stringify({
      name: "legacy-live-wrapper",
      wrappers: {
        preflight: {
          command: "/bin/sh",
          args: ["-c", COMMAND_B_SCRIPT],
          cwd: "repo",
          timeout_sec: 5,
          env_allow: [],
          result_file: "result.json",
        },
      },
    }),
  );
  fs.chmodSync(legacyPath, 0o000);
  return legacyPath;
}

const AUTHORITY_DEFINITION: WorkflowDefinition = {
  key: "host-binding-authority-workflow",
  title: "Host Binding Authority Workflow",
  version: 1,
  steps: [
    {
      key: "preflight",
      kind: "preflight",
      executor: "agent-once",
      config: {},
      order: 0,
      required: true,
    },
  ],
};

function startApprovedRun(
  db: ReturnType<typeof openDb>,
  runId: string,
  repoPath: string,
) {
  persistWorkflowDefinition(db, AUTHORITY_DEFINITION, { now: NOW });
  persistWorkflowRunStart(db, {
    definition: AUTHORITY_DEFINITION,
    runId,
    repoPath,
    objective: "Prove host-binding selection authority",
    now: NOW,
  });
  db.prepare(
    "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ?",
  ).run(runId);
  const claim = claimRunnableWorkflowStep(db, {
    runId,
    stepId: "preflight",
    holder: "host-binding-authority-worker",
    leaseExpiresAt: NOW + 30_000,
    now: NOW,
  });
  if (!claim.ok) throw new Error(claim.reason);
  return claim.claim;
}

describe("host-binding authority (NGX-668 north star)", () => {
  it("executes command A from MOMENTUM_HOST_BINDINGS_FILE and never reads or runs the divergent legacy profile", async () => {
    const repoPath = initRepo();
    const configDir = tempDir();
    const bindingsPath = writeHostBindingsFile(configDir);
    const legacyPath = writeUnreadableLegacyProfile(configDir);
    const dataDir = tempDir();
    const db = openDb(dataDir);
    const runId = "host-binding-authority-run";
    const claim = startApprovedRun(db, runId, repoPath);

    // Only the new selector is set; the legacy profile file merely exists.
    const production = resolveDaemonWorkflowStepDispatch(
      { [DAEMON_HOST_BINDINGS_FILE_ENV_VAR]: bindingsPath },
      executeWorkflowStepDispatch,
      {},
    );
    expect(production.ok, production.ok ? "" : production.message).toBe(true);
    if (!production.ok) return;

    await production.dispatch(claim, {
      db,
      workerId: "host-binding-authority-worker",
      now: NOW + 1,
    });

    // Command A ran; command B never did.
    expect(fs.existsSync(path.join(repoPath, "command-a.txt"))).toBe(true);
    expect(fs.existsSync(path.join(repoPath, "command-b.txt"))).toBe(false);
    // The legacy profile was never read: it is unreadable, so any fallback
    // read would have failed the dispatch instead of producing command A.
    expect(fs.existsSync(path.join(repoPath, "command-a.txt"))).toBe(true);

    const round = db
      .prepare("SELECT state FROM executor_rounds WHERE workflow_run_id = ?")
      .get(runId) as { state: string };
    expect(round.state).toBe("succeeded");

    const checkpoints = db
      .prepare(
        `SELECT c.stage AS stage, c.detail AS detail
           FROM executor_checkpoints AS c
           JOIN executor_rounds AS r ON r.round_id = c.round_id
          WHERE r.workflow_run_id = ?`,
      )
      .all(runId) as { stage: string; detail: string | null }[];
    const binding = checkpoints.find(
      (checkpoint) => checkpoint.stage === "round_started",
    );
    // Durable reattachment identity is one opaque digest string: nothing else.
    expect(binding?.detail ?? "").toMatch(
      /^dispatch binding v2: sha256:[0-9a-f]{64}$/,
    );

    // Durable binding identity is the opaque digest only: no host-local
    // command path, argv, config-file path, profile name, or binding-set
    // identity appears in any durable executor evidence.
    const durable = JSON.stringify({
      attempts: db
        .prepare("SELECT * FROM executor_attempts WHERE workflow_run_id = ?")
        .all(runId),
      rounds: db
        .prepare(
          "SELECT round_id, attempt_id, state, classification, result_digest, input_digest, summary FROM executor_rounds WHERE workflow_run_id = ?",
        )
        .all(runId),
      checkpoints,
      stepConfig: db
        .prepare(
          "SELECT executor_config_json FROM workflow_steps WHERE run_id = ?",
        )
        .all(runId),
    });
    for (const leaked of [
      "/bin/sh",
      "command-a.txt",
      COMMAND_A_SCRIPT.slice(0, 24),
      bindingsPath,
      legacyPath,
      "legacy-live-wrapper",
      "wrappers",
      "host-bindings.json",
    ]) {
      expect(
        durable,
        `durable evidence must not contain ${leaked}`,
      ).not.toContain(leaked);
    }
    db.close();

    // Public run JSON is equally free of host-local binding values.
    let statusJson = "";
    const statusCode = await runCli(
      ["workflow", "status", runId, "--data-dir", dataDir, "--json"],
      {
        stdout: {
          write(chunk: string) {
            statusJson += chunk;
            return true;
          },
        },
        stderr: {
          write() {
            return true;
          },
        },
        env: {},
      },
    );
    expect(statusCode).toBe(0);
    for (const leaked of [
      "/bin/sh",
      bindingsPath,
      legacyPath,
      "legacy-live-wrapper",
      "wrappers",
      "host-bindings.json",
      "policyEnvelope",
    ]) {
      expect(
        statusJson,
        `public run JSON must not contain ${leaked}`,
      ).not.toContain(leaked);
    }
  });

  it("refuses the retired MOMENTUM_LIVE_WRAPPER_PROFILE selector before any launch or workflow mutation", () => {
    const repoPath = initRepo();
    const configDir = tempDir();
    const legacyPath = writeUnreadableLegacyProfile(configDir);
    const db = openDb(tempDir());
    const runId = "retired-selector-run";
    startApprovedRun(db, runId, repoPath);

    const production = resolveDaemonWorkflowStepDispatch(
      { [RETIRED_LIVE_WRAPPER_PROFILE_ENV_VAR]: legacyPath },
      executeWorkflowStepDispatch,
      {},
    );

    // A precise migration diagnostic names the replacement selector.
    expect(production.ok).toBe(false);
    if (production.ok) return;
    expect(production.message).toContain(RETIRED_LIVE_WRAPPER_PROFILE_ENV_VAR);
    expect(production.message).toContain(DAEMON_HOST_BINDINGS_FILE_ENV_VAR);
    expect(production.message).toContain("retired");

    // No fallback source was consulted (the legacy file is unreadable and the
    // refusal happened without touching it), no process was launched, and no
    // workflow state was mutated.
    expect(fs.existsSync(path.join(repoPath, "command-b.txt"))).toBe(false);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM executor_attempts WHERE workflow_run_id = ?",
        )
        .get(runId),
    ).toEqual({ count: 0 });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM executor_rounds WHERE workflow_run_id = ?",
        )
        .get(runId),
    ).toEqual({ count: 0 });
    db.close();
  });

  it("refuses the retired selector even when the new selector is also configured", () => {
    const configDir = tempDir();
    const bindingsPath = writeHostBindingsFile(configDir);
    const legacyPath = writeUnreadableLegacyProfile(configDir);

    const production = resolveDaemonWorkflowStepDispatch(
      {
        [DAEMON_HOST_BINDINGS_FILE_ENV_VAR]: bindingsPath,
        [RETIRED_LIVE_WRAPPER_PROFILE_ENV_VAR]: legacyPath,
      },
      executeWorkflowStepDispatch,
      {},
    );

    expect(production.ok).toBe(false);
    if (production.ok) return;
    expect(production.message).toContain(DAEMON_HOST_BINDINGS_FILE_ENV_VAR);
  });
});
