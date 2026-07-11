import fs from "node:fs";

import { describe, expect, it } from "vitest";

describe("Windows process cleanup source contract", () => {
  const source = fs.readFileSync(
    new URL("../src/adapters/live-step-wrapper.ts", import.meta.url),
    "utf8",
  );

  it("bounds child ownership by command exit and has no unverified tree kill", () => {
    const exitBound =
      "$item.ParentProcessId -eq $commandPid -and $commandExited -and $item.CreationTicks -gt $commandExitedAtTicks";

    expect(source.split(exitBound)).toHaveLength(4);
    expect(source).not.toContain('spawnSync("taskkill"');
  });

  it("validates the command parent before retaining Windows identity", () => {
    const parentCheck =
      '[int]$p.ParentProcessId -ne " + expectedParentPid + ") { exit 1 }';

    expect(source.split(parentCheck)).toHaveLength(3);
    expect(
      source.split("readWindowsCreationTicks(command.pid, process.pid)"),
    ).toHaveLength(2);
    expect(
      source.split("readWindowsCreationTicks(child.pid, process.pid)"),
    ).toHaveLength(2);
  });
});
