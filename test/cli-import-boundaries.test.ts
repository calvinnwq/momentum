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
const coreDir = path.join("src", "core");
const configDir = path.join("src", "config");
const sharedDir = path.join("src", "shared");

const DURABLE_ROOT_SRC_ALLOWLIST = [
  "src/index.ts",
  "src/cli.ts",
  "src/suppress-sqlite-experimental-warning.ts",
  "src/node-shims.d.ts"
] as const;

type RootSrcException = {
  ownerIssue: "NGX-447" | "NGX-448" | "NGX-449" | "NGX-450";
  targetHome: `src/${string}.ts`;
  reason: string;
};

// Every ARCH-02..ARCH-06 transitional root module has now been drained into its
// owned taxonomy home; NGX-450 moved the final one (src/runner-result.ts) into
// src/core/executors/types.ts (shapes) and src/core/executors/runner-result.ts
// (parsing). This stays declared rather than deleted so a future migration slice
// can re-add a named entry with owner issue, target home, and removal reason if
// root migration debt ever becomes unavoidable again.
const TRANSITIONAL_ROOT_SRC_EXCEPTIONS: Record<string, RootSrcException> = {};

// Renderer -> transitional-root type-only edges. Empty after NGX-449 moved the
// daemon / evidence / goal / source / intent / project modules into
// src/core/<domain>; renderer type-only imports of those now target core and
// are allowed generically by rendererTransitionalImportIsAllowed.
const RENDERER_TYPE_ONLY_TRANSITIONAL_IMPORTS = new Set<string>();

// Renderer -> transitional-root runtime read-only constant edges. Empty after
// NGX-449 relocated the daemon stale-threshold defaults into
// src/config/daemon-defaults, which renderers may import at runtime directly.
const RENDERER_READONLY_TRANSITIONAL_IMPORTS = new Map<string, Set<string>>();

type ImportReference = {
  specifier: string;
  isTypeOnly: boolean;
  runtimeBindings: string[];
};

type ImportEdge = {
  from: string;
  to: string;
  specifier: string;
  isTypeOnly: boolean;
  runtimeBindings: string[];
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
    for (const reference of importReferences(file, source)) {
      const { specifier } = reference;
      if (!specifier.startsWith(".")) continue;
      edges.push({
        from: file,
        to: resolveRelativeImport(file, specifier),
        specifier,
        isTypeOnly: reference.isTypeOnly,
        runtimeBindings: reference.runtimeBindings
      });
    }
  }
  return edges;
}

function importSpecifiers(file: string, source: string): string[] {
  return importReferences(file, source).map((reference) => reference.specifier);
}

