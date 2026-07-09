import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readFile(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), "utf8");
}

describe("root ARCHITECTURE.md contract", () => {
  const architecture = readFile("ARCHITECTURE.md");

  it("exists as a compact index plus contract", () => {
    expect(architecture).toMatch(/^# Momentum Architecture/m);
    expect(architecture).toContain("This file is the repo-level architecture contract");
    expect(architecture).toContain("Deeper Contracts");
    expect(architecture.split("\n").length).toBeLessThan(205);
  });

  it("links compact repo contracts and routes long-form internal docs to the personal wiki", () => {
    expect(architecture).toContain("SPEC.md");
    expect(fs.existsSync(path.join(repoRoot, "SPEC.md")), "SPEC.md should exist").toBe(true);
    expect(architecture).toContain("/Workspaces/Momentum");
    expect(architecture).toMatch(/no `internal\/` documentation tree/i);
    expect(fs.existsSync(path.join(repoRoot, "internal")), "internal/ should not exist").toBe(false);
  });

  it("defines the import direction and boundaries", () => {
    expect(architecture).toContain("src/index.ts -> src/cli.ts -> src/commands/ registry + command families -> domain modules");
    expect(architecture).toContain("index -> cli -> commands -> renderers");
    expect(architecture).toMatch(/Domain modules must not import command modules or renderers/i);
    expect(architecture).toMatch(/Renderers must not\s+mutate state/i);
    expect(architecture).toMatch(/External adapters stay behind domain or command boundaries/i);
    expect(architecture).toMatch(/daemon,\s+recovery, and doctor remain deliberate\s+`src\/cli\.ts` compatibility surfaces/i);
  });

  it("is linked from AGENTS.md and SPEC.md", () => {
    expect(readFile("AGENTS.md")).toContain("ARCHITECTURE.md");
    expect(readFile("SPEC.md")).toContain("ARCHITECTURE.md");
  });

});

describe("structural guard around src/cli.ts", () => {
  const cli = readFile("src/cli.ts");

  it("keeps src/index.ts thin and pointed at runCli", () => {
    const index = readFile("src/index.ts");

    expect(index).toContain('await import("./cli.js")');
    expect(index).toContain("runCli");
    expect(index).not.toMatch(/\.\/commands\//);
  });

  it("introduces only the explicit command registry skeleton", () => {
    const srcDir = path.join(repoRoot, "src");
    const commandIndex = readFile("src/commands/index.ts");

    expect(fs.existsSync(path.join(srcDir, "commands", "index.ts"))).toBe(true);
    expect(cli).toMatch(/from "\.\/commands\/index\.js"/);
    expect(commandIndex).toContain("createMomentumCommandRegistry");
    expect(commandIndex).not.toMatch(/readdir|glob|fs\./);
  });

  it("extracts read-only and workflow command families through their assigned M11 slices", () => {
    for (const handler of [
      "function status(",
      "function logs(",
      "function handoff(",
    ]) {
      expect(cli, `src/cli.ts should no longer contain ${handler}`).not.toContain(handler);
    }
    expect(
      fs.existsSync(path.join(repoRoot, "src", "commands", "status.ts")),
      "the goal-first read-only status family is retired"
    ).toBe(false);

    const workflowModule = readFile("src/commands/workflow/index.ts");
    for (const handler of [
      "function workflow(",
      "function workflowRun(",
      "function workflowRunStart(",
      "function workflowRunMonitor(",
    ]) {
      expect(cli, `src/cli.ts should no longer contain ${handler}`).not.toContain(handler);
      expect(workflowModule, `src/commands/workflow/index.ts should contain ${handler}`).toContain(handler);
    }
  });

  it("extracts source, evidence, project, and intent command families for NGX-415", () => {
    const expectations: Array<[string, string]> = [
      ["function source(", "src/commands/source/index.ts"],
      ["function project(", "src/commands/project/index.ts"],
      ["function evidence(", "src/commands/evidence/index.ts"],
      ["function intent(", "src/commands/intent/index.ts"],
    ];

    for (const [handler, modulePath] of expectations) {
      const module = readFile(modulePath);
      expect(cli, `src/cli.ts should no longer contain ${handler}`).not.toContain(handler);
      expect(module, `${modulePath} should contain ${handler}`).toContain(handler);
    }

    expect(
      fs.existsSync(path.join(repoRoot, "src", "commands", "goal")),
      "the goal-first command family is retired"
    ).toBe(false);
  });

});
