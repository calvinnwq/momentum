import path from "node:path";

import {
  WORKFLOW_STEP_KINDS,
  type WorkflowStepKind
} from "../core/workflow/run/reducer.js";

/**
 * Live workflow-step wrapper configuration and registry.
 *
 * Momentum invokes live workflow steps that wrap the existing
 * OpenClaw engines (GNHF, postflight, no-mistakes, merge-cleanup,
 * linear-refresh). The M9-00 decision gate pinned a *wrapper registry keyed by
 * `WorkflowStepKind`* whose entries resolve from durable per-profile
 * configuration rather than hard-coded local paths.
 *
 * This module owns only the typed-config + registry-resolution layer:
 *
 *   - `parseLiveWrapperConfig` validates a single wrapper spec (explicit
 *     absolute `command`, argv `args`, `cwd`, raw `timeout_sec`,
 *     `env_allow`, `result_file`, and an optional pre-flight `probe`).
 *     Durable snake_case keys are canonical; camelCase aliases are accepted
 *     as transitional input while M9 wrappers settle.
 *   - `parseLiveWrapperProfile` validates a named profile whose `wrappers`
 *     mapping is keyed by `WorkflowStepKind`.
 *   - `resolveLiveWrapper` resolves the wrapper config for a requested step
 *     kind, refusing unknown or unconfigured kinds instead of guessing.
 *
 * It does NOT execute anything: spawning the live engines, lease/heartbeat
 * persistence, result-file capture, and verification/commit transactions are
 * composed by the live step wrapper / executor / orchestrator layers. Missing
 * or malformed configuration refuses here, before any workflow state is
 * mutated, per SPEC.md.
 */

export type LiveWrapperCwd = "repo" | "iteration";

export type LiveWrapperProbeConfig = {
  command: string;
  args: readonly string[];
  timeoutSec: number;
};

export type LiveWrapperConfig = {
  command: string;
  args: readonly string[];
  cwd: LiveWrapperCwd;
  timeoutSec: number;
  envAllow: readonly string[];
  resultFile: string;
  probe: LiveWrapperProbeConfig | undefined;
};

export type LiveWrapperProfile = {
  name: string;
  wrappers: ReadonlyMap<WorkflowStepKind, LiveWrapperConfig>;
};

/**
 * Stable refusal vocabulary for the live wrapper config + registry layer.
 * These are configuration-time refusals, distinct from the execution-time
 * recovery taxonomy (`runtime_unavailable`, `command_failed`, ...) mapped by
 * the live process execution layers.
 */
export const LIVE_WRAPPER_REFUSAL_CODES = [
  "live_wrapper_config_missing",
  "live_wrapper_config_invalid",
  "live_wrapper_profile_missing",
  "live_wrapper_profile_invalid",
  "live_wrapper_unsupported_kind",
  "live_wrapper_not_configured"
] as const;

export type LiveWrapperRefusalCode = (typeof LIVE_WRAPPER_REFUSAL_CODES)[number];

export type LiveWrapperConfigErrorCode =
  | "live_wrapper_config_missing"
  | "live_wrapper_config_invalid";

export type LiveWrapperProfileErrorCode =
  | "live_wrapper_profile_missing"
  | "live_wrapper_profile_invalid";

export type LiveWrapperResolveErrorCode =
  | "live_wrapper_unsupported_kind"
  | "live_wrapper_not_configured";

export type LiveWrapperConfigError = {
  ok: false;
  code: LiveWrapperConfigErrorCode;
  error: string;
};

export type LiveWrapperConfigSuccess = {
  ok: true;
  config: LiveWrapperConfig;
};

export type LiveWrapperConfigParse =
  | LiveWrapperConfigSuccess
  | LiveWrapperConfigError;

export type LiveWrapperProfileError = {
  ok: false;
  code: LiveWrapperProfileErrorCode;
  error: string;
};

export type LiveWrapperProfileSuccess = {
  ok: true;
  profile: LiveWrapperProfile;
};

