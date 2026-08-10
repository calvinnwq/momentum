/**
 * Daemon host-binding source resolution.
 *
 * The production `WorkflowStepExecutor` default is real: with no host
 * bindings wired, every canonical kind resolves to the honest
 * `runtime_unavailable` adapter rather than a fabricated success
 * (`step/executor-real-adapters.ts`). The daemon can run dispatched
 * steps through a configured live command and feed the terminal evidence into
 * the reconciliation seam. The production lane is split across two focused
 * pieces:
 *
 *   1. **host-binding source resolution** — how the daemon discovers
 *      {@link HostBindings} from operator configuration (this module); and
 *   2. **daemon-lane wiring** — registering binding-backed built-ins and
 *      resolving their host bindings for the bounded SDK dispatch driver.
 *
 * This module owns host-binding source resolution. It resolves the daemon's
 * host bindings from a single operator-controlled environment variable
 * ({@link DAEMON_HOST_BINDINGS_FILE_ENV_VAR}) that names a JSON host-binding
 * file, matching the repo's `MOMENTUM_*` opt-in convention
 * (`MOMENTUM_DOGFOOD_TERMINALIZE_DISPATCH`, `MOMENTUM_REAL_SMOKE_WORKFLOW`).
 * The resolution is deliberately three-valued so the daemon-lane caller can
 * stay honest:
 *
 *   - **not_configured** — the env var is unset/blank. The default `daemon start`
 *     lane is unchanged; the caller keeps its existing base/dogfood dispatch
 *     behavior and does not synthesize bindings.
 *   - **resolved** — a readable, valid host-binding file the lane can build a
 *     real executor registry from (`buildRealWorkflowStepExecutorRegistry`).
 *   - **invalid** — the configuration is set but broken: the source is
 *     unreadable, not JSON, or not valid host bindings, or the retired
 *     `MOMENTUM_LIVE_WRAPPER_PROFILE` selector is still present. Surfaced
 *     distinctly (never silently downgraded to fabricated bindings or a
 *     fallback source) so the lane can fail closed loudly rather than run a
 *     half-configured host.
 *
 * The retired live-wrapper-profile selector is refused whenever present: its
 * value is never read as a source, no fallback is consulted, and the
 * diagnostic names {@link DAEMON_HOST_BINDINGS_FILE_ENV_VAR} so the operator
 * can migrate precisely.
 *
 * The filesystem read is injected ({@link ResolveDaemonHostBindingsDeps})
 * so the decision logic stays a pure, exhaustively unit-testable function — the
 * same pure-decision / injected-IO split `smoke/workflow-harness.ts` (decision)
 * and `real-workflow-probe.ts` (IO) use. {@link readDaemonHostBindingsSource}
 * is the default real loader the daemon passes.
 */

import fs from "node:fs";

import {
  parseHostBindings,
  type HostBindings,
} from "../../../adapters/host-bindings-registry.js";

/**
 * Operator-controlled environment variable naming the JSON file that holds the
 * daemon's machine-local host bindings. Unset/blank keeps the default daemon
 * lane unchanged. Mirrors the repo's other `MOMENTUM_*` runtime opt-in
 * spellings.
 */
export const DAEMON_HOST_BINDINGS_FILE_ENV_VAR = "MOMENTUM_HOST_BINDINGS_FILE";

/**
 * The retired live-wrapper-profile selector. It is detected only so its
 * presence can refuse with a precise migration diagnostic; its value is never
 * read as a configuration source.
 */
export const RETIRED_LIVE_WRAPPER_PROFILE_ENV_VAR =
  "MOMENTUM_LIVE_WRAPPER_PROFILE";

const DAEMON_HOST_BINDINGS_SOURCE_MAX_BYTES = 1024 * 1024;

/** Why configured host bindings could not be resolved. */
export type DaemonHostBindingsErrorCode =
  | "source_unreadable"
  | "source_invalid_json"
  | "host_bindings_invalid"
  | "retired_selector";

