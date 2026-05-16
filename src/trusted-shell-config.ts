import path from "node:path";

/**
 * Trusted-shell runner configuration introduced by NGX-282 (M4-03).
 *
 * Momentum core owns Goal/Iteration/Job state, the git transaction,
 * verification, and the artifact layout. The trusted-shell runner profile
 * adds an *explicitly trusted* executable-plus-argv runner: it runs with
 * exactly the privileges of the user who invoked Momentum. There is no
 * sandbox and no privilege drop — the operator is responsible for what the
 * configured executable can do.
 *
 * This module parses and validates the `trusted_shell` block from goal
 * frontmatter into a typed `TrustedShellConfig`. It does not execute
 * anything; execution is owned by `src/trusted-shell-runner.ts` and is
 * dispatched through the `RunnerAdapter` boundary defined in
 * `src/runner-adapter.ts`.
 */

export type TrustedShellCwd = "repo" | "iteration";

export type TrustedShellConfig = {
  command: string;
  args: readonly string[];
  cwd: TrustedShellCwd;
  timeoutSec: number;
  env: Readonly<Record<string, string>>;
  envAllow: readonly string[];
  resultFile: string;
};

export type TrustedShellConfigErrorCode =
  | "trusted_shell_config_missing"
  | "trusted_shell_config_invalid";

export type TrustedShellConfigError = {
  ok: false;
  code: TrustedShellConfigErrorCode;
  error: string;
};

export type TrustedShellConfigSuccess = {
  ok: true;
  config: TrustedShellConfig;
};

export type TrustedShellConfigParse =
  | TrustedShellConfigSuccess
  | TrustedShellConfigError;

export const DEFAULT_TRUSTED_SHELL_TIMEOUT_SEC = 900;
export const DEFAULT_TRUSTED_SHELL_CWD: TrustedShellCwd = "repo";
export const DEFAULT_TRUSTED_SHELL_RESULT_FILE = "result.json";

export function parseTrustedShellConfig(
  value: unknown
): TrustedShellConfigParse {
  if (value === undefined || value === null) {
    return {
      ok: false,
      code: "trusted_shell_config_missing",
      error:
        "Goal frontmatter is missing a `trusted_shell` block; the trusted-shell runner requires at least `trusted_shell.command`."
    };
  }
  if (!isRecord(value)) {
    return invalidError(
      "`trusted_shell` must be a mapping with at least a `command` field."
    );
  }

  const rawCommand = value["command"];
  if (typeof rawCommand !== "string" || rawCommand.trim().length === 0) {
    return invalidError(
      "`trusted_shell.command` is required and must be a non-empty string."
    );
  }
  const command = rawCommand.trim();

  const argsResult = parseStringArray(value["args"], "args");
  if (!argsResult.ok) return argsResult;
  const args = argsResult.value;

  const cwdResult = parseCwd(value["cwd"]);
  if (!cwdResult.ok) return cwdResult;
  const cwd = cwdResult.value;

  const timeoutResult = parseTimeoutSec(value["timeout_sec"]);
  if (!timeoutResult.ok) return timeoutResult;
  const timeoutSec = timeoutResult.value;

  const envResult = parseEnv(value["env"]);
  if (!envResult.ok) return envResult;
  const env = envResult.value;

  const envAllowResult = parseStringArray(value["env_allow"], "env_allow");
  if (!envAllowResult.ok) return envAllowResult;
  const envAllow = envAllowResult.value;

  const resultFileResult = parseResultFile(value["result_file"]);
  if (!resultFileResult.ok) return resultFileResult;
  const resultFile = resultFileResult.value;

  return {
    ok: true,
    config: { command, args, cwd, timeoutSec, env, envAllow, resultFile }
  };
}

function parseStringArray(
  raw: unknown,
  field: "args" | "env_allow"
): { ok: true; value: string[] } | TrustedShellConfigError {
  if (raw === undefined || raw === null) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(raw)) {
    return invalidError(
      `\`trusted_shell.${field}\` must be an array of strings.`
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
      return invalidError(
        `\`trusted_shell.${field}[${i}]\` must be a string.`
      );
    }
  }
  return { ok: true, value: out };
}

function parseCwd(
  raw: unknown
): { ok: true; value: TrustedShellCwd } | TrustedShellConfigError {
  if (raw === undefined || raw === null) {
    return { ok: true, value: DEFAULT_TRUSTED_SHELL_CWD };
  }
  if (raw !== "repo" && raw !== "iteration") {
    return invalidError(
      '`trusted_shell.cwd` must be "repo" or "iteration".'
    );
  }
  return { ok: true, value: raw };
}

function parseTimeoutSec(
  raw: unknown
): { ok: true; value: number } | TrustedShellConfigError {
  if (raw === undefined || raw === null) {
    return { ok: true, value: DEFAULT_TRUSTED_SHELL_TIMEOUT_SEC };
  }
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw <= 0 ||
    !Number.isFinite(raw)
  ) {
    return invalidError(
      "`trusted_shell.timeout_sec` must be a positive integer (seconds)."
    );
  }
  return { ok: true, value: raw };
}

function parseEnv(
  raw: unknown
):
  | { ok: true; value: Record<string, string> }
  | TrustedShellConfigError {
  if (raw === undefined || raw === null) {
    return { ok: true, value: {} };
  }
  if (!isRecord(raw)) {
    return invalidError(
      "`trusted_shell.env` must be a mapping of string keys to string values."
    );
  }
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (!isValidEnvName(key)) {
      return invalidError(
        `\`trusted_shell.env\` key ${JSON.stringify(key)} is not a valid environment variable name.`
      );
    }
    if (typeof val === "string") {
      out[key] = val;
    } else if (typeof val === "number" || typeof val === "boolean") {
      out[key] = String(val);
    } else {
      return invalidError(
        `\`trusted_shell.env.${key}\` must be a string, number, or boolean.`
      );
    }
  }
  return { ok: true, value: out };
}

function parseResultFile(
  raw: unknown
): { ok: true; value: string } | TrustedShellConfigError {
  if (raw === undefined || raw === null) {
    return { ok: true, value: DEFAULT_TRUSTED_SHELL_RESULT_FILE };
  }
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return invalidError(
      "`trusted_shell.result_file` must be a non-empty string when provided."
    );
  }
  const value = raw.trim();
  if (
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    hasParentTraversalSegment(value)
  ) {
    return invalidError(
      "`trusted_shell.result_file` must be a relative path inside the iteration artifact directory."
    );
  }
  return { ok: true, value };
}

function hasParentTraversalSegment(value: string): boolean {
  return value.split(/[\\/]+/u).includes("..");
}

function isValidEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function invalidError(message: string): TrustedShellConfigError {
  return { ok: false, code: "trusted_shell_config_invalid", error: message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
