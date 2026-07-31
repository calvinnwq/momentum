import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDb } from "../src/adapters/db.js";
import { resolveDaemonWorkflowStepDispatch } from "../src/core/daemon/workflow-dispatch.js";
import {
  DAEMON_HOST_BINDINGS_FILE_ENV_VAR,
  RETIRED_LIVE_WRAPPER_PROFILE_ENV_VAR,
  readDaemonHostBindingsSource,
  resolveDaemonHostBindings,
  type DaemonHostBindingsSourceLoad,
} from "../src/core/workflow/live-wrapper/daemon-host-bindings.js";
import type { WorkflowDefinition } from "../src/core/workflow/definition/definition.js";
import { persistWorkflowDefinition } from "../src/core/workflow/definition/persist.js";
import { executeWorkflowStepDispatch } from "../src/core/workflow/dispatch/execute.js";
import { runWorkflowSchedulerOnceAsync } from "../src/core/workflow/dispatch/scheduler.js";
import { persistWorkflowRunStart } from "../src/core/workflow/run/start-persist.js";
import { buildRealWorkflowStepExecutorRegistry } from "../src/core/workflow/step/executor-real-adapters.js";

/**
 * NGX-668 (NAM-03E): daemon host-binding *source resolution*.
 *
 * A pure resolver turns the operator environment into either absent host
 * bindings (the unchanged default daemon lane), parsed {@link HostBindings}
 * the daemon lane can build a real executor registry from, or an honest
 * invalid outcome so a misconfigured source never silently fabricates
 * bindings. `MOMENTUM_HOST_BINDINGS_FILE` is the only active selector; the
 * retired `MOMENTUM_LIVE_WRAPPER_PROFILE` selector refuses with a precise
 * migration diagnostic and never consults a fallback source.
 */

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-daemon-host-bindings-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

const VALID_HOST_BINDINGS_JSON = JSON.stringify({
  bindings: {
    implementation: {
      command: "/bin/sh",
      args: ["-c", "true"],
      cwd: "iteration",
      timeout_sec: 30,
      env_allow: [],
      result_file: "result.json",
    },
  },
});

/** A loader that always succeeds with the supplied contents. */
function loaderReturning(contents: string): {
  loadSource: (p: string) => DaemonHostBindingsSourceLoad;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    loadSource: (p: string) => {
      calls.push(p);
      return { ok: true, contents };
    },
  };
}

/** A loader that always fails, as if the file were missing/unreadable. */
function loaderFailing(error: string): {
  loadSource: (p: string) => DaemonHostBindingsSourceLoad;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    loadSource: (p: string) => {
      calls.push(p);
      return { ok: false, error };
    },
  };
}

