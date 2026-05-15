import { describe, expect, it } from "vitest";

import {
  DEFAULT_TRUSTED_SHELL_CWD,
  DEFAULT_TRUSTED_SHELL_RESULT_FILE,
  DEFAULT_TRUSTED_SHELL_TIMEOUT_SEC,
  parseTrustedShellConfig
} from "../src/trusted-shell-config.js";

describe("parseTrustedShellConfig defaults", () => {
  it("returns trusted_shell_config_missing when value is undefined", () => {
    const result = parseTrustedShellConfig(undefined);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("trusted_shell_config_missing");
    expect(result.error).toContain("trusted_shell");
  });

  it("returns trusted_shell_config_missing when value is null", () => {
    const result = parseTrustedShellConfig(null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("trusted_shell_config_missing");
  });

  it("fills sensible defaults when only `command` is provided", () => {
    const result = parseTrustedShellConfig({ command: "/usr/bin/env" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.command).toBe("/usr/bin/env");
    expect(result.config.args).toEqual([]);
    expect(result.config.cwd).toBe(DEFAULT_TRUSTED_SHELL_CWD);
    expect(result.config.timeoutSec).toBe(DEFAULT_TRUSTED_SHELL_TIMEOUT_SEC);
    expect(result.config.env).toEqual({});
    expect(result.config.envAllow).toEqual([]);
    expect(result.config.resultFile).toBe(DEFAULT_TRUSTED_SHELL_RESULT_FILE);
  });

  it("trims surrounding whitespace from command", () => {
    const result = parseTrustedShellConfig({ command: "  /bin/bash  " });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.command).toBe("/bin/bash");
  });
});

describe("parseTrustedShellConfig command validation", () => {
  it("rejects a non-mapping value", () => {
    const result = parseTrustedShellConfig("string");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("trusted_shell_config_invalid");
  });

  it("rejects an array as the trusted_shell block", () => {
    const result = parseTrustedShellConfig(["not", "a", "mapping"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("trusted_shell_config_invalid");
  });

  it("rejects an empty command", () => {
    const result = parseTrustedShellConfig({ command: "   " });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("trusted_shell_config_invalid");
    expect(result.error).toContain("command");
  });

  it("rejects a missing command", () => {
    const result = parseTrustedShellConfig({ args: ["-c", "echo hi"] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("trusted_shell_config_invalid");
    expect(result.error).toContain("command");
  });
});

describe("parseTrustedShellConfig args validation", () => {
  it("accepts a string array", () => {
    const result = parseTrustedShellConfig({
      command: "/bin/sh",
      args: ["-c", "echo hi"]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.args).toEqual(["-c", "echo hi"]);
  });

  it("coerces numeric args to strings", () => {
    const result = parseTrustedShellConfig({
      command: "/bin/sh",
      args: ["-c", 42]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.args).toEqual(["-c", "42"]);
  });

  it("rejects a non-array args field", () => {
    const result = parseTrustedShellConfig({
      command: "/bin/sh",
      args: "-c echo hi"
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("trusted_shell_config_invalid");
    expect(result.error).toContain("args");
  });

  it("rejects an arg entry that is not stringifiable", () => {
    const result = parseTrustedShellConfig({
      command: "/bin/sh",
      args: ["-c", { not: "a string" }]
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("trusted_shell_config_invalid");
    expect(result.error).toContain("args[1]");
  });
});

describe("parseTrustedShellConfig cwd / timeout / env / env_allow / result_file", () => {
  it("accepts cwd values 'repo' and 'iteration'", () => {
    for (const cwd of ["repo", "iteration"] as const) {
      const result = parseTrustedShellConfig({ command: "/bin/sh", cwd });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.config.cwd).toBe(cwd);
    }
  });

  it("rejects an unknown cwd value", () => {
    const result = parseTrustedShellConfig({
      command: "/bin/sh",
      cwd: "home"
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("trusted_shell_config_invalid");
    expect(result.error).toContain("cwd");
  });

  it("accepts a positive integer timeout_sec", () => {
    const result = parseTrustedShellConfig({
      command: "/bin/sh",
      timeout_sec: 60
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.timeoutSec).toBe(60);
  });

  it("rejects non-integer or non-positive timeout_sec", () => {
    for (const bad of [0, -1, 1.5, "60"] as unknown[]) {
      const result = parseTrustedShellConfig({
        command: "/bin/sh",
        timeout_sec: bad
      });
      expect(result.ok, `expected invalid for ${String(bad)}`).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe("trusted_shell_config_invalid");
      expect(result.error).toContain("timeout_sec");
    }
  });

  it("accepts a string env block", () => {
    const result = parseTrustedShellConfig({
      command: "/bin/sh",
      env: { PROMPT: "hello", COUNT: 3, VERBOSE: true }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.env).toEqual({
      PROMPT: "hello",
      COUNT: "3",
      VERBOSE: "true"
    });
  });

  it("rejects an env entry that is not stringifiable", () => {
    const result = parseTrustedShellConfig({
      command: "/bin/sh",
      env: { PROMPT: { nested: true } }
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("trusted_shell_config_invalid");
    expect(result.error).toContain("env.PROMPT");
  });

  it("rejects env keys that are not valid environment variable names", () => {
    const result = parseTrustedShellConfig({
      command: "/bin/sh",
      env: { "1BAD": "x" }
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("trusted_shell_config_invalid");
    expect(result.error).toContain("1BAD");
  });

  it("accepts an env_allow string array", () => {
    const result = parseTrustedShellConfig({
      command: "/bin/sh",
      env_allow: ["PATH", "HOME"]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.envAllow).toEqual(["PATH", "HOME"]);
  });

  it("rejects a non-array env_allow", () => {
    const result = parseTrustedShellConfig({
      command: "/bin/sh",
      env_allow: "PATH"
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("trusted_shell_config_invalid");
    expect(result.error).toContain("env_allow");
  });

  it("accepts a relative result_file inside the iteration directory", () => {
    const result = parseTrustedShellConfig({
      command: "/bin/sh",
      result_file: "runner-output.json"
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.resultFile).toBe("runner-output.json");
  });

  it("rejects an absolute result_file path", () => {
    const result = parseTrustedShellConfig({
      command: "/bin/sh",
      result_file: "/tmp/result.json"
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("trusted_shell_config_invalid");
    expect(result.error).toContain("result_file");
  });

  it("rejects a result_file that escapes via ..", () => {
    const result = parseTrustedShellConfig({
      command: "/bin/sh",
      result_file: "../escape.json"
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("trusted_shell_config_invalid");
    expect(result.error).toContain("result_file");
  });
});
