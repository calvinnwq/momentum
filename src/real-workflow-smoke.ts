/**
 * Opt-in real coding-workflow harness smoke — planning and outcome
 * classification (NGX-372 / Adapter Test Coverage milestone).
 *
 * `src/real-smoke.ts` owns the opt-in real Linear *read* smoke. This sibling
 * module owns the CI-safe decision logic for the opt-in real *coding-workflow
 * harness* smoke: invoking a live OpenClaw wrapper (GNHF / postflight /
 * no-mistakes / merge-cleanup / linear-refresh) behind explicit operator flags.
 * Like its read-smoke sibling it never performs I/O — it only:
 *
 *   - decides whether the harness smoke may run at all, given operator-controlled
 *     environment variables and a configured live-wrapper profile
 *     (`planWorkflowHarnessSmoke`), and
 *   - maps a finished probe / harness run into a documented failure-mode
 *     taxonomy (`classifyWorkflowHarnessOutcome`).
 *
 * Live execution itself (spawning the engine, lease/heartbeat persistence,
 * result capture, the verification/commit transaction) stays owned by the
 * coding-workflow-pipeline skill and the live step wrapper / orchestrator
 * layers; this module is the gate, not the runner.
 *
 * Safety posture (mirrors the read smoke, per
 * internal/contracts/adapter-test-coverage.md):
 *   - The smoke is **skipped unless explicitly opted in**, so default CI never
 *     spawns an expensive external agent.
 *   - Real external **reads** stay separated from real external **writes**: the
 *     external-write family (`linear-refresh` -> `external-apply`) stays closed
 *     unless a *separate* write-policy opt-in is set, so a read-family harness
 *     smoke can never mutate an external system.
 *   - The default mode is the safe **probe-only dry-run**: it runs only the
 *     wrapper's cheap pre-flight probe (availability check) rather than spawning
 *     the full agent. Planning a full run requires an explicit operator flag.
 *   - Missing / malformed configuration fails closed (skip), never runs with
 *     bad input.
 */

import {
  CODING_WORKFLOW_DEFINITION,
  type WorkflowExecutorFamily
} from "./workflow-definition.js";
import {
  parseLiveWrapperProfile,
  resolveLiveWrapper,
  type LiveWrapperCwd,
  type LiveWrapperProbeConfig
} from "./live-wrapper-registry.js";
import {
  WORKFLOW_STEP_KINDS,
  type WorkflowStepKind
} from "./workflow-run-reducer.js";

/** Master opt-in switch. The real coding-workflow harness smoke skips unless truthy. */
export const REAL_SMOKE_WORKFLOW_OPT_IN_ENV_VAR = "MOMENTUM_REAL_SMOKE_WORKFLOW";
/** Selects which workflow step kind's live wrapper to smoke (e.g. "no-mistakes"). */
export const REAL_SMOKE_WORKFLOW_KIND_ENV_VAR = "MOMENTUM_REAL_SMOKE_WORKFLOW_KIND";
/** Opts into spawning the full harness; default is the safe probe-only dry-run. */
export const REAL_SMOKE_WORKFLOW_FULL_ENV_VAR = "MOMENTUM_REAL_SMOKE_WORKFLOW_FULL";
/** Separate write-policy opt-in required to smoke an external-write wrapper. */
export const REAL_SMOKE_WORKFLOW_ALLOW_WRITE_ENV_VAR =
  "MOMENTUM_REAL_SMOKE_WORKFLOW_ALLOW_WRITE";

export type WorkflowHarnessSmokeSkipReason =
  | "not_opted_in"
  | "profile_unavailable"
  | "kind_missing"
  | "unsupported_kind"
  | "not_configured"
  | "write_policy_closed"
  | "probe_unavailable";

export type WorkflowHarnessSmokePlan =
  | { mode: "skip"; reason: WorkflowHarnessSmokeSkipReason; detail: string }
  | {
      mode: "run";
      kind: WorkflowStepKind;
      family: WorkflowExecutorFamily | null;
      isExternalWrite: boolean;
      probeOnly: boolean;
      command: string;
      args: readonly string[];
      cwd: LiveWrapperCwd;
      timeoutSec: number;
      probe: LiveWrapperProbeConfig | null;
    };

