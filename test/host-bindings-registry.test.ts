import { describe, expect, it } from "vitest";

import {
  DEFAULT_HOST_BINDING_PROBE_TIMEOUT_SEC,
  HOST_BINDING_REFUSAL_CODES,
  listConfiguredHostBindingKinds,
  parseHostBinding,
  parseHostBindings,
  resolveHostBinding,
} from "../src/adapters/host-bindings-registry.js";

const validBinding = {
  command: "/usr/bin/gnhf-runner",
  args: ["--run", "1"],
  cwd: "repo",
  timeout_sec: 1800,
  env_allow: ["PATH", "HOME"],
  result_file: "result.json",
  probe: {
    command: "/usr/bin/gnhf-probe",
    args: ["--check"],
    timeout_sec: 15,
  },
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("parseHostBinding missing", () => {
  it("returns host_binding_missing when value is undefined", () => {
    const result = parseHostBinding(undefined);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_binding_missing");
  });

  it("returns host_binding_missing when value is null", () => {
    const result = parseHostBinding(null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_binding_missing");
  });
});

describe("parseHostBinding shape", () => {
  it("maps a fully specified wrapper into a typed config", () => {
    const result = parseHostBinding({
      ...clone(validBinding),
      command_identity: "repo-cleanup",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.command).toBe("/usr/bin/gnhf-runner");
    expect(result.config.commandIdentity).toBe("repo-cleanup");
    expect(result.config.args).toEqual(["--run", "1"]);
    expect(result.config.cwd).toBe("repo");
    expect(result.config.timeoutSec).toBe(1800);
    expect(result.config.envAllow).toEqual(["PATH", "HOME"]);
    expect(result.config.resultFile).toBe("result.json");
    expect(result.config.probe).toEqual({
      command: "/usr/bin/gnhf-probe",
      args: ["--check"],
      timeoutSec: 15,
    });
  });

  it("rejects an unsafe portable command identity", () => {
    const result = parseHostBinding({
      ...clone(validBinding),
      command_identity: "/tmp/repo-cleanup",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_binding_invalid");
    expect(result.error).toContain("command_identity");
  });

  it.each(["@scope:cleanup", "cleanup+safe"])(
    "accepts SDK-compatible portable command identity %s",
    (commandIdentity) => {
      const result = parseHostBinding({
        ...clone(validBinding),
        command_identity: commandIdentity,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.config.commandIdentity).toBe(commandIdentity);
    },
  );

  it("rejects a retired camelCase alias that replaces its canonical key", () => {
    for (const [alias, canonical] of [
      ["timeoutSec", "timeout_sec"],
      ["envAllow", "env_allow"],
      ["resultFile", "result_file"],
    ] as const) {
      const raw = clone(validBinding) as Record<string, unknown>;
      raw[alias] = raw[canonical];
      delete raw[canonical];

      const result = parseHostBinding(raw);
      expect(result.ok, `expected invalid for ${alias}`).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe("host_binding_invalid");
      expect(result.error).toContain(alias);
      expect(result.error).toContain(canonical);
    }
  });

  it("rejects a retired camelCase alias even when the canonical key is also present", () => {
    for (const [alias, aliasValue] of [
      ["timeoutSec", 1800],
      ["envAllow", ["PATH", "HOME"]],
      ["resultFile", "result.json"],
    ] as const) {
      const result = parseHostBinding({
        ...clone(validBinding),
        [alias]: aliasValue,
      });
      expect(result.ok, `expected invalid for ${alias}`).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe("host_binding_invalid");
      expect(result.error).toContain(alias);
    }
  });

  it("names a retired alias even when the rest of the config is malformed", () => {
    for (const [alias, canonical, aliasValue] of [
      ["timeoutSec", "timeout_sec", 30],
      ["envAllow", "env_allow", ["PATH"]],
      ["resultFile", "result_file", "result.json"],
    ] as const) {
      // No `command`, `args`, or `cwd`: the alias refusal must still win.
      const result = parseHostBinding({ [alias]: aliasValue });
      expect(result.ok, `expected invalid for ${alias}`).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe("host_binding_invalid");
      expect(result.error).toContain(alias);
      expect(result.error).toContain(canonical);
    }
  });

  it("still tolerates unrelated unknown keys", () => {
    const result = parseHostBinding({
      ...clone(validBinding),
      nickname: "gnhf",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a non-mapping value", () => {
    const result = parseHostBinding("nope");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_binding_invalid");
  });

  it("rejects an array value", () => {
    const result = parseHostBinding(["nope"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_binding_invalid");
  });
});

describe("parseHostBinding command", () => {
  it("rejects a missing command", () => {
    const raw = clone(validBinding) as Record<string, unknown>;
    delete raw["command"];
    const result = parseHostBinding(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_binding_invalid");
    expect(result.error).toContain("command");
  });

  it("rejects an empty command", () => {
    const result = parseHostBinding({
      ...clone(validBinding),
      command: "   ",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_binding_invalid");
  });

  it("rejects a relative command path", () => {
    const result = parseHostBinding({
      ...clone(validBinding),
      command: "gnhf-runner",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_binding_invalid");
    expect(result.error).toContain("absolute");
  });

  it("trims surrounding whitespace from an absolute command", () => {
    const result = parseHostBinding({
      ...clone(validBinding),
      command: "  /usr/bin/gnhf-runner  ",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.command).toBe("/usr/bin/gnhf-runner");
  });
});

describe("parseHostBinding args", () => {
  it("rejects a missing args array", () => {
    const raw = clone(validBinding) as Record<string, unknown>;
    delete raw["args"];
    const result = parseHostBinding(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_binding_invalid");
    expect(result.error).toContain("args");
  });

  it("coerces numeric argv entries to strings", () => {
    const result = parseHostBinding({
      ...clone(validBinding),
      args: ["--iteration", 7],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.args).toEqual(["--iteration", "7"]);
  });

  it("rejects a non-array args", () => {
    const result = parseHostBinding({
      ...clone(validBinding),
      args: "x",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_binding_invalid");
  });

  it("rejects a non-string/number argv entry", () => {
    const result = parseHostBinding({
      ...clone(validBinding),
      args: [{}],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_binding_invalid");
  });
});

describe("parseHostBinding cwd", () => {
  it("rejects a missing cwd", () => {
    const raw = clone(validBinding) as Record<string, unknown>;
    delete raw["cwd"];
    const result = parseHostBinding(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_binding_invalid");
    expect(result.error).toContain("cwd");
  });

  it("accepts cwd iteration", () => {
    const result = parseHostBinding({
      ...clone(validBinding),
      cwd: "iteration",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.cwd).toBe("iteration");
  });

  it("rejects an unknown cwd value", () => {
    const result = parseHostBinding({
      ...clone(validBinding),
      cwd: "home",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_binding_invalid");
  });
});

describe("parseHostBinding timeout_sec", () => {
  it("rejects a missing timeout_sec", () => {
    const raw = clone(validBinding) as Record<string, unknown>;
    delete raw["timeout_sec"];
    const result = parseHostBinding(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_binding_invalid");
    expect(result.error).toContain("timeout_sec");
  });

  it("rejects a non-positive timeout_sec", () => {
    const result = parseHostBinding({
      ...clone(validBinding),
      timeout_sec: 0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_binding_invalid");
  });

  it("rejects a fractional timeout_sec", () => {
    const result = parseHostBinding({
      ...clone(validBinding),
      timeout_sec: 1.5,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_binding_invalid");
  });

  it("rejects a timeout_sec above the built-in supervisor limit", () => {
    const result = parseHostBinding({
      ...clone(validBinding),
      timeout_sec: 2_147_454,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_binding_invalid");
    expect(result.error).toContain("must not exceed 2147453 seconds");
  });
});

describe("parseHostBinding env_allow", () => {
  it("rejects a missing env_allow array", () => {
    const raw = clone(validBinding) as Record<string, unknown>;
    delete raw["env_allow"];
    const result = parseHostBinding(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_binding_invalid");
    expect(result.error).toContain("env_allow");
  });

  it("rejects a non-array env_allow", () => {
    const result = parseHostBinding({
      ...clone(validBinding),
      env_allow: "PATH",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_binding_invalid");
  });

  it("rejects an invalid environment variable name", () => {
    const result = parseHostBinding({
      ...clone(validBinding),
      env_allow: ["1BAD"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_binding_invalid");
  });
});

describe("parseHostBinding result_file", () => {
  it("rejects a missing result_file", () => {
    const raw = clone(validBinding) as Record<string, unknown>;
    delete raw["result_file"];
    const result = parseHostBinding(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_binding_invalid");
    expect(result.error).toContain("result_file");
  });

  it("rejects an absolute result_file", () => {
    const result = parseHostBinding({
      ...clone(validBinding),
      result_file: "/tmp/result.json",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_binding_invalid");
  });

  it("rejects a result_file that escapes the iteration directory", () => {
    const result = parseHostBinding({
      ...clone(validBinding),
      result_file: "../escape.json",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_binding_invalid");
  });

  it("rejects a result_file that resolves to the iteration directory", () => {
    for (const resultFile of [".", "./", "nested/..", "nested\\.."]) {
      const result = parseHostBinding({
        ...clone(validBinding),
        result_file: resultFile,
      });
      expect(result.ok, `expected invalid for ${resultFile}`).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe("host_binding_invalid");
      expect(result.error).toContain("result_file");
    }
  });

  it("accepts a nested relative result_file", () => {
    const result = parseHostBinding({
      ...clone(validBinding),
      result_file: "live/result.json",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.resultFile).toBe("live/result.json");
  });
});

describe("parseHostBinding probe", () => {
  it("leaves probe undefined when omitted", () => {
    const raw = clone(validBinding) as Record<string, unknown>;
    delete raw["probe"];
    const result = parseHostBinding(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.probe).toBeUndefined();
  });

  it("defaults the probe timeout when omitted", () => {
    const result = parseHostBinding({
      ...clone(validBinding),
      probe: { command: "/usr/bin/gnhf-probe" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.probe?.timeoutSec).toBe(
      DEFAULT_HOST_BINDING_PROBE_TIMEOUT_SEC,
    );
  });

  it("rejects the retired probe timeoutSec alias when it replaces probe.timeout_sec", () => {
    const result = parseHostBinding({
      ...clone(validBinding),
      probe: { command: "/usr/bin/gnhf-probe", timeoutSec: 20 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_binding_invalid");
    expect(result.error).toContain("probe.timeoutSec");
    expect(result.error).toContain("probe.timeout_sec");
  });

  it("names the retired probe timeoutSec alias even when the probe is otherwise malformed", () => {
    // No probe `command`: the alias refusal must still win.
    const result = parseHostBinding({
      ...clone(validBinding),
      probe: { timeoutSec: 20 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_binding_invalid");
    expect(result.error).toContain("probe.timeoutSec");
    expect(result.error).toContain("probe.timeout_sec");
  });

  it("rejects the retired probe timeoutSec alias even when probe.timeout_sec is also present", () => {
    const result = parseHostBinding({
      ...clone(validBinding),
      probe: {
        command: "/usr/bin/gnhf-probe",
        timeout_sec: 15,
        timeoutSec: 20,
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_binding_invalid");
    expect(result.error).toContain("probe.timeoutSec");
  });

  it("rejects a probe timeout above the built-in supervisor limit", () => {
    const result = parseHostBinding({
      ...clone(validBinding),
      probe: {
        command: "/usr/bin/gnhf-probe",
        timeout_sec: 2_147_454,
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_binding_invalid");
    expect(result.error).toContain("must not exceed 2147453 seconds");
  });

  it("rejects a probe without a command", () => {
    const result = parseHostBinding({
      ...clone(validBinding),
      probe: { args: ["--check"] },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_binding_invalid");
  });

  it("rejects a probe with a relative command path", () => {
    const result = parseHostBinding({
      ...clone(validBinding),
      probe: { command: "gnhf-probe" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_binding_invalid");
    expect(result.error).toContain("absolute");
  });

  it("rejects a non-mapping probe", () => {
    const result = parseHostBinding({
      ...clone(validBinding),
      probe: "always",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_binding_invalid");
  });
});

describe("parseHostBindings", () => {
  it("returns host_bindings_missing when undefined", () => {
    const result = parseHostBindings(undefined);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_bindings_missing");
  });

  it("returns host_bindings_missing when null", () => {
    const result = parseHostBindings(null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_bindings_missing");
  });

  it("rejects a non-mapping document", () => {
    const result = parseHostBindings("nope");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_bindings_invalid");
  });

  it("parses a strict top-level bindings mapping keyed by step capability", () => {
    const result = parseHostBindings({
      bindings: { implementation: clone(validBinding) },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bindings.bindings.has("implementation")).toBe(true);
  });

  it("rejects the retired live-wrapper profile shape with a migration diagnostic", () => {
    const result = parseHostBindings({
      name: "daemon-default",
      wrappers: { implementation: clone(validBinding) },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_bindings_invalid");
    expect(result.error).toContain("bindings");
    expect(result.error).toContain("wrappers");
  });

  it("rejects the retired wrappers mapping even alongside a valid bindings mapping", () => {
    const result = parseHostBindings({
      bindings: { implementation: clone(validBinding) },
      wrappers: { implementation: clone(validBinding) },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_bindings_invalid");
    expect(result.error).toContain("wrappers");
  });

  it("rejects unknown top-level keys even alongside a valid bindings mapping", () => {
    const result = parseHostBindings({
      bindings: { implementation: clone(validBinding) },
      name: "extra-identity",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_bindings_invalid");
    expect(result.error).toContain("name");
  });

  it("rejects a document without a bindings mapping", () => {
    const result = parseHostBindings({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_bindings_invalid");
    expect(result.error).toContain("bindings");
  });

  it("rejects an empty bindings mapping", () => {
    const result = parseHostBindings({ bindings: {} });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_bindings_invalid");
  });

  it("rejects an unknown workflow step kind key", () => {
    const result = parseHostBindings({
      bindings: { teleport: clone(validBinding) },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_bindings_invalid");
    expect(result.error).toContain("teleport");
  });

  it("surfaces a malformed binding with its step kind", () => {
    const broken = clone(validBinding) as Record<string, unknown>;
    delete broken["command"];
    const result = parseHostBindings({
      bindings: { implementation: broken },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_bindings_invalid");
    expect(result.error).toContain("implementation");
  });

  it("parses a document with multiple bindings", () => {
    const result = parseHostBindings({
      bindings: {
        implementation: clone(validBinding),
        postflight: { ...clone(validBinding), command: "/usr/bin/postflight" },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bindings.bindings.size).toBe(2);
    expect(result.bindings.bindings.get("implementation")?.command).toBe(
      "/usr/bin/gnhf-runner",
    );
    expect(result.bindings.bindings.get("postflight")?.command).toBe(
      "/usr/bin/postflight",
    );
  });

  it("uses the canonical binding before validating a legacy alias", () => {
    const result = parseHostBindings({
      bindings: {
        validate: clone(validBinding),
        "no-mistakes": {},
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bindings.bindings.get("validate")?.command).toBe(
      "/usr/bin/gnhf-runner",
    );
  });
});

describe("resolveHostBinding", () => {
  const bindings = (() => {
    const parsed = parseHostBindings({
      bindings: { implementation: clone(validBinding) },
    });
    if (!parsed.ok) throw new Error("fixture bindings failed to parse");
    return parsed.bindings;
  })();

  it("resolves a configured step kind", () => {
    const result = resolveHostBinding(bindings, "implementation");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe("implementation");
    expect(result.config.command).toBe("/usr/bin/gnhf-runner");
  });

  it("resolves a legacy step kind through its canonical binding", () => {
    const parsed = parseHostBindings({
      bindings: { "no-mistakes": clone(validBinding) },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = resolveHostBinding(parsed.bindings, "no-mistakes");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe("validate");
    expect(result.config.command).toBe("/usr/bin/gnhf-runner");
  });

  it("refuses an unknown step kind with host_binding_unsupported_kind", () => {
    const result = resolveHostBinding(bindings, "teleport");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_binding_unsupported_kind");
  });

  it("refuses a known but unconfigured step kind with host_binding_not_configured", () => {
    const result = resolveHostBinding(bindings, "postflight");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("host_binding_not_configured");
  });
});

describe("listConfiguredHostBindingKinds", () => {
  it("returns configured kinds in canonical workflow-step order", () => {
    const parsed = parseHostBindings({
      bindings: {
        postflight: { ...clone(validBinding), command: "/usr/bin/postflight" },
        implementation: clone(validBinding),
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(listConfiguredHostBindingKinds(parsed.bindings)).toEqual([
      "implementation",
      "postflight",
    ]);
  });
});

describe("HOST_BINDING_REFUSAL_CODES", () => {
  it("pins the stable refusal vocabulary", () => {
    expect([...HOST_BINDING_REFUSAL_CODES]).toEqual([
      "host_binding_missing",
      "host_binding_invalid",
      "host_bindings_missing",
      "host_bindings_invalid",
      "host_binding_unsupported_kind",
      "host_binding_not_configured",
    ]);
  });
});
