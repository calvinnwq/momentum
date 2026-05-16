import fs from "node:fs";
import path from "node:path";

/**
 * Runtime `MOMENTUM.md` policy loader introduced by NGX-284 (M4-05).
 *
 * The policy file is a repo-owned, opt-in defaults layer sitting between
 * goal-frontmatter values and built-in Momentum defaults. It contains a
 * YAML frontmatter block with a minimal schema (default runner, default
 * verification commands, default verification timeout) plus an optional
 * markdown body that is surfaced to the runner as context-only policy
 * notes.
 *
 * Precedence (highest first):
 *   1. CLI overrides (e.g. `--runner`)
 *   2. Goal frontmatter (`runner`, `verification`, `verification_timeout_sec`)
 *   3. MOMENTUM.md frontmatter
 *   4. Built-in defaults
 *
 * Hard rules:
 *  - Discovery is repo-root only. Parent-directory traversal and `..`
 *    segments are rejected; the loader does not walk up to find a parent
 *    repo's policy file.
 *  - Policy notes (markdown body) are surfaced to the iteration prompt as
 *    *context only*. They never override Momentum safety contracts (no
 *    commits, no pushes, no staging changes).
 *  - Parse errors map to stable error codes so callers can surface them
 *    deterministically.
 *  - Missing MOMENTUM.md is not an error; callers receive an explicit
 *    `present: false` result and fall back to goal-frontmatter / built-in
 *    defaults.
 */

export const MOMENTUM_POLICY_FILENAME = "MOMENTUM.md";

export type MomentumPolicyConfig = {
  runner: string | undefined;
  verification: readonly string[] | undefined;
  verificationTimeoutSec: number | undefined;
};

export type MomentumPolicy = {
  config: MomentumPolicyConfig;
  notes: string;
  rawFrontmatter: Readonly<Record<string, unknown>>;
};

export type MomentumPolicyErrorCode =
  | "policy_file_unreadable"
  | "policy_parse_invalid"
  | "policy_schema_invalid"
  | "policy_path_invalid";

export type MomentumPolicyParseSuccess = {
  ok: true;
  policy: MomentumPolicy;
};

export type MomentumPolicyParseError = {
  ok: false;
  code: MomentumPolicyErrorCode;
  error: string;
};

export type MomentumPolicyParseResult =
  | MomentumPolicyParseSuccess
  | MomentumPolicyParseError;

export type MomentumPolicyLoadAbsent = {
  ok: true;
  present: false;
  path: string;
};

export type MomentumPolicyLoadPresent = {
  ok: true;
  present: true;
  path: string;
  policy: MomentumPolicy;
};

export type MomentumPolicyLoadError = {
  ok: false;
  path: string;
  code: MomentumPolicyErrorCode;
  error: string;
};

export type MomentumPolicyLoadResult =
  | MomentumPolicyLoadAbsent
  | MomentumPolicyLoadPresent
  | MomentumPolicyLoadError;

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\n---\r?\n?([\s\S]*)$/;

/**
 * Compute the canonical MOMENTUM.md path for a repo root, refusing any
 * input that escapes the repo root via `..` segments. Returning a path
 * rather than a load result keeps the loader callable from contexts that
 * may not have stat access yet (e.g. doctor surfacing the configured
 * path).
 */
export function resolvePolicyPath(
  repoPath: string
):
  | { ok: true; path: string }
  | { ok: false; code: MomentumPolicyErrorCode; error: string } {
  if (typeof repoPath !== "string" || repoPath.trim().length === 0) {
    return {
      ok: false,
      code: "policy_path_invalid",
      error: "repoPath must be a non-empty string."
    };
  }
  const absRepo = path.resolve(repoPath);
  const policyPath = path.join(absRepo, MOMENTUM_POLICY_FILENAME);
  const relFromRepo = path.relative(absRepo, policyPath);
  if (
    relFromRepo === "" ||
    relFromRepo.split(path.sep).includes("..") ||
    path.isAbsolute(relFromRepo)
  ) {
    return {
      ok: false,
      code: "policy_path_invalid",
      error: `MOMENTUM.md discovery is repo-root only; refusing path ${policyPath}.`
    };
  }
  return { ok: true, path: policyPath };
}