export type LiveWrapperProfileParse =
  | LiveWrapperProfileSuccess
  | LiveWrapperProfileError;

export type LiveWrapperResolveError = {
  ok: false;
  code: LiveWrapperResolveErrorCode;
  error: string;
};

export type LiveWrapperResolveSuccess = {
  ok: true;
  kind: WorkflowStepKind;
  config: LiveWrapperConfig;
};

export type LiveWrapperResolveResult =
  | LiveWrapperResolveSuccess
  | LiveWrapperResolveError;

export const DEFAULT_LIVE_WRAPPER_PROBE_TIMEOUT_SEC = 30;

const WORKFLOW_STEP_KIND_SET: ReadonlySet<string> = new Set(WORKFLOW_STEP_KINDS);

function isWorkflowStepKind(value: string): value is WorkflowStepKind {
  return WORKFLOW_STEP_KIND_SET.has(value);
}

export function parseLiveWrapperConfig(value: unknown): LiveWrapperConfigParse {
  if (value === undefined || value === null) {
    return {
      ok: false,
      code: "live_wrapper_config_missing",
      error:
        "Live wrapper config is missing; a wrapper requires at least an absolute `command`."
    };
  }
  if (!isRecord(value)) {
    return configInvalid(
      "Live wrapper config must be a mapping with at least a `command` field."
    );
  }

  const commandResult = parseAbsoluteCommand(value["command"], "command");
  if (!commandResult.ok) return commandResult;
  const command = commandResult.value;

  const argsResult = parseRequiredStringArray(value["args"], "args");
  if (!argsResult.ok) return argsResult;
  const args = argsResult.value;

  const cwdResult = parseCwd(value["cwd"]);
  if (!cwdResult.ok) return cwdResult;
  const cwd = cwdResult.value;

  const timeoutResult = parseRequiredTimeoutSec(
    readAlias(value, "timeout_sec", "timeoutSec"),
    "timeout_sec"
  );
  if (!timeoutResult.ok) return timeoutResult;
  const timeoutSec = timeoutResult.value;

  const envAllowResult = parseEnvAllow(
    readAlias(value, "env_allow", "envAllow")
  );
  if (!envAllowResult.ok) return envAllowResult;
  const envAllow = envAllowResult.value;

  const resultFileResult = parseResultFile(
    readAlias(value, "result_file", "resultFile")
  );
  if (!resultFileResult.ok) return resultFileResult;
  const resultFile = resultFileResult.value;

  const probeResult = parseProbe(value["probe"]);
  if (!probeResult.ok) return probeResult;
  const probe = probeResult.value;

  return {
    ok: true,
    config: { command, args, cwd, timeoutSec, envAllow, resultFile, probe }
  };
}

export function parseLiveWrapperProfile(
  value: unknown
): LiveWrapperProfileParse {
  if (value === undefined || value === null) {
    return {
      ok: false,
      code: "live_wrapper_profile_missing",
      error:
        "Live wrapper profile is missing; configure a `name` and at least one wrapper keyed by workflow step kind."
    };
  }
  if (!isRecord(value)) {
    return profileInvalid(
      "Live wrapper profile must be a mapping with `name` and `wrappers` fields."
    );
  }

  const rawName = value["name"];
  if (typeof rawName !== "string" || rawName.trim().length === 0) {
    return profileInvalid(
      "Live wrapper profile `name` is required and must be a non-empty string."
    );
  }
  const name = rawName.trim();

  const rawWrappers = value["wrappers"];
  if (rawWrappers === undefined || rawWrappers === null) {
    return profileInvalid(
      "Live wrapper profile `wrappers` is required and must map workflow step kinds to wrapper configs."
    );
  }
  if (!isRecord(rawWrappers)) {
    return profileInvalid(
      "Live wrapper profile `wrappers` must be a mapping keyed by workflow step kind."
    );
  }

  const entries = Object.entries(rawWrappers);
  if (entries.length === 0) {
    return profileInvalid(
      `Live wrapper profile "${name}" must configure at least one wrapper.`
    );
  }

  const wrappers = new Map<WorkflowStepKind, LiveWrapperConfig>();
  for (const [kind, rawConfig] of entries) {
    if (!isWorkflowStepKind(kind)) {
      return profileInvalid(
        `Live wrapper profile "${name}" has an unknown workflow step kind "${kind}"; supported kinds: ${WORKFLOW_STEP_KINDS.join(", ")}.`
      );
    }
    const parsed = parseLiveWrapperConfig(rawConfig);
    if (!parsed.ok) {
      return profileInvalid(
        `Live wrapper profile "${name}" wrapper "${kind}" is invalid: ${parsed.error}`
      );
    }
    wrappers.set(kind, parsed.config);
  }

  return { ok: true, profile: { name, wrappers } };
}

