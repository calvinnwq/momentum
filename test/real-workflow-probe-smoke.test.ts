import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { REAL_SMOKE_EVIDENCE_DIR_ENV_VAR } from "../src/core/executors/real-smoke.js";
import {
  REAL_SMOKE_WORKFLOW_KIND_ENV_VAR,
  REAL_SMOKE_WORKFLOW_OPT_IN_ENV_VAR,
  classifyWorkflowHarnessOutcome,
  planWorkflowHarnessSmoke
} from "../src/core/executors/real-workflow-smoke.js";
import {
  REAL_SMOKE_WORKFLOW_PROFILE_ENV_VAR,
  buildHarnessProbeEnv,
  loadRawWorkflowProfileFromEnv,
  runHarnessProbe
} from "../src/adapters/real-workflow-probe.js";

/**
 * NGX-372 opt-in real coding-workflow harness *probe* smoke (Adapter Test
 * Coverage milestone).
 *
 * `src/real-workflow-smoke.ts` owns the pure gate (`planWorkflowHarnessSmoke`)
 * and taxonomy (`classifyWorkflowHarnessOutcome`). This file owns the executing
 * layer: it actually spawns the resolved live-wrapper pre-flight probe.
 *
 * Two tiers live here, mirroring `test/real-linear-read-smoke.test.ts`:
 *   - **CI-safe** unit coverage of the execution helpers themselves
 *     (`runHarnessProbe`, `loadRawWorkflowProfileFromEnv`). These spawn only a
 *     cheap, local `process.execPath` (node) child or read a temp file, so they
 *     never reach an external system and always run.
 *   - The **opt-in real probe smoke**, skipped unless an operator points
 *     `MOMENTUM_REAL_SMOKE_WORKFLOW_PROFILE` at a live-wrapper profile and sets
 *     `MOMENTUM_REAL_SMOKE_WORKFLOW=1` (plus a `MOMENTUM_REAL_SMOKE_WORKFLOW_KIND`).
 *     It runs the configured wrapper's pre-flight probe (the safe probe-only
 *     dry-run), classifies the outcome, and records evidence under gitignored
 *     `.agent-runs/real-smoke/`.
 *
 * Manual run (probe-only dry-run of, e.g., the no-mistakes wrapper):
 *   MOMENTUM_REAL_SMOKE_WORKFLOW=1 \
 *   MOMENTUM_REAL_SMOKE_WORKFLOW_KIND=no-mistakes \
 *   MOMENTUM_REAL_SMOKE_WORKFLOW_PROFILE=/abs/path/to/live-wrappers.json \
 *     pnpm vitest run test/real-workflow-probe-smoke.test.ts
 *
 * External writes stay closed: a `linear-refresh` (external-apply) probe needs
 * the separate `MOMENTUM_REAL_SMOKE_WORKFLOW_ALLOW_WRITE=1` gate (enforced by
 * the planner), and this smoke runs only the cheap availability probe, never the
 * full agent (that needs `MOMENTUM_REAL_SMOKE_WORKFLOW_FULL=1`, out of scope here).
 */

const NODE = process.execPath;

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-ngx-372-probe-smoke-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function recordEvidence(label: string, payload: Record<string, unknown>): string {
  const baseDir =
    process.env[REAL_SMOKE_EVIDENCE_DIR_ENV_VAR]?.trim() ||
    path.join(process.cwd(), ".agent-runs", "real-smoke");
  fs.mkdirSync(baseDir, { recursive: true });
  const file = path.join(baseDir, `${label}-${Date.now()}.json`);
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  return file;
}

describe("runHarnessProbe (NGX-372)", () => {
  it("maps a clean local probe exit to an exited outcome the classifier accepts", () => {
    const raw = runHarnessProbe({
      command: NODE,
      args: ["-e", "process.exit(0)"],
      timeoutSec: 30
    });
    expect(raw).toEqual({ kind: "exited", exitCode: 0, signal: null });
    expect(classifyWorkflowHarnessOutcome(raw)).toEqual({ ok: true });
  });

  it("threads a non-zero probe exit code through to command_failed", () => {
    const raw = runHarnessProbe({
      command: NODE,
      args: ["-e", "process.exit(7)"],
      timeoutSec: 30
    });
    expect(raw).toEqual({ kind: "exited", exitCode: 7, signal: null });
    const outcome = classifyWorkflowHarnessOutcome(raw);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.mode).toBe("command_failed");
  });

  it("maps a missing probe binary to a tool_unavailable spawn error", () => {
    const raw = runHarnessProbe({
      command: "/momentum/ngx-372/definitely-not-a-real-binary",
      args: [],
      timeoutSec: 30
    });
    expect(raw.kind).toBe("spawn_error");
    if (raw.kind !== "spawn_error") throw new Error("expected spawn_error");
    expect(raw.code).toBe("ENOENT");
    const outcome = classifyWorkflowHarnessOutcome(raw);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.mode).toBe("tool_unavailable");
  });

  it("kills and reports a probe that exceeds its timeout", () => {
    const raw = runHarnessProbe({
      command: NODE,
      args: ["-e", "setTimeout(() => {}, 60000)"],
      timeoutSec: 1
    });
    expect(raw).toEqual({ kind: "timed_out", timeoutSec: 1 });
    const outcome = classifyWorkflowHarnessOutcome(raw);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.mode).toBe("timeout");
  });

  it("does not inherit parent env variables when no env is supplied", () => {
    const key = "MOMENTUM_SECRET_PROBE_TOKEN";
    const previous = process.env[key];
    process.env[key] = "secret";
    try {
      const raw = runHarnessProbe({
        command: NODE,
        args: ["-e", `process.exit(process.env.${key} ? 9 : 0)`],
        timeoutSec: 30
      });
      expect(raw).toEqual({ kind: "exited", exitCode: 0, signal: null });
    } finally {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  });
});