describe("resolveDaemonHostBindings", () => {
  it("returns not_configured when the env var is unset", () => {
    const loader = loaderReturning(VALID_HOST_BINDINGS_JSON);
    const resolution = resolveDaemonHostBindings({}, loader);
    expect(resolution.status).toBe("not_configured");
    // The default daemon lane must stay untouched: never read a source.
    expect(loader.calls).toEqual([]);
  });

  it("returns not_configured (and reads nothing) when the env var is blank", () => {
    const loader = loaderReturning(VALID_HOST_BINDINGS_JSON);
    const resolution = resolveDaemonHostBindings(
      { [DAEMON_HOST_BINDINGS_FILE_ENV_VAR]: "   " },
      loader,
    );
    expect(resolution.status).toBe("not_configured");
    expect(loader.calls).toEqual([]);
  });

  it("resolves parsed host bindings from a readable, valid source", () => {
    const loader = loaderReturning(VALID_HOST_BINDINGS_JSON);
    const resolution = resolveDaemonHostBindings(
      { [DAEMON_HOST_BINDINGS_FILE_ENV_VAR]: "/etc/momentum/bindings.json" },
      loader,
    );
    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    expect(resolution.source).toBe("/etc/momentum/bindings.json");
    expect(resolution.bindings.bindings.has("implementation")).toBe(true);
  });

  it("trims the configured source path before reading it and echoes the trimmed path", () => {
    const loader = loaderReturning(VALID_HOST_BINDINGS_JSON);
    const resolution = resolveDaemonHostBindings(
      {
        [DAEMON_HOST_BINDINGS_FILE_ENV_VAR]: "  /etc/momentum/bindings.json  ",
      },
      loader,
    );
    expect(loader.calls).toEqual(["/etc/momentum/bindings.json"]);
    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    expect(resolution.source).toBe("/etc/momentum/bindings.json");
  });

  it("returns invalid:source_unreadable when the source cannot be read", () => {
    const loader = loaderFailing("ENOENT: no such file");
    const resolution = resolveDaemonHostBindings(
      { [DAEMON_HOST_BINDINGS_FILE_ENV_VAR]: "/missing/bindings.json" },
      loader,
    );
    expect(resolution.status).toBe("invalid");
    if (resolution.status !== "invalid") return;
    expect(resolution.code).toBe("source_unreadable");
    expect(resolution.source).toBe("/missing/bindings.json");
    expect(resolution.error).toContain("ENOENT");
  });

  it("returns invalid:source_invalid_json when the source is not valid JSON", () => {
    const loader = loaderReturning("{ not json ");
    const resolution = resolveDaemonHostBindings(
      { [DAEMON_HOST_BINDINGS_FILE_ENV_VAR]: "/etc/momentum/bindings.json" },
      loader,
    );
    expect(resolution.status).toBe("invalid");
    if (resolution.status !== "invalid") return;
    expect(resolution.code).toBe("source_invalid_json");
  });

  it("returns invalid:host_bindings_invalid (surfacing the registry error) for valid JSON that is not host bindings", () => {
    const loader = loaderReturning(JSON.stringify({ misc: true }));
    const resolution = resolveDaemonHostBindings(
      { [DAEMON_HOST_BINDINGS_FILE_ENV_VAR]: "/etc/momentum/bindings.json" },
      loader,
    );
    expect(resolution.status).toBe("invalid");
    if (resolution.status !== "invalid") return;
    expect(resolution.code).toBe("host_bindings_invalid");
    // The underlying parseHostBindings message is preserved, not swallowed.
    expect(resolution.error).toContain("bindings");
  });

  it.each(["tracker-refresh", "linear-refresh"])(
    "refuses a %s binding because the daemon never consults it - that step is external-apply-owned",
    (kind) => {
      const loader = loaderReturning(
        JSON.stringify({
          bindings: {
            [kind]: {
              command: "/bin/sh",
              args: ["-c", "true"],
              cwd: "iteration",
              timeout_sec: 30,
              env_allow: [],
              result_file: "result.json",
            },
          },
        }),
      );
      const resolution = resolveDaemonHostBindings(
        { [DAEMON_HOST_BINDINGS_FILE_ENV_VAR]: "/etc/momentum/bindings.json" },
        loader,
      );
      expect(resolution.status).toBe("invalid");
      if (resolution.status !== "invalid") return;
      expect(resolution.code).toBe("host_bindings_invalid");
      expect(resolution.error).toContain("tracker-refresh");
      expect(resolution.error).toContain("external-apply");
    },
  );

  it("refuses the retired live-wrapper profile shape without falling back", () => {
    const loader = loaderReturning(
      JSON.stringify({
        name: "daemon-default",
        wrappers: {
          implementation: {
            command: "/bin/sh",
            args: ["-c", "true"],
            cwd: "iteration",
            timeout_sec: 30,
            env_allow: [],
            result_file: "result.json",
          },
        },
      }),
    );
    const resolution = resolveDaemonHostBindings(
      { [DAEMON_HOST_BINDINGS_FILE_ENV_VAR]: "/etc/momentum/bindings.json" },
      loader,
    );
    expect(resolution.status).toBe("invalid");
    if (resolution.status !== "invalid") return;
    expect(resolution.code).toBe("host_bindings_invalid");
    expect(resolution.error).toContain("wrappers");
  });

  it("produces host bindings that build a configured real executor registry", () => {
    const loader = loaderReturning(VALID_HOST_BINDINGS_JSON);
    const resolution = resolveDaemonHostBindings(
      { [DAEMON_HOST_BINDINGS_FILE_ENV_VAR]: "/etc/momentum/bindings.json" },
      loader,
    );
    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    // The resolver output is exactly the input the daemon-lane wiring will feed
    // to the existing registry builder: the configured kind must be executing.
    const registry = buildRealWorkflowStepExecutorRegistry({
      bindings: resolution.bindings,
    });
    const adapter = registry.get("implementation");
    expect(adapter?.executes).toBe(true);
  });
});

