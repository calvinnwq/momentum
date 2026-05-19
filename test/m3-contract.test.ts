import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function readDoc(filename: string): string {
  return fs.readFileSync(path.join(repoRoot, filename), "utf8");
}

function sectionBetween(doc: string, start: string, end: string): string {
  const startIndex = doc.indexOf(start);
  expect(startIndex, `${start} section should exist`).toBeGreaterThanOrEqual(0);

  const endIndex = doc.indexOf(end, startIndex + start.length);
  expect(endIndex, `${end} section should exist after ${start}`).toBeGreaterThan(startIndex);

  return doc.slice(startIndex, endIndex);
}

const M3_ISSUE_ORDER = [
  "NGX-272",
  "NGX-273",
  "NGX-274",
  "NGX-275",
  "NGX-276",
  "NGX-277",
  "NGX-278"
] as const;

const M3_DURABLE_PRIMITIVES = [
  "Goal",
  "Source",
  "Source Item",
  "Iteration",
  "Job",
  "RunnerAdapter",
  "Workflow",
  "Workspace",
  "Event",
  "Handoff"
] as const;

const M3_NON_GOALS_DOC = [
  "Background runner supervision",
  "Cooperative mid-job cancellation",
  "Per-source-item worktrees",
  "Inbound webhooks",
  "Dashboard or UI surface",
  "Strong sandboxing",
  "Remote git operations",
  "External tracker writes"
] as const;

const M3_DOC_PATH = path.join("docs", "milestones", "m3-operational-safety.md");

describe("M3 contract docs (NGX-272..NGX-278)", () => {
  describe("README.md", () => {
    const readme = readDoc("README.md");

    it("keeps milestone detail out of the concise OSS front door", () => {
      expect(readme).not.toContain("## Milestone 3 Alignment");
      expect(readme).not.toContain("Milestone 3 (Operational Safety) is complete");
      for (const id of M3_ISSUE_ORDER) {
        expect(readme).not.toContain(id);
      }
    });

    it("preserves the M3 CLI surface in the compact command overview", () => {
      for (const cmd of [
        "momentum daemon start",
        "stop",
        "status",
        "momentum recovery clear",
        "momentum doctor"
      ]) {
        expect(readme).toContain(cmd);
      }
    });
  });

  describe("docs/index.md", () => {
    const docsIndex = readDoc("docs/index.md");

    it("links to the canonical M3 docs page now that README is concise", () => {
      expect(docsIndex).toMatch(/milestones\/m3-operational-safety\.md/);
    });
  });

  describe("docs/milestones/m3-operational-safety.md", () => {
    const m3doc = readDoc(M3_DOC_PATH);

    it("names M3 complete with the NGX-272..NGX-278 closeout", () => {
      expect(m3doc).toMatch(/Complete \(NGX-272 through NGX-278\)/);
    });

    it("documents the M3 durable primitives", () => {
      expect(m3doc).toContain("## M3 durable primitives");
      for (const term of M3_DURABLE_PRIMITIVES) {
        expect(m3doc).toContain(term);
      }
    });

    it("documents the M3 locked decisions", () => {
      expect(m3doc).toContain("## M3 locked decisions");
      expect(m3doc).toContain("`Goal`");
      expect(m3doc).toContain("policy-gated");
      expect(m3doc).toContain("MOMENTUM.md");
    });

    it("documents the planned M3 issue order matching the Linear milestone", () => {
      expect(m3doc).toContain("## Planned M3 issue order");
      const plannedOrder = sectionBetween(
        m3doc,
        "## Planned M3 issue order",
        "## M3 non-goals (explicit)"
      );
      let cursor = -1;
      for (const id of M3_ISSUE_ORDER) {
        const next = plannedOrder.indexOf(id, cursor + 1);
        expect(next, `${id} should appear after the previous M3 id`).toBeGreaterThan(cursor);
        cursor = next;
      }
    });

    it("calls out explicit M3 non-goals", () => {
      expect(m3doc).toContain("## M3 non-goals (explicit)");
      for (const ng of M3_NON_GOALS_DOC) {
        expect(m3doc).toContain(ng);
      }
    });

    it("documents the Symphony adopt/avoid mapping", () => {
      expect(m3doc).toContain("## Symphony to Momentum mapping");
      expect(m3doc).toContain("Adopt");
      expect(m3doc).toContain("Avoid");
      expect(m3doc).toContain("Single-authority scheduling");
      expect(m3doc).toContain("In-memory-only scheduler state");
    });
  });

  describe("AGENTS.md", () => {
    const agents = readDoc("AGENTS.md");

    it("names Milestone 3 complete with the NGX-272..NGX-278 closeout (NGX-278)", () => {
      expect(agents).toContain("Milestone 3: Operational Safety is complete");
      for (const id of M3_ISSUE_ORDER) {
        expect(agents).toContain(id);
      }
    });

    it("preserves the ## Milestone 3 alignment block", () => {
      expect(agents).toContain("## Milestone 3 alignment");
    });
  });

  it("keeps the doctor milestone string off the M2 closeout marker after the M3 closeout (NGX-278)", () => {
    const cli = fs.readFileSync(path.join(repoRoot, "src", "cli.ts"), "utf8");
    expect(cli).not.toContain(
      "Milestone 2: queue and worker model (NGX-245, NGX-246, NGX-247, NGX-248, NGX-249, NGX-250) complete"
    );
  });
});