describe("buildHarnessProbeEnv (NGX-372)", () => {
  it("copies only variables named by the wrapper env allowlist", () => {
    expect(
      buildHarnessProbeEnv(["KEEP_ME", "ALSO_KEEP"], {
        KEEP_ME: "yes",
        ALSO_KEEP: "2",
        DROP_ME: "secret"
      })
    ).toEqual({ KEEP_ME: "yes", ALSO_KEEP: "2" });
  });
});

describe("loadRawWorkflowProfileFromEnv (NGX-372)", () => {
  it("returns undefined when the profile env var is unset", () => {
    expect(loadRawWorkflowProfileFromEnv({})).toBeUndefined();
  });

  it("parses the JSON profile document at the configured path", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "live-wrappers.json");
    const doc = { name: "smoke", wrappers: { "no-mistakes": { command: "/usr/bin/true" } } };
    fs.writeFileSync(file, JSON.stringify(doc));
    expect(
      loadRawWorkflowProfileFromEnv({
        [REAL_SMOKE_WORKFLOW_PROFILE_ENV_VAR]: file
      })
    ).toEqual(doc);
  });

  it("returns undefined when the configured profile path does not exist", () => {
    const dir = makeTempDir();
    expect(
      loadRawWorkflowProfileFromEnv({
        [REAL_SMOKE_WORKFLOW_PROFILE_ENV_VAR]: path.join(dir, "missing.json")
      })
    ).toBeUndefined();
  });

  it("returns undefined when the configured profile file is not valid JSON", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "broken.json");
    fs.writeFileSync(file, "{ not valid json");
    expect(
      loadRawWorkflowProfileFromEnv({
        [REAL_SMOKE_WORKFLOW_PROFILE_ENV_VAR]: file
      })
    ).toBeUndefined();
  });

  it("feeds a loaded profile into the planner so an opted-in run resolves a probe", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "live-wrappers.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        name: "smoke",
        wrappers: {
          "no-mistakes": {
            command: NODE,
            args: ["-e", "process.exit(0)"],
            cwd: "repo",
            timeout_sec: 60,
            env_allow: ["PATH"],
            result_file: "result.json",
            probe: { command: NODE, args: ["-e", "process.exit(0)"], timeout_sec: 5 }
          }
        }
      })
    );
    const env = {
      [REAL_SMOKE_WORKFLOW_OPT_IN_ENV_VAR]: "1",
      [REAL_SMOKE_WORKFLOW_KIND_ENV_VAR]: "no-mistakes",
      [REAL_SMOKE_WORKFLOW_PROFILE_ENV_VAR]: file
    };
    const plan = planWorkflowHarnessSmoke(env, loadRawWorkflowProfileFromEnv(env));
    expect(plan.mode).toBe("run");
    if (plan.mode !== "run") throw new Error("expected run");
    expect(plan.probeOnly).toBe(true);
    expect(plan.envAllow).toEqual(["PATH"]);
    expect(plan.probe).not.toBeNull();
  });
});

const smokePlan = planWorkflowHarnessSmoke(
  process.env,
  loadRawWorkflowProfileFromEnv(process.env)
);
const shouldRunProbeSmoke =
  smokePlan.mode === "run" && smokePlan.probeOnly && smokePlan.probe !== null;

describe.skipIf(!shouldRunProbeSmoke)(
  "NGX-372 opt-in real workflow harness probe smoke",
  () => {
    it("runs the resolved pre-flight probe and records evidence", () => {
      if (smokePlan.mode !== "run" || !smokePlan.probeOnly) {
        throw new Error("unreachable: skipIf guards the probe-only run mode");
      }
      if (smokePlan.probe === null) {
        throw new Error(
          "this smoke exercises the pre-flight probe; unset MOMENTUM_REAL_SMOKE_WORKFLOW_FULL or configure a `probe` for the chosen wrapper"
        );
      }

      const raw = runHarnessProbe(smokePlan.probe, {
        env: buildHarnessProbeEnv(smokePlan.envAllow)
      });
      const outcome = classifyWorkflowHarnessOutcome(raw);

      const evidencePath = recordEvidence("workflow-harness-probe", {
        issue: "NGX-372",
        smoke: "opt-in-real-workflow-harness-probe",
        kind: smokePlan.kind,
        family: smokePlan.family,
        isExternalWrite: smokePlan.isExternalWrite,
        probeOnly: smokePlan.probeOnly,
        probe: smokePlan.probe,
        raw,
        outcome
      });
      console.log(
        `[NGX-372 workflow harness probe smoke] kind=${smokePlan.kind} outcome=${JSON.stringify(outcome)} evidence=${evidencePath}`
      );

      expect(
        outcome.ok,
        `real harness probe failed: ${JSON.stringify(outcome)}`
      ).toBe(true);
    });
  }
);

// Always-on guard so this file is never silently a no-op: it asserts the probe
// smoke is correctly gated off whenever the opt-in switch is absent, even if a
// profile path is configured.
describe("NGX-372 real workflow harness probe smoke gating", () => {
  it("stays opt-in: no run plan without the explicit opt-in switch", () => {
    const offPlan = planWorkflowHarnessSmoke(
      {
        [REAL_SMOKE_WORKFLOW_OPT_IN_ENV_VAR]: undefined,
        [REAL_SMOKE_WORKFLOW_KIND_ENV_VAR]: "no-mistakes"
      },
      { name: "smoke", wrappers: { "no-mistakes": { command: "/usr/bin/true" } } }
    );
    expect(offPlan.mode).toBe("skip");
    if (offPlan.mode !== "skip") throw new Error("expected skip");
    expect(offPlan.reason).toBe("not_opted_in");
  });
});
