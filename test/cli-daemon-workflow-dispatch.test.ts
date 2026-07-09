import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/cli.js";
import { openDb } from "../src/adapters/db.js";
import { buildIdempotencyMarker } from "../src/adapters/external-update-adapter.js";
import { DOGFOOD_TERMINALIZE_DISPATCH_ENV_VAR } from "../src/core/workflow/dispatch/dogfood.js";
import { DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR } from "../src/core/workflow/live-wrapper/daemon-profile.js";
import { terminalizeDispatchedExecutorInvocation } from "../src/core/workflow/dispatch/executor-terminalize.js";

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

function makeTempDir(prefix = "momentum-cli-daemon-wf-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function runGit(repoPath: string, args: string[]): string {
  return execFileSync("git", ["-C", repoPath, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function initRepo(repoPath: string): void {
  runGit(repoPath, ["init", "--initial-branch=main", "--quiet"]);
  runGit(repoPath, ["config", "user.email", "test@example.com"]);
  runGit(repoPath, ["config", "user.name", "Test User"]);
  runGit(repoPath, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(repoPath, "README.md"), "init\n", "utf-8");
  runGit(repoPath, ["add", "README.md"]);
  runGit(repoPath, ["commit", "-m", "init", "--quiet"]);
}

async function run(
  argv: string[],
  env: Record<string, string | undefined> = {},
  deps: Parameters<typeof runCli>[2] = {}
): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(
    argv,
    {
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
      env
    },
    deps
  );
  return { code, stdout, stderr };
}

/**
 * Start the built-in coding workflow run and approve it through the
 * implementation boundary, leaving its first step (`preflight`, executor family
 * `one-shot`) `approved` and runnable — exactly the shipped operator path a
 * dogfood would drive, with no test-only dependency injection.
 */
async function startApprovedCodingRun(
  dataDir: string,
  repoDir: string,
  runId: string
): Promise<void> {
  const startResult = await run([
    "workflow",
    "run",
    "start",
    "--run-id",
    runId,
    "--repo",
    repoDir,
    "--objective",
    "Dogfood NGX-367 production dispatch",
    "--data-dir",
    dataDir,
    "--json"
  ]);
  expect(startResult.code).toBe(0);

  const approveResult = await run([
    "workflow",
    "run",
    "approve",
    runId,
    "--approval-boundary",
    "through-implementation",
    "--phrase",
    `approve plan ${runId} through-implementation`,
    "--data-dir",
    dataDir,
    "--json"
  ]);
  expect(approveResult.code).toBe(0);
}

function writeSucceedingPreflightProfile(dir: string, timeoutSec = 5): string {
  const profilePath = path.join(dir, "live-wrapper-profile.json");
  const script = `printf 'preflight from daemon\\n' > "$MOMENTUM_REPO_PATH/daemon-preflight.txt"
cat > "$MOMENTUM_RESULT_PATH" <<'JSON'
{"success":true,"summary":"daemon live wrapper preflight succeeded","key_changes_made":[],"key_learnings":[],"remaining_work":[],"goal_complete":false,"commit":{"type":"test","subject":"daemon live wrapper preflight","body":"","breaking":false}}
JSON`;
  fs.writeFileSync(
    profilePath,
    JSON.stringify({
      name: "daemon-default-test",
      wrappers: {
        preflight: {
          command: "/bin/sh",
          args: ["-c", script],
          cwd: "iteration",
          timeout_sec: timeoutSec,
          env_allow: [],
          result_file: "result.json"
        }
      }
    }),
    "utf8"
  );
  return profilePath;
}

function writeEnvForwardingPreflightProfile(dir: string): string {
  const profilePath = path.join(dir, "live-wrapper-env-profile.json");
  const script = `test "$MOMENTUM_TEST_TOKEN" = "from-cli-io" || exit 7
printf 'env from daemon\\n' > "$MOMENTUM_REPO_PATH/daemon-env.txt"
cat > "$MOMENTUM_RESULT_PATH" <<'JSON'
{"success":true,"summary":"daemon live wrapper env forwarded","key_changes_made":[],"key_learnings":[],"remaining_work":[],"goal_complete":false,"commit":{"type":"test","subject":"daemon live wrapper env","body":"","breaking":false}}
JSON`;
  fs.writeFileSync(
    profilePath,
    JSON.stringify({
      name: "daemon-env-test",
      wrappers: {
        preflight: {
          command: "/bin/sh",
          args: ["-c", script],
          cwd: "iteration",
          timeout_sec: 5,
          env_allow: ["MOMENTUM_TEST_TOKEN"],
          result_file: "result.json"
        }
      }
    }),
    "utf8"
  );
  return profilePath;
}

function writeCodingWorkflowWrapperPreflightProfile(dir: string): string {
  const profilePath = path.join(dir, "coding-wrapper-profile.json");
  fs.writeFileSync(
    profilePath,
    JSON.stringify({
      name: "daemon-coding-wrapper-test",
      wrappers: {
        preflight: {
          command: process.execPath,
          args: [
            "--no-warnings=ExperimentalWarning",
            "--import",
            path.join(
              process.cwd(),
              "src/adapters/typescript-source-register.mjs"
            ),
            path.join(
              process.cwd(),
              "src/adapters/coding-workflow-live-wrapper-cli.ts"
            )
          ],
          cwd: "repo",
          timeout_sec: 30,
          env_allow: ["PATH"],
          result_file: "result.json"
        }
      }
    }),
    "utf8"
  );
  return profilePath;
}

describe("daemon start production workflow lane (NGX-367)", () => {
  it("uses a configured daemon live-wrapper profile to execute and reconcile a dispatched step", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    initRepo(repoDir);
    const profileDir = makeTempDir();
    const profilePath = writeSucceedingPreflightProfile(profileDir);
    const runId = "ngx492-live-wrapper-profile";
    await startApprovedCodingRun(dataDir, repoDir, runId);

    const result = await run(
      [
        "daemon",
        "start",
        "--max-loop-iterations",
        "1",
        "--poll-interval-ms",
        "0",
        "--data-dir",
        dataDir,
        "--json"
      ],
      { [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: profilePath }
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const loop = JSON.parse(result.stdout).loop as Record<string, unknown>;
    expect(loop["workflowStepsDispatched"]).toBe(1);
    expect(loop["lastWorkflowCode"]).toBe("dispatched");

    const db = openDb(dataDir);
    try {
      const step = db
        .prepare(
          "SELECT state, result_digest FROM workflow_steps WHERE run_id = ? AND step_id = ?"
        )
        .get(runId, "preflight") as
        | { state: string; result_digest: string | null }
        | undefined;
      expect(step).toMatchObject({ state: "succeeded" });

      const invocation = db
        .prepare(
          "SELECT state FROM executor_invocations WHERE workflow_run_id = ? AND step_key = ?"
        )
        .get(runId, "preflight") as { state: string } | undefined;
      expect(invocation).toEqual({ state: "succeeded" });

      const round = db
        .prepare(
          "SELECT state, summary FROM executor_rounds WHERE workflow_run_id = ? AND step_key = ?"
        )
        .get(runId, "preflight") as
        | { state: string; summary: string | null }
        | undefined;
      expect(round).toEqual({
        state: "succeeded",
        summary: "daemon live wrapper preflight succeeded"
      });

      const openLeases = db
        .prepare(
          "SELECT lease_kind FROM workflow_leases WHERE run_id = ? AND released_at IS NULL"
        )
        .all(runId) as Array<{ lease_kind: string }>;
      expect(openLeases).toEqual([]);
    } finally {
      db.close();
    }

    expect(
      fs.existsSync(path.join(repoDir, ".agent-workflows", runId, "result.json"))
    ).toBe(true);
  });

  it("parks a daemon live-wrapper step before execution when the repo is dirty", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    initRepo(repoDir);
    const baseHead = runGit(repoDir, ["rev-parse", "HEAD"]);
    const profileDir = makeTempDir();
    const profilePath = writeSucceedingPreflightProfile(profileDir);
    const runId = "ngx599-dirty-live-wrapper-repo";
    await startApprovedCodingRun(dataDir, repoDir, runId);
    fs.writeFileSync(path.join(repoDir, "preexisting.txt"), "dirty\n", "utf8");

    const result = await run(
      [
        "daemon",
        "start",
        "--max-loop-iterations",
        "1",
        "--poll-interval-ms",
        "0",
        "--data-dir",
        dataDir,
        "--json"
      ],
      { [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: profilePath }
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(runGit(repoDir, ["rev-parse", "HEAD"])).toBe(baseHead);
    expect(fs.existsSync(path.join(repoDir, "daemon-preflight.txt"))).toBe(false);

    const db = openDb(dataDir);
    try {
      const runRow = db
        .prepare(
          "SELECT needs_manual_recovery, manual_recovery_reason FROM workflow_runs WHERE id = ?"
        )
        .get(runId) as
        | { needs_manual_recovery: number; manual_recovery_reason: string | null }
        | undefined;
      expect(runRow?.needs_manual_recovery).toBe(1);
      expect(runRow?.manual_recovery_reason).toContain("git_failed");

      const round = db
        .prepare(
          "SELECT state, recovery_code, summary FROM executor_rounds WHERE workflow_run_id = ? AND step_key = ?"
        )
        .get(runId, "preflight") as
        | { state: string; recovery_code: string | null; summary: string | null }
        | undefined;
      expect(round?.state).toBe("manual_recovery_required");
      expect(round?.recovery_code).toBe("git_failed");
      expect(round?.summary).toContain("uncommitted changes");
    } finally {
      db.close();
    }

    const recoveryMd = fs.readFileSync(
      path.join(repoDir, ".agent-workflows", runId, "recovery.md"),
      "utf-8"
    );
    expect(recoveryMd).toContain("git_failed");
    expect(recoveryMd).toContain("uncommitted changes");
  });

  it("matches external-apply intents by Linear issue key scope", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    fs.writeFileSync(
      path.join(repoDir, "MOMENTUM.md"),
      "---\nintent_apply_policy: external_apply_allowed\n---\n",
      "utf8"
    );
    const runId = "ngx496-linear-key-scope";

    const startResult = await run([
      "workflow",
      "run",
      "start",
      "--run-id",
      runId,
      "--repo",
      repoDir,
      "--objective",
      "Apply Linear refresh",
      "--issue-scope",
      "NGX-1001",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(startResult.code).toBe(0);

    const db = openDb(dataDir);
    try {
      db.prepare(
        "UPDATE workflow_steps SET state = 'succeeded' WHERE run_id = ? AND step_order < 5"
      ).run(runId);
      db.prepare(
        "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ? AND step_id = 'linear-refresh'"
      ).run(runId);
      db.prepare("UPDATE workflow_runs SET state = 'approved' WHERE id = ?").run(
        runId
      );
      db.prepare(
        `INSERT INTO source_items
           (id, adapter_kind, external_id, external_key, url, title, status,
            metadata_json, last_observed_at, goal_id, created_at, updated_at)
         VALUES ('source_ngx1001', 'linear', 'linear-issue-1001', 'NGX-1001',
                 'https://linear.app/example/issue/NGX-1001', 'Scoped issue',
                 'Todo', '{}', 1, NULL, 1, 1)`
      ).run();
      db.prepare(
        `INSERT INTO update_intents
           (id, adapter_kind, target_external_id, intent_type, payload_json,
            reason, source_item_id, status, idempotency_key, created_at,
            updated_at, applied_at, skipped_at, canceled_at, decision_reason)
         VALUES ('intent_ngx1001', 'linear', 'linear-issue-1001',
                 'status_update',
                 '{"state":"Done","comment":"evidence says done"}',
                 'evidence says done',
                 'source_ngx1001', 'pending', 'idemp:intent_ngx1001', 1, 1,
                 NULL, NULL, NULL, NULL)`
      ).run();
    } finally {
      db.close();
    }

    let marker = "";
    let applyCalls = 0;
    const deps = {
      buildLinearExternalUpdateClient: () => ({
        async apply(input: { preview: { idempotencyMarker: string } }) {
          applyCalls += 1;
          marker = input.preview.idempotencyMarker;
          return {
            ok: true as const,
            alreadyApplied: false,
            issue: {
              id: "linear-issue-1001",
              key: "NGX-1001",
              url: "https://linear.app/example/issue/NGX-1001"
            },
            comment: {
              id: "comment-ngx1001",
              url: "https://linear.app/example/comment/NGX-1001"
            },
            status: {
              transitioned: true as const,
              previousStateId: "state-todo",
              previousStateName: "Todo",
              nextStateId: "state-done",
              nextStateName: "Done"
            },
            idempotencyMarker: marker
          };
        }
      }),
      buildLinearIssueRefreshClient: () => ({
        async refresh() {
          return {
            ok: true as const,
            issue: {
              id: "linear-issue-1001",
              identifier: "NGX-1001",
              title: "Scoped issue",
              url: "https://linear.app/example/issue/NGX-1001",
              updatedAt: "2026-05-21T00:00:00.000Z",
              state: { id: "state-done", name: "Done" }
            },
            comments: [
              {
                id: "comment-ngx1001",
                body: `Applied ${marker}`,
                url: "https://linear.app/example/comment/NGX-1001"
              }
            ]
          };
        }
      })
    };

    const result = await run(
      [
        "daemon",
        "start",
        "--max-loop-iterations",
        "1",
        "--poll-interval-ms",
        "0",
        "--data-dir",
        dataDir,
        "--json"
      ],
      { LINEAR_API_KEY: "test-key" },
      deps
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(applyCalls).toBe(1);
    const loop = JSON.parse(result.stdout).loop as Record<string, unknown>;
    expect(loop["workflowStepsDispatched"]).toBe(1);

    const verifyDb = openDb(dataDir);
    try {
      const intent = verifyDb
        .prepare("SELECT status FROM update_intents WHERE id = 'intent_ngx1001'")
        .get() as { status: string } | undefined;
      expect(intent).toEqual({ status: "applied" });
      const step = verifyDb
        .prepare(
          "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = 'linear-refresh'"
        )
        .get(runId) as { state: string } | undefined;
      expect(step).toEqual({ state: "succeeded" });
    } finally {
      verifyDb.close();
    }
  });

  it("seeds and applies a missing Linear status_update intent from issue scope", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    fs.writeFileSync(
      path.join(repoDir, "MOMENTUM.md"),
      "---\nintent_apply_policy: external_apply_allowed\n---\n",
      "utf8"
    );
    const runId = "ngx584-linear-refresh-seed";

    const startResult = await run([
      "workflow",
      "run",
      "start",
      "--run-id",
      runId,
      "--repo",
      repoDir,
      "--objective",
      "Seed Linear refresh intent",
      "--issue-scope",
      "NGX-1001",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(startResult.code).toBe(0);

    const db = openDb(dataDir);
    try {
      db.prepare(
        "UPDATE workflow_steps SET state = 'succeeded' WHERE run_id = ? AND step_order < 5"
      ).run(runId);
      db.prepare(
        "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ? AND step_id = 'linear-refresh'"
      ).run(runId);
      db.prepare("UPDATE workflow_runs SET state = 'approved' WHERE id = ?").run(
        runId
      );
      db.prepare(
        `INSERT INTO source_items
           (id, adapter_kind, external_id, external_key, url, title, status,
            metadata_json, last_observed_at, goal_id, created_at, updated_at)
         VALUES ('source_ngx1001_seeded', 'linear', 'linear-issue-1001',
                 'NGX-1001',
                 'https://linear.app/example/issue/NGX-1001', 'Scoped issue',
                 'Todo', '{}', 1, NULL, 1, 1)`
      ).run();
    } finally {
      db.close();
    }

    let marker = "";
    let applyCalls = 0;
    let observedStateName: string | null = null;
    const deps = {
      buildLinearExternalUpdateClient: () => ({
        async apply(input: {
          preview: { idempotencyMarker: string };
          statusMutation?: { kind: string; stateName?: string } | null;
        }) {
          applyCalls += 1;
          marker = input.preview.idempotencyMarker;
          observedStateName =
            input.statusMutation?.kind === "by_name"
              ? input.statusMutation.stateName ?? null
              : null;
          return {
            ok: true as const,
            alreadyApplied: false,
            issue: {
              id: "linear-issue-1001",
              key: "NGX-1001",
              url: "https://linear.app/example/issue/NGX-1001"
            },
            comment: {
              id: "comment-ngx1001-seeded",
              url: "https://linear.app/example/comment/NGX-1001-seeded"
            },
            status: {
              transitioned: true as const,
              previousStateId: "state-todo",
              previousStateName: "Todo",
              nextStateId: "state-done",
              nextStateName: "Done"
            },
            idempotencyMarker: marker
          };
        }
      }),
      buildLinearIssueRefreshClient: () => ({
        async refresh() {
          return {
            ok: true as const,
            issue: {
              id: "linear-issue-1001",
              identifier: "NGX-1001",
              title: "Scoped issue",
              url: "https://linear.app/example/issue/NGX-1001",
              updatedAt: "2026-05-21T00:00:00.000Z",
              state: { id: "state-done", name: "Done" }
            },
            comments: [
              {
                id: "comment-ngx1001-seeded",
                body: `Applied ${marker}`,
                url: "https://linear.app/example/comment/NGX-1001-seeded"
              }
            ]
          };
        }
      })
    };

    const result = await run(
      [
        "daemon",
        "start",
        "--max-loop-iterations",
        "1",
        "--poll-interval-ms",
        "0",
        "--data-dir",
        dataDir,
        "--json"
      ],
      { LINEAR_API_KEY: "test-key" },
      deps
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(applyCalls).toBe(1);
    expect(observedStateName).toBe("Done");

    const verifyDb = openDb(dataDir);
    try {
      const intents = verifyDb
        .prepare(
          `SELECT intent_type, payload_json, source_item_id, status,
                  idempotency_key
             FROM update_intents
            WHERE source_item_id = 'source_ngx1001_seeded'
            ORDER BY created_at ASC`
        )
        .all() as Array<{
        intent_type: string;
        payload_json: string;
        source_item_id: string;
        status: string;
        idempotency_key: string;
      }>;
      expect(intents).toHaveLength(1);
      expect(intents[0]).toMatchObject({
        intent_type: "status_update",
        source_item_id: "source_ngx1001_seeded",
        status: "applied",
        idempotency_key: "linear:linear-issue-1001:status_update:done"
      });
      expect(JSON.parse(intents[0]!.payload_json)).toEqual({ state: "Done" });
      const step = verifyDb
        .prepare(
          "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = 'linear-refresh'"
        )
        .get(runId) as { state: string } | undefined;
      expect(step).toEqual({ state: "succeeded" });
    } finally {
      verifyDb.close();
    }
  });

  it("preflights Linear external-apply auth before calling the adapter client", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    fs.writeFileSync(
      path.join(repoDir, "MOMENTUM.md"),
      "---\nintent_apply_policy: external_apply_allowed\n---\n",
      "utf8"
    );
    const runId = "ngx559-linear-auth-preflight";

    const startResult = await run([
      "workflow",
      "run",
      "start",
      "--run-id",
      runId,
      "--repo",
      repoDir,
      "--objective",
      "Apply Linear refresh",
      "--issue-scope",
      "NGX-1001",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(startResult.code).toBe(0);

    const db = openDb(dataDir);
    try {
      db.prepare(
        "UPDATE workflow_steps SET state = 'succeeded' WHERE run_id = ? AND step_order < 5"
      ).run(runId);
      db.prepare(
        "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ? AND step_id = 'linear-refresh'"
      ).run(runId);
      db.prepare("UPDATE workflow_runs SET state = 'approved' WHERE id = ?").run(
        runId
      );
      db.prepare(
        `INSERT INTO source_items
           (id, adapter_kind, external_id, external_key, url, title, status,
            metadata_json, last_observed_at, goal_id, created_at, updated_at)
         VALUES ('source_ngx1001_missing_auth', 'linear', 'linear-issue-1001', 'NGX-1001',
                 'https://linear.app/example/issue/NGX-1001', 'Scoped issue',
                 'Todo', '{}', 1, NULL, 1, 1)`
      ).run();
      db.prepare(
        `INSERT INTO update_intents
           (id, adapter_kind, target_external_id, intent_type, payload_json,
            reason, source_item_id, status, idempotency_key, created_at,
            updated_at, applied_at, skipped_at, canceled_at, decision_reason)
         VALUES ('intent_ngx1001_missing_auth', 'linear', 'linear-issue-1001',
                 'source_satisfied', '{"kind":"comment"}', 'evidence says done',
                 'source_ngx1001_missing_auth', 'pending',
                 'idemp:intent_ngx1001_missing_auth', 1, 1,
                 NULL, NULL, NULL, NULL)`
      ).run();
    } finally {
      db.close();
    }

    let applyCalls = 0;
    const deps = {
      buildLinearExternalUpdateClient: () => ({
        async apply() {
          applyCalls += 1;
          throw new Error("must not call external apply without auth preflight");
        }
      })
    };

    const result = await run(
      [
        "daemon",
        "start",
        "--max-loop-iterations",
        "1",
        "--poll-interval-ms",
        "0",
        "--data-dir",
        dataDir,
        "--json"
      ],
      {},
      deps
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(applyCalls).toBe(0);

    const verifyDb = openDb(dataDir);
    try {
      const runRow = verifyDb
        .prepare("SELECT needs_manual_recovery FROM workflow_runs WHERE id = ?")
        .get(runId) as { needs_manual_recovery: number } | undefined;
      expect(runRow?.needs_manual_recovery).toBe(1);
      const round = verifyDb
        .prepare(
          "SELECT state, summary FROM executor_rounds WHERE workflow_run_id = ? AND step_key = 'linear-refresh'"
        )
        .get(runId) as { state: string; summary: string | null } | undefined;
      expect(round?.state).toBe("manual_recovery_required");
      expect(round?.summary).toContain("LINEAR_API_KEY");
    } finally {
      verifyDb.close();
    }
  });

  it("preserves Linear policy denial before auth recovery", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const runId = "ngx559-linear-policy-before-auth";

    const startResult = await run([
      "workflow",
      "run",
      "start",
      "--run-id",
      runId,
      "--repo",
      repoDir,
      "--objective",
      "Apply Linear refresh",
      "--issue-scope",
      "NGX-1002",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(startResult.code).toBe(0);

    const db = openDb(dataDir);
    try {
      db.prepare(
        "UPDATE workflow_steps SET state = 'succeeded' WHERE run_id = ? AND step_order < 5"
      ).run(runId);
      db.prepare(
        "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ? AND step_id = 'linear-refresh'"
      ).run(runId);
      db.prepare("UPDATE workflow_runs SET state = 'approved' WHERE id = ?").run(
        runId
      );
      db.prepare(
        `INSERT INTO source_items
           (id, adapter_kind, external_id, external_key, url, title, status,
            metadata_json, last_observed_at, goal_id, created_at, updated_at)
         VALUES ('source_ngx1002_default_policy', 'linear', 'linear-issue-1002', 'NGX-1002',
                 'https://linear.app/example/issue/NGX-1002', 'Scoped issue',
                 'Todo', '{}', 1, NULL, 1, 1)`
      ).run();
      db.prepare(
        `INSERT INTO update_intents
           (id, adapter_kind, target_external_id, intent_type, payload_json,
            reason, source_item_id, status, idempotency_key, created_at,
            updated_at, applied_at, skipped_at, canceled_at, decision_reason)
         VALUES ('intent_ngx1002_default_policy', 'linear', 'linear-issue-1002',
                 'source_satisfied', '{"kind":"comment"}', 'evidence says done',
                 'source_ngx1002_default_policy', 'pending',
                 'idemp:intent_ngx1002_default_policy', 1, 1,
                 NULL, NULL, NULL, NULL)`
      ).run();
    } finally {
      db.close();
    }

    let applyCalls = 0;
    const deps = {
      buildLinearExternalUpdateClient: () => ({
        async apply() {
          applyCalls += 1;
          throw new Error("must not call external apply when policy denies");
        }
      })
    };

    const result = await run(
      [
        "daemon",
        "start",
        "--max-loop-iterations",
        "1",
        "--poll-interval-ms",
        "0",
        "--data-dir",
        dataDir,
        "--json"
      ],
      {},
      deps
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(applyCalls).toBe(0);

    const verifyDb = openDb(dataDir);
    try {
      const runRow = verifyDb
        .prepare("SELECT needs_manual_recovery FROM workflow_runs WHERE id = ?")
        .get(runId) as { needs_manual_recovery: number } | undefined;
      expect(runRow?.needs_manual_recovery).toBe(1);
      const round = verifyDb
        .prepare(
          "SELECT state, summary FROM executor_rounds WHERE workflow_run_id = ? AND step_key = 'linear-refresh'"
        )
        .get(runId) as { state: string; summary: string | null } | undefined;
      expect(round?.state).toBe("manual_recovery_required");
      expect(round?.summary).toContain("policy_denied");
      expect(round?.summary).toContain("create_intents_only");
      expect(round?.summary).not.toContain("LINEAR_API_KEY");
    } finally {
      verifyDb.close();
    }
  });

  it("surfaces invalid Linear refresh policy files before default policy refusal", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const runId = "ngx559-linear-policy-invalid";

    const startResult = await run([
      "workflow",
      "run",
      "start",
      "--run-id",
      runId,
      "--repo",
      repoDir,
      "--objective",
      "Apply Linear refresh",
      "--issue-scope",
      "NGX-1003",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(startResult.code).toBe(0);
    fs.writeFileSync(
      path.join(repoDir, "MOMENTUM.md"),
      "---\nintent_apply_policy: write_everything\n---\n",
      "utf8"
    );

    const db = openDb(dataDir);
    try {
      db.prepare(
        "UPDATE workflow_steps SET state = 'succeeded' WHERE run_id = ? AND step_order < 5"
      ).run(runId);
      db.prepare(
        "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ? AND step_id = 'linear-refresh'"
      ).run(runId);
      db.prepare("UPDATE workflow_runs SET state = 'approved' WHERE id = ?").run(
        runId
      );
      db.prepare(
        `INSERT INTO source_items
           (id, adapter_kind, external_id, external_key, url, title, status,
            metadata_json, last_observed_at, goal_id, created_at, updated_at)
         VALUES ('source_ngx1003_invalid_policy', 'linear', 'linear-issue-1003', 'NGX-1003',
                 'https://linear.app/example/issue/NGX-1003', 'Scoped issue',
                 'Todo', '{}', 1, NULL, 1, 1)`
      ).run();
      db.prepare(
        `INSERT INTO update_intents
           (id, adapter_kind, target_external_id, intent_type, payload_json,
            reason, source_item_id, status, idempotency_key, created_at,
            updated_at, applied_at, skipped_at, canceled_at, decision_reason)
         VALUES ('intent_ngx1003_invalid_policy', 'linear', 'linear-issue-1003',
                 'status_update', '{"state":"Done"}', 'evidence says done',
                 'source_ngx1003_invalid_policy', 'pending',
                 'idemp:intent_ngx1003_invalid_policy', 1, 1,
                 NULL, NULL, NULL, NULL)`
      ).run();
    } finally {
      db.close();
    }

    let applyCalls = 0;
    const deps = {
      buildLinearExternalUpdateClient: () => ({
        async apply() {
          applyCalls += 1;
          throw new Error("must not call external apply when policy is invalid");
        }
      })
    };

    const result = await run(
      [
        "daemon",
        "start",
        "--max-loop-iterations",
        "1",
        "--poll-interval-ms",
        "0",
        "--data-dir",
        dataDir,
        "--json"
      ],
      { LINEAR_API_KEY: "test-key" },
      deps
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(applyCalls).toBe(0);

    const verifyDb = openDb(dataDir);
    try {
      const round = verifyDb
        .prepare(
          "SELECT state, summary FROM executor_rounds WHERE workflow_run_id = ? AND step_key = 'linear-refresh'"
        )
        .get(runId) as { state: string; summary: string | null } | undefined;
      expect(round?.state).toBe("manual_recovery_required");
      expect(round?.summary).toContain("policy_schema_invalid");
      expect(round?.summary).toContain("intent_apply_policy");
      expect(round?.summary).not.toContain("policy_denied");
    } finally {
      verifyDb.close();
    }
  });

  it("fails closed before Linear mutation when the status_update target state is unsafe", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const runId = "ngx584-linear-invalid-target-state";

    const startResult = await run([
      "workflow",
      "run",
      "start",
      "--run-id",
      runId,
      "--repo",
      repoDir,
      "--objective",
      "Apply Linear refresh",
      "--issue-scope",
      "NGX-1004",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(startResult.code).toBe(0);
    fs.writeFileSync(
      path.join(repoDir, "MOMENTUM.md"),
      "---\nintent_apply_policy: external_apply_allowed\n---\n",
      "utf8"
    );

    const db = openDb(dataDir);
    try {
      db.prepare(
        "UPDATE workflow_steps SET state = 'succeeded' WHERE run_id = ? AND step_order < 5"
      ).run(runId);
      db.prepare(
        "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ? AND step_id = 'linear-refresh'"
      ).run(runId);
      db.prepare("UPDATE workflow_runs SET state = 'approved' WHERE id = ?").run(
        runId
      );
      db.prepare(
        `INSERT INTO source_items
           (id, adapter_kind, external_id, external_key, url, title, status,
            metadata_json, last_observed_at, goal_id, created_at, updated_at)
         VALUES ('source_ngx1004_invalid_target_state', 'linear', 'linear-issue-1004', 'NGX-1004',
                 'https://linear.app/example/issue/NGX-1004', 'Scoped issue',
                 'Todo', '{}', 1, NULL, 1, 1)`
      ).run();
      db.prepare(
        `INSERT INTO update_intents
           (id, adapter_kind, target_external_id, intent_type, payload_json,
            reason, source_item_id, status, idempotency_key, created_at,
            updated_at, applied_at, skipped_at, canceled_at, decision_reason)
         VALUES ('intent_ngx1004_invalid_target_state', 'linear', 'linear-issue-1004',
                 'status_update', '{"state":"Done","stateId":"done-id"}',
                 'evidence says done',
                 'source_ngx1004_invalid_target_state', 'pending',
                 'idemp:intent_ngx1004_invalid_target_state', 1, 1,
                 NULL, NULL, NULL, NULL)`
      ).run();
    } finally {
      db.close();
    }

    let applyCalls = 0;
    const deps = {
      buildLinearExternalUpdateClient: () => ({
        async apply() {
          applyCalls += 1;
          throw new Error("must not call external apply for invalid target state");
        }
      })
    };

    const result = await run(
      [
        "daemon",
        "start",
        "--max-loop-iterations",
        "1",
        "--poll-interval-ms",
        "0",
        "--data-dir",
        dataDir,
        "--json"
      ],
      { LINEAR_API_KEY: "test-key" },
      deps
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(applyCalls).toBe(0);

    const verifyDb = openDb(dataDir);
    try {
      const round = verifyDb
        .prepare(
          "SELECT state, summary FROM executor_rounds WHERE workflow_run_id = ? AND step_key = 'linear-refresh'"
        )
        .get(runId) as { state: string; summary: string | null } | undefined;
      expect(round?.state).toBe("manual_recovery_required");
      expect(round?.summary).toContain("payload_invalid");
      expect(round?.summary).toContain("resolve_intent_evidence");
      const intentRow = verifyDb
        .prepare(
          "SELECT status FROM update_intents WHERE id = 'intent_ngx1004_invalid_target_state'"
        )
        .get() as { status: string } | undefined;
      expect(intentRow).toEqual({ status: "pending" });
    } finally {
      verifyDb.close();
    }
  });

  it("reconciles already-applied Linear refresh evidence before policy load failures", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const runId = "ngx565-linear-applied-invalid-policy";
    const intentId = "intent_ngx565_applied_invalid_policy";
    const payload = { state: "Done" };
    const marker = buildIdempotencyMarker({
      adapterKind: "linear",
      intentId,
      payload
    });

    const startResult = await run([
      "workflow",
      "run",
      "start",
      "--run-id",
      runId,
      "--repo",
      repoDir,
      "--objective",
      "Apply Linear refresh",
      "--issue-scope",
      "NGX-565",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(startResult.code).toBe(0);
    fs.writeFileSync(
      path.join(repoDir, "MOMENTUM.md"),
      "---\nintent_apply_policy: write_everything\n---\n",
      "utf8"
    );

    const db = openDb(dataDir);
    try {
      db.prepare(
        "UPDATE workflow_steps SET state = 'succeeded' WHERE run_id = ? AND step_order < 5"
      ).run(runId);
      db.prepare(
        "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ? AND step_id = 'linear-refresh'"
      ).run(runId);
      db.prepare("UPDATE workflow_runs SET state = 'approved' WHERE id = ?").run(
        runId
      );
      db.prepare(
        `INSERT INTO source_items
           (id, adapter_kind, external_id, external_key, url, title, status,
            metadata_json, last_observed_at, goal_id, created_at, updated_at)
         VALUES ('source_ngx565_applied_invalid_policy', 'linear', 'linear-issue-565', 'NGX-565',
                 'https://linear.app/example/issue/NGX-565', 'Scoped issue',
                 'Done', '{}', 1, NULL, 1, 1)`
      ).run();
      db.prepare(
        `INSERT INTO update_intents
           (id, adapter_kind, target_external_id, intent_type, payload_json,
            reason, source_item_id, status, idempotency_key, created_at,
            updated_at, applied_at, skipped_at, canceled_at, decision_reason)
         VALUES (?, 'linear', 'linear-issue-565',
                 'status_update', ?, 'workflow complete',
                 'source_ngx565_applied_invalid_policy', 'applied',
                 'idemp:intent_ngx565_applied_invalid_policy', 1, 2,
                 2, NULL, NULL, NULL)`
      ).run(intentId, JSON.stringify(payload));
      db.prepare(
        `INSERT INTO intent_apply_audits
           (id, intent_id, adapter_kind, provider,
            external_target_external_id, external_target_external_key,
            external_target_url, external_target_title,
            requested_at, finished_at,
            operator_reason, operator_actor,
            intent_apply_policy, allow_status_mutation,
            mutation_kind, preview_summary, idempotency_marker,
            lifecycle_state, result_status, result_code, result_message,
            external_ref_comment_id, external_ref_comment_url,
            external_ref_state_transition_id,
            reconcile_status, reconcile_warning,
            created_at, updated_at)
         VALUES ('audit_ngx565_applied_invalid_policy', ?, 'linear', 'linear',
                 'linear-issue-565', 'NGX-565',
                 'https://linear.app/example/issue/NGX-565', 'Scoped issue',
                 1, 2,
                 ?, NULL,
                 'external_apply_allowed', 1,
                 'status_transition', 'Move NGX-565 to Done', ?,
                 'succeeded', 'succeeded', 'applied', 'External write succeeded.',
                 'comment-ngx565', 'https://linear.app/example/comment/NGX-565',
                 'transition-ngx565',
                 'success', NULL,
                 1, 2)`
      ).run(intentId, `daemon external-apply for workflow ${runId}/linear-refresh`, marker);
    } finally {
      db.close();
    }

    let applyCalls = 0;
    const deps = {
      buildLinearExternalUpdateClient: () => ({
        async apply() {
          applyCalls += 1;
          throw new Error("must not call external apply for already-applied evidence");
        }
      })
    };

    const result = await run(
      [
        "daemon",
        "start",
        "--max-loop-iterations",
        "1",
        "--poll-interval-ms",
        "0",
        "--data-dir",
        dataDir,
        "--json"
      ],
      {},
      deps
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(applyCalls).toBe(0);

    const verifyDb = openDb(dataDir);
    try {
      const step = verifyDb
        .prepare(
          "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = 'linear-refresh'"
        )
        .get(runId) as { state: string } | undefined;
      expect(step).toEqual({ state: "succeeded" });
      const resultJson = JSON.parse(
        fs.readFileSync(
          path.join(repoDir, ".agent-workflows", runId, "external-apply.json"),
          "utf8"
        )
      ) as { resultCode?: string; external?: { alreadyApplied?: boolean } };
      expect(resultJson.resultCode).toBe("already_applied");
      expect(resultJson.external?.alreadyApplied).toBe(true);
      const runRow = verifyDb
        .prepare("SELECT needs_manual_recovery FROM workflow_runs WHERE id = ?")
        .get(runId) as { needs_manual_recovery: number } | undefined;
      expect(runRow?.needs_manual_recovery).toBe(0);
    } finally {
      verifyDb.close();
    }
  });

  it("applies Linear status_update intents for the linear-refresh step", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    fs.writeFileSync(
      path.join(repoDir, "MOMENTUM.md"),
      "---\nintent_apply_policy: external_apply_allowed\n---\n",
      "utf8"
    );
    const runId = "ngx522-linear-status-update";

    const startResult = await run([
      "workflow",
      "run",
      "start",
      "--run-id",
      runId,
      "--repo",
      repoDir,
      "--objective",
      "Apply Linear status refresh",
      "--issue-scope",
      "NGX-522",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(startResult.code).toBe(0);

    const db = openDb(dataDir);
    try {
      db.prepare(
        "UPDATE workflow_steps SET state = 'succeeded' WHERE run_id = ? AND step_order < 5"
      ).run(runId);
      db.prepare(
        "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ? AND step_id = 'linear-refresh'"
      ).run(runId);
      db.prepare("UPDATE workflow_runs SET state = 'approved' WHERE id = ?").run(
        runId
      );
      db.prepare(
        `INSERT INTO source_items
           (id, adapter_kind, external_id, external_key, url, title, status,
            metadata_json, last_observed_at, goal_id, created_at, updated_at)
         VALUES ('source_ngx522', 'linear', 'linear-issue-522', 'NGX-522',
                 'https://linear.app/example/issue/NGX-522', 'Status issue',
                 'In Review', '{}', 1, NULL, 1, 1)`
      ).run();
      db.prepare(
        `INSERT INTO update_intents
           (id, adapter_kind, target_external_id, intent_type, payload_json,
            reason, source_item_id, status, idempotency_key, created_at,
            updated_at, applied_at, skipped_at, canceled_at, decision_reason)
         VALUES ('intent_aaa_ngx522_source_satisfied', 'linear', 'linear-issue-522',
                 'source_satisfied', '{"kind":"comment"}',
                 'source evidence exists',
                 'source_ngx522', 'pending', 'idemp:intent_aaa_ngx522_source_satisfied', 0, 0,
                 NULL, NULL, NULL, NULL)`
      ).run();
      db.prepare(
        `INSERT INTO update_intents
           (id, adapter_kind, target_external_id, intent_type, payload_json,
            reason, source_item_id, status, idempotency_key, created_at,
            updated_at, applied_at, skipped_at, canceled_at, decision_reason)
         VALUES ('intent_ngx522', 'linear', 'linear-issue-522',
                 'status_update',
                 '{"state":"Done","comment":"Native workflow finished."}',
                 'close issue after native workflow',
                 'source_ngx522', 'pending', 'idemp:intent_ngx522', 1, 1,
                 NULL, NULL, NULL, NULL)`
      ).run();
    } finally {
      db.close();
    }

    let marker = "";
    let applyCalls = 0;
    let statusMutation: unknown = null;
    const deps = {
      buildLinearExternalUpdateClient: () => ({
        async apply(input: {
          preview: { idempotencyMarker: string; commentBody: string };
          statusMutation?: unknown;
        }) {
          applyCalls += 1;
          marker = input.preview.idempotencyMarker;
          statusMutation = input.statusMutation;
          expect(input.preview.commentBody).toContain(
            "Native workflow finished."
          );
          return {
            ok: true as const,
            alreadyApplied: false,
            issue: {
              id: "linear-issue-522",
              key: "NGX-522",
              url: "https://linear.app/example/issue/NGX-522"
            },
            comment: {
              id: "comment-ngx522",
              url: "https://linear.app/example/comment/NGX-522"
            },
            status: {
              transitioned: true as const,
              previousStateId: "state-review",
              previousStateName: "In Review",
              nextStateId: "state-done",
              nextStateName: "Done"
            },
            idempotencyMarker: marker
          };
        }
      }),
      buildLinearIssueRefreshClient: () => ({
        async refresh() {
          return {
            ok: true as const,
            issue: {
              id: "linear-issue-522",
              identifier: "NGX-522",
              title: "Status issue",
              url: "https://linear.app/example/issue/NGX-522",
              updatedAt: "2026-06-24T00:00:00.000Z",
              state: { id: "state-done", name: "Done" }
            },
            comments: [
              {
                id: "comment-ngx522",
                body: `Applied ${marker}`,
                url: "https://linear.app/example/comment/NGX-522"
              }
            ]
          };
        }
      })
    };

    const result = await run(
      [
        "daemon",
        "start",
        "--max-loop-iterations",
        "1",
        "--poll-interval-ms",
        "0",
        "--data-dir",
        dataDir,
        "--json"
      ],
      { LINEAR_API_KEY: "test-key" },
      deps
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(applyCalls).toBe(1);
    expect(statusMutation).toEqual({ kind: "by_name", stateName: "Done" });

    const verifyDb = openDb(dataDir);
    try {
      const intent = verifyDb
        .prepare("SELECT status FROM update_intents WHERE id = 'intent_ngx522'")
        .get() as { status: string } | undefined;
      expect(intent).toEqual({ status: "applied" });
      const step = verifyDb
        .prepare(
          "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = 'linear-refresh'"
        )
        .get(runId) as { state: string } | undefined;
      expect(step).toEqual({ state: "succeeded" });
    } finally {
      verifyDb.close();
    }
  });

  it("sizes the dispatch lease for the configured live-wrapper timeout", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    initRepo(repoDir);
    const profileDir = makeTempDir();
    const profilePath = writeSucceedingPreflightProfile(profileDir, 120);
    const runId = "ngx492-live-wrapper-lease-duration";
    await startApprovedCodingRun(dataDir, repoDir, runId);

    const result = await run(
      [
        "daemon",
        "start",
        "--max-loop-iterations",
        "1",
        "--poll-interval-ms",
        "0",
        "--data-dir",
        dataDir,
        "--json"
      ],
      { [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: profilePath }
    );

    expect(result.code).toBe(0);
    const db = openDb(dataDir);
    try {
      const lease = db
        .prepare(
          "SELECT acquired_at, expires_at FROM workflow_leases WHERE run_id = ? AND lease_kind = 'dispatch'"
        )
        .get(runId) as
        | { acquired_at: number; expires_at: number }
        | undefined;
      expect(lease).not.toBeUndefined();
      expect(lease!.expires_at - lease!.acquired_at).toBeGreaterThanOrEqual(
        120_000
      );
    } finally {
      db.close();
    }
  });

  it("forwards the injected CLI env to daemon live-wrapper commands", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    initRepo(repoDir);
    const profileDir = makeTempDir();
    const profilePath = writeEnvForwardingPreflightProfile(profileDir);
    const runId = "ngx492-live-wrapper-env";
    const oldToken = process.env["MOMENTUM_TEST_TOKEN"];
    delete process.env["MOMENTUM_TEST_TOKEN"];
    try {
      await startApprovedCodingRun(dataDir, repoDir, runId);

      const result = await run(
        [
          "daemon",
          "start",
          "--max-loop-iterations",
          "1",
          "--poll-interval-ms",
          "0",
          "--data-dir",
          dataDir,
          "--json"
        ],
        {
          [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: profilePath,
          MOMENTUM_TEST_TOKEN: "from-cli-io"
        }
      );

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      const db = openDb(dataDir);
      try {
        const step = db
          .prepare(
            "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = ?"
          )
          .get(runId, "preflight") as { state: string } | undefined;
        expect(step).toEqual({ state: "succeeded" });
        const round = db
          .prepare(
            "SELECT summary FROM executor_rounds WHERE workflow_run_id = ? AND step_key = ?"
          )
          .get(runId, "preflight") as { summary: string | null } | undefined;
        expect(round?.summary).toBe("daemon live wrapper env forwarded");
      } finally {
        db.close();
      }
    } finally {
      if (oldToken === undefined) {
        delete process.env["MOMENTUM_TEST_TOKEN"];
      } else {
        process.env["MOMENTUM_TEST_TOKEN"] = oldToken;
      }
    }
  });

  it("parks the run for manual recovery when daemon live-wrapper run-dir creation fails", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    initRepo(repoDir);
    const profileDir = makeTempDir();
    const profilePath = writeSucceedingPreflightProfile(profileDir);
    const runId = "ngx492-run-dir-unavailable";
    fs.writeFileSync(path.join(repoDir, ".agent-workflows"), "not a directory");
    runGit(repoDir, ["add", ".agent-workflows"]);
    runGit(repoDir, ["commit", "-m", "block agent workflows dir", "--quiet"]);
    await startApprovedCodingRun(dataDir, repoDir, runId);

    const result = await run(
      [
        "daemon",
        "start",
        "--max-loop-iterations",
        "1",
        "--poll-interval-ms",
        "0",
        "--data-dir",
        dataDir,
        "--json"
      ],
      { [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: profilePath }
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const loop = JSON.parse(result.stdout).loop as Record<string, unknown>;
    expect(loop["workflowStepsDispatched"]).toBe(1);
    expect(loop["lastWorkflowCode"]).toBe("dispatched");

    const db = openDb(dataDir);
    try {
      const runRow = db
        .prepare(
          "SELECT needs_manual_recovery, manual_recovery_reason FROM workflow_runs WHERE id = ?"
        )
        .get(runId) as
        | { needs_manual_recovery: number; manual_recovery_reason: string | null }
        | undefined;
      expect(runRow?.needs_manual_recovery).toBe(1);
      expect(runRow?.manual_recovery_reason).toContain(
        "runtime_unavailable"
      );

      const invocation = db
        .prepare(
          "SELECT state FROM executor_invocations WHERE workflow_run_id = ? AND step_key = ?"
        )
        .get(runId, "preflight") as { state: string } | undefined;
      expect(invocation).toEqual({ state: "manual_recovery_required" });

      const round = db
        .prepare(
          "SELECT state, recovery_code, summary FROM executor_rounds WHERE workflow_run_id = ? AND step_key = ?"
        )
        .get(runId, "preflight") as
        | { state: string; recovery_code: string | null; summary: string | null }
        | undefined;
      expect(round?.state).toBe("manual_recovery_required");
      expect(round?.recovery_code).toBe("runtime_unavailable");
      expect(round?.summary).toContain("run_dir_unavailable");

      const openLeases = db
        .prepare(
          "SELECT lease_kind FROM workflow_leases WHERE run_id = ? AND released_at IS NULL"
        )
        .all(runId) as Array<{ lease_kind: string }>;
      expect(openLeases).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("parks the run for manual recovery when the coding workflow wrapper config is missing", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    initRepo(repoDir);
    const profileDir = makeTempDir();
    const profilePath = writeCodingWorkflowWrapperPreflightProfile(profileDir);
    const runId = "ngx544-missing-wrapper-config";
    await startApprovedCodingRun(dataDir, repoDir, runId);

    const result = await run(
      [
        "daemon",
        "start",
        "--max-loop-iterations",
        "1",
        "--poll-interval-ms",
        "0",
        "--data-dir",
        dataDir,
        "--json"
      ],
      { [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: profilePath }
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const db = openDb(dataDir);
    try {
      const step = db
        .prepare(
          "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = ?"
        )
        .get(runId, "preflight") as { state: string } | undefined;
      expect(step).toEqual({ state: "running" });

      const runRow = db
        .prepare(
          "SELECT needs_manual_recovery, manual_recovery_reason FROM workflow_runs WHERE id = ?"
        )
        .get(runId) as
        | { needs_manual_recovery: number; manual_recovery_reason: string | null }
        | undefined;
      expect(runRow?.needs_manual_recovery).toBe(1);
      expect(runRow?.manual_recovery_reason).toContain(
        "runtime_unavailable"
      );

      const round = db
        .prepare(
          "SELECT state, recovery_code, summary FROM executor_rounds WHERE workflow_run_id = ? AND step_key = ?"
        )
        .get(runId, "preflight") as
        | { state: string; recovery_code: string | null; summary: string | null }
        | undefined;
      expect(round?.state).toBe("manual_recovery_required");
      expect(round?.recovery_code).toBe("runtime_unavailable");
      expect(round?.summary).toContain("retryable setup failure");
    } finally {
      db.close();
    }
  });

  it("advances an approved workflow run through the shipped daemon start --max-* path and records durable executor rows", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const runId = "ngx367-dispatch";
    await startApprovedCodingRun(dataDir, repoDir, runId);

    const result = await run([
      "daemon",
      "start",
      "--max-loop-iterations",
      "1",
      "--poll-interval-ms",
      "0",
      "--data-dir",
      dataDir,
      "--json"
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    const loop = payload["loop"] as Record<string, unknown>;
    // The shipped managed loop is no longer inert: it claimed and dispatched the
    // approved workflow step and surfaces that as stable loop-summary evidence.
    expect(loop["workflowStepsDispatched"]).toBe(1);
    expect(loop["lastWorkflowCode"]).toBe("dispatched");

    // The dispatched step created durable executor_invocations / executor_rounds
    // rows through the production path, observable after the daemon exits.
    const db = openDb(dataDir);
    try {
      const invocations = db
        .prepare(
          "SELECT step_key, executor_family, state FROM executor_invocations WHERE workflow_run_id = ?"
        )
        .all(runId) as Array<{
        step_key: string;
        executor_family: string;
        state: string;
      }>;
      expect(invocations).toEqual([
        { step_key: "preflight", executor_family: "one-shot", state: "running" }
      ]);

      const rounds = db
        .prepare(
          "SELECT step_key, round_index, state FROM executor_rounds WHERE workflow_run_id = ?"
        )
        .all(runId) as Array<{
        step_key: string;
        round_index: number;
        state: string;
      }>;
      expect(rounds).toEqual([
        { step_key: "preflight", round_index: 1, state: "pending" }
      ]);
    } finally {
      db.close();
    }

    // Process-loss observability: status and monitor report the post-dispatch
    // state from durable rows, without any in-memory daemon handle.
    const statusResult = await run([
      "workflow",
      "status",
      runId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(statusResult.code).toBe(0);
    const statusPayload = JSON.parse(statusResult.stdout) as {
      steps: Array<{ stepId: string; state: string }>;
    };
    const preflight = statusPayload.steps.find((s) => s.stepId === "preflight");
    expect(preflight?.state).toBe("running");

    const monitorResult = await run([
      "workflow",
      "run",
      "monitor",
      runId,
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(monitorResult.code).toBe(0);
  });

  it("dispatches the next approved step after the first dispatch is recovered and terminalized", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const runId = "ngx390-second-dispatch";
    await startApprovedCodingRun(dataDir, repoDir, runId);

    const firstDispatch = await run([
      "daemon",
      "start",
      "--max-loop-iterations",
      "1",
      "--poll-interval-ms",
      "0",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(firstDispatch.code).toBe(0);
    expect(JSON.parse(firstDispatch.stdout).loop.workflowStepsDispatched).toBe(1);

    const db = openDb(dataDir);
    try {
      db.prepare(
        `UPDATE workflow_leases
            SET heartbeat_at = ?, expires_at = ?
          WHERE run_id = ? AND lease_kind = ?`
      ).run(1, 2, runId, "dispatch");
      terminalizeDispatchedExecutorInvocation({
        db,
        runId,
        stepId: "preflight",
        now: Date.now(),
        result: {
          ok: true,
          result: {
            state: "succeeded",
            summary: "test terminalizes preflight before second dispatch",
            checkpoints: [],
            artifacts: [],
            resultDigest: "sha256:cli-second-dispatch-preflight",
            errorCode: null,
            errorMessage: null,
            retryHint: null,
            recoveryHint: null
          },
          executorLogPath: path.join(repoDir, ".agent-workflows", runId, "executor.log"),
          resultJsonPath: path.join(repoDir, ".agent-workflows", runId, "result.json")
        }
      });
    } finally {
      db.close();
    }

    const recoverLease = await run([
      "daemon",
      "start",
      "--max-loop-iterations",
      "1",
      "--poll-interval-ms",
      "0",
      "--data-dir",
      dataDir,
      "--json"
    ]);
    expect(recoverLease.code).toBe(0);
    const loop = JSON.parse(recoverLease.stdout).loop as Record<string, unknown>;
    expect(loop["exitReason"]).toBe("max_loop_iterations");
    expect(loop["iterations"]).toBe(1);
    expect(loop["workflowStepsDispatched"]).toBe(1);

    const finalDb = openDb(dataDir);
    try {
      const steps = finalDb
        .prepare(
          "SELECT step_id, state FROM workflow_steps WHERE run_id = ? ORDER BY step_order"
        )
        .all(runId) as Array<{ step_id: string; state: string }>;
      expect(steps.slice(0, 2)).toEqual([
        { step_id: "preflight", state: "succeeded" },
        { step_id: "implementation", state: "running" }
      ]);

      const invocations = finalDb
        .prepare(
          "SELECT step_key, executor_family, state FROM executor_invocations WHERE workflow_run_id = ? ORDER BY created_at"
        )
        .all(runId) as Array<{
        step_key: string;
        executor_family: string;
        state: string;
      }>;
      expect(invocations).toEqual([
        { step_key: "preflight", executor_family: "one-shot", state: "succeeded" },
        { step_key: "implementation", executor_family: "goal-loop", state: "running" }
      ]);
    } finally {
      finalDb.close();
    }
  });

  it("dispatches two approved steps in one dogfood-opted-in daemon start when each step terminalizes safely (NGX-391)", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const runId = "ngx391-cli-multi-dispatch";
    await startApprovedCodingRun(dataDir, repoDir, runId);

    // A SINGLE `daemon start` process, opted into the dogfood terminalize-and-
    // continue lane against this isolated data dir. Unlike the NGX-390 proof —
    // which needed three separate processes plus a manual update-step — this one
    // process dispatches preflight, terminalizes it safely, then dispatches
    // implementation.
    const result = await run(
      [
        "daemon",
        "start",
        "--max-loop-iterations",
        "5",
        "--poll-interval-ms",
        "0",
        "--data-dir",
        dataDir,
        "--json"
      ],
      { [DOGFOOD_TERMINALIZE_DISPATCH_ENV_VAR]: "1" }
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const loop = JSON.parse(result.stdout).loop as Record<string, unknown>;
    // The CLI dogfood receipt: loop iterations and the >= 2 dispatch count.
    expect(loop["workflowStepsDispatched"]).toBe(2);
    expect(loop["iterations"]).toBe(5);
    expect(loop["exitReason"]).toBe("max_loop_iterations");
    expect(loop["lastWorkflowCode"]).toBe("idle");

    const db = openDb(dataDir);
    try {
      const steps = db
        .prepare(
          "SELECT step_id, state FROM workflow_steps WHERE run_id = ? ORDER BY step_order"
        )
        .all(runId) as Array<{ step_id: string; state: string }>;
      expect(steps.slice(0, 2)).toEqual([
        { step_id: "preflight", state: "succeeded" },
        { step_id: "implementation", state: "succeeded" }
      ]);

      // The dispatch lease taken for each step was released on terminal — no
      // lease corruption strands the run.
      const openLeases = db
        .prepare(
          "SELECT lease_kind FROM workflow_leases WHERE run_id = ? AND released_at IS NULL"
        )
        .all(runId) as Array<{ lease_kind: string }>;
      expect(openLeases).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("does not terminalize or re-dispatch in a default daemon start without the dogfood opt-in (NGX-391 gate)", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const runId = "ngx391-default-single-dispatch";
    await startApprovedCodingRun(dataDir, repoDir, runId);

    // The same bounded loop, but with NO dogfood opt-in: the production dispatch
    // holds preflight `running` and never terminalizes it, so the run scans as
    // busy and no second step is ever dispatched — `>= 2` happens only when a
    // step terminalizes safely.
    const result = await run([
      "daemon",
      "start",
      "--max-loop-iterations",
      "5",
      "--poll-interval-ms",
      "0",
      "--data-dir",
      dataDir,
      "--json"
    ]);

    expect(result.code).toBe(0);
    const loop = JSON.parse(result.stdout).loop as Record<string, unknown>;
    expect(loop["workflowStepsDispatched"]).toBe(1);

    const db = openDb(dataDir);
    try {
      const preflight = db
        .prepare(
          "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = ?"
        )
        .get(runId, "preflight") as { state: string } | undefined;
      // The dispatched step stays `running` (held by its dispatch lease); nothing
      // advanced it.
      expect(preflight?.state).toBe("running");
    } finally {
      db.close();
    }
  });

  it("leaves the workflow lane untouched for register-only daemon start", async () => {
    const dataDir = makeTempDir();
    const repoDir = makeTempDir();
    const runId = "ngx367-register-only";
    await startApprovedCodingRun(dataDir, repoDir, runId);

    const result = await run([
      "daemon",
      "start",
      "--data-dir",
      dataDir,
      "--json"
    ]);

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload["ok"]).toBe(true);
    // Register-only mode records a daemon run and exits: no managed loop ran, so
    // there is no loop summary and the workflow scheduler was never entered.
    expect(payload["loop"]).toBeUndefined();

    const db = openDb(dataDir);
    try {
      const invocationCount = (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM executor_invocations WHERE workflow_run_id = ?"
          )
          .get(runId) as { count: number }
      ).count;
      expect(invocationCount).toBe(0);

      const preflight = db
        .prepare(
          "SELECT state FROM workflow_steps WHERE run_id = ? AND step_id = ?"
        )
        .get(runId, "preflight") as { state: string } | undefined;
      // The approved step stays approved; nothing claimed or advanced it.
      expect(preflight?.state).toBe("approved");
    } finally {
      db.close();
    }
  });
});