export function resolveLiveWrapper(
  profile: LiveWrapperProfile,
  kind: string
): LiveWrapperResolveResult {
  if (!isWorkflowStepKind(kind)) {
    return {
      ok: false,
      code: "live_wrapper_unsupported_kind",
      error: `Live wrapper kind "${kind}" is not a workflow step kind; supported kinds: ${WORKFLOW_STEP_KINDS.join(", ")}.`
    };
  }
  const config = profile.wrappers.get(kind);
  if (config === undefined) {
    return {
      ok: false,
      code: "live_wrapper_not_configured",
      error: `Live wrapper profile "${profile.name}" has no wrapper configured for step kind "${kind}".`
    };
  }
  return { ok: true, kind, config };
}

export function listConfiguredLiveWrapperKinds(
  profile: LiveWrapperProfile
): readonly WorkflowStepKind[] {
  return WORKFLOW_STEP_KINDS.filter((kind) => profile.wrappers.has(kind));
}

function parseAbsoluteCommand(
  raw: unknown,
  field: "command" | "probe.command"
): { ok: true; value: string } | LiveWrapperConfigError {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return configInvalid(
      `Live wrapper \`${field}\` is required and must be a non-empty string.`
    );
  }
  const value = raw.trim();
  if (!path.isAbsolute(value)) {
    return configInvalid(
      `Live wrapper \`${field}\` must be an absolute executable path.`
    );
  }
  return { ok: true, value };
}

function parseStringArray(
  raw: unknown,
  field: "args" | "probe.args"
): { ok: true; value: string[] } | LiveWrapperConfigError {
  if (raw === undefined || raw === null) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(raw)) {
    return configInvalid(
      `Live wrapper \`${field}\` must be an array of strings or numbers.`
    );
  }
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    if (typeof entry === "string") {
      out.push(entry);
    } else if (typeof entry === "number") {
      out.push(String(entry));
    } else {
      return configInvalid(
        `Live wrapper \`${field}[${i}]\` must be a string or number.`
      );
    }
  }
  return { ok: true, value: out };
}

function parseRequiredStringArray(
  raw: unknown,
  field: "args"
): { ok: true; value: string[] } | LiveWrapperConfigError {
  if (raw === undefined || raw === null) {
    return configInvalid(
      `Live wrapper \`${field}\` is required and must be an array of strings or numbers.`
    );
  }
  return parseStringArray(raw, field);
}

function readAlias(
  record: Record<string, unknown>,
  canonicalKey: string,
  aliasKey: string
): unknown {
  return record[canonicalKey] ?? record[aliasKey];
}

function parseEnvAllow(
  raw: unknown
): { ok: true; value: string[] } | LiveWrapperConfigError {
  if (raw === undefined || raw === null) {
    return configInvalid(
      "Live wrapper `env_allow` is required and must be an array of environment variable names."
    );
  }
  if (!Array.isArray(raw)) {
    return configInvalid(
      "Live wrapper `env_allow` must be an array of environment variable names."
    );
  }
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    if (typeof entry !== "string" || !isValidEnvName(entry)) {
      return configInvalid(
        `Live wrapper \`env_allow[${i}]\` must be a valid environment variable name.`
      );
    }
    out.push(entry);
  }
  return { ok: true, value: out };
}

