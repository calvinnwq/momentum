import fs from "node:fs";

import { describe, expect, it } from "vitest";

import {
  NATIVE_WINDOWS_UNSUPPORTED_MESSAGE,
  processExecutionPlatformError,
} from "../src/adapters/live-step-wrapper.js";

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

  it("does not retain the removed best-effort Windows containment path", () => {
    const source = fs.readFileSync(
      new URL("../src/adapters/live-step-wrapper.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain("Get-CimInstance Win32_Process");
    expect(source).not.toContain("Stop-Process");
    expect(source).not.toContain("killWindowsProcessTree");
    expect(source).not.toContain("taskkill");
    expect(
      source.split("processExecutionPlatformError()").length,
    ).toBeGreaterThan(4);
  });
});
