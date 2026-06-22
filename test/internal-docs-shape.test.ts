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

describe("repo internal docs boundary", () => {
  it("does not keep an internal/ documentation tree", () => {
    expect(fs.existsSync(path.join(repoRoot, "internal"))).toBe(false);
  });

  it("keeps compact source-truth anchors in living repo docs", () => {
    for (const rel of ["AGENTS.md", "ARCHITECTURE.md", "SPEC.md"]) {
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

  it("does not link to internal/*.md from repo markdown", () => {
    const docs = [
      path.join(repoRoot, "README.md"),
      path.join(repoRoot, "AGENTS.md"),
      path.join(repoRoot, "ARCHITECTURE.md"),
      path.join(repoRoot, "SPEC.md"),
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
