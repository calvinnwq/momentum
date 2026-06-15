import { describe, expect, it } from "vitest";

import {
  sigtermImmuneSleep,
  waitMs
} from "./helpers/process-kill-harness.js";

describe("process-kill harness fixtures", () => {
  describe("sigtermImmuneSleep", () => {
    it("builds a shell fragment that ignores SIGTERM then sleeps", () => {
      expect(sigtermImmuneSleep(3)).toBe('trap "" TERM; sleep 3');
    });

    it("interpolates the requested sleep duration", () => {
      expect(sigtermImmuneSleep(1)).toBe('trap "" TERM; sleep 1');
    });
  });

  describe("waitMs", () => {
    it("blocks the calling thread for at least the requested duration", () => {
      const start = Date.now();
      waitMs(60);
      expect(Date.now() - start).toBeGreaterThanOrEqual(55);
    });
  });
});
