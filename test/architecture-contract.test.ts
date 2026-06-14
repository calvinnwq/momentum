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
    expect(architecture.split("\n").length).toBeLessThan(180);
  });

  it("links deeper internal contracts instead of restating the whole runtime", () => {
    for (const rel of [
      "internal/roadmap.md",
      "internal/contracts/workflow-first-runtime.md",
      "internal/contracts/executor-loop.md",
      "internal/contracts/coding-workflow-ownership.md",
      "internal/contracts/intent-apply.md",
      "internal/contracts/source-adapters.md",
    ]) {
      expect(architecture, `ARCHITECTURE.md should link ${rel}`).toContain(rel);
      expect(fs.existsSync(path.join(repoRoot, rel)), `${rel} should exist`).toBe(true);
    }
  });

  it("defines the M11 import direction and boundaries", () => {
    expect(architecture).toContain("src/index.ts -> src/cli.ts -> src/commands/ registry + command families -> domain modules");
    expect(architecture).toContain("index -> cli -> commands -> renderers");
    expect(architecture).toMatch(/Domain modules must not import command modules or renderers/i);
    expect(architecture).toMatch(/Renderers must not\s+mutate state/i);
    expect(architecture).toMatch(/External adapters stay behind domain or command boundaries/i);
  });

  it("pins NGX-412 through NGX-419 migration order", () => {
    const expected = [
      "NGX-412",
      "NGX-413",
      "NGX-414",
      "NGX-415",
      "NGX-416",
      "NGX-417",
      "NGX-418",
      "NGX-419",
    ];
    let cursor = -1;
    for (const issue of expected) {
      const index = architecture.indexOf(issue);
      expect(index, `${issue} should be listed`).toBeGreaterThan(cursor);
      cursor = index;
    }

    expect(architecture).toMatch(/Do not move workflow or read-only command code/i);
    expect(architecture).toMatch(/NGX-413.*NGX-414/s);
  });

  it("is linked from AGENTS.md and the internal roadmap", () => {
    expect(readFile("AGENTS.md")).toContain("ARCHITECTURE.md");
    expect(readFile("internal/roadmap.md")).toContain("../ARCHITECTURE.md");
  });

});

describe("M11 structural guard around src/cli.ts", () => {
  const cli = readFile("src/cli.ts");

  it("keeps src/index.ts thin and pointed at runCli", () => {
    const index = readFile("src/index.ts");

    expect(index).toContain('await import("./cli.js")');
    expect(index).toContain("runCli");
    expect(index).not.toMatch(/\.\/commands\//);
  });

  it("introduces only the explicit command registry skeleton for NGX-412", () => {
    const srcDir = path.join(repoRoot, "src");
    const commandIndex = readFile("src/commands/index.ts");

    expect(fs.existsSync(path.join(srcDir, "commands", "index.ts"))).toBe(true);
    expect(cli).toMatch(/from "\.\/commands\/index\.js"/);
    expect(commandIndex).toContain("createMomentumCommandRegistry");
    expect(commandIndex).not.toMatch(/readdir|glob|fs\./);
  });

  it("extracts read-only and workflow command families through their assigned M11 slices", () => {
    const statusModule = readFile("src/commands/status.ts");

    for (const handler of [
      "function status(",
      "function logs(",
      "function handoff(",
    ]) {
      expect(cli, `src/cli.ts should no longer contain ${handler}`).not.toContain(handler);
      expect(statusModule, `src/commands/status.ts should contain ${handler}`).toContain(handler);
    }

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
  it("extracts goal, source, evidence, project, and intent command families for NGX-415", () => {
    const expectations: Array<[string, string]> = [
      ["function goalStart(", "src/commands/goal/index.ts"],
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
  });

});