describe("retired MOMENTUM_LIVE_WRAPPER_PROFILE selector", () => {
  it("refuses with a migration diagnostic naming MOMENTUM_HOST_BINDINGS_FILE and consults no source", () => {
    const loader = loaderReturning(VALID_HOST_BINDINGS_JSON);
    const resolution = resolveDaemonHostBindings(
      { [RETIRED_LIVE_WRAPPER_PROFILE_ENV_VAR]: "/legacy/profile.json" },
      loader,
    );
    expect(resolution.status).toBe("invalid");
    if (resolution.status !== "invalid") return;
    expect(resolution.code).toBe("retired_selector");
    expect(resolution.error).toContain("MOMENTUM_LIVE_WRAPPER_PROFILE");
    expect(resolution.error).toContain("MOMENTUM_HOST_BINDINGS_FILE");
    // The retired selector is never treated as a source: no fallback read of
    // either the legacy profile file or the new bindings file happens.
    expect(loader.calls).toEqual([]);
  });

  it("refuses even when MOMENTUM_HOST_BINDINGS_FILE is also configured", () => {
    const loader = loaderReturning(VALID_HOST_BINDINGS_JSON);
    const resolution = resolveDaemonHostBindings(
      {
        [DAEMON_HOST_BINDINGS_FILE_ENV_VAR]: "/etc/momentum/bindings.json",
        [RETIRED_LIVE_WRAPPER_PROFILE_ENV_VAR]: "/legacy/profile.json",
      },
      loader,
    );
    expect(resolution.status).toBe("invalid");
    if (resolution.status !== "invalid") return;
    expect(resolution.code).toBe("retired_selector");
    expect(loader.calls).toEqual([]);
  });

  it("treats a blank retired selector as absent", () => {
    const loader = loaderReturning(VALID_HOST_BINDINGS_JSON);
    const resolution = resolveDaemonHostBindings(
      {
        [DAEMON_HOST_BINDINGS_FILE_ENV_VAR]: "/etc/momentum/bindings.json",
        [RETIRED_LIVE_WRAPPER_PROFILE_ENV_VAR]: "   ",
      },
      loader,
    );
    expect(resolution.status).toBe("resolved");
  });
});

describe("readDaemonHostBindingsSource", () => {
  it("reads the contents of a real file", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "bindings.json");
    fs.writeFileSync(file, VALID_HOST_BINDINGS_JSON, "utf8");
    const load = readDaemonHostBindingsSource(file);
    expect(load.ok).toBe(true);
    if (!load.ok) return;
    expect(load.contents).toBe(VALID_HOST_BINDINGS_JSON);
  });

  it("reports a failure for a missing file rather than throwing", () => {
    const dir = makeTempDir();
    const missing = path.join(dir, "does-not-exist.json");
    const load = readDaemonHostBindingsSource(missing);
    expect(load.ok).toBe(false);
    if (load.ok) return;
    expect(load.error.length).toBeGreaterThan(0);
  });

  it("resolves end to end from a real file through the default loader", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "bindings.json");
    fs.writeFileSync(file, VALID_HOST_BINDINGS_JSON, "utf8");
    const resolution = resolveDaemonHostBindings(
      { [DAEMON_HOST_BINDINGS_FILE_ENV_VAR]: file },
      { loadSource: readDaemonHostBindingsSource },
    );
    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    expect(resolution.bindings.bindings.has("implementation")).toBe(true);
  });
});

/**
 * Daemon pre-claim refusal through the real dispatch path: a native step the
 * resolved environment cannot serve must be refused BEFORE the scheduler
 * claims it. No dispatch lease, executor attempt, or round state may exist
 * afterwards - the before-mutation refusal contract.
 */
