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

const M4_ISSUE_ORDER = [
  "NGX-279",
  "NGX-280",
  "NGX-281",
  "NGX-282",
  "NGX-283",
  "NGX-284",
  "NGX-285",
  "NGX-286"
] as const;

const M4_NON_GOALS_DOC = [
  "External tracker writes",
  "Inbound webhooks",
  "Worktrees / per-source-item workspaces",
  "Background runner supervision",
  "Dashboard or UI surface",
  "Strong sandboxing",
  "Cooperative mid-job cancellation / signal handling",
  "Remote git operations"
] as const;

const M4_NON_GOALS_AGENTS = [
  "external tracker writes",
  "inbound webhooks",
  "per-source-item worktrees / parallel same-repo Goals",
  "background runner supervision",
  "dashboards / UI surfaces",
  "strong sandboxing",
  "cooperative mid-job cancellation / signal handling",
  "remote git operations"
] as const;

const M4_DOC_PATH = path.join("docs", "milestones", "m4-real-runners.md");

describe("M4 contract docs (NGX-279..NGX-286)", () => {
  describe("README.md", () => {
    const readme = readDoc("README.md");

    it("names Milestone 4 complete with the NGX-279..NGX-286 closeout (NGX-286)", () => {
      expect(readme).toContain("## Milestone 4 Roadmap");
      expect(readme).toContain("Milestone 4 (Real Runner Profiles) is complete");
      for (const id of M4_ISSUE_ORDER) {
        expect(readme).toContain(id);
      }
    });

    it("links to the canonical M4 docs page (NGX-295 OSS reshape)", () => {
      expect(readme).toMatch(/docs\/milestones\/m4-real-runners\.md/);
    });

    it("preserves M3 closeout markers and the M3 Alignment narrative", () => {
      expect(readme).toContain("Milestone 3 (Operational Safety) is complete");
      expect(readme).toContain("## Milestone 3 Alignment");
      for (const id of [
        "NGX-272",
        "NGX-273",
        "NGX-274",
        "NGX-275",
        "NGX-276",
        "NGX-277",
        "NGX-278"
      ]) {
        expect(readme).toContain(id);
      }
    });

    it("keeps the top milestone summary aligned with M4 scope", () => {
      expect(readme).toContain("Real runner profiles and the runtime `MOMENTUM.md` policy loader shipped in Milestone 4");
      expect(readme).not.toContain("real runner profiles (Codex / Claude / OpenCode / ACP backends), and a runtime `MOMENTUM.md` loader");
    });

    it("preserves the M3 CLI surface", () => {
      for (const cmd of [
        "momentum daemon start",
        "momentum daemon stop",
        "momentum daemon status",
        "momentum recovery clear",
        "momentum doctor"
      ]) {
        expect(readme).toContain(cmd);
      }
    });
  });

  describe("docs/milestones/m4-real-runners.md", () => {
    const m4doc = readDoc(M4_DOC_PATH);

    it("names M4 complete with the NGX-279..NGX-286 closeout", () => {
      expect(m4doc).toMatch(/Complete \(NGX-279 through NGX-286\)/);
    });

    it("documents the runner architecture decision (core vs RunnerAdapter)", () => {
      expect(m4doc).toContain("## M4 architecture: Momentum core vs runner adapters");
      expect(m4doc).toContain("`RunnerAdapter`");
      expect(m4doc).toContain("Momentum core");
    });

    it("names the initial supported M4 runner family", () => {
      expect(m4doc).toContain("## M4 runner family");
      expect(m4doc).toMatch(/`fake`/);
      expect(m4doc).toMatch(/`trusted-shell`/);
      expect(m4doc).toMatch(/ACP\/acpx/);
    });

    it("documents the planned M4 issue order matching the Linear milestone", () => {
      expect(m4doc).toContain("## Planned M4 issue order");
      const plannedOrder = sectionBetween(
        m4doc,
        "## Planned M4 issue order",
        "## M4 non-goals (explicit)"
      );
      let cursor = -1;
      for (const id of M4_ISSUE_ORDER) {
        const next = plannedOrder.indexOf(id, cursor + 1);
        expect(next, `${id} should appear after the previous M4 id`).toBeGreaterThan(cursor);
        cursor = next;
      }
    });

    it("calls out explicit M4 non-goals", () => {
      expect(m4doc).toContain("## M4 non-goals (explicit)");
      for (const ng of M4_NON_GOALS_DOC) {
        expect(m4doc).toContain(ng);
      }
    });

    it("preserves M3 contracts through M4", () => {
      expect(m4doc).toContain("## M3 contracts preserved");
      for (const cmd of [
        "daemon start",
        "daemon stop",
        "daemon status",
        "recovery clear"
      ]) {
        expect(m4doc).toContain(cmd);
      }
    });
  });

  describe("AGENTS.md", () => {
    const agents = readDoc("AGENTS.md");

    it("names Milestone 4 complete with the NGX-279..NGX-286 closeout (NGX-286)", () => {
      expect(agents).toContain("Milestone 4: Real Runner Profiles is complete");
      for (const id of M4_ISSUE_ORDER) {
        expect(agents).toContain(id);
      }
    });

    it("documents the M4 contract block (runner architecture + non-goals)", () => {
      expect(agents).toContain("## Milestone 4 contract");
      expect(agents).toContain("`RunnerAdapter`");
      expect(agents).toContain("`trusted-shell`");
      for (const ng of M4_NON_GOALS_AGENTS) {
        expect(agents).toContain(ng);
      }
    });

    it("documents the planned M4 issue order in the same sequence as README", () => {
      let cursor = -1;
      for (const id of M4_ISSUE_ORDER) {
        const next = agents.indexOf(id, cursor + 1);
        expect(next, `${id} should appear after the previous M4 id`).toBeGreaterThan(cursor);
        cursor = next;
      }
    });

    it("preserves the M3 complete bullets verbatim", () => {
      expect(agents).toContain("Milestone 3: Operational Safety is complete");
      for (const id of [
        "NGX-272",
        "NGX-273",
        "NGX-274",
        "NGX-275",
        "NGX-276",
        "NGX-277",
        "NGX-278"
      ]) {
        expect(agents).toContain(id);
      }
    });

    it("preserves the M3 CLI surface bullets", () => {
      for (const cmd of [
        "`daemon start`",
        "`daemon stop`",
        "`daemon status`",
        "`recovery clear`",
        "`doctor`"
      ]) {
        expect(agents).toContain(cmd);
      }
    });
  });

  it("keeps the doctor milestone string moved off the M3 closeout marker after the M4 closeout (NGX-286)", () => {
    // NGX-294 (M5-07) intentionally flipped the doctor marker forward from M4 to M5;
    // this test continues to assert the M3 closeout marker is no longer pinned, mirroring
    // NGX-286's original intent of preserving the post-flip invariant.
    const cli = fs.readFileSync(path.join(repoRoot, "src", "cli.ts"), "utf8");
    expect(cli).not.toContain(
      "Milestone 3: operational safety (NGX-272, NGX-273, NGX-274, NGX-275, NGX-276, NGX-277, NGX-278) complete"
    );
  });
});
