import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readDoc(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}

function listMarkdown(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listMarkdown(full));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

const approvedInternalDocExceptions: string[] = [];

function normalizeRel(rel: string): string {
  return rel.split(path.sep).join("/");
}

function isInternalDocPath(rel: string): boolean {
  const normalized = normalizeRel(rel);
  return normalized === "internal" || normalized.startsWith("internal/");
}

function findInternalDocBoundaryViolations(paths: string[]): string[] {
  return paths
    .map(normalizeRel)
    .filter(isInternalDocPath)
    .filter((rel) => !approvedInternalDocExceptions.includes(rel))
    .map((rel) => `${rel}: repo-local internal docs are not allowed`);
}

describe("repo internal docs boundary", () => {
  it("does not keep an internal/ documentation tree", () => {
    expect(fs.existsSync(path.join(repoRoot, "internal"))).toBe(false);
  });

  it("has no standing internal-doc exceptions", () => {
    expect(approvedInternalDocExceptions).toEqual([]);
  });

  it("rejects simulated internal docs instead of allowing hidden anchors", () => {
    expect(
      findInternalDocBoundaryViolations([
        "internal/README.md",
        "internal/contracts/runtime.md",
        "internal/milestones/m10.md",
        "SPEC.md",
        "docs/recovery.md",
      ])
    ).toEqual([
      "internal/README.md: repo-local internal docs are not allowed",
      "internal/contracts/runtime.md: repo-local internal docs are not allowed",
      "internal/milestones/m10.md: repo-local internal docs are not allowed",
    ]);
  });

  it("keeps compact source-truth anchors in living repo docs", () => {
    for (const rel of ["AGENTS.md", "ARCHITECTURE.md", "SPEC.md", "VISION.md"]) {
      const body = readDoc(rel);
      expect(body.trim().length, `${rel} should not be empty`).toBeGreaterThan(0);
      expect(body, `${rel} should route long-form docs to Obsidian`).toContain(
        "/Workspaces/Momentum"
      );
    }

    const spec = readDoc("SPEC.md");
    for (const phrase of [
      "WorkflowDefinition",
      "ExecutorInvocation",
      "external-apply",
      "subworkflow",
      "coding workflow runtime",
      "Runtime Consolidation",
      "api.linear.app",
    ]) {
      expect(spec, `SPEC.md should preserve current contract term ${phrase}`).toContain(phrase);
    }
  });

  it("documents where internal docs go and how exceptions are reviewed", () => {
    for (const rel of ["AGENTS.md", "SPEC.md", "VISION.md"]) {
      const body = readDoc(rel);
      expect(body, `${rel} should keep Obsidian as the durable internal home`).toContain(
        "/Workspaces/Momentum"
      );
      expect(body, `${rel} should make internal-doc exceptions explicit`).toContain(
        "There are no standing exceptions for repo-local `internal/` docs"
      );
      expect(body, `${rel} should require tests for any future exception`).toContain(
        "docs-boundary tests"
      );
    }
  });

  it("does not link to internal/*.md from repo markdown", () => {
    const docs = [
      path.join(repoRoot, "README.md"),
      path.join(repoRoot, "AGENTS.md"),
      path.join(repoRoot, "ARCHITECTURE.md"),
      path.join(repoRoot, "SPEC.md"),
      path.join(repoRoot, "VISION.md"),
      ...listMarkdown(path.join(repoRoot, "docs")),
    ];

    const hits: string[] = [];
    for (const doc of docs) {
      const rel = path.relative(repoRoot, doc).split(path.sep).join("/");
      const body = fs.readFileSync(doc, "utf8");
      const matches = body.match(/\binternal\/[A-Za-z0-9./_-]+/g) ?? [];
      hits.push(...matches.map((match) => `${rel}: ${match}`));
    }

    expect(hits, `repo markdown must not reference internal paths: ${hits.join("; ")}`).toEqual([]);
  });

  it("keeps public docs free of Obsidian-only internal routing details", () => {
    const publicDocs = [
      path.join(repoRoot, "README.md"),
      ...listMarkdown(path.join(repoRoot, "docs")),
    ];

    const hits: string[] = [];
    for (const doc of publicDocs) {
      const rel = path.relative(repoRoot, doc).split(path.sep).join("/");
      const body = fs.readFileSync(doc, "utf8");
      if (body.includes("/Workspaces/Momentum")) hits.push(rel);
    }

    expect(hits, "public docs should not mention the private Obsidian workspace").toEqual([]);
  });
});
