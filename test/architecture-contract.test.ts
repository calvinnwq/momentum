import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readFile(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), "utf8");
}

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function run(args: string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  let stdout = "";
  let stderr = "";
  const home = fs.mkdtempSync(
    path.join(os.tmpdir(), "momentum-architecture-contract-home-"),
  );
  tempRoots.push(home);
  const code = await runCli(args, {
    stdout: { write: (chunk: string) => ((stdout += chunk), true) },
    stderr: { write: (chunk: string) => ((stderr += chunk), true) },
    env: {
      ...process.env,
      HOME: home,
      MOMENTUM_HOME: path.join(home, ".momentum"),
    },
  });
  return { code, stdout, stderr };
}

describe("root ARCHITECTURE.md contract", () => {
  const architecture = readFile("ARCHITECTURE.md");

  it("exists as a compact index plus contract", () => {
    expect(architecture).toMatch(/^# Momentum Architecture/m);
    expect(architecture).toContain(
      "This file is the repo-level architecture contract",
    );
    expect(architecture).toContain("Deeper Contracts");
    expect(architecture.split("\n").length).toBeLessThan(205);
  });

  it("links compact repo contracts and routes long-form internal docs to the personal wiki", () => {
    expect(architecture).toContain("SPEC.md");
    expect(
      fs.existsSync(path.join(repoRoot, "SPEC.md")),
      "SPEC.md should exist",
    ).toBe(true);
    expect(architecture).toContain("/Workspaces/Momentum");
    expect(architecture).toMatch(/no `internal\/` documentation tree/i);
    expect(
      fs.existsSync(path.join(repoRoot, "internal")),
      "internal/ should not exist",
    ).toBe(false);
  });

  it("defines the import direction and boundaries", () => {
    expect(architecture).toContain(
      "src/index.ts -> src/cli.ts -> src/commands/ registry + command families -> domain modules",
    );
    expect(architecture).toContain("index -> cli -> commands -> renderers");
    expect(architecture).toMatch(
      /Domain modules must not import command modules or renderers/i,
    );
    expect(architecture).toMatch(/Renderers must not\s+mutate state/i);
    expect(architecture).toMatch(
      /External adapters stay behind domain or command boundaries/i,
    );
    expect(architecture).toMatch(
      /daemon,\s+recovery, and doctor remain deliberate\s+`src\/cli\.ts` compatibility surfaces/i,
    );
  });

  it("is linked from AGENTS.md and SPEC.md", () => {
    expect(readFile("AGENTS.md")).toContain("ARCHITECTURE.md");
    expect(readFile("SPEC.md")).toContain("ARCHITECTURE.md");
  });
});

describe("CLI architecture behavior", () => {
  it("routes workflow and migrated command families through the public CLI", async () => {
    const cases = [
      { args: ["workflow", "status", "--json"], command: "workflow status" },
      { args: ["tracker", "list", "--json"], command: "tracker list" },
      { args: ["project", "status", "--json"], command: "project status" },
      { args: ["evidence", "list", "--json"], command: "evidence list" },
      { args: ["intent", "list", "--json"], command: "intent list" },
    ];

    for (const { args, command } of cases) {
      const result = await run(args);
      expect(result.code, command).toBe(0);
      expect(result.stderr, command).toBe("");
      expect(JSON.parse(result.stdout), command).toMatchObject({
        ok: true,
        command,
      });
    }
  });
});
