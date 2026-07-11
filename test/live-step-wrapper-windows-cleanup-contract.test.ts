import fs from "node:fs";

import { describe, expect, it } from "vitest";

describe("Windows process cleanup source contract", () => {
  it("bounds child ownership by command exit and has no unverified tree kill", () => {
    const source = fs.readFileSync(
      new URL("../src/adapters/live-step-wrapper.ts", import.meta.url),
      "utf8",
    );
    const exitBound =
      "$item.ParentProcessId -eq $commandPid -and $commandExited -and $item.CreationTicks -gt $commandExitedAtTicks";

    expect(source.split(exitBound)).toHaveLength(4);
    expect(source).not.toContain('spawnSync("taskkill"');
  });
});
