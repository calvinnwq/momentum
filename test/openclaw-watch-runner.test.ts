import { describe, expect, it } from "vitest";

import {
  buildOpenClawWatchProcessCommand,
  OpenClawWatchRunnerError,
  parseOpenClawWatchFailureOutput,
  parseOpenClawWatchOutput
} from "../src/adapters/openclaw-watch-runner.js";

describe("buildOpenClawWatchProcessCommand", () => {
  it("preserves source-loader exec arguments for TypeScript entrypoint fallbacks", () => {
    const command = buildOpenClawWatchProcessCommand({
      runId: "cwfp-openclaw",
      dataDir: "/tmp/momentum-home",
      nodePath: "/usr/local/bin/node",
      nodeExecArgv: ["--import", "tsx"],
      distEntrypoint: "/repo/dist/index.js",
      distExists: false,
      argvEntrypoint: "/repo/src/index.ts",
      argvEntrypointExists: true
    });

    expect(command).toEqual({
      command: "/usr/local/bin/node",
      args: [
        "--import",
        "tsx",
        "/repo/src/index.ts",
        "workflow",
        "run",
        "watch",
        "cwfp-openclaw",
        "--once",
        "--data-dir",
        "/tmp/momentum-home",
        "--json"
      ]
    });
  });
});

describe("parseOpenClawWatchFailureOutput", () => {
  it("extracts workflow watch failure envelope codes from stderr", () => {
    const failure = parseOpenClawWatchFailureOutput(
      JSON.stringify({
        ok: false,
        command: "workflow run watch",
        code: "run_not_found",
        message: "Workflow run not found: cwfp-missing",
        runId: "cwfp-missing"
      })
    );

    expect(failure).toEqual({
      code: "run_not_found",
      message: "Workflow run not found: cwfp-missing"
    });
  });

  it("ignores non-envelope stderr diagnostics", () => {
    expect(parseOpenClawWatchFailureOutput("database locked\n")).toBeNull();
    expect(
      parseOpenClawWatchFailureOutput(
        JSON.stringify({
          ok: false,
          command: "workflow run watch",
          code: "",
          message: "missing code"
        })
      )
    ).toBeNull();
  });
});

describe("parseOpenClawWatchOutput", () => {
  it("preserves direct failure envelope codes", () => {
    let thrown: unknown;
    try {
      parseOpenClawWatchOutput(
        JSON.stringify({
          ok: false,
          command: "workflow run watch",
          code: "watch_unsupported_source",
          message: "`workflow run watch --once` is only supported here.",
          runId: "cwfp-openclaw"
        }),
        "cwfp-openclaw"
      )
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(OpenClawWatchRunnerError);
    expect((thrown as OpenClawWatchRunnerError).code).toBe(
      "watch_unsupported_source"
    );
    expect((thrown as Error).message).toBe(
      "`workflow run watch --once` is only supported here."
    );
  });
});
