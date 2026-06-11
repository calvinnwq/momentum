import { describe, expect, it } from "vitest";

import {
  REAL_SMOKE_WORKFLOW_ALLOW_WRITE_ENV_VAR,
  REAL_SMOKE_WORKFLOW_FULL_ENV_VAR,
  REAL_SMOKE_WORKFLOW_KIND_ENV_VAR,
  REAL_SMOKE_WORKFLOW_OPT_IN_ENV_VAR,
  classifyProbeSpawnResult,
  classifyWorkflowHarnessOutcome,
  planWorkflowHarnessSmoke,
  type ProbeSpawnResult
} from "../src/real-workflow-smoke.js";

/**
 * NGX-372 opt-in real coding-workflow harness smoke — pure planner / classifier.
 *
 * These tests pin the CI-safe decision logic that gates the real coding-workflow
 * harness smoke (preflight / implementation (GNHF) / postflight / no-mistakes /
 * merge-cleanup / linear-refresh): skip unless explicitly opted in with a
 * configured live-wrapper profile, keep the
 * external-write family (linear-refresh) closed unless a separate write policy
 * is opened, default to the safe probe-only dry-run, and map a finished harness
 * outcome into the documented failure-mode taxonomy. No process is spawned.
 */

type RawWrapper = Record<string, unknown>;

function wrapper(overrides: RawWrapper = {}): RawWrapper {
  return {
    command: "/usr/bin/true",
    args: ["--run"],
    cwd: "repo",
    timeout_sec: 60,
    env_allow: ["PATH"],
    result_file: "result.json",
    probe: { command: "/usr/bin/true", args: ["--version"], timeout_sec: 10 },
    ...overrides
  };
}

function profile(
  wrappers: Record<string, RawWrapper> = {
    "no-mistakes": wrapper(),
    "linear-refresh": wrapper()
  }
): unknown {
  return { name: "smoke", wrappers };
}

function optedInEnv(
  overrides: Record<string, string | undefined> = {}
): Record<string, string | undefined> {
  return {
    [REAL_SMOKE_WORKFLOW_OPT_IN_ENV_VAR]: "1",
    [REAL_SMOKE_WORKFLOW_KIND_ENV_VAR]: "no-mistakes",
    ...overrides
  };
}