export function loadMomentumPolicy(repoPath: string): MomentumPolicyLoadResult {
  const resolved = resolvePolicyPath(repoPath);
  if (!resolved.ok) {
    return {
      ok: false,
      path: typeof repoPath === "string" ? repoPath : String(repoPath),
      code: resolved.code,
      error: resolved.error
    };
  }
  const policyPath = resolved.path;

  let content: string;
  try {
    if (!fs.existsSync(policyPath)) {
      return { ok: true, present: false, path: policyPath };
    }
    content = fs.readFileSync(policyPath, "utf-8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    return {
      ok: false,
      path: policyPath,
      code: "policy_file_unreadable",
      error: `Cannot read ${MOMENTUM_POLICY_FILENAME}: ${detail}`
    };
  }

  const parsed = parseMomentumPolicy(content);
  if (!parsed.ok) {
    return { ok: false, path: policyPath, code: parsed.code, error: parsed.error };
  }
  return { ok: true, present: true, path: policyPath, policy: parsed.policy };
}

export function parseMomentumPolicy(
  content: string
): MomentumPolicyParseResult {
  if (typeof content !== "string") {
    return {
      ok: false,
      code: "policy_parse_invalid",
      error: "MOMENTUM.md content must be a string."
    };
  }

  // If the file lacks frontmatter entirely, treat the whole body as policy
  // notes with empty defaults. This keeps the file shape liberal: operators
  // can write pure prose policy without forcing them to add an empty
  // frontmatter block. Strict schema validation only runs when frontmatter
  // is present.
  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    return {
      ok: true,
      policy: {
        config: {
          runner: undefined,
          verification: undefined,
          verificationTimeoutSec: undefined
        },
        notes: content.trim(),
        rawFrontmatter: Object.freeze({})
      }
    };
  }

  const [, fm, body] = match;
  const fieldsResult = parseSimpleYaml(fm ?? "");
  if (!fieldsResult.ok) {
    return fieldsResult;
  }
  const fields = fieldsResult.value;

  const runnerResult = parsePolicyRunner(fields["runner"]);
  if (!runnerResult.ok) return runnerResult;

  const verificationResult = parsePolicyVerification(fields["verification"]);
  if (!verificationResult.ok) return verificationResult;

  const timeoutResult = parsePolicyVerificationTimeout(
    fields["verification_timeout_sec"]
  );
  if (!timeoutResult.ok) return timeoutResult;

  const config: MomentumPolicyConfig = {
    runner: runnerResult.value,
    verification: verificationResult.value,
    verificationTimeoutSec: timeoutResult.value
  };

  return {
    ok: true,
    policy: {
      config,
      notes: (body ?? "").trim(),
      rawFrontmatter: Object.freeze({ ...fields })
    }
  };
}

function parsePolicyRunner(
  raw: unknown
): { ok: true; value: string | undefined } | MomentumPolicyParseError {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, value: undefined };
  }
  if (typeof raw !== "string") {
    return schemaError("`runner` must be a string when set in MOMENTUM.md.");
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: true, value: undefined };
  }
  return { ok: true, value: trimmed };
}

function parsePolicyVerification(
  raw: unknown
):
  | { ok: true; value: readonly string[] | undefined }
  | MomentumPolicyParseError {
  if (raw === undefined || raw === null) {
    return { ok: true, value: undefined };
  }
  if (!Array.isArray(raw)) {
    return schemaError(
      "`verification` must be an array of strings when set in MOMENTUM.md."
    );
  }
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (typeof item !== "string" || item.trim().length === 0) {
      return schemaError(
        `\`verification[${i}]\` must be a non-empty string in MOMENTUM.md.`
      );
    }
    out.push(item);
  }
  return { ok: true, value: Object.freeze(out) };
}

