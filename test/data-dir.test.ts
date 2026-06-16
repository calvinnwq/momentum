import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { resolveDataDir } from "../src/config/data-dir.js";

describe("resolveDataDir", () => {
  it("returns --data-dir when provided", () => {
    expect(resolveDataDir({ dataDir: "/explicit/path", env: {} })).toBe(
      "/explicit/path"
    );
  });

  it("prefers --data-dir over MOMENTUM_HOME", () => {
    expect(
      resolveDataDir({ dataDir: "/explicit", env: { MOMENTUM_HOME: "/env" } })
    ).toBe("/explicit");
  });

  it("returns MOMENTUM_HOME when no --data-dir", () => {
    expect(
      resolveDataDir({ env: { MOMENTUM_HOME: "/from/env" } })
    ).toBe("/from/env");
  });

  it("falls back to ~/.momentum when neither is set", () => {
    expect(resolveDataDir({ env: {} })).toBe(
      path.join(os.homedir(), ".momentum")
    );
  });

  it("falls back to ~/.momentum when MOMENTUM_HOME is empty string", () => {
    expect(resolveDataDir({ env: { MOMENTUM_HOME: "" } })).toBe(
      path.join(os.homedir(), ".momentum")
    );
  });
});
