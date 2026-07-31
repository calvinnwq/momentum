import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DAEMON_HOST_BINDINGS_FILE_ENV_VAR,
  RETIRED_LIVE_WRAPPER_PROFILE_ENV_VAR,
  readDaemonHostBindingsSource,
  resolveDaemonHostBindings,
  type DaemonHostBindingsSourceLoad,
} from "../src/core/workflow/live-wrapper/daemon-host-bindings.js";
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
