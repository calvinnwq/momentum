import path from "node:path";

import { isPortableScriptCommandIdentity } from "../core/executors/sdk/portable-command.js";
import {
  WORKFLOW_STEP_KINDS,
  type WorkflowStepKind,
} from "../core/workflow/run/reducer.js";
import { canonicalWorkflowStepKind } from "../core/workflow/definition/legacy.js";
import { MAX_BUILT_IN_PROCESS_TIMEOUT_SEC } from "../shared/process-limits.js";

/**
 * Machine-local host-binding configuration and registry.
 *
 * Momentum invokes live workflow steps through machine-local executable
 * bindings. The runtime uses a *binding registry keyed by `WorkflowStepKind`*
 * whose entries resolve from the operator's host-binding file rather than
 * hard-coded local paths.
 *
 * This module owns only the typed-config + registry-resolution layer:
 *
 *   - `parseHostBinding` validates a single binding (explicit absolute
 *     `command`, argv `args`, `cwd`, bounded `timeout_sec`, `env_allow`,
 *     `result_file`, and an optional pre-flight `probe`). Durable snake_case
 *     keys are canonical; the retired transitional camelCase aliases
 *     (`timeoutSec`, `envAllow`, `resultFile`, `probe.timeoutSec`) are
 *     rejected whenever present.
 *   - `parseHostBindings` validates the strict top-level `{ "bindings": ... }`
 *     document whose mapping is keyed by `WorkflowStepKind`.
 *     The retired live-wrapper profile shape (`name` / `wrappers`) is refused
 *     with a precise migration diagnostic, never read as a fallback.
 *   - `resolveHostBinding` resolves the binding for a requested step kind,
 *     refusing unknown or unconfigured kinds instead of guessing.
 *
 * It does NOT execute anything: spawning the bound commands, lease/heartbeat
 * persistence, result-file capture, and verification/commit transactions are
 * composed by the live step wrapper / executor / orchestrator layers. Missing
 * or malformed configuration refuses here, before any workflow state is
 * mutated, per SPEC.md.
 */

export type HostBindingCwd = "repo" | "iteration";

export type HostBindingProbeConfig = {
  command: string;
  args: readonly string[];
  timeoutSec: number;
};

export type HostBindingConfig = {
  commandIdentity?: string;
  command: string;
  args: readonly string[];
  cwd: HostBindingCwd;
  timeoutSec: number;
  envAllow: readonly string[];
  resultFile: string;
  probe: HostBindingProbeConfig | undefined;
};

export type HostBindings = {
  bindings: ReadonlyMap<WorkflowStepKind, HostBindingConfig>;
};

/**
 * Stable refusal vocabulary for the host-binding config + registry layer.
 * These are configuration-time refusals, distinct from the execution-time
 * recovery taxonomy (`runtime_unavailable`, `command_failed`, ...) mapped by
 * the live process execution layers.
 */
export const HOST_BINDING_REFUSAL_CODES = [
  "host_binding_missing",
  "host_binding_invalid",
  "host_bindings_missing",
  "host_bindings_invalid",
  "host_binding_unsupported_kind",
  "host_binding_not_configured",
] as const;

export type HostBindingRefusalCode =
  (typeof HOST_BINDING_REFUSAL_CODES)[number];

export type HostBindingConfigErrorCode =
  "host_binding_missing" | "host_binding_invalid";

export type HostBindingsErrorCode =
  "host_bindings_missing" | "host_bindings_invalid";

export type HostBindingResolveErrorCode =
  "host_binding_unsupported_kind" | "host_binding_not_configured";

export type HostBindingConfigError = {
  ok: false;
  code: HostBindingConfigErrorCode;
  error: string;
};

export type HostBindingConfigSuccess = {
  ok: true;
  config: HostBindingConfig;
};

export type HostBindingConfigParse =
  HostBindingConfigSuccess | HostBindingConfigError;

export type HostBindingsError = {
  ok: false;
  code: HostBindingsErrorCode;
  error: string;
};

export type HostBindingsSuccess = {
  ok: true;
  bindings: HostBindings;
};

export type HostBindingsParse = HostBindingsSuccess | HostBindingsError;

export type HostBindingResolveError = {
  ok: false;
  code: HostBindingResolveErrorCode;
  error: string;
};

export type HostBindingResolveSuccess = {
  ok: true;
  kind: WorkflowStepKind;
  config: HostBindingConfig;
};