const WORKFLOW_STEP_KIND_SET: ReadonlySet<string> = new Set(WORKFLOW_STEP_KINDS);

/**
 * Decide whether the opt-in real coding-workflow harness smoke may run, and with
 * what bounded parameters. Pure: reads only the provided environment snapshot
 * and the supplied raw live-wrapper profile value (parsed here so callers may
 * pass file contents without coupling this module to the filesystem).
 */
export function planWorkflowHarnessSmoke(
  env: Record<string, string | undefined>,
  rawProfile: unknown
): WorkflowHarnessSmokePlan {
  if (!isEnvFlagEnabled(env[REAL_SMOKE_WORKFLOW_OPT_IN_ENV_VAR])) {
    return {
      mode: "skip",
      reason: "not_opted_in",
      detail: `${REAL_SMOKE_WORKFLOW_OPT_IN_ENV_VAR} is not set; the real coding-workflow harness smoke stays off by default and never spawns an agent in CI.`
    };
  }

  const parsedProfile = parseLiveWrapperProfile(rawProfile);
  if (!parsedProfile.ok) {
    return {
      mode: "skip",
      reason: "profile_unavailable",
      detail: `A valid live-wrapper profile is required to resolve the harness command: ${parsedProfile.error}`
    };
  }

  const kind = (env[REAL_SMOKE_WORKFLOW_KIND_ENV_VAR] ?? "").trim();
  if (kind.length === 0) {
    return {
      mode: "skip",
      reason: "kind_missing",
      detail: `${REAL_SMOKE_WORKFLOW_KIND_ENV_VAR} must name the workflow step kind to smoke; supported kinds: ${WORKFLOW_STEP_KINDS.join(", ")}.`
    };
  }
  if (!WORKFLOW_STEP_KIND_SET.has(kind)) {
    return {
      mode: "skip",
      reason: "unsupported_kind",
      detail: `${REAL_SMOKE_WORKFLOW_KIND_ENV_VAR}="${kind}" is not a workflow step kind; supported kinds: ${WORKFLOW_STEP_KINDS.join(", ")}.`
    };
  }

  const resolved = resolveLiveWrapper(parsedProfile.profile, kind);
  if (!resolved.ok) {
    return {
      mode: "skip",
      reason: "not_configured",
      detail: resolved.error
    };
  }
  const config = resolved.config;

  const family = resolveStepKindExecutorFamily(resolved.kind);
  const isExternalWrite = family === "external-apply";
  if (isExternalWrite && !isEnvFlagEnabled(env[REAL_SMOKE_WORKFLOW_ALLOW_WRITE_ENV_VAR])) {
    return {
      mode: "skip",
      reason: "write_policy_closed",
      detail: `Step kind "${resolved.kind}" resolves to the external-write family "${family}"; set ${REAL_SMOKE_WORKFLOW_ALLOW_WRITE_ENV_VAR} to explicitly open the separate write policy before smoking a real external write.`
    };
  }

  const probeOnly = !isEnvFlagEnabled(env[REAL_SMOKE_WORKFLOW_FULL_ENV_VAR]);
  if (probeOnly && config.probe === undefined) {
    return {
      mode: "skip",
      reason: "probe_unavailable",
      detail: `The default probe-only dry-run needs a configured \`probe\` for step kind "${resolved.kind}"; configure one or set ${REAL_SMOKE_WORKFLOW_FULL_ENV_VAR} to opt into a full harness run.`
    };
  }

  return {
    mode: "run",
    kind: resolved.kind,
    family,
    isExternalWrite,
    probeOnly,
    command: config.command,
    args: config.args,
    cwd: config.cwd,
    timeoutSec: config.timeoutSec,
    probe: config.probe ?? null
  };
}

export type WorkflowHarnessSmokeFailureMode =
  | "tool_unavailable"
  | "timeout"
  | "command_failed"
  | "result_missing"
  | "result_invalid"
  | "harness_error";

