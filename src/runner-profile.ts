/**
 * Runner profile model and resolver introduced by NGX-280 (M4-01).
 *
 * Momentum core owns Goal/Iteration/Job state, the git transaction,
 * verification, and the artifact layout. A runner profile identifies how
 * the iteration prompt is executed and surfaces a safe summary for
 * operators. M4-01 ships the model only — no shell command is executed
 * here and the `MOMENTUM.md` loader stays a placeholder until a future
 * milestone proves it.
 */

export const BUILTIN_RUNNER_KINDS = ["fake", "trusted-shell"] as const;
export type BuiltinRunnerKind = (typeof BUILTIN_RUNNER_KINDS)[number];

export const DEFAULT_RUNNER_KIND: BuiltinRunnerKind = "fake";

export type RunnerProfileSource =
  | "cli_override"
  | "goal_frontmatter"
  | "builtin_default";

export type RunnerProfile = {
  kind: BuiltinRunnerKind;
  name: BuiltinRunnerKind;
  description: string;
  executes: boolean;
};

export type RunnerProfileErrorCode =
  | "unsupported_runner"
  | "malformed_profile";

export type RunnerProfileError = {
  ok: false;
  code: RunnerProfileErrorCode;
  error: string;
};

export type ParsedRunnerProfile = {
  ok: true;
  profile: RunnerProfile;
};

export type RunnerProfileParseResult = ParsedRunnerProfile | RunnerProfileError;

export type ResolveRunnerProfileInput = {
  cliOverride?: string | undefined;
  frontmatterValue?: unknown;
  builtinDefault?: BuiltinRunnerKind | undefined;
};

export type ResolveRunnerProfileSuccess = {
  ok: true;
  profile: RunnerProfile;
  source: RunnerProfileSource;
  rawValue: string;
};

export type ResolveRunnerProfileResult =
  | ResolveRunnerProfileSuccess
  | (RunnerProfileError & { source: RunnerProfileSource; rawValue: string });

export function isBuiltinRunnerKind(value: string): value is BuiltinRunnerKind {
  return (BUILTIN_RUNNER_KINDS as readonly string[]).includes(value);
}

export function buildRunnerProfile(kind: BuiltinRunnerKind): RunnerProfile {
  switch (kind) {
    case "fake":
      return {
        kind,
        name: kind,
        description:
          "Built-in in-process fake runner; writes a fixture file and no external command runs.",
        executes: false
      };
    case "trusted-shell":
      return {
        kind,
        name: kind,
        description:
          "Operator-trusted shell runner; identity recognized but no shell command executes in M4-01.",
        executes: false
      };
  }
}

export function parseRunnerProfile(
  rawValue: unknown
): RunnerProfileParseResult {
  if (typeof rawValue !== "string") {
    return {
      ok: false,
      code: "malformed_profile",
      error: `Runner profile must be a string; received ${describeType(rawValue)}.`
    };
  }
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      code: "malformed_profile",
      error: "Runner profile must be a non-empty string."
    };
  }
  if (!isBuiltinRunnerKind(trimmed)) {
    return {
      ok: false,
      code: "unsupported_runner",
      error: formatUnsupportedRunnerMessage(trimmed)
    };
  }
  return { ok: true, profile: buildRunnerProfile(trimmed) };
}

export function resolveRunnerProfile(
  input: ResolveRunnerProfileInput = {}
): ResolveRunnerProfileResult {
  const defaultKind = input.builtinDefault ?? DEFAULT_RUNNER_KIND;
  if (!isBuiltinRunnerKind(defaultKind)) {
    return {
      ok: false,
      code: "malformed_profile",
      source: "builtin_default",
      rawValue: String(defaultKind),
      error: `Built-in default runner ${String(defaultKind)} is not a supported runner kind.`
    };
  }

  const cli = sanitizeOptionalString(input.cliOverride);
  if (cli !== undefined) {
    return finalizeResolution(cli, "cli_override");
  }
  if (input.frontmatterValue !== undefined && input.frontmatterValue !== null) {
    return finalizeResolution(input.frontmatterValue, "goal_frontmatter");
  }
  return finalizeResolution(defaultKind, "builtin_default");
}

function finalizeResolution(
  rawValue: unknown,
  source: RunnerProfileSource
): ResolveRunnerProfileResult {
  const parsed = parseRunnerProfile(rawValue);
  const resolvedRawValue =
    typeof rawValue === "string" ? rawValue.trim() : String(rawValue);
  if (!parsed.ok) {
    return { ...parsed, source, rawValue: resolvedRawValue };
  }
  return {
    ok: true,
    profile: parsed.profile,
    source,
    rawValue: resolvedRawValue
  };
}

function sanitizeOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return String(value);
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed;
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function formatUnsupportedRunnerMessage(value: string): string {
  const known = BUILTIN_RUNNER_KINDS.join(", ");
  return `Unsupported runner profile "${value}". Supported runners: ${known}.`;
}

export function safeRunnerProfileSummary(
  profile: RunnerProfile
): { kind: BuiltinRunnerKind; name: BuiltinRunnerKind; description: string; executes: boolean } {
  return {
    kind: profile.kind,
    name: profile.name,
    description: profile.description,
    executes: profile.executes
  };
}