describe("planWorkflowHarnessSmoke (NGX-372)", () => {
  it("skips with not_opted_in when the opt-in flag is unset", () => {
    const plan = planWorkflowHarnessSmoke(
      { [REAL_SMOKE_WORKFLOW_KIND_ENV_VAR]: "no-mistakes" },
      profile()
    );
    expect(plan.mode).toBe("skip");
    if (plan.mode !== "skip") throw new Error("expected skip");
    expect(plan.reason).toBe("not_opted_in");
  });

  it("skips with not_opted_in for falsy opt-in flag strings", () => {
    for (const value of ["0", "false", "no", "off", ""]) {
      const plan = planWorkflowHarnessSmoke(
        optedInEnv({ [REAL_SMOKE_WORKFLOW_OPT_IN_ENV_VAR]: value }),
        profile()
      );
      expect(plan.mode, `value=${JSON.stringify(value)}`).toBe("skip");
      if (plan.mode !== "skip") throw new Error("expected skip");
      expect(plan.reason).toBe("not_opted_in");
    }
  });

  it("skips with profile_unavailable when no profile is supplied", () => {
    const plan = planWorkflowHarnessSmoke(optedInEnv(), undefined);
    expect(plan.mode).toBe("skip");
    if (plan.mode !== "skip") throw new Error("expected skip");
    expect(plan.reason).toBe("profile_unavailable");
  });

  it("skips with profile_unavailable when the profile is invalid", () => {
    const plan = planWorkflowHarnessSmoke(optedInEnv(), {
      name: "",
      wrappers: {}
    });
    expect(plan.mode).toBe("skip");
    if (plan.mode !== "skip") throw new Error("expected skip");
    expect(plan.reason).toBe("profile_unavailable");
  });

  it("skips with kind_missing when no step kind is requested", () => {
    const plan = planWorkflowHarnessSmoke(
      { [REAL_SMOKE_WORKFLOW_OPT_IN_ENV_VAR]: "1" },
      profile()
    );
    expect(plan.mode).toBe("skip");
    if (plan.mode !== "skip") throw new Error("expected skip");
    expect(plan.reason).toBe("kind_missing");
  });

  it("skips with unsupported_kind when the requested kind is not a workflow step kind", () => {
    const plan = planWorkflowHarnessSmoke(
      optedInEnv({ [REAL_SMOKE_WORKFLOW_KIND_ENV_VAR]: "frobnicate" }),
      profile()
    );
    expect(plan.mode).toBe("skip");
    if (plan.mode !== "skip") throw new Error("expected skip");
    expect(plan.reason).toBe("unsupported_kind");
  });

  it("skips with not_configured when the kind is valid but absent from the profile", () => {
    const plan = planWorkflowHarnessSmoke(
      optedInEnv({ [REAL_SMOKE_WORKFLOW_KIND_ENV_VAR]: "postflight" }),
      profile({ "no-mistakes": wrapper() })
    );
    expect(plan.mode).toBe("skip");
    if (plan.mode !== "skip") throw new Error("expected skip");
    expect(plan.reason).toBe("not_configured");
  });

  it("runs a probe-only dry-run by default for a configured read-family kind", () => {
    const plan = planWorkflowHarnessSmoke(optedInEnv(), profile());
    expect(plan.mode).toBe("run");
    if (plan.mode !== "run") throw new Error("expected run");
    expect(plan.kind).toBe("no-mistakes");
    expect(plan.family).toBe("no-mistakes");
    expect(plan.isExternalWrite).toBe(false);
    expect(plan.probeOnly).toBe(true);
    expect(plan.command).toBe("/usr/bin/true");
    expect(plan.args).toEqual(["--run"]);
    expect(plan.envAllow).toEqual(["PATH"]);
    expect(plan.probe).toEqual({
      command: "/usr/bin/true",
      args: ["--version"],
      timeoutSec: 10
    });
  });

  it("skips with probe_unavailable when probe-only is requested but no probe is configured", () => {
    const plan = planWorkflowHarnessSmoke(
      optedInEnv(),
      profile({ "no-mistakes": wrapper({ probe: undefined }) })
    );
    expect(plan.mode).toBe("skip");
    if (plan.mode !== "skip") throw new Error("expected skip");
    expect(plan.reason).toBe("probe_unavailable");
  });

  it("plans a full harness run without a probe when the full flag is set", () => {
    const plan = planWorkflowHarnessSmoke(
      optedInEnv({ [REAL_SMOKE_WORKFLOW_FULL_ENV_VAR]: "1" }),
      profile({ "no-mistakes": wrapper({ probe: undefined }) })
    );
    expect(plan.mode).toBe("run");
    if (plan.mode !== "run") throw new Error("expected run");
    expect(plan.probeOnly).toBe(false);
    expect(plan.probe).toBeNull();
  });

  it("keeps the external-write family closed without the write opt-in", () => {
    const plan = planWorkflowHarnessSmoke(
      optedInEnv({ [REAL_SMOKE_WORKFLOW_KIND_ENV_VAR]: "linear-refresh" }),
      profile()
    );
    expect(plan.mode).toBe("skip");
    if (plan.mode !== "skip") throw new Error("expected skip");
    expect(plan.reason).toBe("write_policy_closed");
  });

  it("opens the external-write family only when the separate write opt-in is set", () => {
    const plan = planWorkflowHarnessSmoke(
      optedInEnv({
        [REAL_SMOKE_WORKFLOW_KIND_ENV_VAR]: "linear-refresh",
        [REAL_SMOKE_WORKFLOW_ALLOW_WRITE_ENV_VAR]: "1"
      }),
      profile()
    );
    expect(plan.mode).toBe("run");
    if (plan.mode !== "run") throw new Error("expected run");
    expect(plan.kind).toBe("linear-refresh");
    expect(plan.family).toBe("external-apply");
    expect(plan.isExternalWrite).toBe(true);
  });
});

