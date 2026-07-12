import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  NATIVE_WINDOWS_UNSUPPORTED_MESSAGE,
  processExecutionPlatformError,
  runProcessGroup,
  runProcessGroupSync,
} from "../src/adapters/live-step-wrapper.js";

async function withProcessPlatform<T>(
  platform: NodeJS.Platform,
  action: () => T | Promise<T>,
): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (descriptor === undefined) throw new Error("process.platform is missing");
  Object.defineProperty(process, "platform", {
    ...descriptor,
    value: platform,
  });
  try {
    return await action();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

describe("native Windows process execution contract", () => {
  it("returns a structured refusal before process-backed execution", () => {
    const error = processExecutionPlatformError("win32");

    expect(error).toMatchObject({
      code: "UNSUPPORTED_PLATFORM",
      message: NATIVE_WINDOWS_UNSUPPORTED_MESSAGE,
    });
    expect(processExecutionPlatformError("linux")).toBeUndefined();
    expect(processExecutionPlatformError("darwin")).toBeUndefined();
  });

  it.each(["sync", "async"] as const)(
    "refuses %s supervision before spawning the configured command",
    async (mode) => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "momentum-win-refusal-"),
      );
      const marker = path.join(root, "spawned");
      const args = [
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "spawned")`,
      ];
      try {
        const result = await withProcessPlatform("win32", () =>
          mode === "sync"
            ? runProcessGroupSync(process.execPath, args, {
                cwd: root,
                env: process.env,
                timeoutMs: 5_000,
                maxBuffer: 1_024,
              })
            : runProcessGroup(process.execPath, args, {
                cwd: root,
                env: process.env,
                timeoutMs: 5_000,
                maxBuffer: 1_024,
              }),
        );

        expect(result.error).toMatchObject({
          code: "UNSUPPORTED_PLATFORM",
          message: NATIVE_WINDOWS_UNSUPPORTED_MESSAGE,
        });
        expect(result.status).toBeNull();
        expect(fs.existsSync(marker)).toBe(false);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("does not retain the removed best-effort Windows containment path", () => {
    const source = fs.readFileSync(
      new URL("../src/adapters/live-step-wrapper.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain("Get-CimInstance Win32_Process");
    expect(source).not.toContain("Stop-Process");
    expect(source).not.toContain("killWindowsProcessTree");
    expect(source).not.toContain("taskkill");
  });
});
