import { describe, expect, it } from "vitest";

import {
  DEFAULT_LIVE_WRAPPER_PROBE_TIMEOUT_SEC,
  LIVE_WRAPPER_REFUSAL_CODES,
  listConfiguredLiveWrapperKinds,
  parseLiveWrapperConfig,
  parseLiveWrapperProfile,
  resolveLiveWrapper
} from "../src/adapters/live-wrapper-registry.js";

const validWrapper = {
  command: "/usr/bin/gnhf-runner",
  args: ["--run", "1"],
  cwd: "repo",
  timeout_sec: 1800,
  env_allow: ["PATH", "HOME"],
  result_file: "result.json",
  probe: {
    command: "/usr/bin/gnhf-probe",
    args: ["--check"],
    timeout_sec: 15
  }
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("parseLiveWrapperConfig missing", () => {
  it("returns live_wrapper_config_missing when value is undefined", () => {
    const result = parseLiveWrapperConfig(undefined);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("live_wrapper_config_missing");
  });

  it("returns live_wrapper_config_missing when value is null", () => {
    const result = parseLiveWrapperConfig(null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("live_wrapper_config_missing");
  });
});

describe("parseLiveWrapperConfig shape", () => {
  it("maps a fully specified wrapper into a typed config", () => {
    const result = parseLiveWrapperConfig(clone(validWrapper));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.command).toBe("/usr/bin/gnhf-runner");
    expect(result.config.args).toEqual(["--run", "1"]);
    expect(result.config.cwd).toBe("repo");
    expect(result.config.timeoutSec).toBe(1800);
    expect(result.config.envAllow).toEqual(["PATH", "HOME"]);
    expect(result.config.resultFile).toBe("result.json");
    expect(result.config.probe).toEqual({
      command: "/usr/bin/gnhf-probe",
      args: ["--check"],
      timeoutSec: 15
    });
  });

  it("accepts camelCase aliases during the durable-config transition", () => {
    const raw = clone(validWrapper) as Record<string, unknown>;
    raw["timeoutSec"] = raw["timeout_sec"];
    raw["envAllow"] = raw["env_allow"];
    raw["resultFile"] = raw["result_file"];
    delete raw["timeout_sec"];
    delete raw["env_allow"];
    delete raw["result_file"];

    const result = parseLiveWrapperConfig(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.timeoutSec).toBe(1800);
    expect(result.config.envAllow).toEqual(["PATH", "HOME"]);
    expect(result.config.resultFile).toBe("result.json");
  });

  it("prefers canonical snake_case keys when aliases are also present", () => {
    const result = parseLiveWrapperConfig({
      ...clone(validWrapper),
      timeoutSec: 1,
      envAllow: ["IGNORED"],
      resultFile: "ignored.json"
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.timeoutSec).toBe(1800);
    expect(result.config.envAllow).toEqual(["PATH", "HOME"]);
    expect(result.config.resultFile).toBe("result.json");
  });

  it("rejects a non-mapping value", () => {
    const result = parseLiveWrapperConfig("nope");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("live_wrapper_config_invalid");
  });

  it("rejects an array value", () => {
    const result = parseLiveWrapperConfig(["nope"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("live_wrapper_config_invalid");
  });
});

describe("parseLiveWrapperConfig command", () => {
  it("rejects a missing command", () => {
    const raw = clone(validWrapper) as Record<string, unknown>;
    delete raw["command"];
    const result = parseLiveWrapperConfig(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("live_wrapper_config_invalid");
    expect(result.error).toContain("command");
  });

  it("rejects an empty command", () => {
    const result = parseLiveWrapperConfig({ ...clone(validWrapper), command: "   " });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("live_wrapper_config_invalid");
  });

  it("rejects a relative command path", () => {
    const result = parseLiveWrapperConfig({
      ...clone(validWrapper),
      command: "gnhf-runner"
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("live_wrapper_config_invalid");
    expect(result.error).toContain("absolute");
  });

  it("trims surrounding whitespace from an absolute command", () => {
    const result = parseLiveWrapperConfig({
      ...clone(validWrapper),
      command: "  /usr/bin/gnhf-runner  "
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.command).toBe("/usr/bin/gnhf-runner");
  });
});

describe("parseLiveWrapperConfig args", () => {
  it("rejects a missing args array", () => {
    const raw = clone(validWrapper) as Record<string, unknown>;
    delete raw["args"];
    const result = parseLiveWrapperConfig(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("live_wrapper_config_invalid");
    expect(result.error).toContain("args");
  });

  it("coerces numeric argv entries to strings", () => {
    const result = parseLiveWrapperConfig({
      ...clone(validWrapper),
      args: ["--iteration", 7]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.args).toEqual(["--iteration", "7"]);
  });

  it("rejects a non-array args", () => {
    const result = parseLiveWrapperConfig({ ...clone(validWrapper), args: "x" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("live_wrapper_config_invalid");
  });

  it("rejects a non-string/number argv entry", () => {
    const result = parseLiveWrapperConfig({
      ...clone(validWrapper),
      args: [{}]
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("live_wrapper_config_invalid");
  });
});

describe("parseLiveWrapperConfig cwd", () => {
  it("rejects a missing cwd", () => {
    const raw = clone(validWrapper) as Record<string, unknown>;
    delete raw["cwd"];
    const result = parseLiveWrapperConfig(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("live_wrapper_config_invalid");
    expect(result.error).toContain("cwd");
  });

  it("accepts cwd iteration", () => {
    const result = parseLiveWrapperConfig({
      ...clone(validWrapper),
      cwd: "iteration"
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.cwd).toBe("iteration");
  });

  it("rejects an unknown cwd value", () => {
    const result = parseLiveWrapperConfig({ ...clone(validWrapper), cwd: "home" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("live_wrapper_config_invalid");
  });
});

describe("parseLiveWrapperConfig timeout_sec", () => {
  it("rejects a missing timeout_sec", () => {
    const raw = clone(validWrapper) as Record<string, unknown>;
    delete raw["timeout_sec"];
    const result = parseLiveWrapperConfig(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("live_wrapper_config_invalid");
    expect(result.error).toContain("timeout_sec");
  });

  it("rejects a non-positive timeout_sec", () => {
    const result = parseLiveWrapperConfig({ ...clone(validWrapper), timeout_sec: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("live_wrapper_config_invalid");
  });

  it("rejects a fractional timeout_sec", () => {
    const result = parseLiveWrapperConfig({
      ...clone(validWrapper),
      timeout_sec: 1.5
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("live_wrapper_config_invalid");
  });
});

describe("parseLiveWrapperConfig env_allow", () => {
  it("rejects a missing env_allow array", () => {
    const raw = clone(validWrapper) as Record<string, unknown>;
    delete raw["env_allow"];
    const result = parseLiveWrapperConfig(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("live_wrapper_config_invalid");
    expect(result.error).toContain("env_allow");
  });

  it("rejects a non-array env_allow", () => {
    const result = parseLiveWrapperConfig({
      ...clone(validWrapper),
      env_allow: "PATH"
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("live_wrapper_config_invalid");
  });

  it("rejects an invalid environment variable name", () => {
    const result = parseLiveWrapperConfig({
      ...clone(validWrapper),
      env_allow: ["1BAD"]
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("live_wrapper_config_invalid");
  });
});

describe("parseLiveWrapperConfig result_file", () => {
  it("rejects a missing result_file", () => {
    const raw = clone(validWrapper) as Record<string, unknown>;
    delete raw["result_file"];
    const result = parseLiveWrapperConfig(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("live_wrapper_config_invalid");
    expect(result.error).toContain("result_file");
  });

  it("rejects an absolute result_file", () => {
    const result = parseLiveWrapperConfig({
      ...clone(validWrapper),
      result_file: "/tmp/result.json"
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("live_wrapper_config_invalid");
  });

  it("rejects a result_file that escapes the iteration directory", () => {
    const result = parseLiveWrapperConfig({
      ...clone(validWrapper),
      result_file: "../escape.json"
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("live_wrapper_config_invalid");
  });

  it("rejects a result_file that resolves to the iteration directory", () => {
    for (const resultFile of [".", "./", "nested/..", "nested\\.."]) {
      const result = parseLiveWrapperConfig({
        ...clone(validWrapper),
        result_file: resultFile
      });
      expect(result.ok, `expected invalid for ${resultFile}`).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe("live_wrapper_config_invalid");
      expect(result.error).toContain("result_file");
    }
  });

  it("accepts a nested relative result_file", () => {
    const result = parseLiveWrapperConfig({
      ...clone(validWrapper),
      result_file: "live/result.json"
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.resultFile).toBe("live/result.json");
  });
});

describe("parseLiveWrapperConfig probe", () => {
  it("leaves probe undefined when omitted", () => {
    const raw = clone(validWrapper) as Record<string, unknown>;
    delete raw["probe"];
    const result = parseLiveWrapperConfig(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.probe).toBeUndefined();
  });

  it("defaults the probe timeout when omitted", () => {
    const result = parseLiveWrapperConfig({
      ...clone(validWrapper),
      probe: { command: "/usr/bin/gnhf-probe" }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.probe?.timeoutSec).toBe(
      DEFAULT_LIVE_WRAPPER_PROBE_TIMEOUT_SEC
    );
  });

  it("accepts a probe timeoutSec alias during the durable-config transition", () => {
    const result = parseLiveWrapperConfig({
      ...clone(validWrapper),
      probe: { command: "/usr/bin/gnhf-probe", timeoutSec: 20 }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.probe?.timeoutSec).toBe(20);
  });

  it("rejects a probe without a command", () => {
    const result = parseLiveWrapperConfig({
      ...clone(validWrapper),
      probe: { args: ["--check"] }
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("live_wrapper_config_invalid");
  });

  it("rejects a probe with a relative command path", () => {
    const result = parseLiveWrapperConfig({
      ...clone(validWrapper),
      probe: { command: "gnhf-probe" }
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("live_wrapper_config_invalid");
    expect(result.error).toContain("absolute");
  });

  it("rejects a non-mapping probe", () => {
    const result = parseLiveWrapperConfig({
      ...clone(validWrapper),
      probe: "always"
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("live_wrapper_config_invalid");
  });
});

describe("parseLiveWrapperProfile", () => {
  it("returns live_wrapper_profile_missing when undefined", () => {
    const result = parseLiveWrapperProfile(undefined);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("live_wrapper_profile_missing");
  });

  it("returns live_wrapper_profile_missing when null", () => {
    const result = parseLiveWrapperProfile(null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("live_wrapper_profile_missing");
  });

  it("rejects a non-mapping profile", () => {
    const result = parseLiveWrapperProfile("nope");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("live_wrapper_profile_invalid");
  });

  it("rejects a profile without a name", () => {
    const result = parseLiveWrapperProfile({
      wrappers: { implementation: clone(validWrapper) }
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("live_wrapper_profile_invalid");
    expect(result.error).toContain("name");
  });

  it("rejects a profile without wrappers", () => {
    const result = parseLiveWrapperProfile({ name: "openclaw-live" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("live_wrapper_profile_invalid");
    expect(result.error).toContain("wrappers");
  });

  it("rejects an empty wrappers mapping", () => {
    const result = parseLiveWrapperProfile({
      name: "openclaw-live",
      wrappers: {}
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("live_wrapper_profile_invalid");
  });

  it("rejects an unknown workflow step kind key", () => {
    const result = parseLiveWrapperProfile({
      name: "openclaw-live",
      wrappers: { teleport: clone(validWrapper) }
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("live_wrapper_profile_invalid");
    expect(result.error).toContain("teleport");
  });

  it("surfaces a malformed wrapper with its step kind", () => {
    const broken = clone(validWrapper) as Record<string, unknown>;
    delete broken["command"];
    const result = parseLiveWrapperProfile({
      name: "openclaw-live",
      wrappers: { implementation: broken }
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("live_wrapper_profile_invalid");
    expect(result.error).toContain("implementation");
  });

  it("parses a profile with multiple wrappers", () => {
    const result = parseLiveWrapperProfile({
      name: "openclaw-live",
      wrappers: {
        implementation: clone(validWrapper),
        postflight: { ...clone(validWrapper), command: "/usr/bin/postflight" }
      }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.name).toBe("openclaw-live");
    expect(result.profile.wrappers.size).toBe(2);
    expect(result.profile.wrappers.get("implementation")?.command).toBe(
      "/usr/bin/gnhf-runner"
    );
    expect(result.profile.wrappers.get("postflight")?.command).toBe(
      "/usr/bin/postflight"
    );
  });
});

describe("resolveLiveWrapper", () => {
  const profile = (() => {
    const parsed = parseLiveWrapperProfile({
      name: "openclaw-live",
      wrappers: { implementation: clone(validWrapper) }
    });
    if (!parsed.ok) throw new Error("fixture profile failed to parse");
    return parsed.profile;
  })();

  it("resolves a configured step kind", () => {
    const result = resolveLiveWrapper(profile, "implementation");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe("implementation");
    expect(result.config.command).toBe("/usr/bin/gnhf-runner");
  });

  it("refuses an unknown step kind with live_wrapper_unsupported_kind", () => {
    const result = resolveLiveWrapper(profile, "teleport");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("live_wrapper_unsupported_kind");
  });

  it("refuses a known but unconfigured step kind with live_wrapper_not_configured", () => {
    const result = resolveLiveWrapper(profile, "postflight");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("live_wrapper_not_configured");
  });
});

describe("listConfiguredLiveWrapperKinds", () => {
  it("returns configured kinds in canonical workflow-step order", () => {
    const parsed = parseLiveWrapperProfile({
      name: "openclaw-live",
      wrappers: {
        postflight: { ...clone(validWrapper), command: "/usr/bin/postflight" },
        implementation: clone(validWrapper)
      }
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(listConfiguredLiveWrapperKinds(parsed.profile)).toEqual([
      "implementation",
      "postflight"
    ]);
  });
});

describe("LIVE_WRAPPER_REFUSAL_CODES", () => {
  it("pins the stable refusal vocabulary", () => {
    expect([...LIVE_WRAPPER_REFUSAL_CODES]).toEqual([
      "live_wrapper_config_missing",
      "live_wrapper_config_invalid",
      "live_wrapper_profile_missing",
      "live_wrapper_profile_invalid",
      "live_wrapper_unsupported_kind",
      "live_wrapper_not_configured"
    ]);
  });
});