describe("classifyWorkflowHarnessOutcome (NGX-372)", () => {
  it("reports ok when the process exits zero with no signal", () => {
    expect(
      classifyWorkflowHarnessOutcome({ kind: "exited", exitCode: 0, signal: null })
    ).toEqual({ ok: true });
  });

  it("classifies a non-zero exit as command_failed", () => {
    const outcome = classifyWorkflowHarnessOutcome({
      kind: "exited",
      exitCode: 2,
      signal: null
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.mode).toBe("command_failed");
  });

  it("classifies a terminating signal as command_failed", () => {
    const outcome = classifyWorkflowHarnessOutcome({
      kind: "exited",
      exitCode: null,
      signal: "SIGKILL"
    });
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.mode).toBe("command_failed");
  });

  it("classifies an ENOENT spawn error as tool_unavailable", () => {
    const outcome = classifyWorkflowHarnessOutcome({
      kind: "spawn_error",
      code: "ENOENT",
      message: "spawn /usr/bin/gnhf ENOENT"
    });
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.mode).toBe("tool_unavailable");
  });

  it("classifies an unrecognized spawn error as harness_error", () => {
    const outcome = classifyWorkflowHarnessOutcome({
      kind: "spawn_error",
      code: "EPIPE",
      message: "write EPIPE"
    });
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.mode).toBe("harness_error");
  });

  it("classifies a timeout as timeout", () => {
    const outcome = classifyWorkflowHarnessOutcome({
      kind: "timed_out",
      timeoutSec: 60
    });
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.mode).toBe("timeout");
  });

  it("classifies a missing result document as result_missing", () => {
    const outcome = classifyWorkflowHarnessOutcome({
      kind: "result_missing",
      path: "result.json"
    });
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.mode).toBe("result_missing");
  });

  it("classifies a malformed result document as result_invalid", () => {
    const outcome = classifyWorkflowHarnessOutcome({
      kind: "result_invalid",
      path: "result.json",
      reason: "not valid JSON"
    });
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.mode).toBe("result_invalid");
  });
});

describe("classifyProbeSpawnResult (NGX-372)", () => {
  const probe = { timeoutSec: 30 };

  it("maps a clean zero exit to an exited outcome", () => {
    const raw = classifyProbeSpawnResult(
      { error: null, status: 0, signal: null },
      probe
    );
    expect(raw).toEqual({ kind: "exited", exitCode: 0, signal: null });
    // ...and the existing classifier treats a clean exit as success.
    expect(classifyWorkflowHarnessOutcome(raw)).toEqual({ ok: true });
  });

  it("threads a non-zero exit code through as an exited outcome", () => {
    const raw = classifyProbeSpawnResult(
      { error: null, status: 7, signal: null },
      probe
    );
    expect(raw).toEqual({ kind: "exited", exitCode: 7, signal: null });
    const outcome = classifyWorkflowHarnessOutcome(raw);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.mode).toBe("command_failed");
  });

  it("threads a terminating signal through as an exited outcome", () => {
    const raw = classifyProbeSpawnResult(
      { error: null, status: null, signal: "SIGKILL" },
      probe
    );
    expect(raw).toEqual({ kind: "exited", exitCode: null, signal: "SIGKILL" });
    const outcome = classifyWorkflowHarnessOutcome(raw);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.mode).toBe("command_failed");
  });

  it("maps an ETIMEDOUT spawn error to timed_out using the probe timeout", () => {
    const result: ProbeSpawnResult = {
      error: Object.assign(new Error("spawnSync /bin/sleep ETIMEDOUT"), {
        code: "ETIMEDOUT"
      }),
      status: null,
      signal: "SIGTERM"
    };
    const raw = classifyProbeSpawnResult(result, { timeoutSec: 45 });
    expect(raw).toEqual({ kind: "timed_out", timeoutSec: 45 });
    const outcome = classifyWorkflowHarnessOutcome(raw);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.mode).toBe("timeout");
  });

  it("maps an ENOENT spawn error to a spawn_error outcome", () => {
    const result: ProbeSpawnResult = {
      error: Object.assign(new Error("spawn /usr/bin/gnhf ENOENT"), {
        code: "ENOENT"
      }),
      status: null,
      signal: null
    };
    const raw = classifyProbeSpawnResult(result, probe);
    expect(raw).toEqual({
      kind: "spawn_error",
      code: "ENOENT",
      message: "spawn /usr/bin/gnhf ENOENT"
    });
    const outcome = classifyWorkflowHarnessOutcome(raw);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.mode).toBe("tool_unavailable");
  });

  it("maps an unrecognized spawn error to a spawn_error outcome with its code", () => {
    const result: ProbeSpawnResult = {
      error: Object.assign(new Error("spawn EACCES"), { code: "EACCES" }),
      status: null,
      signal: null
    };
    const raw = classifyProbeSpawnResult(result, probe);
    expect(raw).toEqual({
      kind: "spawn_error",
      code: "EACCES",
      message: "spawn EACCES"
    });
    const outcome = classifyWorkflowHarnessOutcome(raw);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.mode).toBe("harness_error");
  });

  it("normalizes a spawn error with no errno code to a null code", () => {
    const result: ProbeSpawnResult = {
      error: new Error("opaque spawn failure"),
      status: null,
      signal: null
    };
    const raw = classifyProbeSpawnResult(result, probe);
    expect(raw).toEqual({
      kind: "spawn_error",
      code: null,
      message: "opaque spawn failure"
    });
  });
});