export type HostBindingResolveResult =
  HostBindingResolveSuccess | HostBindingResolveError;

export const DEFAULT_HOST_BINDING_PROBE_TIMEOUT_SEC = 30;

export function parseHostBinding(value: unknown): HostBindingConfigParse {
  if (value === undefined || value === null) {
    return {
      ok: false,
      code: "host_binding_missing",
      error:
        "Host binding is missing; a binding requires at least an absolute `command`.",
    };
  }
  if (!isRecord(value)) {
    return configInvalid(
      "Host binding must be a mapping with at least a `command` field.",
    );
  }

  // Retired aliases are refused before any field validation so the
  // whenever-present diagnostic is deterministic even for malformed input.
  const aliasError =
    rejectDeprecatedAlias(value, "timeoutSec", "timeout_sec") ??
    rejectDeprecatedAlias(value, "envAllow", "env_allow") ??
    rejectDeprecatedAlias(value, "resultFile", "result_file");
  if (aliasError) return aliasError;

  const commandResult = parseAbsoluteCommand(value["command"], "command");
  if (!commandResult.ok) return commandResult;
  const command = commandResult.value;
  const rawCommandIdentity = value["command_identity"];
  if (
    rawCommandIdentity !== undefined &&
    !isPortableScriptCommandIdentity(rawCommandIdentity)
  ) {
    return configInvalid(
      "Host binding `command_identity` must be a portable command identity.",
    );
  }
  const commandIdentity = rawCommandIdentity as string | undefined;

  const argsResult = parseRequiredStringArray(value["args"], "args");
  if (!argsResult.ok) return argsResult;
  const args = argsResult.value;

  const cwdResult = parseCwd(value["cwd"]);
  if (!cwdResult.ok) return cwdResult;
  const cwd = cwdResult.value;

  const timeoutResult = parseRequiredTimeoutSec(
    value["timeout_sec"],
    "timeout_sec",
  );
  if (!timeoutResult.ok) return timeoutResult;
  const timeoutSec = timeoutResult.value;

  const envAllowResult = parseEnvAllow(value["env_allow"]);
  if (!envAllowResult.ok) return envAllowResult;
  const envAllow = envAllowResult.value;

  const resultFileResult = parseResultFile(value["result_file"]);
  if (!resultFileResult.ok) return resultFileResult;
  const resultFile = resultFileResult.value;

  const probeResult = parseProbe(value["probe"]);
  if (!probeResult.ok) return probeResult;
  const probe = probeResult.value;

  return {
    ok: true,
    config: {
      ...(commandIdentity !== undefined ? { commandIdentity } : {}),
      command,
      args,
      cwd,
      timeoutSec,
      envAllow,
      resultFile,
      probe,
    },
  };
}

export function parseHostBindings(value: unknown): HostBindingsParse {
  if (value === undefined || value === null) {
    return {
      ok: false,
      code: "host_bindings_missing",
      error:
        "Host bindings are missing; configure a strict top-level `bindings` mapping keyed by workflow step kind.",
    };
  }
  if (!isRecord(value)) {
    return bindingsInvalid(
      "Host bindings must be a mapping with a single top-level `bindings` field.",
    );
  }

  // The retired live-wrapper profile shape must never be read as a fallback:
  // refuse it with a precise migration diagnostic before anything else.
  if ("wrappers" in value) {
    return bindingsInvalid(
      "Host bindings use the strict top-level `bindings` mapping; the retired profile `wrappers` shape is not read. Move each entry under a top-level `bindings` key and remove the profile `name`.",
    );
  }
  const unknownKey = Object.keys(value).find((key) => key !== "bindings");
  if (unknownKey !== undefined) {
    return bindingsInvalid(
      `Host bindings have an unknown top-level key "${unknownKey}"; the strict shape has a single top-level \`bindings\` mapping.`,
    );
  }

  const rawBindings = value["bindings"];
  if (rawBindings === undefined || rawBindings === null) {
    return bindingsInvalid(
      "Host bindings `bindings` is required and must map workflow step kinds to binding configs.",
    );
  }
  if (!isRecord(rawBindings)) {
    return bindingsInvalid(
      "Host bindings `bindings` must be a mapping keyed by workflow step kind.",
    );
  }

  const entries = Object.entries(rawBindings);
  if (entries.length === 0) {
    return bindingsInvalid(
      "Host bindings must configure at least one binding.",
    );
  }

  const selectedBindings = new Map<
    WorkflowStepKind,
    { rawKind: string; rawConfig: unknown }
  >();
  for (const [kind, rawConfig] of entries) {
    const canonicalKind = canonicalWorkflowStepKind(kind);
    if (canonicalKind === undefined) {
      return bindingsInvalid(
        `Host bindings have an unknown workflow step kind "${kind}"; supported kinds: ${WORKFLOW_STEP_KINDS.join(", ")}.`,
      );
    }
    const existing = selectedBindings.get(canonicalKind);
    if (existing?.rawKind === canonicalKind) continue;
    selectedBindings.set(canonicalKind, { rawKind: kind, rawConfig });
  }

  const bindings = new Map<WorkflowStepKind, HostBindingConfig>();
  for (const [kind, selected] of selectedBindings) {
    const parsed = parseHostBinding(selected.rawConfig);
    if (!parsed.ok) {
      return bindingsInvalid(
        `Host binding "${selected.rawKind}" is invalid: ${parsed.error}`,
      );
    }
    bindings.set(kind, parsed.config);
  }

  return { ok: true, bindings: { bindings } };
}

