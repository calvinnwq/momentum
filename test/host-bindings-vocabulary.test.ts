import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  listConfiguredHostBindingKinds,
  resolveHostBinding,
} from "../src/adapters/host-bindings-registry.js";
import {
  DAEMON_HOST_BINDINGS_FILE_ENV_VAR,
  readDaemonHostBindingsSource,
  resolveDaemonHostBindings,
  RETIRED_LIVE_WRAPPER_PROFILE_ENV_VAR,
} from "../src/core/workflow/live-wrapper/daemon-host-bindings.js";

const REPO_ROOT = process.cwd();
const bindingsPath = path.join(
  REPO_ROOT,
  "bindings/coding-workflow.host-bindings.json",
);

describe("host-binding vocabulary guard (NGX-668)", () => {
  it("resolves the checked-in source through the production host-binding registry", () => {
    const resolution = resolveDaemonHostBindings(
      { [DAEMON_HOST_BINDINGS_FILE_ENV_VAR]: bindingsPath },
      { loadSource: readDaemonHostBindingsSource },
    );

    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    expect(resolution.source).toBe(bindingsPath);
    expect(listConfiguredHostBindingKinds(resolution.bindings)).toEqual([
      "preflight",
      "implementation",
      "postflight",
      "validate",
      "merge-cleanup",
    ]);

    const implementation = resolveHostBinding(
      resolution.bindings,
      "implementation",
    );
    expect(implementation).toMatchObject({
      ok: true,
      kind: "implementation",
      config: {
        command: "/usr/bin/env",
        cwd: "repo",
        resultFile: "result.json",
      },
    });

    const unsupported = resolveHostBinding(
      resolution.bindings,
      "linear-refresh",
    );
    expect(unsupported).toMatchObject({
      ok: false,
      code: "host_binding_not_configured",
    });
  });

  it("refuses the retired selector without consulting a legacy source", () => {
    const resolution = resolveDaemonHostBindings(
      { [RETIRED_LIVE_WRAPPER_PROFILE_ENV_VAR]: "retired.profile.json" },
      {
        loadSource: () => ({ ok: true as const, contents: "{}" }),
      },
    );

    expect(resolution).toMatchObject({
      status: "invalid",
      code: "retired_selector",
    });
  });
});
