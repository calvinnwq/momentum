import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const PUBLIC_DOCS_DIR = path.join(repoRoot, "docs");
const README_PATH = path.join(repoRoot, "README.md");

function listMarkdown(dir: string): string[] {
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

function relFromRoot(p: string): string {
  return path.relative(repoRoot, p).split(path.sep).join("/");
}

const publicDocs = listMarkdown(PUBLIC_DOCS_DIR);

const publicSurfaces: { label: string; file: string; body: string }[] = [
  { label: "README.md", file: "README.md", body: fs.readFileSync(README_PATH, "utf8") },
  ...publicDocs.map((file) => ({
    label: relFromRoot(file),
    file: relFromRoot(file),
    body: fs.readFileSync(file, "utf8"),
  })),
];

describe("public docs hygiene", () => {
  describe("README command surface", () => {
    it("lists workflow run watch in the workflow run command summary", () => {
      const workflowRunCommand = publicSurfaces
        .find((surface) => surface.file === "README.md")
        ?.body.split("\n")
        .find((line) => line.startsWith("momentum workflow run "));

      expect(workflowRunCommand).toContain("monitor|watch|logs");
    });
  });

  describe("OpenClaw supervise examples", () => {
    it("uses the valid workflow approval flag in human action examples", () => {
      const doc = publicSurfaces.find(
        (surface) => surface.file === "docs/openclaw-supervise.md"
      )?.body;

      expect(doc).toContain("--approval-boundary");
      expect(doc).toContain("through-implementation");
      expect(doc).not.toMatch(/workflow run approve[^\n"]* --boundary(?:\s|=)/);
    });
  });

  describe("no-mistakes recovery advertisement contract", () => {
    it("distinguishes clear-recovery acceptance from monitor advertising", () => {
      const recovery = publicSurfaces.find(
        (surface) => surface.file === "docs/recovery.md"
      )?.body;
      const commands = publicSurfaces.find(
        (surface) => surface.file === "docs/workflow-commands.md"
      )?.body;
      const ordinaryFailure =
        "Ordinary failed no-mistakes steps still surface as `retry_failed_step` with `recoveryDetail: null` unless the durable manual-recovery context identifies interrupted checks-passed or deterministic-evidence reconciliation.";
      const unflaggedClear =
        "`workflow run clear-recovery` may still accept explicit checks-passed or structured deterministic evidence for an unflagged failed no-mistakes step.";

      expect(recovery).toContain(ordinaryFailure);
      expect(recovery).toContain(unflaggedClear);
      expect(commands).toContain(ordinaryFailure);
      expect(commands).toContain(unflaggedClear);
    });
  });

  describe("no NGX/Linear issue identifiers", () => {
    for (const surface of publicSurfaces) {
      it(`${surface.label} must not reference NGX-* issue identifiers`, () => {
        const matches = surface.body.match(/\bNGX-\d+\b/g) ?? [];
        expect(
          matches,
          `${surface.label} should not contain NGX-* identifiers; move to Obsidian /Workspaces/Momentum`
        ).toEqual([]);
      });
    }
  });

  describe("no internal milestone vocabulary", () => {
    const forbiddenPhrases = [
      /\bMilestone\s+[0-9]+\b/,
      /\bM[0-9]+\b/,
      /\bM[3-9]\s+(contract|alignment|closeout|scope|non-goals|invariant)/i,
      /\b(Milestone\s+[0-9]+|M[3-9])\s+is\s+(complete|the\s+active\s+milestone)\b/i,
      /\bactive\s+milestone\b/i,
      /\bLinear\s+milestone\b/i,
      /\bclose(?:out)?\s+marker\b/i,
      /\bplanned(?:\s+M[0-9]+)?\s+issue\s+order\b/i,
    ];
    for (const surface of publicSurfaces) {
      it(`${surface.label} must not use internal milestone vocabulary`, () => {
        const hits: string[] = [];
        for (const re of forbiddenPhrases) {
          const m = surface.body.match(re);
          if (m) hits.push(m[0]);
        }
        expect(
          hits,
          `${surface.label} should not reference milestone planning vocabulary; move to Obsidian /Workspaces/Momentum`
        ).toEqual([]);
      });
    }
  });

  describe("no links into internal planning tree", () => {
    for (const surface of publicSurfaces) {
      it(`${surface.label} must not link into internal/`, () => {
        const linkRe = /\]\((?:\.\/)?internal\/[^)\s]+\)/g;
        const inlineRe = /\binternal\/(roadmap|milestones|contracts|exclusions|smoke-tests)\b/g;
        const linkHits = surface.body.match(linkRe) ?? [];
        const inlineHits = surface.body.match(inlineRe) ?? [];
        expect(
          [...linkHits, ...inlineHits],
          `${surface.label} should not reference internal/ planning paths`
        ).toEqual([]);
      });
    }
  });

  describe("no references to moved planning files", () => {
    const forbiddenPaths = [
      "docs/roadmap.md",
      "docs/milestones/",
      "docs/contracts/",
      "docs/exclusions.md",
      "docs/smoke-tests.md",
    ];
    for (const surface of publicSurfaces) {
      it(`${surface.label} must not reference moved planning docs`, () => {
        const hits = forbiddenPaths.filter((p) => surface.body.includes(p));
        expect(
          hits,
          `${surface.label} should not reference paths that have moved to internal/`
        ).toEqual([]);
      });
    }
  });

  describe("public docs tree contains no planning files", () => {
    it("docs/ has no milestones/ or contracts/ subdirectories", () => {
      const milestonesDir = path.join(PUBLIC_DOCS_DIR, "milestones");
      const contractsDir = path.join(PUBLIC_DOCS_DIR, "contracts");
      expect(fs.existsSync(milestonesDir), "docs/milestones/ should not exist").toBe(false);
      expect(fs.existsSync(contractsDir), "docs/contracts/ should not exist").toBe(false);
    });

    it("docs/ has no roadmap.md, exclusions.md, or smoke-tests.md", () => {
      for (const name of ["roadmap.md", "exclusions.md", "smoke-tests.md"]) {
        const p = path.join(PUBLIC_DOCS_DIR, name);
        expect(fs.existsSync(p), `docs/${name} should not exist`).toBe(false);
      }
    });
  });
});
