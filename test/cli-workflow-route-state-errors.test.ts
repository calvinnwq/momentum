import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/cli.js";
import { openDb } from "../src/adapters/db.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function seedRouteRefusal(): string {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "momentum-cli-route-refusal-"),
  );
  tempRoots.push(dataDir);
  const db = new DatabaseSync(path.join(dataDir, "momentum.db"));
  try {
    db.exec(
      fs.readFileSync(
        path.join(__dirname, "fixtures", "v0220-route-state.sql"),
        "utf8",
      ),
    );
    db.prepare(
      "UPDATE workflow_runs SET route_json = ? WHERE id = 'native-simple'",
    ).run('{"unknown":true}');
  } finally {
    db.close();
  }
  return dataDir;
}

async function run(argv: string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    stdout: {
      write(chunk: string) {
        stdout += chunk;
        return true;
      },
    },
    stderr: {
      write(chunk: string) {
        stderr += chunk;
        return true;
      },
    },
    env: {},
  });
  return { code, stdout, stderr };
}

describe("workflow route-state CLI failure normalization", () => {
  const cases = [
    {
      name: "status list",
      argv: ["workflow", "status"],
      command: "workflow status",
    },
    {
      name: "status detail",
      argv: ["workflow", "status", "native-simple"],
      command: "workflow status",
    },
    {
      name: "logs",
      argv: ["workflow", "run", "logs", "native-simple"],
      command: "workflow run logs",
    },
    {
      name: "monitor",
      argv: ["workflow", "run", "monitor", "native-simple"],
      command: "workflow run monitor",
    },
    {
      name: "watch",
      argv: ["workflow", "run", "watch", "native-simple", "--once"],
      command: "workflow run watch",
    },
  ] as const;

  for (const testCase of cases) {
    it(`preserves route diagnostics for ${testCase.name}`, async () => {
      const dataDir = seedRouteRefusal();
      const result = await run([
        ...testCase.argv,
        "--data-dir",
        dataDir,
        "--json",
      ]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toMatchObject({
        ok: false,
        command: testCase.command,
        code: "route_state_unknown_key",
        runId: "native-simple",
        jsonPath: "$.unknown",
        repair: expect.stringContaining("manually repair"),
      });
    });
  }

  it("preserves route diagnostics from compatibility projection", async () => {
    const dataDir = seedRouteRefusal();
    const raw = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      raw
        .prepare(
          "UPDATE workflow_runs SET route_json = ? WHERE id = 'native-simple'",
        )
        .run('{"implementationEngine":"gnhf"}');
    } finally {
      raw.close();
    }
    openDb(dataDir).close();
    const corrupt = new DatabaseSync(path.join(dataDir, "momentum.db"));
    try {
      corrupt
        .prepare(
          `UPDATE workflow_steps
              SET agent_config_json = '{"model":" "}'
            WHERE run_id = 'native-full' AND step_id = 'implementation'`,
        )
        .run();
    } finally {
      corrupt.close();
    }

    const result = await run([
      "workflow",
      "status",
      "native-full",
      "--data-dir",
      dataDir,
      "--json",
    ]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      command: "workflow status",
      code: "route_state_value_invalid",
      runId: "native-full",
      jsonPath: "$.steps.implementation.model",
      repair: expect.stringContaining("manually repair"),
    });
  });
});
