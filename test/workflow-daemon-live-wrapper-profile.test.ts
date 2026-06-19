import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR,
  readDaemonLiveWrapperProfileSource,
  resolveDaemonLiveWrapperProfile,
  type DaemonLiveWrapperProfileSourceLoad
} from "../src/core/workflow/daemon-live-wrapper-profile.js";
import { buildRealWorkflowStepExecutorRegistry } from "../src/core/workflow/step-executor-real-adapters.js";

/**
 * RC-5b (NGX-492): the daemon-default live-wrapper profile *source resolution*.
 *
 * This is the deferred "profile source" half of the RC-5b narrowing: a pure
 * resolver that turns the operator environment into either an absent profile
 * (the unchanged default daemon lane), a parsed {@link LiveWrapperProfile} the
 * daemon lane can build a real executor registry from, or an honest invalid
 * outcome so a misconfigured source never silently fabricates a profile. The
 * filesystem read is injected so the decision logic stays exhaustively
 * unit-testable, mirroring `planWorkflowHarnessSmoke`'s pure-decision pattern.
 */

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-daemon-profile-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

const VALID_PROFILE_JSON = JSON.stringify({
  name: "daemon-default",
  wrappers: {
    implementation: {
      command: "/bin/sh",
      args: ["-c", "true"],
      cwd: "iteration",
      timeout_sec: 30,
      env_allow: [],
      result_file: "result.json"
    }
  }
});

/** A loader that always succeeds with the supplied contents. */
function loaderReturning(
  contents: string
): { loadSource: (p: string) => DaemonLiveWrapperProfileSourceLoad; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    loadSource: (p: string) => {
      calls.push(p);
      return { ok: true, contents };
    }
  };
}

/** A loader that always fails, as if the file were missing/unreadable. */
function loaderFailing(error: string): {
  loadSource: (p: string) => DaemonLiveWrapperProfileSourceLoad;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    loadSource: (p: string) => {
      calls.push(p);
      return { ok: false, error };
    }
  };
}

describe("resolveDaemonLiveWrapperProfile", () => {
  it("returns not_configured when the env var is unset", () => {
    const loader = loaderReturning(VALID_PROFILE_JSON);
    const resolution = resolveDaemonLiveWrapperProfile({}, loader);
    expect(resolution.status).toBe("not_configured");
    // The default daemon lane must stay untouched: never read a source.
    expect(loader.calls).toEqual([]);
  });

  it("returns not_configured (and reads nothing) when the env var is blank", () => {
    const loader = loaderReturning(VALID_PROFILE_JSON);
    const resolution = resolveDaemonLiveWrapperProfile(
      { [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: "   " },
      loader
    );
    expect(resolution.status).toBe("not_configured");
    expect(loader.calls).toEqual([]);
  });

  it("resolves a parsed profile from a readable, valid source", () => {
    const loader = loaderReturning(VALID_PROFILE_JSON);
    const resolution = resolveDaemonLiveWrapperProfile(
      { [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: "/etc/momentum/profile.json" },
      loader
    );
    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    expect(resolution.source).toBe("/etc/momentum/profile.json");
    expect(resolution.profile.name).toBe("daemon-default");
    expect(resolution.profile.wrappers.has("implementation")).toBe(true);
  });

  it("trims the configured source path before reading it and echoes the trimmed path", () => {
    const loader = loaderReturning(VALID_PROFILE_JSON);
    const resolution = resolveDaemonLiveWrapperProfile(
      { [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: "  /etc/momentum/profile.json  " },
      loader
    );
    expect(loader.calls).toEqual(["/etc/momentum/profile.json"]);
    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    expect(resolution.source).toBe("/etc/momentum/profile.json");
  });

  it("returns invalid:source_unreadable when the source cannot be read", () => {
    const loader = loaderFailing("ENOENT: no such file");
    const resolution = resolveDaemonLiveWrapperProfile(
      { [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: "/missing/profile.json" },
      loader
    );
    expect(resolution.status).toBe("invalid");
    if (resolution.status !== "invalid") return;
    expect(resolution.code).toBe("source_unreadable");
    expect(resolution.source).toBe("/missing/profile.json");
    expect(resolution.error).toContain("ENOENT");
  });

  it("returns invalid:source_invalid_json when the source is not valid JSON", () => {
    const loader = loaderReturning("{ not json ");
    const resolution = resolveDaemonLiveWrapperProfile(
      { [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: "/etc/momentum/profile.json" },
      loader
    );
    expect(resolution.status).toBe("invalid");
    if (resolution.status !== "invalid") return;
    expect(resolution.code).toBe("source_invalid_json");
  });

  it("returns invalid:profile_invalid (surfacing the registry error) for valid JSON that is not a profile", () => {
    const loader = loaderReturning(JSON.stringify({ name: "broken" }));
    const resolution = resolveDaemonLiveWrapperProfile(
      { [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: "/etc/momentum/profile.json" },
      loader
    );
    expect(resolution.status).toBe("invalid");
    if (resolution.status !== "invalid") return;
    expect(resolution.code).toBe("profile_invalid");
    // The underlying parseLiveWrapperProfile message is preserved, not swallowed.
    expect(resolution.error).toContain("wrappers");
  });

  it("produces a profile that builds a configured real executor registry", () => {
    const loader = loaderReturning(VALID_PROFILE_JSON);
    const resolution = resolveDaemonLiveWrapperProfile(
      { [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: "/etc/momentum/profile.json" },
      loader
    );
    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    // The resolver output is exactly the input the daemon-lane wiring will feed
    // to the existing registry builder: the configured kind must be executing.
    const registry = buildRealWorkflowStepExecutorRegistry({
      profile: resolution.profile
    });
    const adapter = registry.get("implementation");
    expect(adapter?.executes).toBe(true);
  });
});

describe("readDaemonLiveWrapperProfileSource", () => {
  it("reads the contents of a real file", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "profile.json");
    fs.writeFileSync(file, VALID_PROFILE_JSON, "utf8");
    const load = readDaemonLiveWrapperProfileSource(file);
    expect(load.ok).toBe(true);
    if (!load.ok) return;
    expect(load.contents).toBe(VALID_PROFILE_JSON);
  });

  it("reports a failure for a missing file rather than throwing", () => {
    const dir = makeTempDir();
    const missing = path.join(dir, "does-not-exist.json");
    const load = readDaemonLiveWrapperProfileSource(missing);
    expect(load.ok).toBe(false);
    if (load.ok) return;
    expect(load.error.length).toBeGreaterThan(0);
  });

  it("resolves end to end from a real file through the default loader", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "profile.json");
    fs.writeFileSync(file, VALID_PROFILE_JSON, "utf8");
    const resolution = resolveDaemonLiveWrapperProfile(
      { [DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR]: file },
      { loadSource: readDaemonLiveWrapperProfileSource }
    );
    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    expect(resolution.profile.wrappers.has("implementation")).toBe(true);
  });
});