function parsePolicyVerificationTimeout(
  raw: unknown
):
  | { ok: true; value: number | undefined }
  | MomentumPolicyParseError {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, value: undefined };
  }
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    return schemaError(
      "`verification_timeout_sec` must be a positive integer in MOMENTUM.md."
    );
  }
  return { ok: true, value: raw };
}

function schemaError(message: string): MomentumPolicyParseError {
  return { ok: false, code: "policy_schema_invalid", error: message };
}

type YamlScalar = string | number | boolean;
type YamlMapping = { [key: string]: YamlValue };
type YamlValue = YamlScalar | string[] | YamlMapping;

function parseSimpleYaml(
  yaml: string
):
  | { ok: true; value: Record<string, YamlValue> }
  | MomentumPolicyParseError {
  const lines = yaml.split("\n");
  const fields: Record<string, YamlValue> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      i += 1;
      continue;
    }
    if (indentWidth(line) !== 0) {
      return {
        ok: false,
        code: "policy_parse_invalid",
        error: `MOMENTUM.md frontmatter line ${i + 1} is indented; only top-level keys are supported.`
      };
    }
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx < 0) {
      return {
        ok: false,
        code: "policy_parse_invalid",
        error: `MOMENTUM.md frontmatter line ${i + 1} is missing a colon.`
      };
    }
    const key = trimmed.slice(0, colonIdx).trim();
    if (key.length === 0) {
      return {
        ok: false,
        code: "policy_parse_invalid",
        error: `MOMENTUM.md frontmatter line ${i + 1} is missing a key name.`
      };
    }
    const rest = stripInlineComment(trimmed.slice(colonIdx + 1)).trim();
    if (rest.length === 0) {
      const arrResult = readBlockArray(lines, i + 1);
      if (!arrResult.ok) return arrResult;
      if (arrResult.consumed === 0) {
        fields[key] = "";
        i += 1;
      } else {
        fields[key] = arrResult.value;
        i = arrResult.nextIndex;
      }
      continue;
    }
    if (rest.startsWith("[") && rest.endsWith("]")) {
      fields[key] = parseInlineArray(rest);
      i += 1;
      continue;
    }
    fields[key] = parseScalar(rest);
    i += 1;
  }
  return { ok: true, value: fields };
}

function readBlockArray(
  lines: string[],
  fromIndex: number
):
  | { ok: true; value: string[]; consumed: number; nextIndex: number }
  | MomentumPolicyParseError {
  const items: string[] = [];
  let j = fromIndex;
  let consumed = 0;
  while (j < lines.length) {
    const line = lines[j] ?? "";
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      j += 1;
      continue;
    }
    if (indentWidth(line) === 0) {
      break;
    }
    if (!trimmed.startsWith("- ") && trimmed !== "-") {
      return {
        ok: false,
        code: "policy_parse_invalid",
        error: `MOMENTUM.md frontmatter line ${j + 1} is indented but not a list item.`
      };
    }
    const itemText = trimmed === "-" ? "" : trimmed.slice(2).trim();
    items.push(String(parseScalar(itemText)));
    consumed += 1;
    j += 1;
  }
  return { ok: true, value: items, consumed, nextIndex: j };
}

function parseInlineArray(raw: string): string[] {
  const inner = raw.slice(1, -1).trim();
  if (inner.length === 0) return [];
  const items: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (const ch of inner) {
    if ((ch === '"' || ch === "'") && quote === undefined) {
      quote = ch;
    } else if (ch === quote) {
      quote = undefined;
    }
    if (ch === "," && quote === undefined) {
      items.push(String(parseScalar(current.trim())));
      current = "";
    } else {
      current += ch;
    }
  }
  items.push(String(parseScalar(current.trim())));
  return items;
}

