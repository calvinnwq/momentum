import { describe, expect, it } from "vitest";

import {
  LIVE_STEP_WRAPPER_OUTPUT_MAX_BYTES,
  LIVE_STEP_WRAPPER_RECOVERY_CODES,
} from "../src/adapters/live-step-wrapper.js";

/**
 * Fast-lane coverage for pure runtime taxonomy / contract constants.
 *
 * These assertions pin stable vocabularies — the live-wrapper execution
 * recovery codes and the live-wrapper output cap — without spawning a child
 * process or waiting on a real timeout. They were extracted from the heavy
 * `test/live-step-wrapper.test.ts` integration suite (NGX-433) so the default
 * `pnpm test` lane proves the contracts instantly, while every real
 * process-behavior proof stays in `pnpm test:integration`.
 */
describe("LIVE_STEP_WRAPPER_RECOVERY_CODES", () => {
  it("pins the stable live-wrapper execution recovery vocabulary", () => {
    expect([...LIVE_STEP_WRAPPER_RECOVERY_CODES]).toEqual([
      "unsupported_platform",
      "runtime_unavailable",
      "auth_unavailable",
      "command_failed",
      "command_timed_out",
      "output_overflow",
      "result_missing",
      "result_invalid",
    ]);
  });

  it("defaults the output cap to 256 MiB", () => {
    expect(LIVE_STEP_WRAPPER_OUTPUT_MAX_BYTES).toBe(256 * 1024 * 1024);
  });
});
