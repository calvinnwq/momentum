import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const srcRoot = path.join(repoRoot, "src");
const commandsDir = path.join("src", "commands");
const renderersDir = path.join("src", "renderers");
const adaptersDir = path.join("src", "adapters");

type ImportEdge = {
  from: string;
  to: string;
  specifier: string;
};

function readFile(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), "utf8");
}

function sourceFiles(dir = srcRoot): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(absolute));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path.relative(repoRoot, absolute));
    }
  }
  return files.sort();
}

function importEdges(): ImportEdge[] {
  const edges: ImportEdge[] = [];
  for (const file of sourceFiles()) {
    const source = readFile(file);
    for (const specifier of importSpecifiers(file, source)) {
      if (!specifier.startsWith(".")) continue;
      edges.push({
        from: file,
        to: resolveRelativeImport(file, specifier),
        specifier
      });
    }
  }
  return edges;
}

function importSpecifiers(file: string, source: string): string[] {
  const specifiers: string[] = [];
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  function addModuleSpecifier(moduleSpecifier: ts.Expression | undefined): void {
    if (moduleSpecifier && ts.isStringLiteralLike(moduleSpecifier)) {
      specifiers.push(moduleSpecifier.text);
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      addModuleSpecifier(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node)) {
      addModuleSpecifier(node.moduleSpecifier);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1
    ) {
      addModuleSpecifier(node.arguments[0]);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

function resolveRelativeImport(file: string, specifier: string): string {
  const resolved = path.relative(
    repoRoot,
    path.resolve(path.dirname(path.join(repoRoot, file)), specifier)
  );
  return resolved.replace(/\.js$/, ".ts");
}

function commandFamily(file: string): string | null {
  const parts = file.split(path.sep);
  if (parts[0] !== "src" || parts[1] !== "commands") return null;
  if (parts[2] === "index.ts") return null;
  if (parts[2]?.endsWith(".ts")) return parts[2];
  return parts[2] ?? null;
}

function isCliEntrypoint(file: string): boolean {
  return (
    file === path.join("src", "index.ts") ||
    file === path.join("src", "cli.ts")
  );
}

function isCommandModule(file: string): boolean {
  return file === commandsDir || file.startsWith(commandsDir + path.sep);
}

function isRendererModule(file: string): boolean {
  return file === renderersDir || file.startsWith(renderersDir + path.sep);
}

function isAdapterModule(file: string): boolean {
  return file === adaptersDir || file.startsWith(adaptersDir + path.sep);
}

describe("M11 CLI import boundaries", () => {
  it("collects all relative import forms for structural checks", () => {
    expect(
      importSpecifiers(
        "src/domain-example.ts",
        `
          import "./commands/source/index.js";
          import type { Source } from "./commands/source/index.js";
          export { render } from "./renderers/source.js";
          const lazy = import("./commands/intent/index.js");
          type Lazy = import("./renderers/intent.js").IntentJsonShape;
        `
      )
    ).toEqual([
      "./commands/source/index.js",
      "./commands/source/index.js",
      "./renderers/source.js",
      "./commands/intent/index.js",
      "./renderers/intent.js"
    ]);
  });

  it("keeps core/domain modules independent from commands and renderers", () => {
    const violations = importEdges().filter((edge) => {
      if (
        isCliEntrypoint(edge.from) ||
        isCommandModule(edge.from) ||
        isRendererModule(edge.from)
      ) {
        return false;
      }
      return isCommandModule(edge.to) || isRendererModule(edge.to);
    });

    expect(
      violations.map(
        (edge) =>
          `${edge.from} imports ${edge.specifier} -> ${edge.to}; move CLI formatting behind src/commands or src/renderers instead of importing it from core/domain code.`
      )
    ).toEqual([]);
  });

  it("prevents renderers from importing command modules", () => {
    const violations = importEdges().filter(
      (edge) => isRendererModule(edge.from) && isCommandModule(edge.to)
    );

    expect(
      violations.map(
        (edge) =>
          `${edge.from} imports ${edge.specifier} -> ${edge.to}; renderers must accept computed results instead of importing command modules.`
      )
    ).toEqual([]);
  });

  it("prevents command families from importing sibling command families for render shapes", () => {
    const violations = importEdges().filter((edge) => {
      const fromFamily = commandFamily(edge.from);
      const toFamily = commandFamily(edge.to);
      return fromFamily !== null && toFamily !== null && fromFamily !== toFamily;
    });

    expect(
      violations.map(
        (edge) =>
          `${edge.from} imports ${edge.specifier} -> ${edge.to}; shared JSON/text shapes belong in src/renderers, not another command family.`
      )
    ).toEqual([]);
  });

  it("keeps direct stdout/stderr process access in CLI or rendering layers", () => {
    const violations = sourceFiles().filter((file) => {
      if (isCliEntrypoint(file) || isRendererModule(file)) return false;
      return /process\.(?:stdout|stderr)/.test(readFile(file));
    });

    expect(
      violations.map(
        (file) =>
          `${file} reads process stdout/stderr directly; thread output through CliIo and src/renderers instead.`
      )
    ).toEqual([]);
  });

  it("keeps infrastructure-facing adapters under src/adapters ownership", () => {
    const expectedAdapters = [
      "src/adapters/db.ts",
      "src/adapters/external-update-adapter.ts",
      "src/adapters/git-transaction.ts",
      "src/adapters/linear-external-update-client.ts",
      "src/adapters/linear-http-client.ts",
      "src/adapters/linear-issue-refresh.ts",
      "src/adapters/acp-config.ts",
      "src/adapters/acp-runner.ts",
      "src/adapters/fake-runner.ts",
      "src/adapters/live-step-wrapper.ts",
      "src/adapters/live-wrapper-registry.ts",
      "src/adapters/source-adapter.ts",
      "src/adapters/linear-source-adapter.ts",
      "src/adapters/runner-adapter.ts",
      "src/adapters/trusted-shell-config.ts",
      "src/adapters/trusted-shell-runner.ts",
      "src/adapters/no-mistakes-executor.ts",
      "src/adapters/no-mistakes-orchestrator.ts",
      "src/adapters/real-workflow-probe.ts"
    ];

    expect(
      expectedAdapters.filter((file) => !fs.existsSync(path.join(repoRoot, file))),
      "NGX-417 adapter/infrastructure modules should have clear ownership under src/adapters"
    ).toEqual([]);

    const rootInfrastructureModules = [
      "src/db.ts",
      "src/external-update-adapter.ts",
      "src/git-transaction.ts",
      "src/linear-external-update-client.ts",
      "src/linear-http-client.ts",
      "src/linear-issue-refresh.ts",
      "src/acp-config.ts",
      "src/acp-runner.ts",
      "src/fake-runner.ts",
      "src/live-step-wrapper.ts",
      "src/live-wrapper-registry.ts",
      "src/source-adapter.ts",
      "src/linear-source-adapter.ts",
      "src/runner-adapter.ts",
      "src/trusted-shell-config.ts",
      "src/trusted-shell-runner.ts",
      "src/no-mistakes-executor.ts",
      "src/no-mistakes-orchestrator.ts",
      "src/real-workflow-probe.ts"
    ];

    expect(
      rootInfrastructureModules.filter((file) =>
        fs.existsSync(path.join(repoRoot, file))
      ),
      "NGX-417 adapter/infrastructure modules should not remain as flat src/ modules after ownership migration"
    ).toEqual([]);
  });

  it("prevents adapters from importing commands or renderers", () => {
    const violations = importEdges().filter(
      (edge) =>
        isAdapterModule(edge.from) &&
        (isCommandModule(edge.to) || isRendererModule(edge.to))
    );

    expect(
      violations.map(
        (edge) =>
          `${edge.from} imports ${edge.specifier} -> ${edge.to}; adapters must stay independent from CLI commands and renderers.`
      )
    ).toEqual([]);
  });

  it("keeps src/cli.ts thin after command-family extraction", () => {
    const lineCount = readFile("src/cli.ts").split("\n").length;

    expect(
      lineCount,
      "src/cli.ts should stay below 3000 lines after M11 extraction"
    ).toBeLessThan(3000);
  });

  it("documents how to add a command module without crossing boundaries", () => {
    const architecture = readFile("ARCHITECTURE.md");

    expect(architecture).toContain("## Adding a Command Module");
    expect(architecture).toMatch(/Do not import sibling command famil/i);
    expect(architecture).toContain("src/renderers/");
    expect(architecture).toMatch(/src\/cli\.ts.*dispatch/s);
  });
});