describe("daemon pre-claim host-binding refusal (real dispatch path)", () => {
  const NOW = 1_700_000_000_000;

  function initRepo(): string {
    const repoPath = makeTempDir("momentum-daemon-preclaim-repo-");
    execFileSync("git", ["-C", repoPath, "init", "--quiet"]);
    execFileSync("git", [
      "-C",
      repoPath,
      "config",
      "user.name",
      "Momentum Test",
    ]);
    execFileSync("git", [
      "-C",
      repoPath,
      "config",
      "user.email",
      "momentum@example.test",
    ]);
    fs.writeFileSync(path.join(repoPath, "README.md"), "fixture\n");
    execFileSync("git", ["-C", repoPath, "add", "README.md"]);
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

  function startApprovedRun(
    db: ReturnType<typeof openDb>,
    definition: WorkflowDefinition,
    runId: string,
    repoPath: string,
  ): void {
    persistWorkflowDefinition(db, definition, { now: NOW });
    persistWorkflowRunStart(db, {
      definition,
      runId,
      repoPath,
      objective: "Prove pre-claim host-binding refusal",
      now: NOW,
    });
    db.prepare(
      "UPDATE workflow_steps SET state = 'approved' WHERE run_id = ?",
    ).run(runId);
  }

  function assertNothingClaimed(
    db: ReturnType<typeof openDb>,
    runId: string,
  ): void {
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM workflow_leases WHERE run_id = ?",
        )
        .get(runId),
    ).toEqual({ count: 0 });
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
    expect(
      db
        .prepare("SELECT state FROM workflow_steps WHERE run_id = ?")
        .get(runId),
    ).toEqual({ state: "approved" });
  }

  it("refuses a pending delegate-supervisor step pre-claim when no bindings source is configured", async () => {
    const repoPath = initRepo();
    const db = openDb(makeTempDir("momentum-daemon-preclaim-data-"));
    const runId = "delegate-preclaim-run";
    startApprovedRun(
      db,
      {
        key: "daemon-preclaim-delegate",
        title: "Daemon Pre-Claim Delegate",
        version: 1,
        steps: [
          {
            key: "handoff",
            kind: "implementation",
            executor: "delegate-supervisor",
            config: { tool: "gnhf" },
            order: 0,
            required: true,
          },
        ],
      },
      runId,
      repoPath,
    );

    // No bindings source at all: the dogfood daemon lane stays available, but
    // a host-binding-required delegate step must be refused before claiming.
    const production = resolveDaemonWorkflowStepDispatch(
      {},
      executeWorkflowStepDispatch,
      {},
    );
    expect(production.ok, production.ok ? "" : production.message).toBe(true);
    if (!production.ok) return;
    expect(production.preClaim).toBeDefined();

    await expect(
      runWorkflowSchedulerOnceAsync({
        db,
        runId,
        workerId: "delegate-preclaim-worker",
        dispatch: production.dispatch,
        ...(production.preClaim === undefined
          ? {}
          : { preClaim: production.preClaim }),
        now: () => NOW + 1,
      }),
    ).rejects.toThrow(
      `${DAEMON_HOST_BINDINGS_FILE_ENV_VAR} is required for native delegate-supervisor host bindings`,
    );

    assertNothingClaimed(db, runId);
    db.close();
  });

  it("refuses pre-claim when a valid bindings file lacks the selected native step kind", async () => {
    const repoPath = initRepo();
    const configDir = makeTempDir("momentum-daemon-preclaim-bindings-");
    const bindingsPath = path.join(configDir, "host-bindings.json");
    // A resolvable, valid file - but it binds only `implementation`, not the
    // `preflight` kind the pending native step selects.
    fs.writeFileSync(bindingsPath, VALID_HOST_BINDINGS_JSON, "utf8");
    const db = openDb(makeTempDir("momentum-daemon-preclaim-data-"));
    const runId = "missing-binding-preclaim-run";
    startApprovedRun(
      db,
      {
        key: "daemon-preclaim-missing-binding",
        title: "Daemon Pre-Claim Missing Binding",
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
      },
      runId,
      repoPath,
    );

    const production = resolveDaemonWorkflowStepDispatch(
      { [DAEMON_HOST_BINDINGS_FILE_ENV_VAR]: bindingsPath },
      executeWorkflowStepDispatch,
      {},
    );
    expect(production.ok, production.ok ? "" : production.message).toBe(true);
    if (!production.ok) return;
    expect(production.preClaim).toBeDefined();

    await expect(
      runWorkflowSchedulerOnceAsync({
        db,
        runId,
        workerId: "missing-binding-preclaim-worker",
        dispatch: production.dispatch,
        ...(production.preClaim === undefined
          ? {}
          : { preClaim: production.preClaim }),
        now: () => NOW + 1,
      }),
    ).rejects.toThrow(
      "host bindings have no preflight binding for native agent-once",
    );

    assertNothingClaimed(db, runId);
    db.close();
  });
});
