export type GoalSpec = {
  title: string;
  repo: string | undefined;
  runner: string;
  branch: string;
  max_iterations: number;
  verification: string[];
  verification_timeout_sec: number;
  trusted_shell?: unknown;
  acp?: unknown;
  body: string;
};

export type GoalSpecError = { ok: false; error: string };
export type GoalSpecSuccess = {
  ok: true;
  spec: GoalSpec;
  rawFrontmatter: {
    runner?: unknown;
    trusted_shell?: unknown;
    acp?: unknown;
    verificationProvided: boolean;
    verificationTimeoutProvided: boolean;
  };
};
export type GoalSpecResult = GoalSpecError | GoalSpecSuccess;
