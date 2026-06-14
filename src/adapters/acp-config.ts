import path from "node:path";

/**
 * ACP runner configuration introduced by NGX-283 (M4-04).
 *
 * The `acp` runner profile is a smoke harness around the existing
 * `RunnerAdapter` boundary for ACP/acpx-style external agent runtimes.
 * Momentum core continues to own Goal/Iteration/Job state, the git
 * transaction, verification, and the artifact layout. The adapter only
 * spawns the configured runtime, detects whether the runtime is available
 * (pre-flight probe), and reports a normalized `RunnerResult`.
 *
 * Like `trusted-shell`, the runtime command runs with the privileges of
 * the Momentum invoker. There is no sandbox and no privilege drop. The
 * operator is responsible for what the configured runtime can do.
 */

export type AcpCwd = "repo" | "iteration";

export type AcpProbeConfig = {
  command: string;
  args: readonly string[];
  timeoutSec: number;
};

export type AcpConfig = {
  command: string;
  args: readonly string[];
  cwd: AcpCwd;
  timeoutSec: number;
  env: Readonly<Record<string, string>>;
  envAllow: readonly string[];
  resultFile: string;
  probe: AcpProbeConfig | undefined;
};

export type AcpConfigErrorCode = "acp_config_missing" | "acp_config_invalid";

export type AcpConfigError = {
  ok: false;
  code: AcpConfigErrorCode;
  error: string;
};

export type AcpConfigSuccess = {
  ok: true;
  config: AcpConfig;
};

export type AcpConfigParse = AcpConfigSuccess | AcpConfigError;

export const DEFAULT_ACP_TIMEOUT_SEC = 900;
export const DEFAULT_ACP_PROBE_TIMEOUT_SEC = 30;
export const DEFAULT_ACP_CWD: AcpCwd = "repo";
export const DEFAULT_ACP_RESULT_FILE = "result.json";

export function parseAcpConfig(value: unknown): AcpConfigParse {
  if (value === undefined || value === null) {
    return {
      ok: false,
      code: "acp_config_missing",
      error:
        "Goal frontmatter is missing an `acp` block; the acp runner requires at least `acp.command`."
    };
  }
  if (!isRecord(value)) {
    return invalidError(
      "`acp` must be a mapping with at least a `command` field."
    );
  }

  const rawCommand = value["command"];
  if (typeof rawCommand !== "string" || rawCommand.trim().length === 0) {
    return invalidError(
      "`acp.command` is required and must be a non-empty string."
    );
  }
  const command = rawCommand.trim();

  const argsResult = parseStringArray(value["args"], "args");
  if (!argsResult.ok) return argsResult;
  const args = argsResult.value;

  const cwdResult = parseCwd(value["cwd"]);
  if (!cwdResult.ok) return cwdResult;
  const cwd = cwdResult.value;

  const timeoutResult = parseTimeoutSec(value["timeout_sec"], "timeout_sec");
  if (!timeoutResult.ok) return timeoutResult;
  const timeoutSec = timeoutResult.value ?? DEFAULT_ACP_TIMEOUT_SEC;

  const envResult = parseEnv(value["env"]);
  if (!envResult.ok) return envResult;
  const env = envResult.value;

  const envAllowResult = parseStringArray(value["env_allow"], "env_allow");
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
      command,
      args,
      cwd,
      timeoutSec,
      env,
      envAllow,
      resultFile,
      probe
    }
  };
}

function parseStringArray(
  raw: unknown,
  field: "args" | "env_allow" | "probe.args"
): { ok: true; value: string[] } | AcpConfigError {
  if (raw === undefined || raw === null) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(raw)) {
    const valueDescription =
      field === "env_allow" ? "strings" : "strings or numbers";
    return invalidError(
      `\`acp.${field}\` must be an array of ${valueDescription}.`
    );
  }
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    if (typeof entry === "string") {
      out.push(entry);
    } else if (typeof entry === "number" && field !== "env_allow") {
      out.push(String(entry));
    } else {
      const valueDescription =
        field === "env_allow" ? "a string" : "a string or number";
      return invalidError(
        `\`acp.${field}[${i}]\` must be ${valueDescription}.`
      );
    }
  }
  return { ok: true, value: out };
}

