import { describe, expect, it } from "vitest";

import {
  DEFAULT_ACP_CWD,
  DEFAULT_ACP_PROBE_TIMEOUT_SEC,
  DEFAULT_ACP_RESULT_FILE,
  DEFAULT_ACP_TIMEOUT_SEC,
  parseAcpConfig
} from "../src/adapters/acp-config.js";

describe("parseAcpConfig defaults", () => {
  it("returns acp_config_missing when value is undefined", () => {
    const result = parseAcpConfig(undefined);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("acp_config_missing");
    expect(result.error).toContain("acp");
  });

  it("returns acp_config_missing when value is null", () => {
    const result = parseAcpConfig(null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("acp_config_missing");
  });

  it("fills sensible defaults when only `command` is provided", () => {
    const result = parseAcpConfig({ command: "/usr/local/bin/acpx" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.command).toBe("/usr/local/bin/acpx");
    expect(result.config.args).toEqual([]);
    expect(result.config.cwd).toBe(DEFAULT_ACP_CWD);
    expect(result.config.timeoutSec).toBe(DEFAULT_ACP_TIMEOUT_SEC);
    expect(result.config.env).toEqual({});
    expect(result.config.envAllow).toEqual([]);
    expect(result.config.resultFile).toBe(DEFAULT_ACP_RESULT_FILE);
    expect(result.config.probe).toBeUndefined();
  });

  it("trims surrounding whitespace from command", () => {
    const result = parseAcpConfig({ command: "  /bin/acpx  " });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.command).toBe("/bin/acpx");
  });
});

describe("parseAcpConfig command and shape validation", () => {
  it("rejects a non-mapping value", () => {
    const result = parseAcpConfig("acpx");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("acp_config_invalid");
    expect(result.error).toContain("mapping");
  });

  it("rejects an array as the acp block", () => {
    const result = parseAcpConfig(["not", "a", "mapping"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("acp_config_invalid");
  });

  it("rejects an empty command", () => {
    const result = parseAcpConfig({ command: "   " });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("acp_config_invalid");
    expect(result.error).toContain("command");
  });

  it("rejects a missing command", () => {
    const result = parseAcpConfig({ args: ["run"] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("acp_config_invalid");
    expect(result.error).toContain("command");
  });
});

describe("parseAcpConfig args validation", () => {
  it("accepts a string array and coerces numeric args", () => {
    const result = parseAcpConfig({
      command: "/bin/acpx",
      args: ["run", 1]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.args).toEqual(["run", "1"]);
  });

  it("rejects a non-array args field", () => {
    const result = parseAcpConfig({
      command: "/bin/acpx",
      args: "run"
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("acp_config_invalid");
    expect(result.error).toContain("args");
  });

  it("rejects an arg entry that is not stringifiable", () => {
    const result = parseAcpConfig({
      command: "/bin/acpx",
      args: ["run", { not: "a string" }]
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("acp_config_invalid");
    expect(result.error).toContain("args[1]");
  });
});

describe("parseAcpConfig cwd / timeout / env / env_allow / result_file", () => {
  it("accepts cwd values 'repo' and 'iteration'", () => {
    for (const cwd of ["repo", "iteration"] as const) {
      const result = parseAcpConfig({ command: "/bin/acpx", cwd });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.config.cwd).toBe(cwd);
    }
  });

  it("rejects an unknown cwd value", () => {
    const result = parseAcpConfig({ command: "/bin/acpx", cwd: "home" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("acp_config_invalid");
    expect(result.error).toContain("cwd");
  });

  it("accepts a positive integer timeout_sec", () => {
    const result = parseAcpConfig({
      command: "/bin/acpx",
      timeout_sec: 600
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.timeoutSec).toBe(600);
  });

  it("rejects non-integer or non-positive timeout_sec", () => {
    for (const bad of [0, -1, 1.5, "60"] as unknown[]) {
      const result = parseAcpConfig({
        command: "/bin/acpx",
        timeout_sec: bad
      });
      expect(result.ok, `expected invalid for ${String(bad)}`).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe("acp_config_invalid");
      expect(result.error).toContain("timeout_sec");
    }
  });

  it("accepts a string env block and coerces numeric/boolean values", () => {
    const result = parseAcpConfig({
      command: "/bin/acpx",
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

  it("rejects env keys that are not valid environment variable names", () => {
    const result = parseAcpConfig({
      command: "/bin/acpx",
      env: { "1BAD": "x" }
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("acp_config_invalid");
    expect(result.error).toContain("1BAD");
  });

  it("accepts an env_allow string array", () => {
    const result = parseAcpConfig({
      command: "/bin/acpx",
      env_allow: ["PATH", "HOME"]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.envAllow).toEqual(["PATH", "HOME"]);
  });

  it("rejects a non-array env_allow", () => {
    const result = parseAcpConfig({
      command: "/bin/acpx",
      env_allow: "PATH"
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("acp_config_invalid");
    expect(result.error).toContain("env_allow");
  });

  it("rejects env_allow numeric entries", () => {
    const result = parseAcpConfig({
      command: "/bin/acpx",
      env_allow: [42]
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("acp_config_invalid");
    expect(result.error).toContain("env_allow[0]");
  });

  it("accepts a relative result_file inside the iteration directory", () => {
    const result = parseAcpConfig({
      command: "/bin/acpx",
      result_file: "runner-output.json"
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.resultFile).toBe("runner-output.json");
  });

  it("rejects absolute result_file paths", () => {
    for (const resultFile of [
      "/tmp/result.json",
      "C:\\temp\\result.json",
      "\\\\server\\share\\result.json"
    ]) {
      const result = parseAcpConfig({
        command: "/bin/acpx",
        result_file: resultFile
      });
      expect(result.ok, `expected invalid for ${resultFile}`).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe("acp_config_invalid");
      expect(result.error).toContain("result_file");
    }
  });

  it("rejects a result_file that escapes via parent directory segments", () => {
    for (const resultFile of ["../escape.json", "nested\\..\\escape.json"]) {
      const result = parseAcpConfig({
        command: "/bin/acpx",
        result_file: resultFile
      });
      expect(result.ok, `expected invalid for ${resultFile}`).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe("acp_config_invalid");
      expect(result.error).toContain("result_file");
    }
  });
});

describe("parseAcpConfig probe", () => {
  it("omits the probe by default", () => {
    const result = parseAcpConfig({ command: "/bin/acpx" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.probe).toBeUndefined();
  });

  it("accepts a probe with default timeout when only command is provided", () => {
    const result = parseAcpConfig({
      command: "/bin/acpx",
      probe: { command: "/bin/acpx", args: ["--version"] }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.probe).toEqual({
      command: "/bin/acpx",
      args: ["--version"],
      timeoutSec: DEFAULT_ACP_PROBE_TIMEOUT_SEC
    });
  });

  it("accepts a probe with custom timeout_sec", () => {
    const result = parseAcpConfig({
      command: "/bin/acpx",
      probe: { command: "/bin/acpx", timeout_sec: 5 }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.probe?.timeoutSec).toBe(5);
  });

  it("rejects a probe without a command", () => {
    const result = parseAcpConfig({
      command: "/bin/acpx",
      probe: { args: ["--version"] }
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("acp_config_invalid");
    expect(result.error).toContain("probe.command");
  });

  it("rejects a non-mapping probe", () => {
    const result = parseAcpConfig({
      command: "/bin/acpx",
      probe: ["acpx", "--version"]
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("acp_config_invalid");
    expect(result.error).toContain("probe");
  });

  it("rejects probe.args entries that are not stringifiable", () => {
    const result = parseAcpConfig({
      command: "/bin/acpx",
      probe: { command: "/bin/acpx", args: [{ x: 1 }] }
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("acp_config_invalid");
    expect(result.error).toContain("probe.args[0]");
  });

  it("rejects non-positive probe.timeout_sec", () => {
    const result = parseAcpConfig({
      command: "/bin/acpx",
      probe: { command: "/bin/acpx", timeout_sec: 0 }
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("acp_config_invalid");
    expect(result.error).toContain("probe.timeout_sec");
  });
});