function parseScalar(raw: string): YamlScalar {
  const stripped = stripInlineComment(raw).trim();
  if (
    (stripped.startsWith('"') && stripped.endsWith('"')) ||
    (stripped.startsWith("'") && stripped.endsWith("'"))
  ) {
    return stripped.slice(1, -1);
  }
  if (stripped === "true") return true;
  if (stripped === "false") return false;
  if (stripped !== "" && !Number.isNaN(Number(stripped))) {
    return Number(stripped);
  }
  return stripped;
}

function stripInlineComment(raw: string): string {
  let quote: string | undefined;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if ((ch === '"' || ch === "'") && quote === undefined) {
      quote = ch;
    } else if (ch === quote) {
      quote = undefined;
    } else if (
      ch === "#" &&
      quote === undefined &&
      (i === 0 || /\s/.test(raw[i - 1] ?? ""))
    ) {
      return raw.slice(0, i);
    }
  }
  return raw;
}

function indentWidth(line: string): number {
  let n = 0;
  while (n < line.length) {
    const ch = line[n];
    if (ch === " " || ch === "\t") n += 1;
    else break;
  }
  return n;
}

export type PolicyEffectiveFieldSource =
  | "goal_frontmatter"
  | "momentum_policy"
  | "builtin_default";

export type PolicyEffectiveSource = {
  verification: PolicyEffectiveFieldSource;
  verificationTimeoutSec: PolicyEffectiveFieldSource;
};

export type PolicyEffectiveValues = {
  verification: readonly string[];
  verificationTimeoutSec: number;
  source: PolicyEffectiveSource;
};

export type ResolvePolicyEffectiveValuesInput = {
  goalVerificationProvided: boolean;
  goalVerification: readonly string[];
  goalVerificationTimeoutSecProvided: boolean;
  goalVerificationTimeoutSec: number;
  policyConfig: MomentumPolicyConfig | undefined;
  builtinDefaultVerification?: readonly string[];
  builtinDefaultVerificationTimeoutSec?: number;
};

export const BUILTIN_DEFAULT_VERIFICATION: readonly string[] = Object.freeze([]);
export const BUILTIN_DEFAULT_VERIFICATION_TIMEOUT_SEC = 900;

export function resolvePolicyEffectiveValues(
  input: ResolvePolicyEffectiveValuesInput
): PolicyEffectiveValues {
  const builtinVerification =
    input.builtinDefaultVerification ?? BUILTIN_DEFAULT_VERIFICATION;
  const builtinTimeout =
    input.builtinDefaultVerificationTimeoutSec ??
    BUILTIN_DEFAULT_VERIFICATION_TIMEOUT_SEC;

  let verification: readonly string[];
  let verificationSource: PolicyEffectiveFieldSource;
  if (input.goalVerificationProvided) {
    verification = input.goalVerification;
    verificationSource = "goal_frontmatter";
  } else if (input.policyConfig?.verification !== undefined) {
    verification = input.policyConfig.verification;
    verificationSource = "momentum_policy";
  } else {
    verification = builtinVerification;
    verificationSource = "builtin_default";
  }

  let verificationTimeoutSec: number;
  let timeoutSource: PolicyEffectiveFieldSource;
  if (input.goalVerificationTimeoutSecProvided) {
    verificationTimeoutSec = input.goalVerificationTimeoutSec;
    timeoutSource = "goal_frontmatter";
  } else if (input.policyConfig?.verificationTimeoutSec !== undefined) {
    verificationTimeoutSec = input.policyConfig.verificationTimeoutSec;
    timeoutSource = "momentum_policy";
  } else {
    verificationTimeoutSec = builtinTimeout;
    timeoutSource = "builtin_default";
  }

  return {
    verification,
    verificationTimeoutSec,
    source: {
      verification: verificationSource,
      verificationTimeoutSec: timeoutSource
    }
  };
}
