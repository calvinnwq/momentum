/**
 * Daemon-default live-wrapper profile source resolution.
 *
 * The production `WorkflowStepExecutor` default is real: with no
 * live-wrapper profile wired, every canonical kind resolves to the honest
 * `runtime_unavailable` adapter rather than a fabricated success
 * (`step/executor-real-adapters.ts`). The daemon can run dispatched
 * steps through a configured live command and feed the terminal evidence into the
 * reconciliation seam. The production lane is split across two focused pieces:
 *
 *   1. **profile source resolution** — how the daemon discovers a
 *      {@link LiveWrapperProfile} from operator configuration (this module); and
 *   2. **daemon-lane wiring** — registering profile-backed built-ins and
 *      resolving their host bindings for the bounded SDK dispatch driver.
 *
 * This module owns profile source resolution. It resolves the daemon's
 * live-wrapper profile from a single operator-controlled environment variable
 * ({@link DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR}) that names a JSON profile file,
 * matching the repo's `MOMENTUM_*` opt-in convention
 * (`MOMENTUM_DOGFOOD_TERMINALIZE_DISPATCH`, `MOMENTUM_REAL_SMOKE_WORKFLOW`). The
 * resolution is deliberately three-valued so the daemon-lane caller can stay
 * honest:
 *
 *   - **not_configured** — the env var is unset/blank. The default `daemon start`
 *     lane is unchanged; the caller keeps its existing base/dogfood dispatch
 *     behavior and does not synthesize a profile.
 *   - **resolved** — a readable, valid profile the lane can build a real executor
 *     registry from (`buildRealWorkflowStepExecutorRegistry`).
 *   - **invalid** — the env var is set but the source is unreadable, not JSON, or
 *     not a valid profile. Surfaced distinctly (never silently downgraded to a
 *     fabricated profile) so the lane can fail closed loudly rather than run a
 *     half-configured profile.
 *
 * The filesystem read is injected ({@link ResolveDaemonLiveWrapperProfileDeps})
 * so the decision logic stays a pure, exhaustively unit-testable function — the
 * same pure-decision / injected-IO split `smoke/workflow-harness.ts` (decision) and
 * `real-workflow-probe.ts` (IO) use. {@link readDaemonLiveWrapperProfileSource} is
 * the default real loader the daemon passes.
 */

import fs from "node:fs";

import {
  parseLiveWrapperProfile,
  type LiveWrapperProfile,
} from "../../../adapters/live-wrapper-registry.js";

/**
 * Operator-controlled environment variable naming the JSON file that holds the
 * daemon's live-wrapper profile. Unset/blank keeps the default daemon lane
 * unchanged. Mirrors the repo's other `MOMENTUM_*` runtime opt-in spellings.
 */
export const DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR =
  "MOMENTUM_LIVE_WRAPPER_PROFILE";

/** Why a configured profile source could not be turned into a valid profile. */
export type DaemonLiveWrapperProfileErrorCode =
  "source_unreadable" | "source_invalid_json" | "profile_invalid";

/**
 * The outcome of resolving the daemon's live-wrapper profile from the
 * environment. Total over the three operator situations the daemon lane must
 * distinguish (unconfigured / configured-and-valid / configured-but-broken).
 */
export type DaemonLiveWrapperProfileResolution =
  | { status: "not_configured" }
  | { status: "resolved"; source: string; profile: LiveWrapperProfile }
  | {
      status: "invalid";
      source: string;
      code: DaemonLiveWrapperProfileErrorCode;
      error: string;
    };

/** The result of attempting to load a profile source's raw contents. */
export type DaemonLiveWrapperProfileSourceLoad =
  { ok: true; contents: string } | { ok: false; error: string };

/** Injected IO seam: read a profile source path into its raw contents. */
export type ResolveDaemonLiveWrapperProfileDeps = {
  loadSource: (sourcePath: string) => DaemonLiveWrapperProfileSourceLoad;
};

/**
 * Resolve the daemon's live-wrapper profile from the supplied environment
 * snapshot. Pure with respect to the injected {@link ResolveDaemonLiveWrapperProfileDeps.loadSource}:
 * it reads only the env var and the source contents the loader returns, never the
 * real filesystem or process env directly. A blank/unset env var returns
 * `not_configured` without ever invoking the loader, so the default `daemon start`
 * lane is provably untouched.
 */
export function resolveDaemonLiveWrapperProfile(
  env: Record<string, string | undefined>,
  deps: ResolveDaemonLiveWrapperProfileDeps,
): DaemonLiveWrapperProfileResolution {
  const rawSourcePath = env[DAEMON_LIVE_WRAPPER_PROFILE_ENV_VAR];
  const source = (rawSourcePath ?? "").trim();
  if (source.length === 0) {
    return { status: "not_configured" };
  }

  const load = deps.loadSource(source);
  if (!load.ok) {
    return {
      status: "invalid",
      source,
      code: "source_unreadable",
      error: load.error,
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(load.contents);
  } catch (error) {
    return {
      status: "invalid",
      source,
      code: "source_invalid_json",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const parsedProfile = parseLiveWrapperProfile(parsedJson);
  if (!parsedProfile.ok) {
    return {
      status: "invalid",
      source,
      code: "profile_invalid",
      error: parsedProfile.error,
    };
  }

  return { status: "resolved", source, profile: parsedProfile.profile };
}

/**
 * Default real loader for {@link resolveDaemonLiveWrapperProfile}: read the
 * profile source file as UTF-8, reporting a read failure (e.g. a missing file) as
 * a typed `{ ok: false }` rather than throwing, so resolution stays total.
 */
export function readDaemonLiveWrapperProfileSource(
  sourcePath: string,
): DaemonLiveWrapperProfileSourceLoad {
  try {
    return { ok: true, contents: fs.readFileSync(sourcePath, "utf8") };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
