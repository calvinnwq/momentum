import fs from "node:fs";

import { describe, expect, it } from "vitest";

describe("POSIX process cleanup source contract", () => {
  it("uses retained handles and verified PIDs instead of numeric groups", () => {
    const source = fs.readFileSync(
      new URL("../src/adapters/live-step-wrapper.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain(
      'signalPosixTarget(-groupLeaderPid, "SIGKILL")',
    );
    expect(source).not.toContain('process.kill(-child.pid, "SIGKILL")');
    expect(source).toContain('return child.kill("SIGKILL")');
    expect(source).toContain('signalPosixTarget(pid, "SIGKILL")');
  });
});