/**
 * The outcome of resolving the daemon's host bindings from the environment.
 * Total over the operator situations the daemon lane must distinguish
 * (unconfigured / configured-and-valid / configured-but-broken, including the
 * retired selector).
 */
export type DaemonHostBindingsResolution =
  | { status: "not_configured" }
  | { status: "resolved"; source: string; bindings: HostBindings }
  | {
      status: "invalid";
      source: string;
      code: DaemonHostBindingsErrorCode;
      error: string;
    };

/** The result of attempting to load a host-binding source's raw contents. */
export type DaemonHostBindingsSourceLoad =
  { ok: true; contents: string } | { ok: false; error: string };

/** Injected IO seam: read a host-binding source path into its raw contents. */
export type ResolveDaemonHostBindingsDeps = {
  loadSource: (sourcePath: string) => DaemonHostBindingsSourceLoad;
};

/**
 * Resolve the daemon's host bindings from the supplied environment snapshot.
 * Pure with respect to the injected {@link ResolveDaemonHostBindingsDeps.loadSource}:
 * it reads only the env vars and the source contents the loader returns, never
 * the real filesystem or process env directly. A blank/unset env var returns
 * `not_configured` without ever invoking the loader, so the default
 * `daemon start` lane is provably untouched. A present retired
 * `MOMENTUM_LIVE_WRAPPER_PROFILE` selector refuses before any source is
 * consulted.
 */
export function resolveDaemonHostBindings(
  env: Record<string, string | undefined>,
  deps: ResolveDaemonHostBindingsDeps,
): DaemonHostBindingsResolution {
  const retired = (env[RETIRED_LIVE_WRAPPER_PROFILE_ENV_VAR] ?? "").trim();
  if (retired.length > 0) {
    return {
      status: "invalid",
      source: RETIRED_LIVE_WRAPPER_PROFILE_ENV_VAR,
      code: "retired_selector",
      error:
        `${RETIRED_LIVE_WRAPPER_PROFILE_ENV_VAR} is retired and is no longer read. ` +
        `Unset it and set ${DAEMON_HOST_BINDINGS_FILE_ENV_VAR} to a host-binding JSON file ` +
        'using the strict top-level { "bindings": { ... } } shape.',
    };
  }

  const rawSourcePath = env[DAEMON_HOST_BINDINGS_FILE_ENV_VAR];
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

  const parsed = parseHostBindings(parsedJson);
  if (!parsed.ok) {
    return {
      status: "invalid",
      source,
      code: "host_bindings_invalid",
      error: parsed.error,
    };
  }
  // The daemon never consults a tracker-refresh binding: that step is owned by
  // the policy-gated external-apply adapter. Accepting one here would mislead
  // operators into believing its command is authoritative, so the daemon
  // selector refuses it instead of silently ignoring it.
  if (parsed.bindings.bindings.has("tracker-refresh")) {
    return {
      status: "invalid",
      source,
      code: "host_bindings_invalid",
      error:
        'Host bindings must not configure "tracker-refresh" (or the legacy "linear-refresh" spelling); that step is owned by the policy-gated external-apply adapter, not a host-bound command.',
    };
  }

  return { status: "resolved", source, bindings: parsed.bindings };
}

/**
 * Default real loader for {@link resolveDaemonHostBindings}: read the
 * host-binding source file as UTF-8, reporting a read failure (e.g. a missing
 * file) as a typed `{ ok: false }` rather than throwing, so resolution stays
 * total.
 */
export function readDaemonHostBindingsSource(
  sourcePath: string,
): DaemonHostBindingsSourceLoad {
  try {
    const stat = fs.statSync(sourcePath);
    if (!stat.isFile()) {
      return {
        ok: false,
        error: "host-bindings source is not a regular file",
      };
    }
    if (stat.size > DAEMON_HOST_BINDINGS_SOURCE_MAX_BYTES) {
      return {
        ok: false,
        error:
          `host-bindings source exceeds ${DAEMON_HOST_BINDINGS_SOURCE_MAX_BYTES} bytes`,
      };
    }
    return { ok: true, contents: fs.readFileSync(sourcePath, "utf8") };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
