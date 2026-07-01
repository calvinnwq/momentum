import {
  DEFAULT_INTENT_APPLY_POLICY,
  type UpdateIntentApplyPolicy
} from "../intent/policy.js";

export const EXTERNAL_ADAPTER_PREFLIGHT_STATUSES = Object.freeze([
  "ready",
  "auth_missing",
  "permission_missing",
  "target_missing",
  "unsafe_state",
  "unsupported",
  "unknown"
] as const);

export type ExternalAdapterPreflightStatus =
  (typeof EXTERNAL_ADAPTER_PREFLIGHT_STATUSES)[number];

export type ExternalAdapterPreflightResult =
  | {
      ok: true;
      status: "ready";
      message: string;
    }
  | {
      ok: false;
      status: Exclude<ExternalAdapterPreflightStatus, "ready">;
      message: string;
      action: string;
    };

const LINEAR_API_KEY_ENV = "LINEAR_API_KEY";
const GITHUB_AUTH_ENV_VARS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_CONFIG_DIR"
] as const;

type EnvSnapshot = Record<string, string | undefined>;

export function preflightLinearExternalApply(input: {
  env: EnvSnapshot;
  intentApplyPolicy?: UpdateIntentApplyPolicy | null;
  targetExternalId?: string | null;
}): ExternalAdapterPreflightResult {
  const target = input.targetExternalId?.trim() ?? "";
  if (target.length === 0) {
    return {
      ok: false,
      status: "target_missing",
      message: "Linear external-apply has no resolved issue target.",
      action:
        "Seed exactly one pending Linear intent for the workflow issue scope before running linear-refresh."
    };
  }

  const policy = input.intentApplyPolicy ?? DEFAULT_INTENT_APPLY_POLICY;
  if (policy !== "external_apply_allowed") {
    return {
      ok: false,
      status: "permission_missing",
      message:
        `Linear external-apply is blocked by intent_apply_policy=${policy}.`,
      action:
        "Set intent_apply_policy: external_apply_allowed in the repo policy before authorizing external tracker writes."
    };
  }

  const auth = preflightLinearExternalApplyAuth({ env: input.env });
  if (!auth.ok) return auth;

  return {
    ok: true,
    status: "ready",
    message: "Linear external-apply preflight passed."
  };
}

export function preflightLinearExternalApplyAuth(input: {
  env: EnvSnapshot;
}): ExternalAdapterPreflightResult {
  const apiKey = input.env[LINEAR_API_KEY_ENV];
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    return {
      ok: false,
      status: "auth_missing",
      message:
        `${LINEAR_API_KEY_ENV} is not set in the workflow process environment.`,
      action:
        "Provide LINEAR_API_KEY to the daemon/supervisor environment; Momentum will still use the two-phase audit and idempotency path."
    };
  }

  return {
    ok: true,
    status: "ready",
    message: "Linear external-apply auth preflight passed."
  };
}

export function preflightGitHubMergeCleanup(input: {
  env: EnvSnapshot;
  targetRef?: string | null;
}): ExternalAdapterPreflightResult {
  const target = input.targetRef?.trim();
  if (target !== undefined && target.length === 0) {
    return {
      ok: false,
      status: "target_missing",
      message: "GitHub merge-cleanup has no pull request or branch target.",
      action:
        "Resolve the pull request / branch target before running merge-cleanup."
    };
  }

  const presentAuth = GITHUB_AUTH_ENV_VARS.find((name) => {
    const value = input.env[name];
    return typeof value === "string" && value.trim().length > 0;
  });
  if (presentAuth === undefined) {
    return {
      ok: false,
      status: "auth_missing",
      message:
        "GitHub merge-cleanup has no explicit auth in the workflow process environment.",
      action:
        "Provide GH_TOKEN, GITHUB_TOKEN, or GH_CONFIG_DIR to the live-wrapper environment before running merge-cleanup."
    };
  }

  return {
    ok: true,
    status: "ready",
    message: `GitHub merge-cleanup preflight passed using ${presentAuth}.`
  };
}