export function resolveHostBinding(
  hostBindings: HostBindings,
  kind: string,
): HostBindingResolveResult {
  const canonicalKind = canonicalWorkflowStepKind(kind);
  if (canonicalKind === undefined) {
    return {
      ok: false,
      code: "host_binding_unsupported_kind",
      error: `Host binding kind "${kind}" is not a workflow step kind; supported kinds: ${WORKFLOW_STEP_KINDS.join(", ")}.`,
    };
  }
  const config = hostBindings.bindings.get(canonicalKind);
  if (config === undefined) {
    return {
      ok: false,
      code: "host_binding_not_configured",
      error: `Host bindings have no binding configured for step kind "${kind}".`,
    };
  }
  return { ok: true, kind: canonicalKind, config };
}

export function listConfiguredHostBindingKinds(
  hostBindings: HostBindings,
): readonly WorkflowStepKind[] {
  return WORKFLOW_STEP_KINDS.filter((kind) => hostBindings.bindings.has(kind));
}

function parseAbsoluteCommand(
  raw: unknown,
  field: "command" | "probe.command",
): { ok: true; value: string } | HostBindingConfigError {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return configInvalid(
      `Host binding \`${field}\` is required and must be a non-empty string.`,
    );
  }
  const value = raw.trim();
  if (!path.isAbsolute(value)) {
    return configInvalid(
      `Host binding \`${field}\` must be an absolute executable path.`,
    );
  }
  return { ok: true, value };
}

function parseStringArray(
  raw: unknown,
  field: "args" | "probe.args",
): { ok: true; value: string[] } | HostBindingConfigError {
  if (raw === undefined || raw === null) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(raw)) {
    return configInvalid(
      `Host binding \`${field}\` must be an array of strings or numbers.`,
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
        `Host binding \`${field}[${i}]\` must be a string or number.`,
      );
    }
  }
  return { ok: true, value: out };
}

function parseRequiredStringArray(
  raw: unknown,
  field: "args",
): { ok: true; value: string[] } | HostBindingConfigError {
  if (raw === undefined || raw === null) {
    return configInvalid(
      `Host binding \`${field}\` is required and must be an array of strings or numbers.`,
    );
  }
  return parseStringArray(raw, field);
}

/**
 * Refuse a retired transitional camelCase alias whenever it is present in
 * serialized binding input, even alongside its canonical snake_case key, so
 * durable configs cannot keep leaning on the removed alias vocabulary.
 */
function rejectDeprecatedAlias(
  record: Record<string, unknown>,
  aliasKey: "timeoutSec" | "envAllow" | "resultFile",
  canonicalKey: "timeout_sec" | "env_allow" | "result_file",
  fieldPrefix = "",
): HostBindingConfigError | undefined {
  if (!(aliasKey in record)) return undefined;
  return configInvalid(
    `Host binding \`${fieldPrefix}${aliasKey}\` is a removed deprecated alias; use the canonical \`${fieldPrefix}${canonicalKey}\` key.`,
  );
}