/**
 * A finished probe / harness run, reduced to the facts the classifier needs.
 * The executing layer (operator harness / gated smoke test) produces this from
 * the spawned process result; this module owns only the taxonomy mapping.
 */
export type WorkflowHarnessRawOutcome =
  | { kind: "exited"; exitCode: number | null; signal: string | null }
  | { kind: "spawn_error"; code: string | null; message: string }
  | { kind: "timed_out"; timeoutSec: number }
  | { kind: "result_missing"; path: string }
  | { kind: "result_invalid"; path: string; reason: string };

export type WorkflowHarnessSmokeOutcome =
  | { ok: true }
  | {
      ok: false;
      mode: WorkflowHarnessSmokeFailureMode;
      code: string;
      detail: string;
    };

/**
 * Map a finished probe / harness run into the documented harness-smoke
 * failure-mode taxonomy. Pure: inspects only the supplied raw outcome.
 */
export function classifyWorkflowHarnessOutcome(
  raw: WorkflowHarnessRawOutcome
): WorkflowHarnessSmokeOutcome {
  switch (raw.kind) {
    case "exited": {
      if (raw.exitCode === 0 && raw.signal === null) {
        return { ok: true };
      }
      const detail =
        raw.signal !== null
          ? `harness process terminated by signal ${raw.signal}`
          : `harness process exited with code ${raw.exitCode}`;
      return { ok: false, mode: "command_failed", code: "harness_exit", detail };
    }
    case "spawn_error": {
      const code = raw.code ?? "";
      if (code === "ENOENT" || /\benoent\b/i.test(raw.message)) {
        return {
          ok: false,
          mode: "tool_unavailable",
          code: "harness_spawn_error",
          detail: `harness command is unavailable: ${raw.message}`
        };
      }
      return {
        ok: false,
        mode: "harness_error",
        code: "harness_spawn_error",
        detail: raw.message
      };
    }
    case "timed_out":
      return {
        ok: false,
        mode: "timeout",
        code: "harness_timeout",
        detail: `harness exceeded its ${raw.timeoutSec}s timeout`
      };
    case "result_missing":
      return {
        ok: false,
        mode: "result_missing",
        code: "harness_result_missing",
        detail: `harness produced no result document at ${raw.path}`
      };
    case "result_invalid":
      return {
        ok: false,
        mode: "result_invalid",
        code: "harness_result_invalid",
        detail: `harness result document at ${raw.path} is invalid: ${raw.reason}`
      };
  }
}

/**
 * The facts a finished `spawnSync` carries that the probe mapping needs: the
 * thrown/returned spawn error (with its optional errno `code`), the exit
 * `status`, and the terminating `signal`. The executing layer
 * (`src/real-workflow-probe.ts`) adapts a real `SpawnSyncReturns` into this
 * shape so this module stays I/O-free and exhaustively unit-testable.
 */
export type ProbeSpawnResult = {
  error: (Error & { code?: string }) | null;
  status: number | null;
  signal: string | null;
};

/**
 * Reduce a finished probe `spawnSync` into the `WorkflowHarnessRawOutcome` the
 * taxonomy classifier consumes. Pure: inspects only the supplied result. The
 * timeout detection mirrors the repo's canonical probe handling in
 * `src/acp-runner.ts` — a `spawnSync` timeout surfaces as an `ETIMEDOUT` error
 * (alongside a `SIGTERM` kill) rather than a plain non-zero exit.
 */
export function classifyProbeSpawnResult(
  result: ProbeSpawnResult,
  probe: { timeoutSec: number }
): WorkflowHarnessRawOutcome {
  if (result.error !== null) {
    const code = result.error.code ?? null;
    if (code === "ETIMEDOUT") {
      return { kind: "timed_out", timeoutSec: probe.timeoutSec };
    }
    return { kind: "spawn_error", code, message: result.error.message };
  }
  return { kind: "exited", exitCode: result.status, signal: result.signal };
}

function resolveStepKindExecutorFamily(
  kind: WorkflowStepKind
): WorkflowExecutorFamily | null {
  const step = CODING_WORKFLOW_DEFINITION.steps.find((entry) => entry.kind === kind);
  return step ? step.executor : null;
}

function isEnvFlagEnabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
