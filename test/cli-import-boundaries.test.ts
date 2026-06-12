import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const srcRoot = path.join(repoRoot, "src");

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
    const fromImportPattern =
      /\b(?:import|export)\s+(?:type\s+)?[\s\S]*?\s+from\s+["']([^"']+)["']/g;
    const dynamicImportPattern = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
    for (const pattern of [fromImportPattern, dynamicImportPattern]) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1];
        if (!specifier?.startsWith(".")) continue;
        const resolved = path
          .relative(
            repoRoot,
            path.resolve(path.dirname(path.join(repoRoot, file)), specifier)
          )
          .replace(/\.js$/, ".ts");
        edges.push({ from: file, to: resolved, specifier });
      }
    }
  }
  return edges;
}

function commandFamily(file: string): string | null {
  const parts = file.split(path.sep);
  if (parts[0] !== "src" || parts[1] !== "commands") return null;
  if (parts[2] === "index.ts") return null;
  if (parts[2]?.endsWith(".ts")) return parts[2];
  return parts[2] ?? null;
}

function isCliOrRenderer(file: string): boolean {
  return (
    file === path.join("src", "index.ts") ||
    file === path.join("src", "cli.ts") ||
    file.startsWith(path.join("src", "commands") + path.sep) ||
    file.startsWith(path.join("src", "renderers") + path.sep)
  );
}

describe("M11 CLI import boundaries", () => {
  it("keeps core/domain modules independent from commands and renderers", () => {
    const violations = importEdges().filter((edge) => {
      if (isCliOrRenderer(edge.from)) return false;
      return (
        edge.to.startsWith(path.join("src", "commands") + path.sep) ||
        edge.to.startsWith(path.join("src", "renderers") + path.sep)
      );
    });

    expect(
      violations.map(
        (edge) =>
          `${edge.from} imports ${edge.specifier} -> ${edge.to}; move CLI formatting behind src/commands or src/renderers instead of importing it from core/domain code.`
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
      if (isCliOrRenderer(file)) return false;
      return /process\.(?:stdout|stderr)/.test(readFile(file));
    });

    expect(
      violations.map(
        (file) =>
          `${file} reads process stdout/stderr directly; thread output through CliIo and src/renderers instead.`
      )
    ).toEqual([]);
  });

  it("keeps src/cli.ts thin after command-family extraction", () => {
    const lineCount = readFile("src/cli.ts").split("\n").length;

    expect(lineCount, "src/cli.ts should stay below 3000 lines after M11 extraction").toBeLessThan(3000);
  });

  it("documents how to add a command module without crossing boundaries", () => {
    const architecture = readFile("ARCHITECTURE.md");

    expect(architecture).toContain("## Adding a Command Module");
    expect(architecture).toMatch(/Do not import sibling command famil/i);
    expect(architecture).toContain("src/renderers/");
    expect(architecture).toMatch(/src\/cli\.ts.*dispatch/s);
  });
});