function parseCwd(
  raw: unknown
): { ok: true; value: LiveWrapperCwd } | LiveWrapperConfigError {
  if (raw === undefined || raw === null) {
    return configInvalid(
      'Live wrapper `cwd` is required and must be "repo" or "iteration".'
    );
  }
  if (raw !== "repo" && raw !== "iteration") {
    return configInvalid('Live wrapper `cwd` must be "repo" or "iteration".');
  }
  return { ok: true, value: raw };
}

function parseRequiredTimeoutSec(
  raw: unknown,
  field: "timeout_sec" | "probe.timeout_sec"
): { ok: true; value: number } | LiveWrapperConfigError {
  if (raw === undefined || raw === null) {
    return configInvalid(
      `Live wrapper \`${field}\` is required and must be a positive integer (seconds).`
    );
  }
  if (!isPositiveInteger(raw)) {
    return configInvalid(
      `Live wrapper \`${field}\` must be a positive integer (seconds).`
    );
  }
  return { ok: true, value: raw };
}

function parseOptionalTimeoutSec(
  raw: unknown,
  field: "probe.timeout_sec"
): { ok: true; value: number | undefined } | LiveWrapperConfigError {
  if (raw === undefined || raw === null) {
    return { ok: true, value: undefined };
  }
  if (!isPositiveInteger(raw)) {
    return configInvalid(
      `Live wrapper \`${field}\` must be a positive integer (seconds).`
    );
  }
  return { ok: true, value: raw };
}

function parseResultFile(
  raw: unknown
): { ok: true; value: string } | LiveWrapperConfigError {
  if (raw === undefined || raw === null) {
    return configInvalid(
      "Live wrapper `result_file` is required and must be a relative path inside the iteration artifact directory."
    );
  }
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return configInvalid(
      "Live wrapper `result_file` must be a non-empty string."
    );
  }
  const value = raw.trim();
  const normalized = path.posix.normalize(value.replace(/\\/g, "/"));
  if (
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    hasParentTraversalSegment(value) ||
    normalized === "." ||
    normalized === "./"
  ) {
    return configInvalid(
      "Live wrapper `result_file` must be a relative path inside the iteration artifact directory."
    );
  }
  return { ok: true, value };
}

function parseProbe(
  raw: unknown
): { ok: true; value: LiveWrapperProbeConfig | undefined } | LiveWrapperConfigError {
  if (raw === undefined || raw === null) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(raw)) {
    return configInvalid(
      "Live wrapper `probe` must be a mapping with at least a `command` field, or omitted entirely."
    );
  }

  const commandResult = parseAbsoluteCommand(raw["command"], "probe.command");
  if (!commandResult.ok) return commandResult;

  const argsResult = parseStringArray(raw["args"], "probe.args");
  if (!argsResult.ok) return argsResult;

  const timeoutResult = parseOptionalTimeoutSec(
    readAlias(raw, "timeout_sec", "timeoutSec"),
    "probe.timeout_sec"
  );
  if (!timeoutResult.ok) return timeoutResult;

  return {
    ok: true,
    value: {
      command: commandResult.value,
      args: argsResult.value,
      timeoutSec: timeoutResult.value ?? DEFAULT_LIVE_WRAPPER_PROBE_TIMEOUT_SEC
    }
  };
}

function isPositiveInteger(raw: unknown): raw is number {
  return (
    typeof raw === "number" &&
    Number.isInteger(raw) &&
    Number.isFinite(raw) &&
    raw > 0
  );
}

function hasParentTraversalSegment(value: string): boolean {
  return value.split(/[\\/]+/u).includes("..");
}

function isValidEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function configInvalid(message: string): LiveWrapperConfigError {
  return { ok: false, code: "live_wrapper_config_invalid", error: message };
}

function profileInvalid(message: string): LiveWrapperProfileError {
  return { ok: false, code: "live_wrapper_profile_invalid", error: message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