function importReferences(file: string, source: string): ImportReference[] {
  const references: ImportReference[] = [];
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  function addModuleSpecifier(
    moduleSpecifier: ts.Expression | undefined,
    isTypeOnly = false,
    runtimeBindings: string[] = []
  ): void {
    if (moduleSpecifier && ts.isStringLiteralLike(moduleSpecifier)) {
      references.push({
        specifier: moduleSpecifier.text,
        isTypeOnly,
        runtimeBindings
      });
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      addModuleSpecifier(
        node.moduleSpecifier,
        importDeclarationIsTypeOnly(node),
        importDeclarationRuntimeBindings(node)
      );
    } else if (ts.isExportDeclaration(node)) {
      addModuleSpecifier(
        node.moduleSpecifier,
        exportDeclarationIsTypeOnly(node),
        exportDeclarationIsTypeOnly(node) ? [] : ["*"]
      );
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1
    ) {
      addModuleSpecifier(node.arguments[0], false, ["*"]);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      references.push({
        specifier: node.argument.literal.text,
        isTypeOnly: true,
        runtimeBindings: []
      });
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return references;
}

function importDeclarationIsTypeOnly(node: ts.ImportDeclaration): boolean {
  const importClause = node.importClause;
  if (!importClause) return false;
  if (importClause.isTypeOnly) return true;
  if (importClause.name) return false;
  const namedBindings = importClause.namedBindings;
  return (
    !!namedBindings &&
    ts.isNamedImports(namedBindings) &&
    namedBindings.elements.length > 0 &&
    namedBindings.elements.every((element) => element.isTypeOnly)
  );
}

function importDeclarationRuntimeBindings(node: ts.ImportDeclaration): string[] {
  const importClause = node.importClause;
  if (!importClause || importClause.isTypeOnly) return [];

  const bindings: string[] = [];
  if (importClause.name) {
    bindings.push("default");
  }

  const namedBindings = importClause.namedBindings;
  if (!namedBindings) return bindings;
  if (ts.isNamespaceImport(namedBindings)) {
    bindings.push("*");
    return bindings;
  }

  bindings.push(
    ...namedBindings.elements
      .filter((element) => !element.isTypeOnly)
      .map((element) => (element.propertyName ?? element.name).text)
  );
  return bindings;
}

function exportDeclarationIsTypeOnly(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  const exportClause = node.exportClause;
  return (
    !!exportClause &&
    ts.isNamedExports(exportClause) &&
    exportClause.elements.length > 0 &&
    exportClause.elements.every((element) => element.isTypeOnly)
  );
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

function isCoreModule(file: string): boolean {
  return file === coreDir || file.startsWith(coreDir + path.sep);
}

function isTransitionalRootSrcException(file: string): boolean {
  return Object.hasOwn(TRANSITIONAL_ROOT_SRC_EXCEPTIONS, file);
}

function isPersistenceOrMutationModule(file: string): boolean {
  if (isAdapterModule(file) || isCoreModule(file) || isTransitionalRootSrcException(file)) {
    return true;
  }

  return /(?:^|[/.-])(?:persist|migrations|db|lock|locks|queue|runs|records|audits|execute|finalize|reconcile|reconciliation|leases|items|intents|branch)(?:[/.-]|$)/.test(
    file
  );
}

function isForbiddenRendererRuntimeTarget(file: string): boolean {
  return (
    isCliEntrypoint(file) ||
    isCommandModule(file) ||
    isAdapterModule(file) ||
    isPersistenceOrMutationModule(file)
  );
}

function rendererTransitionalImportIsAllowed(edge: ImportEdge): boolean {
  if (isCoreModule(edge.to)) return edge.isTypeOnly;
  if (!isTransitionalRootSrcException(edge.to)) return false;

  const key = `${edge.from} -> ${edge.to}`;
  if (edge.isTypeOnly) {
    return RENDERER_TYPE_ONLY_TRANSITIONAL_IMPORTS.has(key);
  }

  const allowedBindings = RENDERER_READONLY_TRANSITIONAL_IMPORTS.get(key);
  return (
    !!allowedBindings &&
    edge.runtimeBindings.length > 0 &&
    edge.runtimeBindings.every((binding) => allowedBindings.has(binding))
  );
}

function rootSourceFiles(): string[] {
  return fs
    .readdirSync(srcRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.join("src", entry.name))
    .sort();
}

function sourceFilesUnder(relativeDir: string): string[] {
  const absolute = path.join(repoRoot, relativeDir);
  if (!fs.existsSync(absolute)) return [];
  return sourceFiles(absolute);
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

  it("classifies inline type-only named imports without treating mixed imports as type-only", () => {
    expect(
      importReferences(
        "src/renderers/example.ts",
        `
          import { type SourceItem } from "../source-items.js";
          export { type WorkflowRunImport } from "../workflow-run-import.js";
          import { write, type CliIo } from "./cli-output.js";
          import DefaultExport, { type GoalSpec } from "../goal-spec.js";
        `
      )
    ).toEqual([
      {
        specifier: "../source-items.js",
        isTypeOnly: true,
        runtimeBindings: []
      },
      {
        specifier: "../workflow-run-import.js",
        isTypeOnly: true,
        runtimeBindings: []
      },
      {
        specifier: "./cli-output.js",
        isTypeOnly: false,
        runtimeBindings: ["write"]
      },
      {
        specifier: "../goal-spec.js",
        isTypeOnly: false,
        runtimeBindings: ["default"]
      }
    ]);
  });

  it("classifies core source modules as renderer runtime boundaries", () => {
    // The runner-result shapes/parsing drained into src/core/executors (NGX-450);
    // its owned core home classifies as a renderer runtime boundary.
    expect(isPersistenceOrMutationModule("src/core/executors/types.ts")).toBe(true);
    expect(isPersistenceOrMutationModule("src/core/executors/runner-result.ts")).toBe(true);
    // Owned core/domain homes (post NGX-449/NGX-450) classify as renderer runtime boundaries.
    expect(isPersistenceOrMutationModule("src/core/daemon/status.ts")).toBe(true);
    expect(isPersistenceOrMutationModule("src/core/goal/status.ts")).toBe(true);
    expect(isPersistenceOrMutationModule("src/core/goal/types.ts")).toBe(true);
    expect(isPersistenceOrMutationModule("src/core/source/context.ts")).toBe(true);
    expect(isPersistenceOrMutationModule("src/core/evidence/handoff.ts")).toBe(true);
    expect(isPersistenceOrMutationModule("src/core/intent/policy.ts")).toBe(true);
    expect(isPersistenceOrMutationModule("src/core/repo/project-rollup.ts")).toBe(true);
  });

  it("classifies CLI entrypoints as forbidden renderer runtime targets", () => {
    expect(isForbiddenRendererRuntimeTarget("src/index.ts")).toBe(true);
    expect(isForbiddenRendererRuntimeTarget("src/cli.ts")).toBe(true);
  });

  it("allows only explicit renderer transitional imports", () => {
    const updateIntentTypeEdge: ImportEdge = {
      from: "src/renderers/evidence.ts",
      to: "src/core/source/update-intent-generator.ts",
      specifier: "../core/source/update-intent-generator.js",
      isTypeOnly: true,
      runtimeBindings: []
    };
    expect(rendererTransitionalImportIsAllowed(updateIntentTypeEdge)).toBe(true);
    expect(
      rendererTransitionalImportIsAllowed({
        ...updateIntentTypeEdge,
        isTypeOnly: false,
        runtimeBindings: ["evaluateGoalForSourceSatisfiedIntent"]
      })
    ).toBe(false);

    const coreTypeEdge: ImportEdge = {
      from: "src/renderers/status.ts",
      to: "src/core/goal/status.ts",
      specifier: "../core/goal/status.js",
      isTypeOnly: true,
      runtimeBindings: []
    };
    expect(rendererTransitionalImportIsAllowed(coreTypeEdge)).toBe(true);
    expect(
      rendererTransitionalImportIsAllowed({
        ...coreTypeEdge,
        isTypeOnly: false,
        runtimeBindings: ["loadGoalStatus"]
      })
    ).toBe(false);
  });

  it("enforces the durable root src allowlist with named transitional debt", () => {
    expect(DURABLE_ROOT_SRC_ALLOWLIST).toEqual([
      "src/index.ts",
      "src/cli.ts",
      "src/suppress-sqlite-experimental-warning.ts",
      "src/node-shims.d.ts"
    ]);

    const allowed = new Set([
      ...DURABLE_ROOT_SRC_ALLOWLIST,
      ...Object.keys(TRANSITIONAL_ROOT_SRC_EXCEPTIONS)
    ]);
    const unexpectedRootFiles = rootSourceFiles().filter((file) => !allowed.has(file));

    expect(
      unexpectedRootFiles,
      "New root src/*.ts files must move into src/core/<domain>, src/config, src/shared, src/adapters, src/commands, or src/renderers; if migration debt is unavoidable, add a named transitional exception with owner issue, target home, and reason."
    ).toEqual([]);

    const staleExceptions = Object.keys(TRANSITIONAL_ROOT_SRC_EXCEPTIONS).filter(
      (file) => !fs.existsSync(path.join(repoRoot, file))
    );
    expect(
      staleExceptions,
      "Remove transitional root allowlist entries after their file moves."
    ).toEqual([]);

    const malformedExceptions = Object.entries(TRANSITIONAL_ROOT_SRC_EXCEPTIONS)
      .filter(([, exception]) => {
        return (
          !/^NGX-(?:447|448|449|450)$/.test(exception.ownerIssue) ||
          !/^src\/(?:core\/(?:workflow|executors|goal|source|intent|daemon|repo|evidence)\/|config\/|shared\/|adapters\/)/.test(
            exception.targetHome
          ) ||
          exception.reason.trim().length < 20
        );
      })
      .map(([file]) => file);

    expect(
      malformedExceptions,
      "Each transitional root src exception must name NGX-447/448/449/450, a target taxonomy home, and a practical removal reason."
    ).toEqual([]);
  });

  it("keeps source taxonomy directories real and placeholder-free", () => {
    const existingTaxonomyDirs = [commandsDir, renderersDir, adaptersDir];
    for (const dir of existingTaxonomyDirs) {
      const files = sourceFilesUnder(dir);
      expect(files.length, `${dir} should contain real TypeScript modules`).toBeGreaterThan(0);
    }

    for (const pendingDir of [coreDir, configDir, sharedDir]) {
      const absolute = path.join(repoRoot, pendingDir);
      if (!fs.existsSync(absolute)) continue;

      const files = sourceFilesUnder(pendingDir);
      expect(
        files.length,
        `${pendingDir} is pending taxonomy; do not create placeholder-only directories.`
      ).toBeGreaterThan(0);
      expect(
        files.filter((file) => /(?:placeholder|todo|stub|junk|example)/i.test(file)),
        `${pendingDir} should contain real ownership modules, not placeholder junk.`
      ).toEqual([]);
    }

    const documentedTargetPrefixes = new Set(
      Object.values(TRANSITIONAL_ROOT_SRC_EXCEPTIONS).map((exception) =>
        exception.targetHome.split("/").slice(0, 3).join("/")
      )
    );
    // Empty now that NGX-450 drained the last transitional root module.
    expect([...documentedTargetPrefixes].sort()).toEqual([]);
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

  it("keeps future src/core modules independent from command and renderer layers", () => {
    const violations = importEdges().filter(
      (edge) =>
        isCoreModule(edge.from) &&
        (isCommandModule(edge.to) || isRendererModule(edge.to))
    );

    expect(
      violations.map(
        (edge) =>
          `${edge.from} imports ${edge.specifier} -> ${edge.to}; core modules own behavior and must not import command parsing or rendering layers.`
      )
    ).toEqual([]);
  });

  it("prevents renderers from importing commands, adapters, or runtime mutation modules", () => {
    const violations = importEdges().filter((edge) => {
      if (!isRendererModule(edge.from)) return false;
      const forbidden = isForbiddenRendererRuntimeTarget(edge.to);
      if (!forbidden) return false;
      return !rendererTransitionalImportIsAllowed(edge);
    });

    expect(
      violations.map(
        (edge) =>
          `${edge.from} imports ${edge.specifier} -> ${edge.to}; renderers must accept computed results and type-only shapes instead of importing CLI entrypoints, commands, adapters, persistence, or mutation modules.`
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

  it("documents how to add future source modules without creating root junk", () => {
    const standard = readFile("internal/contracts/repo-architecture-standard.md");

    expect(standard).toContain("## Adding Source Modules During ARCH Migration");
    expect(standard).toMatch(/Do not add new root `src\/\*\.ts` modules/i);
    expect(standard).toMatch(/src\/core\/<domain>/);
    expect(standard).toMatch(/transitional exception/i);
  });
});
