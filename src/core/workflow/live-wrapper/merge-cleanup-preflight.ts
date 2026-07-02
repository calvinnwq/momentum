export type MergeCleanupPreflightStatus =
  | "ready"
  | "auth_missing"
  | "target_missing"
  | "unsafe_state"
  | "unsupported"
  | "unknown";

export type MergeCleanupPreflightResult =
  | {
      ok: true;
      status: "ready";
      message: string;
    }
  | {
      ok: false;
      status: Exclude<MergeCleanupPreflightStatus, "ready">;
      message: string;
      action: string;
    };

const GITHUB_AUTH_ENV_VARS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_CONFIG_DIR"
] as const;

type EnvSnapshot = Record<string, string | undefined>;

export function preflightGitHubMergeCleanup(input: {
  env: EnvSnapshot;
  targetRef?: string | null;
}): MergeCleanupPreflightResult {
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