function parseEnvAllow(
  raw: unknown,
): { ok: true; value: string[] } | HostBindingConfigError {
  if (raw === undefined || raw === null) {
    return configInvalid(
      "Host binding `env_allow` is required and must be an array of environment variable names.",
    );
  }
  if (!Array.isArray(raw)) {
    return configInvalid(
      "Host binding `env_allow` must be an array of environment variable names.",
    );
  }
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    if (typeof entry !== "string" || !isValidEnvName(entry)) {
      return configInvalid(
        `Host binding \`env_allow[${i}]\` must be a valid environment variable name.`,
      );
    }
    out.push(entry);
  }
  return { ok: true, value: out };
}

function parseCwd(
  raw: unknown,
): { ok: true; value: HostBindingCwd } | HostBindingConfigError {
  if (raw === undefined || raw === null) {
    return configInvalid(
      'Host binding `cwd` is required and must be "repo" or "iteration".',
    );
  }
  if (raw !== "repo" && raw !== "iteration") {
    return configInvalid('Host binding `cwd` must be "repo" or "iteration".');
  }
  return { ok: true, value: raw };
}

function parseRequiredTimeoutSec(
  raw: unknown,
  field: "timeout_sec" | "probe.timeout_sec",
): { ok: true; value: number } | HostBindingConfigError {
  if (raw === undefined || raw === null) {
    return configInvalid(
      `Host binding \`${field}\` is required and must be a positive integer (seconds).`,
    );
  }
  if (!isPositiveInteger(raw)) {
    return configInvalid(
      `Host binding \`${field}\` must be a positive integer (seconds).`,
    );
  }
  if (raw > MAX_BUILT_IN_PROCESS_TIMEOUT_SEC) {
    return configInvalid(
      `Host binding \`${field}\` must not exceed ${MAX_BUILT_IN_PROCESS_TIMEOUT_SEC} seconds.`,
    );
  }
  return { ok: true, value: raw };
}

function parseOptionalTimeoutSec(
  raw: unknown,
  field: "probe.timeout_sec",
): { ok: true; value: number | undefined } | HostBindingConfigError {
  if (raw === undefined || raw === null) {
    return { ok: true, value: undefined };
  }
  if (!isPositiveInteger(raw)) {
    return configInvalid(
      `Host binding \`${field}\` must be a positive integer (seconds).`,
    );
  }
  if (raw > MAX_BUILT_IN_PROCESS_TIMEOUT_SEC) {
    return configInvalid(
      `Host binding \`${field}\` must not exceed ${MAX_BUILT_IN_PROCESS_TIMEOUT_SEC} seconds.`,
    );
  }
  return { ok: true, value: raw };
}

function parseResultFile(
  raw: unknown,
): { ok: true; value: string } | HostBindingConfigError {
  if (raw === undefined || raw === null) {
    return configInvalid(
      "Host binding `result_file` is required and must be a relative path inside the iteration artifact directory.",
    );
  }
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return configInvalid(
      "Host binding `result_file` must be a non-empty string.",
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
      "Host binding `result_file` must be a relative path inside the iteration artifact directory.",
    );
  }
  return { ok: true, value };
}

function parseProbe(
  raw: unknown,
):
  | { ok: true; value: HostBindingProbeConfig | undefined }
  | HostBindingConfigError {
  if (raw === undefined || raw === null) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(raw)) {
    return configInvalid(
      "Host binding `probe` must be a mapping with at least a `command` field, or omitted entirely.",
    );
  }

  // Same whenever-present guarantee as the top-level aliases: refuse before
  // probe field validation so a malformed probe still names the alias.
  const aliasError = rejectDeprecatedAlias(
    raw,
    "timeoutSec",
    "timeout_sec",
    "probe.",
  );
  if (aliasError) return aliasError;

  const commandResult = parseAbsoluteCommand(raw["command"], "probe.command");
  if (!commandResult.ok) return commandResult;

  const argsResult = parseStringArray(raw["args"], "probe.args");
  if (!argsResult.ok) return argsResult;

  const timeoutResult = parseOptionalTimeoutSec(
    raw["timeout_sec"],
    "probe.timeout_sec",
  );
  if (!timeoutResult.ok) return timeoutResult;

  return {
    ok: true,
    value: {
      command: commandResult.value,
      args: argsResult.value,
      timeoutSec: timeoutResult.value ?? DEFAULT_HOST_BINDING_PROBE_TIMEOUT_SEC,
    },
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

function configInvalid(message: string): HostBindingConfigError {
  return { ok: false, code: "host_binding_invalid", error: message };
}

function bindingsInvalid(message: string): HostBindingsError {
  return { ok: false, code: "host_bindings_invalid", error: message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
