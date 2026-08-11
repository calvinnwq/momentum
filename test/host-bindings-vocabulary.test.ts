import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

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
  it("keeps the retired checked-in profile path out of the repository", () => {
    expect(
      fs.existsSync(
        path.join(
          REPO_ROOT,
          "profiles/coding-workflow-live-wrapper.profile.json",
        ),
      ),
    ).toBe(false);
    expect(fs.existsSync(bindingsPath)).toBe(true);
  });

  it("ships the checked-in host bindings in the strict { bindings } shape", () => {
    const document = JSON.parse(
      fs.readFileSync(bindingsPath, "utf8"),
    ) as Record<string, unknown>;
    expect(Object.keys(document)).toEqual(["bindings"]);
  });

  it("resolves the checked-in source through the production environment path", () => {
    const resolution = resolveDaemonHostBindings(
      { [DAEMON_HOST_BINDINGS_FILE_ENV_VAR]: bindingsPath },
      { loadSource: readDaemonHostBindingsSource },
    );

    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    expect(resolution.source).toBe(bindingsPath);
    expect(resolution.bindings.bindings.has("implementation")).toBe(true);
    expect(resolution.bindings.bindings.has("validate")).toBe(true);
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
