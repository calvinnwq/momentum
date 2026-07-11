import fs from "node:fs";

import { describe, expect, it } from "vitest";

describe("POSIX process cleanup source contract", () => {
  it("validates the anchor identity before signaling its process group", () => {
    const source = fs.readFileSync(
      new URL("../src/adapters/live-step-wrapper.ts", import.meta.url),
      "utf8",
    );
    const groupSignal = 'signalPosixTarget(-groupLeaderPid, "SIGKILL")';
    const identityCheck = "const leaderOwnership = posixProcessOwnership(";

    expect(source.split(groupSignal)).toHaveLength(2);
    expect(source.indexOf(identityCheck)).toBeLessThan(
      source.indexOf(groupSignal),
    );
  });
});
