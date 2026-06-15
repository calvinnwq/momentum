import { describe, expect, it } from "vitest";

import {
  LIVE_STEP_WRAPPER_OUTPUT_MAX_BYTES,
  LIVE_STEP_WRAPPER_RECOVERY_CODES
} from "../src/adapters/live-step-wrapper.js";
import { TRUSTED_SHELL_ENV_VARS } from "../src/adapters/trusted-shell-runner.js";

/**
 * Fast-lane coverage for pure runtime taxonomy / contract constants.
 *
 * These assertions pin stable vocabularies — the live-wrapper execution
 * recovery codes, the live-wrapper output cap, and the trusted-shell
 * MOMENTUM_* environment contract — without spawning a child process or
 * waiting on a real timeout. They were extracted from the heavy
 * `test/live-step-wrapper.test.ts` and `test/trusted-shell-runner.test.ts`
 * integration suites (NGX-433) so the default `pnpm test` lane proves the
 * contracts instantly, while every real process-behavior proof for those
 * mechanisms stays in `pnpm test:integration`.
 */
describe("LIVE_STEP_WRAPPER_RECOVERY_CODES", () => {
  it("pins the stable live-wrapper execution recovery vocabulary", () => {
    expect([...LIVE_STEP_WRAPPER_RECOVERY_CODES]).toEqual([
      "runtime_unavailable",
      "auth_unavailable",
      "command_failed",
      "command_timed_out",
      "output_overflow",
      "result_missing",
      "result_invalid"
    ]);
  });

  it("defaults the output cap to 256 MiB", () => {
    expect(LIVE_STEP_WRAPPER_OUTPUT_MAX_BYTES).toBe(256 * 1024 * 1024);
  });
});

describe("TRUSTED_SHELL_ENV_VARS", () => {
  it("exposes a stable MOMENTUM_* contract", () => {
    expect(TRUSTED_SHELL_ENV_VARS).toEqual({
      GOAL_ID: "MOMENTUM_GOAL_ID",
      ITERATION: "MOMENTUM_ITERATION",
      REPO_PATH: "MOMENTUM_REPO_PATH",
      BASE_HEAD: "MOMENTUM_BASE_HEAD",
      BRANCH: "MOMENTUM_BRANCH",
      PROMPT_PATH: "MOMENTUM_PROMPT_PATH",
      ITERATION_DIR: "MOMENTUM_ITERATION_DIR",
      RESULT_PATH: "MOMENTUM_RESULT_PATH"
    });
  });
});
