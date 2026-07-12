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

  it("retains a live wrapper identity instead of querying a spawned PID", () => {
    expect(source).not.toContain("readWindowsCreationTicks");
    expect(source).toContain("const LIVE_STEP_COMMAND_WRAPPER = String.raw`");
    expect(source).toContain(
      'emit({ type: "identity", pid: process.pid, creationTicks });',
    );
    expect(source.split('meta.type === "identity"')).toHaveLength(3);
    expect(source.split("meta.pid === command.pid")).toHaveLength(2);
    expect(source.split("meta.pid === child.pid")).toHaveLength(2);
  });
});