function parseCwd(
  raw: unknown
): { ok: true; value: AcpCwd } | AcpConfigError {
  if (raw === undefined || raw === null) {
    return { ok: true, value: DEFAULT_ACP_CWD };
  }
  if (raw !== "repo" && raw !== "iteration") {
    return invalidError('`acp.cwd` must be "repo" or "iteration".');
  }
  return { ok: true, value: raw };
}

function parseTimeoutSec(
  raw: unknown,
  field: "timeout_sec" | "probe.timeout_sec"
): { ok: true; value: number | undefined } | AcpConfigError {
  if (raw === undefined || raw === null) {
    return { ok: true, value: undefined };
  }
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw <= 0 ||
    !Number.isFinite(raw)
  ) {
    return invalidError(
      `\`acp.${field}\` must be a positive integer (seconds).`
    );
  }
  return { ok: true, value: raw };
}

function parseEnv(
  raw: unknown
): { ok: true; value: Record<string, string> } | AcpConfigError {
  if (raw === undefined || raw === null) {
    return { ok: true, value: {} };
  }
  if (!isRecord(raw)) {
    return invalidError(
      "`acp.env` must be a mapping of string keys to string, number, or boolean values."
    );
  }
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (!isValidEnvName(key)) {
      return invalidError(
        `\`acp.env\` key ${JSON.stringify(key)} is not a valid environment variable name.`
      );
    }
    if (typeof val === "string") {
      out[key] = val;
    } else if (typeof val === "number" || typeof val === "boolean") {
      out[key] = String(val);
    } else {
      return invalidError(
        `\`acp.env.${key}\` must be a string, number, or boolean.`
      );
    }
  }
  return { ok: true, value: out };
}

function parseResultFile(
  raw: unknown
): { ok: true; value: string } | AcpConfigError {
  if (raw === undefined || raw === null) {
    return { ok: true, value: DEFAULT_ACP_RESULT_FILE };
  }
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return invalidError(
      "`acp.result_file` must be a non-empty string when provided."
    );
  }
  const value = raw.trim();
  if (
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    hasParentTraversalSegment(value)
  ) {
    return invalidError(
      "`acp.result_file` must be a relative path inside the iteration artifact directory."
    );
  }
  return { ok: true, value };
}

function parseProbe(
  raw: unknown
): { ok: true; value: AcpProbeConfig | undefined } | AcpConfigError {
  if (raw === undefined || raw === null) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(raw)) {
    return invalidError(
      "`acp.probe` must be a mapping with at least a `command` field, or omitted entirely."
    );
  }
  const rawCommand = raw["command"];
  if (typeof rawCommand !== "string" || rawCommand.trim().length === 0) {
    return invalidError(
      "`acp.probe.command` is required and must be a non-empty string when `acp.probe` is set."
    );
  }
  const command = rawCommand.trim();

  const argsResult = parseStringArray(raw["args"], "probe.args");
  if (!argsResult.ok) return argsResult;

  const timeoutResult = parseTimeoutSec(raw["timeout_sec"], "probe.timeout_sec");
  if (!timeoutResult.ok) return timeoutResult;

  return {
    ok: true,
    value: {
      command,
      args: argsResult.value,
      timeoutSec: timeoutResult.value ?? DEFAULT_ACP_PROBE_TIMEOUT_SEC
    }
  };
}

function hasParentTraversalSegment(value: string): boolean {
  return value.split(/[\\/]+/u).includes("..");
}

function isValidEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function invalidError(message: string): AcpConfigError {
  return { ok: false, code: "acp_config_invalid", error: message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
